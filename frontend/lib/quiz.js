// ============================================================
// MATHX — Khan-style MCQ + Practice Test (PR-B)
// ============================================================
// Vanilla DOM-builder module that renders quiz cards inline in
// the chat transcript (NOT modals, NOT new pages). Matches the
// existing study-mode.js code style.
//
// Contents:
//   • studyAnalytics       — in-memory store + localStorage + pub/sub
//   • openSingleQuiz()     — 1-question MCQ card
//   • openPracticeTest()   — 5-question test card with progress + summary
//   • openBranchDiffMenu() — dropdown asking for branch + difficulty
//
// PR-A swap points marked with `PR-A:` comments.
// ============================================================

import { formatMessage } from './markdown.js';
import { getMockTest, checkMockAnswer } from './quiz-mock.js';
import { supabase } from '../supabaseClient.js';

// ── Backend wiring (PR-A) ────────────────────────────────────
//
// Resolved at runtime the same way study-mode.js does — so the dev server
// hits the local FastAPI, the staging build hits VITE_API_URL, and prod
// uses the same origin. If the request fails (offline, expired test, etc.)
// the helpers transparently fall back to the static bank in quiz-mock.js
// so the UI is still usable. The mock leaks the correct answer client-side;
// the real endpoint does NOT.

function _apiBase() {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) {
        return String(import.meta.env.VITE_API_URL).replace(/\/$/, '');
    }
    return window.location.hostname === 'localhost' ? 'http://localhost:8000' : '';
}

async function fetchMcqTest({ branch, difficulty, count, sourceQuestion = '' }) {
    const url = `${_apiBase()}/study/mcq/generate`;
    const ctx = typeof window.getCurrentChatContext === 'function' ? window.getCurrentChatContext() : { context: '', user_question: '', topic: branch, unit: '' };
    const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ 
            branch, 
            difficulty: difficulty || 'medium', 
            count, 
            source_question: sourceQuestion || undefined,
            context: ctx.context,
            user_question: ctx.user_question,
            topic: ctx.topic || branch,
            unit: ctx.unit
        }),
    });
    if (!res.ok) throw new Error(`MCQ generate ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.questions)) {
        throw new Error('MCQ generate: malformed payload');
    }
    // Normalize so renderMCQCard can consume both real + mock payloads with
    // the same field names. The mock uses `correctOptionId` directly; the
    // real /generate response has stripped it, and we never need it on the
    // client (the server checks).
    return {
        test_id:    data.test_id,
        branch:     data.branch || branch,
        difficulty: data.difficulty || difficulty,
        source:     'server',
        questions:  data.questions.map((q) => ({
            id:              q.id,
            question:        q.question || '',
            questionAr:      q.questionAr || '',
            options:         q.options || [],
            // No correctOptionId here — the server enforces this and the
            // regression test in test_mcq_parser.py asserts it.
            correctOptionId: null,
            explanation:     '',  // populated by /check
            explanationAr:   '',
            hint:            q.hint || '',
            hintAr:          q.hintAr || '',
        })),
    };
}

async function fetchMcqCheck({ test_id, question_id, selected_option_id }) {
    const url = `${_apiBase()}/study/mcq/check`;
    const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ test_id, question_id, selected_option_id }),
    });
    if (!res.ok) throw new Error(`MCQ check ${res.status}`);
    return res.json();
}

/** Try the real backend first; fall back to the mock bank on any failure. */
async function loadTest(branch, difficulty, count, sourceQuestion = '') {
    try {
        return await fetchMcqTest({ branch, difficulty, count, sourceQuestion });
    } catch (e) {
        console.warn('[quiz] backend unavailable, using mock bank:', e.message);
        const mock = getMockTest(branch, count, difficulty);
        mock.source = 'mock';
        return mock;
    }
}

/**
 * Check an answer against the backend; fall back to the mock for tests
 * whose `source === 'mock'`. The mock check is synchronous; the real one
 * isn't — both return the same { is_correct, correct_option_id, explanation,
 * points_awarded } shape.
 */
async function checkAnswer(testContext, question, selectedId, lang) {
    if (testContext && testContext.source === 'mock') {
        return checkMockAnswer(question, selectedId, lang);
    }
    try {
        return await fetchMcqCheck({
            test_id:            testContext.test_id,
            question_id:        question.id,
            selected_option_id: selectedId,
        });
    } catch (e) {
        console.warn('[quiz] backend check failed, falling back to mock:', e.message);
        return checkMockAnswer(question, selectedId, lang);
    }
}

// ── Bilingual strings ────────────────────────────────────────
// Hard-coded per the codebase convention (no i18n library). Keyed
// by language; every new string MUST exist in both `en` and `ar`.

const STR = {
    en: {
        createQuestion:   'Create Practice Question',
        createTest:       'Create Practice Test',
        pickBranch:       'Pick a branch',
        pickDifficulty:   'Pick a difficulty',
        easy:             'Easy',
        medium:           'Medium',
        hard:             'Hard',
        algebra:          'Algebra',
        calculus:         'Calculus',
        trigonometry:     'Trigonometry',
        start:            'Start',
        cancel:           'Cancel',
        check:            'Check',
        showSteps:        'Show Steps',
        hideSteps:        'Hide Steps',
        tryAnother:       'Try another',
        nextQuestion:     'Next question',
        prev:             'Previous',
        next:             'Next',
        submitTest:       'Submit test',
        questionN:        (n) => `Question ${n}`,
        practiceTestOn:   (b) => `Practice Test on ${capitalize(b)}`,
        letsStart:        `Let's start!`,
        halfway:          `Halfway there! 💪`,
        almostDone:       `Almost done!`,
        finished:         `Test complete 🎉`,
        scoreLine:        (x, y) => `You have earned ${x} out of ${y} points attempted`,
        greatStart:       `Great start!`,
        keepPracticing:   `Keep practicing!`,
        correct:          `Correct!`,
        tryAgain:         `Try again`,
        tryAgainBtn:      `Try again`,
        newTest:          `New test`,
        close:            `Close`,
        confirmLoseProgress: `You will lose your progress. Sure?`,
        generating:       `Generating your quiz…`,
        retry:            `Retry`,
        generationFailed: `Couldn't generate the quiz. Please retry.`,
        sessionAnalytics: `Session Analytics`,
        mode:             `Mode`,
        solved:           `Solved`,
        accuracy:         `Accuracy`,
        hints:            `Hints`,
        time:             `Time`,
        weakTopics:       `Weak topics`,
        strongTopics:     `Strong topics`,
        clientDerived:    `(client-derived)`,
        phaseExplain:     `Learning`,
        phaseSocratic:    `Guided`,
        phaseCheck:       `Checking`,
        phasePractice:    `Practice`,
        phaseSummary:     `Wrap-up`,
        phaseTest:        (n, total) => `Practice Test (Q ${n}/${total})`,
        noWeakTopics:     `No weak topics yet`,
        noStrongTopics:   `No strong topics yet`,
        endSession:       `End Session`,
        endSessionHint:   `Wrap up & summarize`,
        selectAnOption:   `Select an option to continue`,
        yourAnswer:       `Your answer`,
        correctAnswer:    `Correct answer`,
        explanation:      `Explanation`,
    },
    ar: {
        createQuestion:   'سؤال تدريبي',
        createTest:       'اختبار تدريبي',
        pickBranch:       'اختر الفرع',
        pickDifficulty:   'اختر المستوى',
        easy:             'سهل',
        medium:           'متوسط',
        hard:             'صعب',
        algebra:          'الجبر',
        calculus:         'التفاضل والتكامل',
        trigonometry:     'حساب المثلثات',
        start:            'ابدأ',
        cancel:           'إلغاء',
        check:            'تحقّق',
        showSteps:        'اعرض الخطوات',
        hideSteps:        'إخفاء الخطوات',
        tryAnother:       'جرّب واحدة تانية',
        nextQuestion:     'السؤال التالي',
        prev:             'السابق',
        next:             'التالي',
        submitTest:       'أنهِ الاختبار',
        questionN:        (n) => `السؤال ${n}`,
        practiceTestOn:   (b) => `اختبار تدريبي في ${STR.ar[b] || b}`,
        letsStart:        `هيا نبدأ!`,
        halfway:          `وصلت للنصف! 💪`,
        almostDone:       `قربت تخلّص!`,
        finished:         `خلصت الاختبار 🎉`,
        scoreLine:        (x, y) => `حصلت على ${x} من ${y} نقطة محاولة`,
        greatStart:       `بداية ممتازة!`,
        keepPracticing:   `استمر في التدريب!`,
        correct:          `إجابة صحيحة`,
        tryAgain:         `حاول مرّة تانية`,
        tryAgainBtn:      `أعد المحاولة`,
        newTest:          `اختبار جديد`,
        close:            `إغلاق`,
        confirmLoseProgress: `هتفقد التقدم. متأكد؟`,
        generating:       `جاري تجهيز الاختبار…`,
        retry:            `إعادة المحاولة`,
        generationFailed: `ماقدرناش نجهّز الاختبار. جرّب تاني.`,
        sessionAnalytics: `تحليلات الجلسة`,
        mode:             `الوضع`,
        solved:           `حل`,
        accuracy:         `الدقة`,
        hints:            `تلميحات`,
        time:             `الوقت`,
        weakTopics:       `نقاط الضعف`,
        strongTopics:     `نقاط القوة`,
        clientDerived:    `(محسوب من الجهاز)`,
        phaseExplain:     `تعلّم`,
        phaseSocratic:    `إرشاد`,
        phaseCheck:       `تصحيح`,
        phasePractice:    `تدريب`,
        phaseSummary:     `مراجعة`,
        phaseTest:        (n, total) => `اختبار تدريبي (سؤال ${n}/${total})`,
        noWeakTopics:     `لسه مفيش نقاط ضعف`,
        noStrongTopics:   `لسه مفيش نقاط قوة`,
        endSession:       `إنهاء الجلسة`,
        endSessionHint:   `اختم الجلسة بملخّص`,
        selectAnOption:   `اختر إجابة للاستمرار`,
        yourAnswer:       `إجابتك`,
        correctAnswer:    `الإجابة الصحيحة`,
        explanation:      `الشرح`,
    },
};

function capitalize(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function t(lang) {
    return STR[lang === 'ar' ? 'ar' : 'en'];
}

function detectLang() {
    // Prefer a global set by the caller; fall back to html.dir / lang.
    if (window.__MATHX_LANG === 'ar' || window.__MATHX_LANG === 'en') return window.__MATHX_LANG;
    const dir = document.documentElement.getAttribute('dir');
    if (dir === 'rtl') return 'ar';
    return 'en';
}

function optionLetter(idx, lang) {
    if (lang === 'ar') return ['أ', 'ب', 'ج', 'د'][idx] || String(idx + 1);
    return ['A', 'B', 'C', 'D'][idx] || String(idx + 1);
}


// ═════════════════════════════════════════════════════════════
// studyAnalytics — store + pub/sub + localStorage persistence
// ═════════════════════════════════════════════════════════════

const STORAGE_KEY = 'mathx_study_analytics_v1';
// Per-session snapshots so switching between chat-history items in the
// sidebar restores that chat's analytics (Bug 7). The default STORAGE_KEY is
// kept as a "most-recent" snapshot for plain page refreshes when we don't
// yet know which session will be loaded.
const SESSION_STORAGE_PREFIX = 'mathx_study_analytics_v1__session__';
// Per-user lifetime totals snapshot so a logged-in user's Solved / Accuracy
// / Hints / Weak topics keep showing the right numbers across page reloads
// (and even before the Supabase fetch resolves). The cloud row is the source
// of truth — this is just a fast cache.
const LIFETIME_STORAGE_PREFIX = 'mathx_student_stats_v1__user__';

const initialState = () => ({
    sessionId:        null,
    userId:           null,
    branch:           null,
    phase:            null,    // explain|socratic|check|practice|summary|null
    mode:             null,    // override label, e.g. 'Practice Test (Q 2/5)'
    // Lifetime totals — accumulate forever per user, synced to Supabase
    // (table public.student_stats) so the numbers survive logout / new
    // chat / device change. The widget displays these directly.
    solved:           0,
    attempts:         0,
    correct:          0,
    hintsUsed:        0,
    // Per-chat totals — same counters but scoped to the active chat
    // session_id, synced to Supabase (table public.student_chat_stats)
    // so reopening a past chat shows its own numbers (and the dashboard
    // can render a per-chat breakdown).
    sessionSolved:    0,
    sessionAttempts:  0,
    sessionCorrect:   0,
    sessionHintsUsed: 0,
    sessionStartedAt: null,    // ms epoch
    sessionEndedAt:   null,    // ms epoch — set by endSession() to freeze the
                               // displayed elapsed time once the user wraps up.
    weakBranches:     {},      // { [branch]: { attempts, correct } }
    activeQuiz:       null,    // { kind: 'single'|'test', … } — not persisted
    cloudSynced:      false,   // true once the initial fetch from Supabase
                               // landed; until then the numbers come from
                               // localStorage and may be out of date.
});

/**
 * Hydrate state from localStorage. If a sessionId is provided, prefer that
 * session's saved snapshot; otherwise fall back to the global "last seen"
 * snapshot so a plain refresh still shows numbers.
 *
 * Returns `{ state, isFresh }` where `isFresh` is true when no snapshot
 * exists for the requested sessionId (i.e. it's a brand-new chat) — the
 * caller uses this to start a fresh elapsed-time counter.
 */
function loadFromStorage(sessionId = null) {
    if (sessionId) {
        try {
            const raw = localStorage.getItem(SESSION_STORAGE_PREFIX + sessionId);
            if (raw) {
                const parsed = JSON.parse(raw);
                return { state: { ...initialState(), ...parsed, sessionId, activeQuiz: null }, isFresh: false };
            }
        } catch { /* fall through */ }
        // No snapshot for this specific session — start clean instead of
        // inheriting the previous chat's numbers from the global key.
        return { state: { ...initialState(), sessionId }, isFresh: true };
    }
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { state: initialState(), isFresh: true };
        const parsed = JSON.parse(raw);
        // Never persist the activeQuiz handle (contains DOM refs when live).
        return { state: { ...initialState(), ...parsed, activeQuiz: null }, isFresh: false };
    } catch {
        return { state: initialState(), isFresh: true };
    }
}

