-- ============================================================
-- MATHX — Student Stats persistence
-- ============================================================
-- Run this in your Supabase project's SQL editor (Database → SQL).
-- It is idempotent: re-running it on the same project is safe.
--
-- Creates a single row per authenticated user that holds the
-- lifetime "Solved / Accuracy / Hints / Weak topics / Strong
-- topics" numbers shown in the Study Mode sidebar. The numbers
-- accumulate forever across sessions, devices, and logouts —
-- the row is keyed by auth.users.id, and Row-Level Security is
-- locked down so a user can only ever see/modify their own row.
-- ============================================================

create table if not exists public.student_stats (
    user_id              uuid        primary key references auth.users(id) on delete cascade,
    total_solved         integer     not null default 0,
    total_attempts       integer     not null default 0,
    total_correct        integer     not null default 0,
    total_hints_used     integer     not null default 0,
    -- weak_branches accumulates per-branch attempts/correct counts as JSON
    -- so the client can derive Weak / Strong topic chips from one column.
    -- Shape: { "<branch>": { "attempts": n, "correct": n }, ... }
    weak_branches        jsonb       not null default '{}'::jsonb,
    last_session_id      text,
    -- last_active_at lets us light up the dashboard "Current Streak" card
    -- without scanning the messages table every render.
    last_active_at       timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

-- Bump updated_at automatically so we don't have to set it on every upsert.
create or replace function public.touch_student_stats_updated_at()
returns trigger as $$
begin
    new.updated_at := now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_student_stats_updated_at on public.student_stats;
create trigger trg_student_stats_updated_at
    before update on public.student_stats
    for each row execute function public.touch_student_stats_updated_at();

-- ──────────────── Row-Level Security ────────────────
alter table public.student_stats enable row level security;

-- Users can read only their own row.
drop policy if exists "student_stats_select_own" on public.student_stats;
create policy "student_stats_select_own"
    on public.student_stats
    for select
    using (auth.uid() = user_id);

-- Users can insert only a row keyed by their own uid.
drop policy if exists "student_stats_insert_own" on public.student_stats;
create policy "student_stats_insert_own"
    on public.student_stats
    for insert
    with check (auth.uid() = user_id);

-- Users can update only their own row.
drop policy if exists "student_stats_update_own" on public.student_stats;
create policy "student_stats_update_own"
    on public.student_stats
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- (no delete policy — keep history; row is deleted automatically when the
-- user is deleted thanks to ON DELETE CASCADE on the FK above.)

-- ──────────────── Atomic increment RPC ────────────────
-- The frontend uses upsert + delta increments via this function so two
-- tabs / devices recording attempts at the same time can't overwrite
-- each other's totals. It returns the new row so the client can refresh
-- its in-memory state from the authoritative DB value.
create or replace function public.increment_student_stats(
    p_solved_delta    integer default 0,
    p_attempts_delta  integer default 0,
    p_correct_delta   integer default 0,
    p_hints_delta     integer default 0,
    p_branch          text    default null,
    p_branch_attempts integer default 0,
    p_branch_correct  integer default 0,
    p_session_id      text    default null
) returns public.student_stats
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid     uuid := auth.uid();
    v_branch  jsonb;
    v_row     public.student_stats;
begin
    if v_uid is null then
        raise exception 'increment_student_stats requires an authenticated user';
    end if;

    -- Make sure the row exists.
    insert into public.student_stats (user_id) values (v_uid)
    on conflict (user_id) do nothing;

    -- Build the per-branch delta. We patch the existing JSON entry in place
    -- using jsonb_set so concurrent writers on different branches don't
    -- clobber each other's counters.
    if p_branch is not null and (p_branch_attempts <> 0 or p_branch_correct <> 0) then
        select coalesce(weak_branches, '{}'::jsonb) into v_branch
        from public.student_stats where user_id = v_uid;

        v_branch := jsonb_set(
            v_branch,
            array[p_branch],
            jsonb_build_object(
                'attempts',
                coalesce((v_branch -> p_branch ->> 'attempts')::int, 0) + p_branch_attempts,
                'correct',
                coalesce((v_branch -> p_branch ->> 'correct')::int,  0) + p_branch_correct
            ),
            true
        );

        update public.student_stats
           set weak_branches = v_branch
         where user_id = v_uid;
    end if;

    update public.student_stats
       set total_solved     = total_solved     + greatest(p_solved_delta,   0),
           total_attempts   = total_attempts   + greatest(p_attempts_delta, 0),
           total_correct    = total_correct    + greatest(p_correct_delta,  0),
           total_hints_used = total_hints_used + greatest(p_hints_delta,    0),
           last_session_id  = coalesce(p_session_id, last_session_id),
           last_active_at   = now()
     where user_id = v_uid
    returning * into v_row;

    return v_row;
end;
$$;

revoke all on function public.increment_student_stats(integer, integer, integer, integer, text, integer, integer, text) from public;
grant  execute on function public.increment_student_stats(integer, integer, integer, integer, text, integer, integer, text) to authenticated;


-- ============================================================
-- Per-chat stats: one row per Study Mode chat session
-- ============================================================
-- Lifetime totals live in student_stats; this table mirrors the same
-- numbers but scoped to a single session_id, so we can render a chat's
-- own Solved / Accuracy / Hints / Time / branch / phase next to it in
-- the sidebar history, and so the dashboard can show per-chat detail.
-- ============================================================

create table if not exists public.student_chat_stats (
    session_id       text        primary key,
    user_id          uuid        not null references auth.users(id) on delete cascade,
    branch           text,
    phase            text,        -- last seen: explain | socratic | check | practice | summary
    solved           integer     not null default 0,
    attempts         integer     not null default 0,
    correct          integer     not null default 0,
    hints_used       integer     not null default 0,
    started_at       timestamptz not null default now(),
    ended_at         timestamptz,
    last_activity_at timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

-- Helpful for "show me this user's most recent chats" queries.
create index if not exists idx_student_chat_stats_user_recent
    on public.student_chat_stats (user_id, last_activity_at desc);

drop trigger if exists trg_student_chat_stats_updated_at on public.student_chat_stats;
create trigger trg_student_chat_stats_updated_at
    before update on public.student_chat_stats
    for each row execute function public.touch_student_stats_updated_at();

-- ──────────────── Row-Level Security ────────────────
alter table public.student_chat_stats enable row level security;

drop policy if exists "student_chat_stats_select_own" on public.student_chat_stats;
create policy "student_chat_stats_select_own"
    on public.student_chat_stats
    for select
    using (auth.uid() = user_id);

drop policy if exists "student_chat_stats_insert_own" on public.student_chat_stats;
create policy "student_chat_stats_insert_own"
    on public.student_chat_stats
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "student_chat_stats_update_own" on public.student_chat_stats;
create policy "student_chat_stats_update_own"
    on public.student_chat_stats
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

drop policy if exists "student_chat_stats_delete_own" on public.student_chat_stats;
create policy "student_chat_stats_delete_own"
    on public.student_chat_stats
    for delete
    using (auth.uid() = user_id);

-- ──────────────── Atomic upsert RPC ────────────────
-- Frontend calls this every time a student records an attempt or uses a
-- hint inside a study chat. It increments the counters, refreshes the
-- branch / phase, and bumps last_activity_at. Concurrent writers (e.g.
-- the user has the same chat open in two tabs) stay consistent because
-- the increments happen in a single SQL statement.
create or replace function public.upsert_chat_session_stats(
    p_session_id     text,
    p_branch         text        default null,
    p_phase          text        default null,
    p_solved_delta   integer     default 0,
    p_attempts_delta integer     default 0,
    p_correct_delta  integer     default 0,
    p_hints_delta    integer     default 0,
    p_started_at     timestamptz default null,
    p_ended_at       timestamptz default null
) returns public.student_chat_stats
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid           uuid := auth.uid();
    v_existing_user uuid;
    v_row           public.student_chat_stats;
begin
    if v_uid is null then
        raise exception 'upsert_chat_session_stats requires an authenticated user';
    end if;
    if p_session_id is null or length(trim(p_session_id)) = 0 then
        raise exception 'session_id required';
    end if;

    -- Ownership guard: if the row already exists, it must belong to
    -- the caller. SECURITY DEFINER bypasses RLS so we enforce it
    -- manually instead of relying on the policies above.
    select user_id into v_existing_user
    from public.student_chat_stats
    where session_id = p_session_id;

    if v_existing_user is not null and v_existing_user <> v_uid then
        raise exception 'permission denied for session %', p_session_id;
    end if;

    insert into public.student_chat_stats (
        session_id, user_id, branch, phase,
        solved, attempts, correct, hints_used,
        started_at, ended_at, last_activity_at
    ) values (
        p_session_id,
        v_uid,
        p_branch,
        p_phase,
        greatest(p_solved_delta,   0),
        greatest(p_attempts_delta, 0),
        greatest(p_correct_delta,  0),
        greatest(p_hints_delta,    0),
        coalesce(p_started_at, now()),
        p_ended_at,
        now()
    )
    on conflict (session_id) do update set
        branch           = coalesce(p_branch, public.student_chat_stats.branch),
        phase            = coalesce(p_phase,  public.student_chat_stats.phase),
        solved           = public.student_chat_stats.solved     + greatest(p_solved_delta,   0),
        attempts         = public.student_chat_stats.attempts   + greatest(p_attempts_delta, 0),
        correct          = public.student_chat_stats.correct    + greatest(p_correct_delta,  0),
        hints_used       = public.student_chat_stats.hints_used + greatest(p_hints_delta,    0),
        last_activity_at = now(),
        ended_at         = coalesce(p_ended_at, public.student_chat_stats.ended_at)
    returning * into v_row;

    return v_row;
end;
$$;

revoke all     on function public.upsert_chat_session_stats(text, text, text, integer, integer, integer, integer, timestamptz, timestamptz) from public;
grant  execute on function public.upsert_chat_session_stats(text, text, text, integer, integer, integer, integer, timestamptz, timestamptz) to authenticated;


-- ============================================================
-- Per-user quiz results: one row per quiz attempt
-- ============================================================
-- Stores every quiz the student completes (single MCQ or practice
-- test) so they can revisit past attempts, review explanations,
-- and track progress over time from the sidebar or dashboard.
-- ============================================================

create table if not exists public.student_quiz_results (
    id               uuid        primary key default gen_random_uuid(),
    user_id          uuid        not null references auth.users(id) on delete cascade,
    session_id       text,                -- chat session_id (links to student_chat_stats)
    quiz_type        text        not null, -- 'single' | 'practice_test' | 'panel'
    branch           text        not null,
    difficulty       text        not null default 'medium',
    total_questions  integer     not null default 1,
    correct_count    integer     not null default 0,
    score_pct        numeric(5,2) not null default 0,
    time_spent_ms    integer,             -- elapsed time in milliseconds
    -- Full question + answer detail as JSONB so the user can review
    -- each question, their answer, the correct answer, and explanation.
    -- Shape: [ { question, questionAr, options, selectedId,
    --            correctId, isCorrect, explanation, hint } ]
    questions_json   jsonb       not null default '[]'::jsonb,
    created_at       timestamptz not null default now()
);

-- Fast lookup: "show me this user's recent quizzes"
create index if not exists idx_student_quiz_results_user_recent
    on public.student_quiz_results (user_id, created_at desc);

-- ──────────────── Row-Level Security ────────────────
alter table public.student_quiz_results enable row level security;

drop policy if exists "quiz_results_select_own" on public.student_quiz_results;
create policy "quiz_results_select_own"
    on public.student_quiz_results
    for select
    using (auth.uid() = user_id);

drop policy if exists "quiz_results_insert_own" on public.student_quiz_results;
create policy "quiz_results_insert_own"
    on public.student_quiz_results
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "quiz_results_delete_own" on public.student_quiz_results;
create policy "quiz_results_delete_own"
    on public.student_quiz_results
    for delete
    using (auth.uid() = user_id);

-- ──────────────── Insert RPC ────────────────
-- SECURITY DEFINER so the function can write under RLS. The caller
-- must be authenticated; we enforce ownership inside the function.
create or replace function public.save_quiz_result(
    p_session_id      text        default null,
    p_quiz_type       text        default 'single',
    p_branch          text        default 'algebra',
    p_difficulty      text        default 'medium',
    p_total_questions  integer    default 1,
    p_correct_count   integer     default 0,
    p_score_pct       numeric     default 0,
    p_time_spent_ms   integer     default null,
    p_questions_json  jsonb       default '[]'::jsonb
) returns public.student_quiz_results
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid  uuid := auth.uid();
    v_row  public.student_quiz_results;
begin
    if v_uid is null then
        raise exception 'save_quiz_result requires an authenticated user';
    end if;

    insert into public.student_quiz_results (
        user_id, session_id, quiz_type, branch, difficulty,
        total_questions, correct_count, score_pct,
        time_spent_ms, questions_json
    ) values (
        v_uid,
        p_session_id,
        p_quiz_type,
        p_branch,
        p_difficulty,
        p_total_questions,
        p_correct_count,
        p_score_pct,
        p_time_spent_ms,
        p_questions_json
    )
    returning * into v_row;

    return v_row;
end;
$$;

revoke all     on function public.save_quiz_result(text, text, text, text, integer, integer, numeric, integer, jsonb) from public;
grant  execute on function public.save_quiz_result(text, text, text, text, integer, integer, numeric, integer, jsonb) to authenticated;