function saveToStorage(state) {
    try {
        // Strip runtime-only flags: activeQuiz holds DOM refs and
        // cloudSynced is a per-page-load latch that should reset on
        // refresh so we always re-pull the latest cloud row at startup.
        const { activeQuiz, cloudSynced, ...rest } = state;
        // Latest snapshot — used for cold-start refresh recovery and any
        // legacy callers that still read the single key directly.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
        // Per-session snapshot — restored on chat-history click.
        if (state.sessionId) {
            localStorage.setItem(SESSION_STORAGE_PREFIX + state.sessionId, JSON.stringify(rest));
        }
        // Per-user lifetime cache — read on login before the network round-trip
        // resolves so the widget doesn't flash 0s.
        if (state.userId) {
            localStorage.setItem(LIFETIME_STORAGE_PREFIX + state.userId, JSON.stringify({
                solved:       rest.solved       || 0,
                attempts:     rest.attempts     || 0,
                correct:      rest.correct      || 0,
                hintsUsed:    rest.hintsUsed    || 0,
                weakBranches: rest.weakBranches || {},
            }));
        }
    } catch { /* quota / private mode */ }
}

/**
 * Load a user's lifetime totals from the per-user localStorage cache. Used
 * for instant first paint while the Supabase fetch is in flight.
 */
function loadLifetimeFromCache(userId) {
    if (!userId) return null;
    try {
        const raw = localStorage.getItem(LIFETIME_STORAGE_PREFIX + userId);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return {
            solved:       parsed.solved       || 0,
            attempts:     parsed.attempts     || 0,
            correct:      parsed.correct      || 0,
            hintsUsed:    parsed.hintsUsed    || 0,
            weakBranches: parsed.weakBranches || {},
        };
    } catch { return null; }
}

export const studyAnalytics = (() => {
    let _state     = loadFromStorage().state;
    const _subs    = new Set();

    // ── Cloud sync (Supabase: public.student_stats) ──────────────
    // Lifetime totals (Solved / Accuracy / Hints / Weak topics) are
    // mirrored to Supabase tied to auth.uid() so the same student
    // sees the same numbers on every device after login. The schema
    // and RLS policies live in /db/student_stats.sql — run that
    // file in your Supabase SQL editor before this code can persist.
    const PENDING_DELTA = {
        solved:        0,
        attempts:      0,
        correct:       0,
        hintsUsed:     0,
        // { [branch]: { attempts, correct } }
        branchDeltas:  {},
    };
    // Per-chat deltas keyed by session_id so attempts queued before a
    // session switch flush against the correct chat row. Each entry
    // mirrors the lifetime counters scoped to one Study Mode session.
    // Shape: { [sessionId]: { branch, phase, solved, attempts, correct,
    //                         hintsUsed, startedAt, endedAt } }
    const PENDING_CHAT_DELTAS = {};
    let _flushTimer = null;
    let _flushInFlight = null;

    function _resetPendingDelta() {
        PENDING_DELTA.solved    = 0;
        PENDING_DELTA.attempts  = 0;
        PENDING_DELTA.correct   = 0;
        PENDING_DELTA.hintsUsed = 0;
        PENDING_DELTA.branchDeltas = {};
    }

    function _queueChatDelta({ solvedDelta = 0, attemptsDelta = 0, correctDelta = 0, hintsDelta = 0, branch, phase, startedAt, endedAt } = {}) {
        const sid = _state.sessionId;
        if (!sid) return;          // anonymous / pre-session attempts skip per-chat tracking
        const entry = PENDING_CHAT_DELTAS[sid] || {
            branch:    null,
            phase:     null,
            solved:    0,
            attempts:  0,
            correct:   0,
            hintsUsed: 0,
            startedAt: null,
            endedAt:   null,
        };
        entry.solved    += solvedDelta;
        entry.attempts  += attemptsDelta;
        entry.correct   += correctDelta;
        entry.hintsUsed += hintsDelta;
        if (branch)    entry.branch    = branch;
        if (phase)     entry.phase     = phase;
        if (startedAt) entry.startedAt = startedAt;
        if (endedAt)   entry.endedAt   = endedAt;
        PENDING_CHAT_DELTAS[sid] = entry;
    }

    function _hasPending() {
        return PENDING_DELTA.solved   > 0
            || PENDING_DELTA.attempts > 0
            || PENDING_DELTA.correct  > 0
            || PENDING_DELTA.hintsUsed > 0
            || Object.keys(PENDING_DELTA.branchDeltas).length > 0
            || Object.keys(PENDING_CHAT_DELTAS).length > 0;
    }

    async function _flushNow() {
        if (!_state.userId)   return;
        if (!_hasPending())   return;
        // Avoid overlapping RPCs — if one is already running, the next
        // tick will pick up whatever queued up while we were waiting.
        if (_flushInFlight) return _flushInFlight;

        // Snapshot + clear so new attempts queued during the in-flight
        // request aren't lost.
        const branches = PENDING_DELTA.branchDeltas;
        const snap = {
            solved:    PENDING_DELTA.solved,
            attempts:  PENDING_DELTA.attempts,
            correct:   PENDING_DELTA.correct,
            hintsUsed: PENDING_DELTA.hintsUsed,
            branches,
        };
        _resetPendingDelta();

        // Snapshot + clear the per-chat deltas the same way. Each entry
        // is keyed by its own sessionId so a chat switch mid-flush won't
        // misattribute the rows.
        const chatSnap = {};
        for (const sid of Object.keys(PENDING_CHAT_DELTAS)) {
            chatSnap[sid] = PENDING_CHAT_DELTAS[sid];
            delete PENDING_CHAT_DELTAS[sid];
        }

        _flushInFlight = (async () => {
            // ── 1. Lifetime totals (public.student_stats) ───────
            // The atomic RPC takes a single branch delta per call; we issue
            // one call per branch (almost always 1, occasionally 2) so the
            // jsonb_set in SQL keeps each branch's counters intact.
            const branchKeys = Object.keys(branches);
            const calls = branchKeys.length === 0 ? [null] : branchKeys;

            // Spread the totals across the per-branch calls so we don't
            // double-count: the first call carries the totals + its branch
            // delta, every subsequent call carries only the branch delta.
            let totalsClaimedBy = null;
            for (let i = 0; i < calls.length; i++) {
                const branchKey = calls[i];
                const isFirst = totalsClaimedBy === null;
                if (isFirst) totalsClaimedBy = branchKey;

                const params = {
                    p_solved_delta:    isFirst ? snap.solved    : 0,
                    p_attempts_delta:  isFirst ? snap.attempts  : 0,
                    p_correct_delta:   isFirst ? snap.correct   : 0,
                    p_hints_delta:     isFirst ? snap.hintsUsed : 0,
                    p_branch:          branchKey || null,
                    p_branch_attempts: branchKey ? branches[branchKey].attempts : 0,
                    p_branch_correct:  branchKey ? branches[branchKey].correct  : 0,
                    p_session_id:      _state.sessionId || null,
                };

                try {
                    const { data, error } = await supabase.rpc('increment_student_stats', params);
                    if (error) {
                        console.warn('[analytics] cloud sync failed', error);
                        // Re-queue so we don't drop the user's progress on a
                        // transient network blip.
                        PENDING_DELTA.solved    += params.p_solved_delta;
                        PENDING_DELTA.attempts  += params.p_attempts_delta;
                        PENDING_DELTA.correct   += params.p_correct_delta;
                        PENDING_DELTA.hintsUsed += params.p_hints_delta;
                        if (branchKey) {
                            const cur = PENDING_DELTA.branchDeltas[branchKey] || { attempts: 0, correct: 0 };
                            PENDING_DELTA.branchDeltas[branchKey] = {
                                attempts: cur.attempts + (params.p_branch_attempts || 0),
                                correct:  cur.correct  + (params.p_branch_correct  || 0),
                            };
                        }
                        // Don't return — we still want to attempt the
                        // per-chat flush below so a single failing call
                        // doesn't strand the chat-stats sync.
                        break;
                    }
                    // The RPC returns the authoritative row; on the LAST
                    // call we sync our in-memory state to it so two tabs
                    // don't drift.
                    if (i === calls.length - 1 && data) {
                        const row = Array.isArray(data) ? data[0] : data;
                        if (row) _applyCloudRow(row);
                    }
                } catch (e) {
                    console.warn('[analytics] cloud sync threw', e);
                    // Same re-queue logic as above so progress isn't lost.
                    PENDING_DELTA.solved    += params.p_solved_delta;
                    PENDING_DELTA.attempts  += params.p_attempts_delta;
                    PENDING_DELTA.correct   += params.p_correct_delta;
                    PENDING_DELTA.hintsUsed += params.p_hints_delta;
                    if (branchKey) {
                        const cur = PENDING_DELTA.branchDeltas[branchKey] || { attempts: 0, correct: 0 };
                        PENDING_DELTA.branchDeltas[branchKey] = {
                            attempts: cur.attempts + (params.p_branch_attempts || 0),
                            correct:  cur.correct  + (params.p_branch_correct  || 0),
                        };
                    }
                    break;
                }
            }

            // ── 2. Per-chat stats (public.student_chat_stats) ───
            // One upsert RPC per sessionId. We ship all the counters for
            // that chat in a single call so the row stays atomically
            // consistent. Failure on one chat doesn't abort the others.
            for (const sid of Object.keys(chatSnap)) {
                const entry = chatSnap[sid];
                const chatParams = {
                    p_session_id:     sid,
                    p_branch:         entry.branch || null,
                    p_phase:          entry.phase  || null,
                    p_solved_delta:   entry.solved    || 0,
                    p_attempts_delta: entry.attempts  || 0,
                    p_correct_delta:  entry.correct   || 0,
                    p_hints_delta:    entry.hintsUsed || 0,
                    p_started_at:     entry.startedAt ? new Date(entry.startedAt).toISOString() : null,
                    p_ended_at:       entry.endedAt   ? new Date(entry.endedAt).toISOString()   : null,
                };
                try {
                    const { error } = await supabase.rpc('upsert_chat_session_stats', chatParams);
                    if (error) {
                        console.warn('[analytics] chat-stats sync failed for', sid, error);
                        // Merge the failed entry back into the pending map
                        // so the next flush retries it.
                        const existing = PENDING_CHAT_DELTAS[sid];
                        if (existing) {
                            existing.solved    += entry.solved;
                            existing.attempts  += entry.attempts;
                            existing.correct   += entry.correct;
                            existing.hintsUsed += entry.hintsUsed;
                            if (entry.branch)    existing.branch    = entry.branch;
                            if (entry.phase)     existing.phase     = entry.phase;
                            if (entry.startedAt) existing.startedAt = entry.startedAt;
                            if (entry.endedAt)   existing.endedAt   = entry.endedAt;
                        } else {
                            PENDING_CHAT_DELTAS[sid] = entry;
                        }
                    }
                } catch (e) {
                    console.warn('[analytics] chat-stats sync threw for', sid, e);
                    PENDING_CHAT_DELTAS[sid] = entry;
                }
            }
        })().finally(() => {
            _flushInFlight = null;
            // If new deltas accumulated while we were waiting, flush again.
            if (_hasPending()) _scheduleFlush(0);
        });

        return _flushInFlight;
    }

    function _scheduleFlush(delayMs = 800) {
        if (!_state.userId) return; // signed-out users stay localStorage-only
        if (_flushTimer) clearTimeout(_flushTimer);
        _flushTimer = setTimeout(() => {
            _flushTimer = null;
            _flushNow();
        }, delayMs);
    }

    function _applyCloudRow(row) {
        if (!row) return;
        _state = {
            ..._state,
            solved:       row.total_solved      ?? _state.solved,
            attempts:     row.total_attempts    ?? _state.attempts,
            correct:      row.total_correct     ?? _state.correct,
            hintsUsed:    row.total_hints_used  ?? _state.hintsUsed,
            weakBranches: row.weak_branches     ?? _state.weakBranches ?? {},
            cloudSynced:  true,
        };
        _emit();
    }

    // Final-resort: try to flush before the page is closed so a hint or
    // attempt typed seconds before navigation isn't dropped. We use the
    // navigator.sendBeacon-like keepalive on fetch via Supabase's RPC if
    // a flush is mid-debounce; if no user is logged in this is a no-op.
    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => {
            if (_flushTimer) {
                clearTimeout(_flushTimer);
                _flushTimer = null;
                // Fire-and-forget; we can't await on beforeunload.
                _flushNow().catch(() => {});
            }
        });
    }

    function _emit() {
        for (const fn of _subs) {
            try { fn(_state); } catch (e) { console.warn('[analytics] subscriber threw', e); }
        }
        saveToStorage(_state);
    }

    return {
        get state() { return _state; },

        subscribe(fn) {
            _subs.add(fn);
            fn(_state);
            return () => _subs.delete(fn);
        },

        /**
         * Bind the analytics store to a Supabase user. Hydrates lifetime
         * totals (Solved / Accuracy / Hints / Weak topics) from the
         * `student_stats` row keyed by auth.uid() so the widget shows the
         * student's true cumulative numbers right after login. Falls back
         * to a per-user localStorage cache for instant first paint while
         * the network request is in flight.
         *
         * Pass `null` (called by study-mode.js on logout) to clear all
         * personal data from memory + localStorage.
         */
        async setUser(userId) {
            if (!userId) {
                if (_state.userId) {
                    // Signing out — wipe lifetime totals so the next user
                    // on this device doesn't inherit them. Per-session
                    // snapshots are also cleared by reset().
                    this.reset();
                }
                return;
            }
            if (_state.userId === userId && _state.cloudSynced) return;

            // 1. Instant paint from per-user localStorage cache.
            const cached = loadLifetimeFromCache(userId);
            if (cached) {
                _state = {
                    ..._state,
                    userId,
                    solved:       cached.solved,
                    attempts:     cached.attempts,
                    correct:      cached.correct,
                    hintsUsed:    cached.hintsUsed,
                    weakBranches: { ...(_state.weakBranches || {}), ...cached.weakBranches },
                    cloudSynced:  false,
                };
            } else {
                // No cached row yet — but DON'T reset the in-memory totals
                // accumulated during this session before login resolved
                // (e.g. a guest who solved a problem then signed in). We
                // forward those numbers to the cloud below.
                _state = { ..._state, userId, cloudSynced: false };
            }
            _emit();

            // 2. Authoritative fetch from Supabase.
            try {
                const { data, error } = await supabase
                    .from('student_stats')
                    .select('total_solved, total_attempts, total_correct, total_hints_used, weak_branches')
                    .eq('user_id', userId)
                    .maybeSingle();
                if (error && error.code !== 'PGRST116') {
                    // PGRST116 = no row yet — first time the student opens
                    // the app. Anything else is a real error worth logging.
                    console.warn('[analytics] failed to fetch student_stats', error);
                } else if (data) {
                    _applyCloudRow(data);
                } else {
                    // First-time user: create the row by zero-incrementing
                    // so subsequent updates work without an explicit insert.
                    try {
                        await supabase.rpc('increment_student_stats', {
                            p_solved_delta: 0, p_attempts_delta: 0, p_correct_delta: 0,
                            p_hints_delta: 0, p_branch: null,
                            p_branch_attempts: 0, p_branch_correct: 0,
                            p_session_id: _state.sessionId || null,
                        });
                    } catch (e) {
                        console.warn('[analytics] could not seed student_stats row', e);
                    }
                    _state = { ..._state, cloudSynced: true };
                    _emit();
                }
            } catch (e) {
                console.warn('[analytics] student_stats fetch threw', e);
            }
        },

        startSession(sessionId, branch) {
            // Lifetime totals (solved/attempts/correct/hintsUsed/weakBranches)
            // are NOT reset here — they're cumulative across every session.
            // We only refresh the per-session bits: which chat is active,
            // when it started, and what branch the agent is teaching.
            const now = Date.now();
            _state = {
                ..._state,
                sessionId,
                branch,
                phase:            null,
                mode:             null,
                activeQuiz:       null,
                // Reset per-chat counters for the new session
                sessionSolved:    0,
                sessionAttempts:  0,
                sessionCorrect:   0,
                sessionHintsUsed: 0,
                sessionStartedAt: now,
                sessionEndedAt:   null,
            };
            // Seed the chat-stats row in Supabase with startedAt + branch
            _queueChatDelta({ branch, startedAt: now });
            _scheduleFlush();
            _emit();
        },

        /**
         * Freeze the running "Time" counter at its current value and flip
         * the phase chip to "Wrap-up". Called from study-mode.js's
         * handleEndSession so both the inline action-bar button AND the
         * sidebar End Session button stop the clock identically.
         */
        endSession() {
            // Already ended — leave the frozen value alone so a second
            // click doesn't shift the displayed elapsed time.
            if (_state.sessionEndedAt) {
                if (_state.phase !== 'summary') _state = { ..._state, phase: 'summary' };
                _emit();
                return;
            }
            const now = Date.now();
            _state = {
                ..._state,
                phase: 'summary',
                mode: null,                  // clear "Practice Test (Q n/N)"
                activeQuiz: null,
                sessionEndedAt: now,
            };
            // Record the ended_at + final phase in the per-chat row
            _queueChatDelta({ phase: 'summary', endedAt: now });
            // Flush any pending stat deltas immediately so the summary
            // reflects the user's final attempt before the page navigates.
            if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
            _flushNow().catch(() => {});
            _emit();
        },

        /**
         * Switch the active analytics view to another chat session. Called
         * by study-mode.js when the user clicks a different chat-history
         * item in the sidebar — without this the widget would keep showing
         * the previous chat's per-session bits.
         *
         * Lifetime totals are kept intact across the switch so the user
         * sees their true Solved / Accuracy / Hints regardless of which
         * chat they happen to be on.
         */
        loadSession(sessionId) {
            if (!sessionId) return;
            if (_state.sessionId === sessionId) return;
            // Persist the outgoing state first so we don't lose anything
            // accumulated since the last _emit().
            if (_state.sessionId) saveToStorage(_state);

            const { state: snapshot, isFresh } = loadFromStorage(sessionId);
            _state = {
                ..._state,
                sessionId,
                branch:           snapshot.branch || _state.branch,
                phase:            snapshot.phase  || null,
                mode:             snapshot.mode   || null,
                activeQuiz:       null,
                // Restore per-chat counters from the snapshot
                sessionSolved:    isFresh ? 0 : (snapshot.sessionSolved    || 0),
                sessionAttempts:  isFresh ? 0 : (snapshot.sessionAttempts  || 0),
                sessionCorrect:   isFresh ? 0 : (snapshot.sessionCorrect   || 0),
                sessionHintsUsed: isFresh ? 0 : (snapshot.sessionHintsUsed || 0),
                // Brand-new chat → start the "Time" counter from now so the
                // user sees it ticking immediately, instead of waiting for
                // them to launch a quiz before sessionStartedAt is set.
                sessionStartedAt: isFresh ? Date.now() : snapshot.sessionStartedAt,
                sessionEndedAt:   isFresh ? null      : snapshot.sessionEndedAt,
            };
            _emit();

            // Hydrate per-chat stats from Supabase if the user is logged in
            // and the snapshot didn't already have them (e.g. new device).
            if (_state.userId && !isFresh) {
                supabase
                    .from('student_chat_stats')
                    .select('solved, attempts, correct, hints_used, branch, phase, started_at, ended_at')
                    .eq('session_id', sessionId)
                    .maybeSingle()
                    .then(({ data, error }) => {
                        if (error || !data) return;
                        // Only apply if we're still on the same session
                        if (_state.sessionId !== sessionId) return;
                        _state = {
                            ..._state,
                            sessionSolved:    data.solved       ?? _state.sessionSolved,
                            sessionAttempts:  data.attempts     ?? _state.sessionAttempts,
                            sessionCorrect:   data.correct      ?? _state.sessionCorrect,
                            sessionHintsUsed: data.hints_used   ?? _state.sessionHintsUsed,
                            branch:           data.branch       || _state.branch,
                            phase:            data.phase        || _state.phase,
                            sessionStartedAt: data.started_at   ? new Date(data.started_at).getTime() : _state.sessionStartedAt,
                            sessionEndedAt:   data.ended_at     ? new Date(data.ended_at).getTime()   : _state.sessionEndedAt,
                        };
                        _emit();
                    })
                    .catch(() => { /* offline — localStorage snapshot is good enough */ });
            }
        },

        /**
         * Wipe the per-session view (phase / mode / time) without touching
         * the lifetime totals or localStorage caches. Called by
         * study-mode.js on a fresh "New chat" navigation so the previous
         * chat's phase chip doesn't bleed into the new chat's hero screen.
         */
        resetActiveView() {
            _state = {
                ..._state,
                sessionId:        null,
                branch:           null,
                phase:            null,
                mode:             null,
                activeQuiz:       null,
                sessionSolved:    0,
                sessionAttempts:  0,
                sessionCorrect:   0,
                sessionHintsUsed: 0,
                sessionStartedAt: null,
                sessionEndedAt:   null,
            };
            _emit();
        },

        setPhase(phase) {
            if (_state.phase === phase) return;
            _state = { ..._state, phase };
            // Sync the phase to the per-chat row so reopening this
            // chat later shows the correct phase chip.
            _queueChatDelta({ phase });
            _scheduleFlush();
            _emit();
        },

        setMode(mode) {
            if (_state.mode === mode) return;
            _state = { ..._state, mode };
            _emit();
        },

        recordAttempt({ branch, correct }) {
            const wb  = { ..._state.weakBranches };
            const key = branch || _state.branch || 'unknown';
            wb[key]   = wb[key] || { attempts: 0, correct: 0 };
            wb[key]   = { attempts: wb[key].attempts + 1, correct: wb[key].correct + (correct ? 1 : 0) };
            const solvedDelta = correct ? 1 : 0;
            _state = {
                ..._state,
                // Lifetime totals
                attempts: _state.attempts + 1,
                correct:  _state.correct  + solvedDelta,
                solved:   _state.solved   + solvedDelta,
                weakBranches: wb,
                // Per-chat totals (|| 0 guards against NaN from old
                // localStorage snapshots that pre-date these fields)
                sessionAttempts:  (_state.sessionAttempts  || 0) + 1,
                sessionCorrect:   (_state.sessionCorrect   || 0) + solvedDelta,
                sessionSolved:    (_state.sessionSolved    || 0) + solvedDelta,
            };
            // Queue a cloud sync so the running totals catch up to the
            // authoritative DB value within ~1 second. Rapid-fire attempts
            // (e.g. quickly answering a 5-question test) coalesce into a
            // single RPC.
            PENDING_DELTA.attempts += 1;
            PENDING_DELTA.correct  += solvedDelta;
            PENDING_DELTA.solved   += solvedDelta;
            const bd = PENDING_DELTA.branchDeltas[key] || { attempts: 0, correct: 0 };
            PENDING_DELTA.branchDeltas[key] = {
                attempts: bd.attempts + 1,
                correct:  bd.correct  + solvedDelta,
            };
            // Per-chat delta
            _queueChatDelta({
                attemptsDelta: 1,
                correctDelta:  solvedDelta,
                solvedDelta:   solvedDelta,
                branch: key,
                phase: _state.phase,
            });
            _scheduleFlush();
            _emit();
        },

        recordHintUsed() {
            _state = {
                ..._state,
                hintsUsed:        (_state.hintsUsed        || 0) + 1,
                sessionHintsUsed: (_state.sessionHintsUsed || 0) + 1,
            };
            PENDING_DELTA.hintsUsed += 1;
            // Per-chat delta
            _queueChatDelta({ hintsDelta: 1 });
            _scheduleFlush();
            _emit();
        },

        setActiveQuiz(quiz) {
            _state = { ..._state, activeQuiz: quiz };
            _emit();
        },

        closeQuiz() {
            _state = { ..._state, activeQuiz: null, mode: null };
            _emit();
        },

        /** Weak branches: accuracy < 60% across ≥ 3 attempts. */
        deriveWeakBranches() {
            const out = [];
            for (const [branch, s] of Object.entries(_state.weakBranches || {})) {
                if (s.attempts >= 3 && s.correct / s.attempts < 0.60) out.push(branch);
            }
            return out;
        },

        /** Strong branches: accuracy ≥ 85% across ≥ 3 attempts. */
        deriveStrongBranches() {
            const out = [];
            for (const [branch, s] of Object.entries(_state.weakBranches || {})) {
                if (s.attempts >= 3 && s.correct / s.attempts >= 0.85) out.push(branch);
            }
            return out;
        },

        /** Reset everything (call on logout). Also clears every per-session
         *  snapshot so the next user doesn't inherit the previous user's
         *  stats when they sign in on the same device. The cloud row in
         *  Supabase is left intact so re-login restores everything. */
        reset() {
            const prevUserId = _state.userId;
            // Cancel any in-flight cloud sync so it doesn't write under
            // the wrong identity after a logout.
            if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
            _resetPendingDelta();
            // Also clear pending per-chat deltas
            for (const k of Object.keys(PENDING_CHAT_DELTAS)) delete PENDING_CHAT_DELTAS[k];

            _state = initialState();
            try {
                localStorage.removeItem(STORAGE_KEY);
                // Sweep per-session snapshots.
                const toRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && (
                        k.startsWith(SESSION_STORAGE_PREFIX) ||
                        // Wipe the ex-user's lifetime cache so a different
                        // account on the same browser starts at 0 until
                        // the cloud fetch resolves.
                        (prevUserId && k === LIFETIME_STORAGE_PREFIX + prevUserId)
                    )) toRemove.push(k);
                }
                toRemove.forEach(k => { try { localStorage.removeItem(k); } catch {} });
            } catch {}
            _emit();
        },
    };
})();


// ═════════════════════════════════════════════════════════════
// Quiz result persistence (Supabase: public.student_quiz_results)
// ═════════════════════════════════════════════════════════════
// Fire-and-forget save of every completed quiz so the student can
// review past attempts from the sidebar / dashboard. Requires the
// user to be authenticated — anonymous attempts are not saved.

/**
 * Persist a completed quiz result to Supabase.
 *
 * @param {object} opts
 * @param {'single'|'practice_test'|'panel'} opts.quizType
 * @param {string}  opts.branch
 * @param {string}  opts.difficulty
 * @param {number}  opts.totalQuestions
 * @param {number}  opts.correctCount
 * @param {number}  [opts.timeSpentMs]
 * @param {Array}   opts.questions  — raw question objects
 * @param {Array}   opts.results    — per-question { selectedId, is_correct, correct_option_id, explanation }
 */
function _saveQuizResult({ quizType, branch, difficulty, totalQuestions, correctCount, timeSpentMs, questions, results }) {
    const userId = studyAnalytics.state?.userId;
    if (!userId) return; // guest — skip

    const sessionId = studyAnalytics.state?.sessionId || null;
    const scorePct  = totalQuestions > 0
        ? Math.round((correctCount / totalQuestions) * 10000) / 100   // 2 decimal places
        : 0;

    // Build the compact questions payload for review
    const questionsJson = (questions || []).map((q, i) => {
        const r = results?.[i] || {};
        return {
            question:     q.question     || '',
            questionAr:   q.questionAr   || '',
            options:      (q.options || []).map(o => ({
                id:   o.id,
                text: o.text || o.textAr || '',
            })),
            selectedId:   r.selectedId           || null,
            correctId:    r.correct_option_id    || q.correctOptionId || null,
            isCorrect:    !!r.is_correct,
            explanation:  r.explanation           || q.explanation || '',
            hint:         q.hint                  || '',
        };
    });

    // Fire-and-forget RPC call
    supabase.rpc('save_quiz_result', {
        p_session_id:      sessionId,
        p_quiz_type:       quizType,
        p_branch:          branch || 'unknown',
        p_difficulty:      difficulty || 'medium',
        p_total_questions: totalQuestions || 1,
        p_correct_count:   correctCount  || 0,
        p_score_pct:       scorePct,
        p_time_spent_ms:   timeSpentMs   || null,
        p_questions_json:  questionsJson,
    }).then(({ error }) => {
        if (error) console.warn('[quiz] save_quiz_result failed:', error);
        else       console.log('[quiz] quiz result saved');
    }).catch(e => console.warn('[quiz] save_quiz_result threw:', e));
}

/**
 * Fetch the current user's quiz history from Supabase.
 * Returns an array of quiz result rows, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=20]          — max rows
 * @param {string} [opts.branch]            — filter by branch
 * @param {string} [opts.quizType]          — filter: 'single' | 'practice_test' | 'panel'
 * @returns {Promise<Array>}
 */
export async function fetchQuizHistory({ limit = 20, branch, quizType } = {}) {
    const userId = studyAnalytics.state?.userId;
    if (!userId) return [];

    let query = supabase
        .from('student_quiz_results')
        .select('id, quiz_type, branch, difficulty, total_questions, correct_count, score_pct, time_spent_ms, questions_json, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (branch)   query = query.eq('branch', branch);
    if (quizType) query = query.eq('quiz_type', quizType);

    const { data, error } = await query;
    if (error) {
        console.warn('[quiz] fetchQuizHistory failed:', error);
        return [];
    }
    return data || [];
}


// ═════════════════════════════════════════════════════════════
// Shared DOM helpers
// ═════════════════════════════════════════════════════════════

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls)  node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

function renderMath(html) {
    // The existing formatMessage renders markdown + KaTeX + code with
    // error-safe fallbacks. Reuse it so rendering stays consistent.
    return formatMessage(html);
}

/**
 * Append the card into the chat transcript the same way `addMessage`
 * does — as a new full-width message bubble. If called from outside
 * a transcript context (e.g. tests), falls back to document.body.
 */
function appendToTranscript(cardEl) {
    const wrapper = document.getElementById('chat-messages') || document.body;
    // Wrap in a message bubble so it inherits the existing message styles.
    const msg = el('div', 'message ai-message quiz-message');
    const content = el('div', 'message-content');
    content.appendChild(cardEl);
    msg.appendChild(content);
    wrapper.appendChild(msg);
    const scrollWrap = document.getElementById('study-chat-messages-wrapper');
    if (scrollWrap) scrollWrap.scrollTop = scrollWrap.scrollHeight;
    return msg;
}

function chipRow(items, { onPick, selectedValue, lang }) {
    const row = el('div', 'quiz-chip-row');
    items.forEach((it) => {
        const b = el('button', 'quiz-chip');
        b.type = 'button';
        b.textContent = it.label;
        b.dataset.value = it.value;
        if (it.value === selectedValue) b.classList.add('active');
        b.addEventListener('click', () => {
            row.querySelectorAll('.quiz-chip').forEach(c => c.classList.remove('active'));
            b.classList.add('active');
            onPick(it.value);
        });
        row.appendChild(b);
    });
    return row;
}


// ═════════════════════════════════════════════════════════════
// Branch + difficulty opener (dropdown card)
// ═════════════════════════════════════════════════════════════

/**
 * Show a small inline dialog above/near the trigger asking for branch
 * and difficulty. When confirmed, calls onStart({ branch, difficulty }).
 */
export function openBranchDiffMenu({ trigger, kind, onStart }) {
    const lang = detectLang();
    const S    = t(lang);

    // Remove any existing open menu (only one at a time).
    document.querySelectorAll('.quiz-opener-menu').forEach(n => n.remove());

    const menu = el('div', 'quiz-opener-menu');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-modal', 'false');
    menu.dataset.kind = kind;
    if (lang === 'ar') menu.setAttribute('dir', 'rtl');

    const title = el('div', 'quiz-opener-title',
        kind === 'single' ? S.createQuestion : S.createTest);
    menu.appendChild(title);

    let chosenBranch = 'algebra';
    let chosenDiff   = 'medium';

    const branchLabel = el('div', 'quiz-opener-label', S.pickBranch);
    menu.appendChild(branchLabel);
    menu.appendChild(chipRow([
        { value: 'algebra',      label: S.algebra },
        { value: 'calculus',     label: S.calculus },
        { value: 'trigonometry', label: S.trigonometry },
    ], {
        onPick: (v) => { chosenBranch = v; },
        selectedValue: chosenBranch,
        lang,
    }));

    // Always show the difficulty step — Single MCQ and Practice Test both
    // let the student pick how hard the question(s) should be. (Previously
    // single skipped this and defaulted to 'medium'; user feedback asked
    // for an explicit choice on Create Practice Question too.)
    const diffLabel = el('div', 'quiz-opener-label', S.pickDifficulty);
    menu.appendChild(diffLabel);
    menu.appendChild(chipRow([
        { value: 'easy',   label: S.easy },
        { value: 'medium', label: S.medium },
        { value: 'hard',   label: S.hard },
    ], {
        onPick: (v) => { chosenDiff = v; },
        selectedValue: chosenDiff,
        lang,
    }));

    const actions = el('div', 'quiz-opener-actions');
    const cancel  = el('button', 'quiz-btn quiz-btn-ghost', S.cancel);
    cancel.type   = 'button';
    const start   = el('button', 'quiz-btn quiz-btn-primary', S.start);
    start.type    = 'button';
    actions.appendChild(cancel);
    actions.appendChild(start);
    menu.appendChild(actions);

    // Portal the popup directly onto <body> with position:fixed so it's
    // immune to ancestor stacking contexts. Previously the popup lived
    // INSIDE the trigger pill — that pill sits in the same parent as
    // the chat input, and the input's children (mode dropdown, send
    // button, mathfield, etc.) live in their own stacking contexts which
    // sometimes painted on top of the menu no matter how high we set its
    // z-index. Fixed-position + body-anchored = guaranteed top layer.
    menu.classList.add('quiz-opener-menu--portal');
    document.body.appendChild(menu);
    positionOpenerMenu(menu, trigger);

    // Reposition on resize / scroll so the popup stays glued to the pill.
    const reposition = () => positionOpenerMenu(menu, trigger);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    function teardown() {
        try { window.removeEventListener('resize', reposition); } catch (_) {}
        try { window.removeEventListener('scroll', reposition, true); } catch (_) {}
        menu.remove();
    }

    cancel.addEventListener('click', teardown);
    start.addEventListener('click', () => {
        teardown();
        onStart({ branch: chosenBranch, difficulty: chosenDiff });
    });

    // Close on outside click.
    setTimeout(() => {
        const off = (e) => {
            if (!menu.contains(e.target) && e.target !== trigger) {
                document.removeEventListener('click', off, true);
                teardown();
            }
        };
        document.addEventListener('click', off, true);
    }, 0);
}

/**
 * Place a portalled `.quiz-opener-menu--portal` element directly below the
 * trigger button, flipping above when there's not enough room. The menu
 * uses `position: fixed`, so coordinates are in viewport space.
 */
function positionOpenerMenu(menu, trigger) {
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    // Measure after a render so the menu has its natural size.
    const mw = menu.offsetWidth  || 320;
    const mh = menu.offsetHeight || 280;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: directly below the trigger, left-aligned with it.
    let top  = rect.bottom + gap;
    let left = rect.left;

    // Flip above the trigger if the menu would overflow the viewport.
    if (top + mh > vh - 8 && rect.top - gap - mh > 8) {
        top = rect.top - gap - mh;
    }
    // Clamp horizontally so the popup never falls off-screen.
    if (left + mw > vw - 8) left = vw - mw - 8;
    if (left < 8) left = 8;

    menu.style.top  = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
}


// ═════════════════════════════════════════════════════════════
// Shimmer placeholder while generating
// ═════════════════════════════════════════════════════════════

function renderShimmerCard(lang) {
    const S = t(lang);
    const card = el('div', 'quiz-card quiz-shimmer');
    card.setAttribute('aria-live', 'polite');
    card.appendChild(el('div', 'quiz-shimmer-avatar'));
    const body = el('div', 'quiz-shimmer-body');
    body.appendChild(el('div', 'quiz-shimmer-line quiz-shimmer-line-lg'));
    for (let i = 0; i < 4; i++) body.appendChild(el('div', 'quiz-shimmer-option'));
    card.appendChild(body);
    const hint = el('div', 'quiz-shimmer-hint', S.generating);
    card.appendChild(hint);
    return card;
}


// ═════════════════════════════════════════════════════════════
// Single MCQ card renderer
// ═════════════════════════════════════════════════════════════

/**
 * Render a single-question MCQ card into the given container.
 * Returns { element, api } where api exposes close() / destroy().
 */
function renderMCQCard(container, question, { lang, onChecked, mode = 'single', testContext = null }) {
    const S = t(lang);
    container.innerHTML = '';
    const card = el('div', 'quiz-card');
    if (lang === 'ar') card.setAttribute('dir', 'rtl');

    // Header: avatar + question
    const header = el('div', 'quiz-card-header');
    const avatar = el('div', 'quiz-avatar');
    avatar.innerHTML = '<span class="quiz-avatar-glyph" aria-hidden="true">√</span>';
    header.appendChild(avatar);
    const qText = el('div', 'quiz-question');
    qText.innerHTML = renderMath(lang === 'ar' && question.questionAr ? question.questionAr : question.question);
    header.appendChild(qText);
    card.appendChild(header);

    // Options (ARIA radio group)
    const opts = el('div', 'quiz-options');
    opts.setAttribute('role', 'radiogroup');
    opts.setAttribute('aria-label', lang === 'ar' ? question.questionAr || question.question : question.question);
    let selectedId = null;
    let checked    = false;

    const optionRows = question.options.map((opt, idx) => {
        const row = el('button', 'quiz-option');
        row.type = 'button';
        row.setAttribute('role', 'radio');
        row.setAttribute('aria-checked', 'false');
        row.dataset.optionId = opt.id;

        const letter = el('span', 'quiz-option-letter', optionLetter(idx, lang));
        const radio  = el('span', 'quiz-option-radio');
        const lbl    = el('span', 'quiz-option-label');
        lbl.innerHTML = renderMath(opt.label);

        row.appendChild(radio);
        row.appendChild(letter);
        row.appendChild(lbl);

        row.addEventListener('click', () => {
            if (checked) return;
            selectedId = opt.id;
            optionRows.forEach(r => {
                r.classList.toggle('selected', r.dataset.optionId === selectedId);
                r.setAttribute('aria-checked', r.dataset.optionId === selectedId ? 'true' : 'false');
            });
            checkBtn.disabled = false;
        });

        row.addEventListener('keydown', (e) => {
            if (checked) return;
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                row.click();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                e.preventDefault();
                const next = optionRows[(idx + 1) % optionRows.length];
                next.focus();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const prev = optionRows[(idx - 1 + optionRows.length) % optionRows.length];
                prev.focus();
            }
        });

        opts.appendChild(row);
        return row;
    });
    card.appendChild(opts);

    // Footer: Check + Show Steps
    const footer = el('div', 'quiz-card-footer');
    const checkBtn = el('button', 'quiz-btn quiz-btn-primary', S.check);
    checkBtn.type = 'button';
    checkBtn.disabled = true;
    const stepsLink  = el('button', 'quiz-link-btn', S.showSteps);
    stepsLink.type   = 'button';
    stepsLink.setAttribute('aria-expanded', 'false');
    footer.appendChild(checkBtn);
    footer.appendChild(stepsLink);
    card.appendChild(footer);

    // Live region for SR announcements
    const live = el('div', 'quiz-sr-live');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    card.appendChild(live);

    // Explanation panel (hidden by default, expandable via Show Steps)
    const explain = el('div', 'quiz-explanation');
    explain.hidden = true;
    const explainBody = el('div', 'quiz-explanation-body');
    explainBody.innerHTML = renderMath(
        (lang === 'ar' && question.explanationAr) ? question.explanationAr : question.explanation
    );
    explain.appendChild(el('div', 'quiz-explanation-title', S.explanation));
    explain.appendChild(explainBody);
    card.appendChild(explain);

    stepsLink.addEventListener('click', () => {
        const open = !explain.hidden;
        explain.hidden = open;
        stepsLink.setAttribute('aria-expanded', open ? 'false' : 'true');
        stepsLink.textContent = open ? S.showSteps : S.hideSteps;
    });

    // Enter on the card triggers Check when an option is selected
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !checked && !checkBtn.disabled) {
            e.preventDefault();
            checkBtn.click();
        }
    });

    function applyResult(selected, correct, feedbackText, explanationText) {
        checked = true;
        optionRows.forEach(r => {
            const id = r.dataset.optionId;
            if (id === correct) r.classList.add('correct');
            if (id === selected && selected !== correct) r.classList.add('incorrect');
            r.setAttribute('aria-disabled', 'true');
            r.disabled = true;
        });
        live.textContent = feedbackText;
        // Populate the explanation now that the backend has returned one.
        // The mock path passes the bank-baked explanation through unchanged.
        if (explanationText) {
            explainBody.innerHTML = renderMath(explanationText);
        }
        // Replace Check with "Next question" or "Try another".
        checkBtn.remove();
        const nextLabel = mode === 'test' ? S.nextQuestion : S.tryAnother;
        const nextBtn   = el('button', 'quiz-btn quiz-btn-primary', nextLabel);
        nextBtn.type    = 'button';
        nextBtn.addEventListener('click', () => {
            if (onChecked && onChecked.onNext) onChecked.onNext();
        });
        footer.insertBefore(nextBtn, stepsLink);
        // Auto-expand explanation on a wrong answer (matches Khan behavior).
        if (selected !== correct) {
            explain.hidden = false;
            stepsLink.setAttribute('aria-expanded', 'true');
            stepsLink.textContent = S.hideSteps;
        }
    }

    checkBtn.addEventListener('click', async () => {
        if (!selectedId || checked) return;
        // Disable while in-flight so a frantic double-click can't fire twice.
        checkBtn.disabled = true;
        const prevLabel   = checkBtn.textContent;
        checkBtn.textContent = '…';
        let result;
        try {
            result = await checkAnswer(testContext, question, selectedId, lang);
        } finally {
            checkBtn.textContent = prevLabel;
        }
        const feedback = result.is_correct ? S.correct : S.tryAgain;
        applyResult(selectedId, result.correct_option_id, feedback, result.explanation);
        studyAnalytics.recordAttempt({
            branch:  testContext?.branch || question.branch || 'unknown',
            correct: result.is_correct,
        });
        if (onChecked && onChecked.onResult) onChecked.onResult(result);
    });

    // --- STEP-BY-STEP SOLUTION UI ---
    if (question.steps && Array.isArray(question.steps)) {
        const stepsContainer = el('div', 'qp-steps-panel');
        stepsContainer.hidden = true;
        
        question.steps.forEach(step => {
            const stepEl = el('div', 'qp-step-item');
            stepEl.innerHTML = `
                <div class="qp-step-title">${step.title}</div>
                <div class="qp-step-explanation">${step.explanation}</div>
                <div class="qp-step-formula">${renderMath(step.formula)}</div>
            `;
            stepsContainer.appendChild(stepEl);
        });

        const toggleBtn = el('button', 'qp-step-btn');
        toggleBtn.innerHTML = '<span class="material-symbols-outlined">visibility</span> Show Step-by-Step Solution';
        
        toggleBtn.addEventListener('click', () => {
            const isHidden = stepsContainer.hidden;
            stepsContainer.hidden = !isHidden;
            toggleBtn.innerHTML = isHidden 
                ? '<span class="material-symbols-outlined">visibility_off</span> Hide Step-by-Step Solution'
                : '<span class="material-symbols-outlined">visibility</span> Show Step-by-Step Solution';
        });

        card.appendChild(toggleBtn);
        card.appendChild(stepsContainer);
    }

    container.appendChild(card);

    return {
        element: card,
        focusFirst: () => { if (optionRows[0]) optionRows[0].focus(); },
        destroy: () => { container.innerHTML = ''; },
    };
}


// ═════════════════════════════════════════════════════════════
// Public: Single MCQ (opened from the "Create Practice Question" button)
// ═════════════════════════════════════════════════════════════

export async function openSingleQuiz({ branch = 'algebra', difficulty = 'medium' } = {}) {
    const lang = detectLang();
    const S    = t(lang);

    // Insert shimmer placeholder first so the user sees the loading state.
    const shimmer = renderShimmerCard(lang);
    const msg     = appendToTranscript(shimmer);

    // Real backend first; loadTest() falls back to the mock bank if /generate
    // is unreachable. If even the mock throws (e.g. unknown branch) we render
    // a retry card.
    let test;
    try {
        test = await loadTest(branch, difficulty, 1);
    } catch (e) {
        console.warn('[quiz] single generation failed', e);
        shimmer.replaceWith(renderRetryCard(lang, () => openSingleQuiz({ branch, difficulty })));
        return;
    }
    const q = test.questions[0];
    q.branch = test.branch;

    const container = msg.querySelector('.message-content');
    container.innerHTML = '';

    let liveCard = null;
    const rerender = () => {
        liveCard = renderMCQCard(container, q, {
            lang,
            mode: 'single',
            testContext: {
                branch:  test.branch,
                test_id: test.test_id,
                source:  test.source || 'mock',
            },
            onChecked: {
                onNext: () => {
                    // "Try another" re-rolls from the bank with same params.
                    openSingleQuiz({ branch, difficulty });
                },
                onResult: (result) => {
                    // Save single MCQ result to Supabase for review
                    _saveQuizResult({
                        quizType:       'single',
                        branch:         test.branch || branch,
                        difficulty:     test.difficulty || difficulty,
                        totalQuestions: 1,
                        correctCount:   result.is_correct ? 1 : 0,
                        questions:      [q],
                        results:        [result],
                    });
                },
            },
        });
        // Focus the first option so keyboard users land on the radio group.
        queueMicrotask(() => liveCard.focusFirst());
    };
    rerender();

    studyAnalytics.setActiveQuiz({ kind: 'single', branch, difficulty });
}


// ═════════════════════════════════════════════════════════════
// Public: Practice Test (opened from "Create Practice Test")
// ═════════════════════════════════════════════════════════════

export async function openPracticeTest({ branch = 'algebra', difficulty = 'medium', count = 5 } = {}) {
    const lang = detectLang();
    const S    = t(lang);

    const shimmer = renderShimmerCard(lang);
    const msg     = appendToTranscript(shimmer);

    // Real backend first; mock-bank fallback on failure.
    let test;
    try {
        test = await loadTest(branch, difficulty, count);
    } catch (e) {
        console.warn('[quiz] test generation failed', e);
        shimmer.replaceWith(renderRetryCard(lang, () => openPracticeTest({ branch, difficulty, count })));
        return;
    }

    // Test state
    const state = {
        index:        0,
        answers:      new Array(test.questions.length).fill(null),
        checked:      new Array(test.questions.length).fill(false),
        results:      new Array(test.questions.length).fill(null),
        submitted:    false,
    };

    const container = msg.querySelector('.message-content');
    container.innerHTML = '';

    const card = el('div', 'quiz-card quiz-test-card');
    if (lang === 'ar') card.setAttribute('dir', 'rtl');
    container.appendChild(card);

    // Header row: title + expand + close
    const topbar = el('div', 'quiz-test-topbar');
    const title  = el('div', 'quiz-test-title', S.practiceTestOn(test.branch));
    const spacer = el('div', 'quiz-test-spacer');
    const expandBtn = el('button', 'quiz-icon-btn', '');
    expandBtn.type  = 'button';
    expandBtn.setAttribute('aria-label', S.close);
    expandBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">open_in_full</span>';
    const closeBtn  = el('button', 'quiz-icon-btn', '');
    closeBtn.type   = 'button';
    closeBtn.setAttribute('aria-label', S.close);
    closeBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">close</span>';
    topbar.appendChild(title);
    topbar.appendChild(spacer);
    topbar.appendChild(expandBtn);
    topbar.appendChild(closeBtn);
    card.appendChild(topbar);

    // Subtitle + segmented progress + score line
    const subtitle = el('div', 'quiz-test-subtitle', S.letsStart);
    card.appendChild(subtitle);

    const progressBar = el('div', 'quiz-test-progress');
    progressBar.setAttribute('role', 'progressbar');
    progressBar.setAttribute('aria-valuemin', '0');
    progressBar.setAttribute('aria-valuemax', String(test.questions.length));
    const segments = test.questions.map((_, i) => {
        const seg = el('div', 'quiz-test-segment');
        seg.dataset.index = String(i);
        return seg;
    });
    segments.forEach(s => progressBar.appendChild(s));
    card.appendChild(progressBar);

    const scoreLine = el('div', 'quiz-test-score');
    card.appendChild(scoreLine);

    // Navigation row
    const nav = el('div', 'quiz-test-nav');
    const prevBtn = el('button', 'quiz-icon-btn', '');
    prevBtn.type  = 'button';
    prevBtn.setAttribute('aria-label', S.prev);
    prevBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">chevron_left</span>';
    const navLabel = el('div', 'quiz-test-nav-label', '');
    const nextBtn  = el('button', 'quiz-icon-btn', '');
    nextBtn.type   = 'button';
    nextBtn.setAttribute('aria-label', S.next);
    nextBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">chevron_right</span>';
    nav.appendChild(prevBtn);
    nav.appendChild(navLabel);
    nav.appendChild(nextBtn);
    card.appendChild(nav);

    // Question body
    const body = el('div', 'quiz-test-body');
    card.appendChild(body);

    function currentQ() { return test.questions[state.index]; }
    function pointsEarned() {
        return state.results.reduce((sum, r) => sum + (r ? (r.points_awarded || 0) : 0), 0);
    }
    function pointsAttempted() {
        return state.checked.filter(Boolean).length;
    }

    function renderProgress() {
        segments.forEach((seg, i) => {
            seg.classList.toggle('done', state.checked[i]);
            seg.classList.toggle('correct', state.checked[i] && state.results[i]?.is_correct);
            seg.classList.toggle('wrong', state.checked[i] && state.results[i] && !state.results[i].is_correct);
            seg.classList.toggle('current', i === state.index && !state.submitted);
        });
        progressBar.setAttribute('aria-valuenow', String(pointsAttempted()));
        scoreLine.innerHTML = boldNumbers(S.scoreLine(pointsEarned(), pointsAttempted()));
        subtitle.textContent = progressBlurb(pointsAttempted(), test.questions.length, S, state.submitted);
        // Mode label in sidebar
        studyAnalytics.setMode(S.phaseTest(state.index + 1, test.questions.length));
    }

    function renderNav() {
        prevBtn.disabled = state.index === 0 || state.submitted;
        navLabel.textContent = S.questionN(state.index + 1);
        const last = state.index === test.questions.length - 1;
        if (last && !state.submitted) {
            // Replace next button with Submit when on last question
            nextBtn.disabled = !state.checked[state.index];
            nextBtn.classList.add('quiz-nav-submit');
            nextBtn.innerHTML = `<span class="quiz-submit-label">${S.submitTest}</span>`;
        } else {
            nextBtn.classList.remove('quiz-nav-submit');
            nextBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">chevron_right</span>';
            nextBtn.disabled = !state.checked[state.index] || state.submitted;
        }
    }

    function renderQuestion() {
        body.innerHTML = '';
        // Side rail with thumbs (client-side analytics only for now)
        const rail = el('div', 'quiz-test-rail');
        const up   = el('button', 'quiz-rail-btn', '');
        up.type    = 'button';
        up.setAttribute('aria-label', 'thumbs up');
        up.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">thumb_up</span>';
        const down = el('button', 'quiz-rail-btn', '');
        down.type  = 'button';
        down.setAttribute('aria-label', 'thumbs down');
        down.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">thumb_down</span>';
        up.addEventListener('click', () => {
            up.classList.toggle('active');
            down.classList.remove('active');
            // TODO: wire to analytics
        });
        down.addEventListener('click', () => {
            down.classList.toggle('active');
            up.classList.remove('active');
        });
        rail.appendChild(up);
        rail.appendChild(down);

        const qContainer = el('div', 'quiz-test-q-container');
        body.appendChild(rail);
        body.appendChild(qContainer);

        const q = currentQ();
        renderMCQCard(qContainer, q, {
            lang,
            mode: 'test',
            testContext: {
                branch:  test.branch,
                test_id: test.test_id,
                source:  test.source || 'mock',
            },
            onChecked: {
                onResult: (result) => {
                    state.checked[state.index] = true;
                    state.results[state.index] = result;
                    renderProgress();
                    renderNav();
                },
                onNext: () => {
                    if (state.index < test.questions.length - 1) {
                        state.index++;
                        renderQuestion();
                        renderProgress();
                        renderNav();
                    } else {
                        submit();
                    }
                },
            },
        });
    }

    function submit() {
        state.submitted = true;
        studyAnalytics.setMode(null);
        const total = test.questions.length;
        const score = pointsEarned();

        // Save practice test result to Supabase for review
        _saveQuizResult({
            quizType:       'practice_test',
            branch:         branch,
            difficulty:     difficulty,
            totalQuestions: total,
            correctCount:   score,
            questions:      test.questions,
            results:        state.results,
        });

        body.innerHTML = '';
        nav.remove();
        const summary = el('div', 'quiz-test-summary');

        const bigScore = el('div', 'quiz-test-big-score', `${score} / ${total}`);
        const emoji    = score >= Math.ceil(total * 0.8) ? '🎉' :
                         score >= Math.ceil(total * 0.5) ? '💪' : '📚';
        const line     = el('div', 'quiz-test-summary-line');
        line.textContent = (score >= Math.ceil(total * 0.8) ? S.greatStart : S.keepPracticing) + ' ' + emoji;

        summary.appendChild(bigScore);
        summary.appendChild(line);

        // Per-question list (expandable)
        const list = el('div', 'quiz-test-summary-list');
        test.questions.forEach((q, i) => {
            const r = state.results[i];
            const item = el('details', 'quiz-test-summary-item');
            if (r && r.is_correct) item.classList.add('correct');
            else item.classList.add('wrong');

            const sum = el('summary', 'quiz-test-summary-row');
            const icon = el('span', 'quiz-test-summary-icon', r?.is_correct ? '✓' : '✗');
            const lbl  = el('span', 'quiz-test-summary-rowlabel', `${S.questionN(i + 1)}`);
            sum.appendChild(icon);
            sum.appendChild(lbl);
            item.appendChild(sum);

            const expand = el('div', 'quiz-test-summary-expand');
            const qHtml  = renderMath(lang === 'ar' && q.questionAr ? q.questionAr : q.question);
            expand.insertAdjacentHTML('beforeend', `<div class="quiz-test-summary-q">${qHtml}</div>`);
            // /check returns `correct_option_id` + `explanation` — use those
            // when present so server-source tests (which strip those fields
            // upfront) still render the answer key in the summary.
            const correctOptId = r?.correct_option_id || q.correctOptionId;
            const yourOpt     = q.options.find(o => o.id === state.answers[i]);
            const correctOpt  = q.options.find(o => o.id === correctOptId);
            expand.insertAdjacentHTML('beforeend',
                `<div class="quiz-test-summary-ans"><strong>${S.yourAnswer}:</strong> ${yourOpt ? renderMath(yourOpt.label) : '—'}</div>`);
            if (!r?.is_correct && correctOpt) {
                expand.insertAdjacentHTML('beforeend',
                    `<div class="quiz-test-summary-ans"><strong>${S.correctAnswer}:</strong> ${renderMath(correctOpt.label)}</div>`);
            }
            const explanationText = r?.explanation
                || (lang === 'ar' && q.explanationAr ? q.explanationAr : q.explanation)
                || '';
            if (explanationText) {
                expand.insertAdjacentHTML('beforeend',
                    `<div class="quiz-test-summary-explain"><strong>${S.explanation}:</strong> ${renderMath(explanationText)}</div>`);
            }
            item.appendChild(expand);
            list.appendChild(item);
        });
        summary.appendChild(list);

        // Bottom buttons: Try again / New test
        const actions = el('div', 'quiz-test-summary-actions');
        const again = el('button', 'quiz-btn quiz-btn-ghost', S.tryAgainBtn);
        again.type  = 'button';
        again.addEventListener('click', () => {
            openPracticeTest({ branch, difficulty, count });
        });
        const fresh = el('button', 'quiz-btn quiz-btn-primary', S.newTest);
        fresh.type  = 'button';
        fresh.addEventListener('click', () => {
            openBranchDiffMenu({
                trigger: fresh,
                kind: 'test',
                onStart: ({ branch: b, difficulty: d }) =>
                    openPracticeTest({ branch: b, difficulty: d, count }),
            });
        });
        actions.appendChild(again);
        actions.appendChild(fresh);
        summary.appendChild(actions);

        body.appendChild(summary);
    }

    // Populate answer index from selected option whenever user clicks an option.
    // (renderMCQCard doesn't expose a direct hook — we piggyback on the
    // `data-option-id` value from the DOM when the user clicks Check.)
    body.addEventListener('click', (e) => {
        const opt = e.target.closest('.quiz-option');
        if (!opt) return;
        state.answers[state.index] = opt.dataset.optionId;
    });

    prevBtn.addEventListener('click', () => {
        if (state.index > 0) {
            state.index--;
            renderQuestion();
            renderProgress();
            renderNav();
        }
    });
    nextBtn.addEventListener('click', () => {
        const last = state.index === test.questions.length - 1;
        if (last && state.checked[state.index]) {
            submit();
        } else if (!last && state.checked[state.index]) {
            state.index++;
            renderQuestion();
            renderProgress();
            renderNav();
        }
    });

    closeBtn.addEventListener('click', () => {
        if (state.submitted || state.checked.every(c => !c)) {
            msg.remove();
            studyAnalytics.closeQuiz();
            return;
        }
        // eslint-disable-next-line no-alert
        if (confirm(S.confirmLoseProgress)) {
            msg.remove();
            studyAnalytics.closeQuiz();
        }
    });
    expandBtn.addEventListener('click', () => {
        card.classList.toggle('quiz-test-expanded');
    });

    studyAnalytics.setActiveQuiz({ kind: 'test', branch, difficulty, total: test.questions.length });

    renderQuestion();
    renderProgress();
    renderNav();
}


// ═════════════════════════════════════════════════════════════
// Retry card (on generation failure)
// ═════════════════════════════════════════════════════════════

function renderRetryCard(lang, onRetry) {
    const S = t(lang);
    const card = el('div', 'quiz-card quiz-card-error');
    if (lang === 'ar') card.setAttribute('dir', 'rtl');
    const body = el('div', 'quiz-card-error-body', S.generationFailed);
    card.appendChild(body);
    const btn = el('button', 'quiz-btn quiz-btn-primary', S.retry);
    btn.type  = 'button';
    btn.addEventListener('click', () => { card.remove(); onRetry(); });
    card.appendChild(btn);
    return card;
}


// ═════════════════════════════════════════════════════════════
// Utilities for the score line / subtitle blurbs
// ═════════════════════════════════════════════════════════════

function progressBlurb(attempted, total, S, submitted) {
    if (submitted) return S.finished;
    if (attempted === 0) return S.letsStart;
    const pct = attempted / total;
    if (pct >= 0.75) return S.almostDone;
    if (pct >= 0.5)  return S.halfway;
    return S.letsStart;
}

function boldNumbers(text) {
    // Wrap integer runs in <strong> so "You have earned 3 out of 5 points"
    // bolds the numbers — matches the visual spec. Escape other content.
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[c]);
    const parts = [];
    let last = 0;
    const re = /\d+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push(esc(text.slice(last, m.index)));
        parts.push(`<strong>${m[0]}</strong>`);
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(esc(text.slice(last)));
    return parts.join('');
}


// ═════════════════════════════════════════════════════════════
// Sidebar: Session Analytics renderer
// ═════════════════════════════════════════════════════════════

/**
 * Render (or update) the Session Analytics section inside the given
 * container element. Subscribes to studyAnalytics so it stays live.
 * Returns an unsubscribe function.
 */
export function mountSessionAnalytics(container) {
    if (!container) return () => {};
    const lang = detectLang();
    const S    = t(lang);

    container.innerHTML = `
        <div class="srs-section-header">
            <span class="material-symbols-outlined srs-icon">analytics</span>
            <h3>${S.sessionAnalytics}</h3>
        </div>
        <div class="srs-analytics-mode srs-stat srs-stat-featured">
            <span class="srs-stat-label">${S.mode}</span>
            <span class="srs-stat-value" id="srs-an-mode">—</span>
        </div>
        <div class="srs-analytics-grid">
            <div class="srs-stat"><span class="srs-stat-label">${S.solved}</span>   <span class="srs-stat-value" id="srs-an-solved">0</span></div>
            <div class="srs-stat"><span class="srs-stat-label">${S.accuracy}</span> <span class="srs-stat-value" id="srs-an-accuracy">—</span></div>
            <div class="srs-stat"><span class="srs-stat-label">${S.hints}</span>    <span class="srs-stat-value" id="srs-an-hints">0</span></div>
            <div class="srs-stat"><span class="srs-stat-label">${S.time}</span>     <span class="srs-stat-value" id="srs-an-time">—</span></div>
        </div>
        <div class="srs-analytics-topics">
            <div class="srs-topic-title">${S.weakTopics}</div>
            <div class="srs-topic-list" id="srs-an-weak"></div>
            <div class="srs-topic-divider" aria-hidden="true"></div>
            <div class="srs-topic-title">${S.strongTopics} <span class="srs-topic-hint">${S.clientDerived}</span></div>
            <div class="srs-topic-list" id="srs-an-strong"></div>
        </div>
        <button type="button" class="srs-end-session-btn" id="srs-end-session-btn"
                title="${S.endSessionHint}">
            <span class="material-symbols-outlined" aria-hidden="true">stop_circle</span>
            <span class="srs-end-session-label">${S.endSession}</span>
        </button>
    `;

    // Wire the End Session button to the existing handler that the inline
    // action-bar already uses (window.handleEndSession is set by study-mode.js
    // at module-load time). We don't import it directly because lib/quiz.js
    // must stay free of study-mode.js's auth / chat state to keep the
    // analytics widget independently testable.
    const endBtn = container.querySelector('#srs-end-session-btn');
    if (endBtn) {
        endBtn.addEventListener('click', () => {
            // Disable while a request is in flight so quick double-clicks
            // don't queue up two summary messages.
            if (endBtn.dataset.busy === '1') return;
            const fn = typeof window !== 'undefined' && typeof window.handleEndSession === 'function'
                ? window.handleEndSession
                : null;
            if (!fn) return;
            endBtn.dataset.busy = '1';
            endBtn.classList.add('is-busy');
            try { fn(); } catch (e) { console.warn('[analytics] end-session failed', e); }
            // Re-enable shortly after — handleEndSession's own state.isStreaming
            // guard prevents the actual double-submit anyway.
            setTimeout(() => { endBtn.dataset.busy = ''; endBtn.classList.remove('is-busy'); }, 1200);
        });
    }

    function phaseLabel(state) {
        if (state.mode) return state.mode;
        switch (state.phase) {
            case 'explain':  return S.phaseExplain;
            case 'socratic': return S.phaseSocratic;
            case 'check':    return S.phaseCheck;
            case 'practice': return S.phasePractice;
            case 'summary':  return S.phaseSummary;
            default:         return '—';
        }
    }

    function fmtDuration(ms) {
        if (!ms) return '—';
        const total = Math.floor(ms / 1000);
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}m ${s}s`;
    }

    const $ = (id) => container.querySelector(id);

    function render(state) {
        $('#srs-an-mode').textContent   = phaseLabel(state);
        // Solved / Accuracy / Hints are PER-CHAT totals — scoped to the
        // active session_id so each chat shows its own numbers. Lifetime
        // totals are still synced to Supabase (student_stats) but the
        // sidebar widget displays the current chat's progress.
        $('#srs-an-solved').textContent = String(state.sessionSolved || 0);
        const att = state.sessionAttempts || 0;
        const cor = state.sessionCorrect  || 0;
        const acc = att > 0 ? Math.round((cor / att) * 100) : null;
        $('#srs-an-accuracy').textContent = acc == null ? '—' : `${acc}%`;
        $('#srs-an-hints').textContent  = String(state.sessionHintsUsed || 0);
        // If the session was ended, freeze the elapsed time at the snapshot
        // taken in endSession() instead of continuing to tick from "now".
        const elapsedTo = state.sessionEndedAt || Date.now();
        $('#srs-an-time').textContent   = state.sessionStartedAt ? fmtDuration(elapsedTo - state.sessionStartedAt) : '—';

        const weak   = studyAnalytics.deriveWeakBranches();
        const strong = studyAnalytics.deriveStrongBranches();
        $('#srs-an-weak').innerHTML   = weak.length
            ? weak.map(b => `<span class="srs-topic-chip weak">${escHtml(capitalize(b))}</span>`).join('')
            : `<span class="srs-topic-empty">${S.noWeakTopics}</span>`;
        $('#srs-an-strong').innerHTML = strong.length
            ? strong.map(b => `<span class="srs-topic-chip strong">${escHtml(capitalize(b))}</span>`).join('')
            : `<span class="srs-topic-empty">${S.noStrongTopics}</span>`;
    }

    // Tick for "time since start" display.
    const tick = setInterval(() => render(studyAnalytics.state), 1000);
    const unsub = studyAnalytics.subscribe(render);
    return () => { clearInterval(tick); unsub(); };
}

function escHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[c]);
}


// ═════════════════════════════════════════════════════════════
// QUIZ SESSION PANEL  (right-sidebar copilot mode)
// ═════════════════════════════════════════════════════════════
//
// Replaces the inline-chat-card flow when the user clicks the new
// "Quiz Mode" pill or the hero "Create Practice Question/Test" buttons.
//
// Mounts inside `#srs-quiz-panel` (which lives at the END of
// `<aside id="study-right-sidebar">`). The default sidebar wrapper
// `#srs-default-content` is hidden via the `quiz-active` class on the
// sidebar, so the timer / notes / tasks state survive in the DOM.
//
// State machine (kept inside one closure so a panel reopen always
// starts from a clean slate):
//
//   loading → active → submitted → (next) → active … → completed
//                                ↘ exit
//
// The panel inherits the active study branch when called from the
// per-AI-message "Quiz Mode" button, and gradually scales the next
// question's difficulty based on rolling accuracy (adaptive mode).

const PANEL_ID            = 'srs-quiz-panel';
const SIDEBAR_ID          = 'study-right-sidebar';
const QUIZ_ACTIVE_CLASS   = 'quiz-active';

let _activePanelDestroy = null;

/**
 * Open the quiz session panel inside the right sidebar.
 *
 * @param {object} options
 * @param {string} [options.branch='algebra']       Initial branch (e.g. 'calculus')
 * @param {string} [options.difficulty='medium']    Initial difficulty
 * @param {number} [options.count=5]                Total questions in the session
 * @param {string} [options.contextHint]            Free-text hint shown above the
 *                                                   question (e.g. "Calculus · Chain Rule")
 * @param {string} [options.sourceQuestion]         Active study question/context used
 *                                                   to keep MCQs on the same concept
 * @param {boolean}[options.adaptive=true]          Adjust difficulty after every 2 questions
 *                                                   based on rolling accuracy
 */
export async function openQuizPanel(options = {}) {
    const {
        branch       = 'algebra',
        difficulty   = 'medium',
        count        = 5,
        contextHint  = '',
        sourceQuestion = '',
        adaptive     = true,
    } = options;

    const panel   = document.getElementById(PANEL_ID);
    if (!panel) {
        console.warn('[quiz] panel slot not found in DOM');
        return;
    }

    // Tear down any previous panel first (fresh slate on reopen).
    if (_activePanelDestroy) {
        try { _activePanelDestroy(); } catch (_) {}
        _activePanelDestroy = null;
    }

    panel.hidden = false;
    panel.classList.add(QUIZ_ACTIVE_CLASS);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    document.body.classList.add('quiz-modal-open');

    const lang = detectLang();
    const S    = t(lang);

    // ── Per-session state ───────────────────────────────────
    const state = {
        // Catalogue
        branch,
        difficulty,
        count,
        contextHint,
        sourceQuestion,
        adaptive,
        // Question queue + cursor
        questions:  [],   // array of normalised question objects
        index:      0,
        // Per-question results: { selectedId, is_correct, correct_option_id, explanation, points_awarded }
        results:    new Array(count).fill(null),
        // Live aggregates
        score:      0,
        attempts:   0,
        correct:    0,
        streak:     0,
        bestStreak: 0,
        startedAt:  Date.now(),
        // Phase: 'loading' | 'active' | 'submitted' | 'completed'
        phase:      'loading',
        selectedId: null,
        currentTestId: null,
        currentSource: 'mock',
    };

    // ── DOM scaffolding ─────────────────────────────────────
    panel.innerHTML = '';
    const dirAttr = lang === 'ar' ? 'rtl' : 'ltr';
    panel.setAttribute('dir', dirAttr);
    const shell = el('div', 'qp-modal-shell');

    const header = el('div', 'qp-header');
    const headerRow = el('div', 'qp-header-row');
    const title = el('div', 'qp-title', S.createTest);
    const exitBtn = el('button', 'qp-exit');
    exitBtn.type = 'button';
    exitBtn.setAttribute('aria-label', S.close);
    exitBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">close</span>';
    headerRow.appendChild(title);
    headerRow.appendChild(exitBtn);
    header.appendChild(headerRow);

    const meta = el('div', 'qp-meta');
    const branchChip = el('span', 'qp-meta-chip', capitalize(branch));
    const diffChip = el('span', 'qp-meta-chip diff-' + difficulty, S[difficulty] || difficulty);
    const progressLine = el('span', 'qp-progress-line', '');
    meta.appendChild(branchChip);
    meta.appendChild(diffChip);
    meta.appendChild(el('span', 'qp-meta-spacer'));
    meta.appendChild(progressLine);
    progressLine.style.marginInlineStart = 'auto';
    header.appendChild(meta);

    const progress = el('div', 'qp-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', String(count));
    const segments = [];
    for (let i = 0; i < count; i++) {
        const seg = el('div', 'qp-progress-seg');
        progress.appendChild(seg);
        segments.push(seg);
    }
    header.appendChild(progress);

    const body = el('div', 'qp-body');
    const footer = el('div', 'qp-footer');

    // Footer stats (persistent across questions)
    const stats = el('div', 'qp-stats');
    function statCell(label, id, extraClass) {
        const wrap = el('div', 'qp-stat' + (extraClass ? ' ' + extraClass : ''));
        wrap.appendChild(el('span', 'qp-stat-label', label));
        const val = el('span', 'qp-stat-value', '—');
        val.id = id;
        wrap.appendChild(val);
        return wrap;
    }
    stats.appendChild(statCell(S.time,     'qp-stat-time'));
    stats.appendChild(statCell(S.solved,   'qp-stat-score'));
    stats.appendChild(statCell(S.accuracy, 'qp-stat-acc'));
    const streakCell = statCell(lang === 'ar' ? 'سلسلة' : 'Streak', 'qp-stat-streak', 'streak');
    stats.appendChild(streakCell);
    footer.appendChild(stats);

    const actions = el('div', 'qp-actions');
    footer.appendChild(actions);

    shell.appendChild(header);
    shell.appendChild(body);
    shell.appendChild(footer);
    panel.appendChild(shell);

    // ── Helpers ─────────────────────────────────────────────
    function setProgressLine() {
        progressLine.textContent = state.phase === 'completed'
            ? S.finished
            : `${Math.min(state.index + 1, count)} / ${count}`;
    }

    function paintProgress() {
        segments.forEach((seg, i) => {
            seg.classList.remove('done', 'correct', 'wrong', 'current');
            const r = state.results[i];
            if (r) {
                seg.classList.add('done', r.is_correct ? 'correct' : 'wrong');
            } else if (i === state.index && state.phase !== 'completed') {
                seg.classList.add('current');
            }
        });
        progress.setAttribute('aria-valuenow', String(state.attempts));
        setProgressLine();
    }

    function paintStats() {
        const tEl = document.getElementById('qp-stat-time');
        const sEl = document.getElementById('qp-stat-score');
        const aEl = document.getElementById('qp-stat-acc');
        const stEl = document.getElementById('qp-stat-streak');
        if (tEl) tEl.textContent = fmtPanelDuration(Date.now() - state.startedAt);
        if (sEl) sEl.textContent = `${state.score}/${count}`;
        if (aEl) aEl.textContent = state.attempts > 0
            ? Math.round((state.correct / state.attempts) * 100) + '%'
            : '—';
        if (stEl) stEl.textContent = String(state.streak);
        if (state.streak >= 3) streakCell.classList.add('hot');
        else streakCell.classList.remove('hot');
    }

    function adjustDifficultyIfNeeded() {
        if (!state.adaptive) return;
        // Re-evaluate every 2 attempts. Bump difficulty if accuracy ≥ 80%,
        // ease off if ≤ 30%. Stay clamped to {easy, medium, hard}.
        if (state.attempts === 0 || state.attempts % 2 !== 0) return;
        const acc = state.correct / state.attempts;
        const order = ['easy', 'medium', 'hard'];
        const cur   = order.indexOf(state.difficulty);
        let next    = cur;
        if (acc >= 0.80 && cur < 2) next = cur + 1;
        else if (acc <= 0.30 && cur > 0) next = cur - 1;
        if (next !== cur) {
            state.difficulty = order[next];
            diffChip.textContent = S[state.difficulty] || state.difficulty;
            diffChip.className = 'qp-meta-chip diff-' + state.difficulty;
        }
    }

    async function fetchNextBatch(needCount) {
        // Pre-load the whole session up front for count=1 (single MCQ) and
        // count=5 (test). For adaptive flows we re-fetch one at a time when
        // the difficulty has shifted. Keeps logic simple.
        const batch = await loadTest(state.branch, state.difficulty, needCount, state.sourceQuestion || '');
        state.currentTestId = batch.test_id;
        state.currentSource = batch.source;
        return batch.questions;
    }

    function clearBody() { body.innerHTML = ''; }
    function clearActions() { actions.innerHTML = ''; }

    function renderLoading() {
        clearBody();
        clearActions();
        const wrap = el('div', 'qp-loading');
        wrap.appendChild(el('div', 'quiz-shimmer-line quiz-shimmer-line-lg'));
        for (let i = 0; i < 4; i++) wrap.appendChild(el('div', 'quiz-shimmer-option'));
        const note = el('div', 'qp-empty', S.generating);
        body.appendChild(wrap);
        body.appendChild(note);
    }

    function renderError(retryFn) {
        clearBody();
        clearActions();
        const note = el('div', 'qp-empty', S.generationFailed);
        body.appendChild(note);
        const retry = el('button', 'quiz-btn quiz-btn-primary', S.retry);
        retry.type = 'button';
        retry.addEventListener('click', retryFn);
        actions.appendChild(retry);
    }

    function renderQuestion() {
        state.phase      = 'active';
        state.selectedId = null;
        clearBody();
        clearActions();

        const q = state.questions[state.index];
        if (!q) {
            renderError(() => bootstrap());
            return;
        }
        // Optional context line (e.g. inherited from the active study session).
        if (state.contextHint) {
            body.appendChild(el('div', 'qp-context', state.contextHint));
        }
        const qText = el('div', 'qp-question');
        qText.innerHTML = renderMath(lang === 'ar' && q.questionAr ? q.questionAr : q.question);
        body.appendChild(qText);

        const opts = el('div', 'qp-options');
        opts.setAttribute('role', 'radiogroup');
        opts.setAttribute('aria-label', q.question || '');
        const optionRows = q.options.map((opt, idx) => {
            const row = el('button', 'quiz-option');
            row.type = 'button';
            row.setAttribute('role', 'radio');
            row.setAttribute('aria-checked', 'false');
            row.dataset.optionId = opt.id;

            const radio  = el('span', 'quiz-option-radio');
            const letter = el('span', 'quiz-option-letter', optionLetter(idx, lang));
            const lbl    = el('span', 'quiz-option-label');
            lbl.innerHTML = renderMath(lang === 'ar' && opt.labelAr ? opt.labelAr : opt.label);
            row.appendChild(radio);
            row.appendChild(letter);
            row.appendChild(lbl);

            row.addEventListener('click', () => {
                if (state.phase !== 'active') return;
                state.selectedId = opt.id;
                optionRows.forEach(r => {
                    r.classList.toggle('selected', r.dataset.optionId === state.selectedId);
                    r.setAttribute('aria-checked', r.dataset.optionId === state.selectedId ? 'true' : 'false');
                });
                checkBtn.disabled = false;
            });
            row.addEventListener('keydown', (e) => {
                if (state.phase !== 'active') return;
                if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    row.click();
                } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                    e.preventDefault();
                    optionRows[(idx + 1) % optionRows.length].focus();
                } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    optionRows[(idx - 1 + optionRows.length) % optionRows.length].focus();
                }
            });
            opts.appendChild(row);
            return row;
        });
        body.appendChild(opts);

        const liveRegion = el('div', 'quiz-sr-live');
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('role', 'status');
        body.appendChild(liveRegion);

        // Footer actions
        const checkBtn = el('button', 'quiz-btn quiz-btn-primary', S.check);
        checkBtn.type = 'button';
        checkBtn.disabled = true;
        checkBtn.addEventListener('click', () => submitCurrent(optionRows, liveRegion));
        actions.appendChild(checkBtn);

        // Focus first option for keyboard users (next tick so it's mounted).
        queueMicrotask(() => optionRows[0]?.focus());

        paintProgress();
        paintStats();
    }

    async function submitCurrent(optionRows, liveRegion) {
        if (!state.selectedId || state.phase !== 'active') return;
        state.phase = 'submitted';
        const q = state.questions[state.index];

        // Disable everything while in-flight
        optionRows.forEach(r => { r.disabled = true; r.setAttribute('aria-disabled', 'true'); });
        clearActions();
        const pendingBtn = el('button', 'quiz-btn quiz-btn-primary', '…');
        pendingBtn.type = 'button';
        pendingBtn.disabled = true;
        actions.appendChild(pendingBtn);

        let result;
        try {
            result = await checkAnswer(
                { branch: state.branch, test_id: state.currentTestId, source: state.currentSource },
                q,
                state.selectedId,
                lang,
            );
        } catch (e) {
            console.warn('[quiz] panel check failed:', e);
            result = { is_correct: false, correct_option_id: q.correctOptionId || '', explanation: '', points_awarded: 0 };
        }

        // Update aggregates
        state.attempts += 1;
        if (result.is_correct) {
            state.correct  += 1;
            state.score    += 1;
            state.streak   += 1;
            state.bestStreak = Math.max(state.bestStreak, state.streak);
        } else {
            state.streak = 0;
        }
        state.results[state.index] = {
            selectedId: state.selectedId,
            ...result,
        };
        // Mirror into the global studyAnalytics so the (now-hidden) sidebar
        // widget catches up the moment the user exits the panel.
        studyAnalytics.recordAttempt({ branch: state.branch, correct: !!result.is_correct });

        // Paint result on options
        optionRows.forEach(r => {
            const id = r.dataset.optionId;
            if (id === result.correct_option_id) r.classList.add('correct');
            if (id === state.selectedId && state.selectedId !== result.correct_option_id) r.classList.add('incorrect');
        });

        // Feedback box
        const feedback = el('div', 'qp-feedback ' + (result.is_correct ? 'correct' : 'wrong'));
        feedback.appendChild(el('div', 'qp-feedback-title',
            (result.is_correct ? '✓ ' : '✗ ') + (result.is_correct ? S.correct : S.tryAgain)
        ));
        if (result.explanation) {
            const ex = el('div', 'qp-feedback-explain');
            ex.innerHTML = renderMath(result.explanation);
            feedback.appendChild(ex);
        }
        body.appendChild(feedback);
        liveRegion.textContent = result.is_correct ? S.correct : S.tryAgain;

        // Next button (or submit if last)
        clearActions();
        const isLast = state.index >= state.count - 1;
        const nextBtn = el('button', 'quiz-btn quiz-btn-primary', isLast ? S.submitTest : S.nextQuestion);
        nextBtn.type = 'button';
        nextBtn.addEventListener('click', () => {
            if (isLast) renderCompleted();
            else advanceToNext();
        });
        actions.appendChild(nextBtn);

        paintProgress();
        paintStats();

        // Adaptive difficulty (recomputed AFTER attempt count updates)
        adjustDifficultyIfNeeded();
    }

    async function advanceToNext() {
        state.index += 1;
        // If we still have a pre-loaded question, just render it.
        if (state.questions[state.index]) {
            renderQuestion();
            return;
        }
        // Else fetch one more (adaptive mode after a difficulty bump).
        renderLoading();
        try {
            const more = await fetchNextBatch(1);
            state.questions[state.index] = more[0];
            renderQuestion();
        } catch (e) {
            renderError(advanceToNext);
        }
    }

    function renderCompleted() {
        state.phase = 'completed';

        // Save quiz panel result to Supabase for review
        _saveQuizResult({
            quizType:       'panel',
            branch:         state.branch,
            difficulty:     state.difficulty,
            totalQuestions: state.count,
            correctCount:   state.correct,
            timeSpentMs:    Date.now() - state.startedAt,
            questions:      state.questions,
            results:        state.results,
        });

        clearBody();
        clearActions();
        setProgressLine();
        paintProgress();

        const wrap = el('div', 'qp-completed');
        const pct = state.attempts > 0 ? state.correct / state.attempts : 0;
        const emoji = pct >= 0.8 ? '🎉' : pct >= 0.5 ? '💪' : '📚';
        wrap.appendChild(el('div', 'qp-completed-emoji', emoji));
        wrap.appendChild(el('div', 'qp-completed-score', `${state.score} / ${state.count}`));
        wrap.appendChild(el('div', 'qp-completed-line',
            pct >= 0.8 ? S.greatStart : S.keepPracticing
        ));

        // Per-question breakdown (compact)
        const breakdown = el('div', 'qp-completed-breakdown');
        state.questions.forEach((q, i) => {
            const r = state.results[i];
            const row = el('div', 'qp-breakdown-row ' + (r?.is_correct ? 'correct' : 'wrong'));
            row.appendChild(el('span', 'qp-breakdown-icon', r?.is_correct ? '✓' : '✗'));
            row.appendChild(el('span', 'qp-breakdown-text', `${S.questionN(i + 1)}`));
            breakdown.appendChild(row);
        });
        wrap.appendChild(breakdown);
        body.appendChild(wrap);

        // Actions: Try again / New
        const again = el('button', 'quiz-btn quiz-btn-ghost', S.tryAgainBtn);
        again.type = 'button';
        again.addEventListener('click', () => {
            // Same params, fresh questions
            openQuizPanel({ branch: state.branch, difficulty: state.difficulty, count: state.count, contextHint: state.contextHint, adaptive: state.adaptive });
        });
        const fresh = el('button', 'quiz-btn quiz-btn-primary', S.newTest);
        fresh.type = 'button';
        fresh.addEventListener('click', () => {
            openBranchDiffMenu({
                trigger: fresh,
                kind:    'test',
                onStart: ({ branch: b, difficulty: d }) => {
                    openQuizPanel({ branch: b, difficulty: d, count: state.count, adaptive: state.adaptive });
                },
            });
        });
        actions.appendChild(again);
        actions.appendChild(fresh);

        paintStats();
    }

    function exit() {
        // Confirm if mid-quiz with progress
        if (state.phase !== 'completed' && state.attempts > 0) {
            // eslint-disable-next-line no-alert
            if (!confirm(S.confirmLoseProgress)) return;
        }
        teardown();
    }

    function teardown() {
        clearInterval(timerHandle);
        document.removeEventListener('keydown', onKey);
        panel.removeEventListener('click', onBackdropClick);
        panel.classList.remove(QUIZ_ACTIVE_CLASS);
        document.body.classList.remove('quiz-modal-open');
        // Keep `hidden` true so the slid-out panel is no longer focusable.
        // Wait for the slide-out transition before clearing inner DOM, so
        // the user sees the animation play through.
        setTimeout(() => {
            panel.hidden = true;
            panel.innerHTML = '';
        }, 300);
        studyAnalytics.closeQuiz();
        _activePanelDestroy = null;
    }

    exitBtn.addEventListener('click', exit);

    // Esc closes the panel from anywhere on the page.
    const onKey = (e) => { if (e.key === 'Escape') exit(); };
    document.addEventListener('keydown', onKey);
    const onBackdropClick = (e) => { if (e.target === panel) exit(); };
    panel.addEventListener('click', onBackdropClick);

    // Live timer (1s tick) + initial paint.
    const timerHandle = setInterval(paintStats, 1000);

    studyAnalytics.setActiveQuiz({ kind: 'panel', branch, difficulty, total: count });
    studyAnalytics.setMode(lang === 'ar' ? `اختبار تدريبي (سؤال 1/${count})` : `Practice Quiz (Q 1/${count})`);

    // ── Bootstrap: pre-load the whole batch then render Q1 ──
    async function bootstrap() {
        renderLoading();
        try {
            state.questions = await fetchNextBatch(state.count);
        } catch (e) {
            renderError(bootstrap);
            return;
        }
        if (!state.questions.length) {
            renderError(bootstrap);
            return;
        }
        renderQuestion();
    }

    paintProgress();
    paintStats();

    // Branch + difficulty are always picked by the caller before this
    // function runs (openBranchDiffMenu for Practice Test, hero pill
    // default for Single MCQ), so we skip the redundant in-modal
    // "Select Difficulty" picker and start generating immediately.
    bootstrap();

    _activePanelDestroy = () => {
        clearInterval(timerHandle);
        document.removeEventListener('keydown', onKey);
        panel.removeEventListener('click', onBackdropClick);
        panel.classList.remove(QUIZ_ACTIVE_CLASS);
        document.body.classList.remove('quiz-modal-open');
        panel.hidden = true;
        panel.innerHTML = '';
    };
}

/** Public exit helper — for callers that want to close the panel without a confirm prompt. */
export function closeQuizPanel() {
    if (_activePanelDestroy) {
        const fn = _activePanelDestroy;
        _activePanelDestroy = null;
        try { fn(); } catch (_) {}
    }
}

function fmtPanelDuration(ms) {
    if (!ms || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}
