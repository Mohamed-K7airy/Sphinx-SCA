"""
MATHX — Study Mode: Session Management (v2 — Production)
"""

from typing import TypedDict, List, Optional, Literal, Tuple
import uuid
import threading
from datetime import datetime


class AttemptRecord(TypedDict):
    attempt:   str
    feedback:  str
    correct:   bool
    timestamp: str


class PracticeProblem(TypedDict):
    question:   str
    difficulty: str
    branch:     str


class StudySessionState(TypedDict):
    session_id:          str
    question:            str          # CURRENT active problem (mutates when practice is generated)
    original_question:   str          # IMMUTABLE first problem — anchor for practice generation
    branch:              str
    difficulty:          str
    phase:               Literal["explain", "socratic", "check", "practice", "summary"]
    hints_used:          int
    attempt:             str
    attempt_history:     List[AttemptRecord]
    concept_explanation: str
    socratic_questions:  List[str]
    mistake_feedback:    str
    practice_problems:   List[PracticeProblem]
    problems_solved:     int
    weak_concepts:       List[str]
    session_start:       str
    error_counters:      dict
    last_error_type:     str


MAX_HINTS:           int = 3
SESSION_TTL_MINUTES: int = 180

VALID_PHASES = ["explain", "socratic", "check", "practice", "summary"]

# Allowed forward transitions — strictly enforced
PHASE_TRANSITIONS: dict[str, List[str]] = {
    "explain":  ["socratic", "check", "practice", "summary"],
    "socratic": ["check", "practice", "summary"],
    "check":    ["socratic", "practice", "summary"],
    "practice": ["check", "socratic", "summary"],
    "summary":  [],
}

sessions_db: dict[str, StudySessionState] = {}

# Single re-entrant lock guards ALL mutations of `sessions_db` and the per-session
# dicts inside it. Without this, FastAPI's threadpool could land two `/study/check`
# calls on the same session simultaneously and clobber `error_counters`,
# `attempt_history`, or `hints_used` via non-atomic read-modify-write.
_session_lock = threading.RLock()


def create_session(question: str, branch: str) -> str:
    cleanup_expired_sessions()
    session_id = str(uuid.uuid4())
    with _session_lock:
        sessions_db[session_id] = StudySessionState(
            session_id          = session_id,
            question            = question,
            original_question   = question,
            branch              = branch,
            difficulty          = "medium",
            phase               = "explain",
            hints_used          = 0,
            attempt             = "",
            attempt_history     = [],
            concept_explanation = "",
            socratic_questions  = [],
            mistake_feedback    = "",
            practice_problems   = [],
            problems_solved     = 0,
            weak_concepts       = [],
            session_start       = datetime.now().isoformat(),
            error_counters      = {},
            last_error_type     = "",
        )
    return session_id


def get_session(session_id: str) -> Optional[StudySessionState]:
    # Reads are intentionally lock-free: dict.get is atomic in CPython and
    # nothing here mutates the returned dict's identity.
    return sessions_db.get(session_id)


def update_session(session_id: str, updates: dict) -> bool:
    valid_keys = set(StudySessionState.__annotations__.keys())
    invalid    = [k for k in updates if k not in valid_keys]
    if invalid:
        raise KeyError(f"Invalid session fields: {invalid}")
    with _session_lock:
        if session_id not in sessions_db:
            raise ValueError(f"Session '{session_id}' not found.")
        for key, value in updates.items():
            sessions_db[session_id][key] = value
    return True


def end_session(session_id: str) -> bool:
    with _session_lock:
        if session_id in sessions_db:
            del sessions_db[session_id]
            return True
    return False


def set_phase(session_id: str, phase: str) -> bool:
    if phase not in VALID_PHASES:
        raise ValueError(f"Invalid phase '{phase}'. Must be one of: {VALID_PHASES}")
    with _session_lock:
        if session_id not in sessions_db:
            raise ValueError(f"Session '{session_id}' not found.")
        current = sessions_db[session_id]["phase"]
        if current == "summary":
            return False  # terminal — silently ignore
        allowed = PHASE_TRANSITIONS.get(current, [])
        if phase not in allowed:
            return False  # invalid transition — silently ignore (don't crash)
        sessions_db[session_id]["phase"] = phase
    return True


def add_attempt(session_id: str, attempt: str, feedback: str, correct: bool) -> bool:
    record: AttemptRecord = {
        "attempt":   attempt,
        "feedback":  feedback,
        "correct":   correct,
        "timestamp": datetime.now().isoformat(),
    }
    with _session_lock:
        if session_id not in sessions_db:
            raise ValueError(f"Session '{session_id}' not found.")
        sessions_db[session_id]["attempt_history"].append(record)
        sessions_db[session_id]["attempt"] = attempt
        if correct:
            sessions_db[session_id]["problems_solved"] += 1
    return True


def can_use_hint(session_id: str) -> bool:
    session = get_session(session_id)
    if not session:
        return False
    return session["hints_used"] < MAX_HINTS


def use_hint(session_id: str) -> bool:
    with _session_lock:
        if session_id not in sessions_db:
            raise ValueError(f"Session '{session_id}' not found.")
        if sessions_db[session_id]["hints_used"] >= MAX_HINTS:
            raise ValueError(f"Hint limit reached ({MAX_HINTS}/{MAX_HINTS}).")
        sessions_db[session_id]["hints_used"] += 1
    return True


def try_use_hint(session_id: str) -> Tuple[bool, int]:
    """Atomically check-and-increment the hint counter.

    Returns (granted, hints_used_after). If the limit was already hit,
    returns (False, MAX_HINTS) without mutating state. This closes the
    race where two concurrent /study/hint calls both see `hints_used=2`,
    both pass `can_use_hint`, and both increment to land at 4.
    """
    with _session_lock:
        if session_id not in sessions_db:
            return False, 0
        used = sessions_db[session_id]["hints_used"]
        if used >= MAX_HINTS:
            return False, used
        sessions_db[session_id]["hints_used"] = used + 1
        return True, used + 1


def increment_error_counter(session_id: str, error_type: str) -> int:
    """Atomically increment a session's error_counter[error_type] and return new count."""
    with _session_lock:
        if session_id not in sessions_db:
            return 0
        ec = dict(sessions_db[session_id].get("error_counters") or {})
        ec[error_type] = ec.get(error_type, 0) + 1
        sessions_db[session_id]["error_counters"]  = ec
        sessions_db[session_id]["last_error_type"] = error_type
        return ec[error_type]


def add_weak_concept(session_id: str, concept: str) -> bool:
    with _session_lock:
        if session_id not in sessions_db:
            raise ValueError(f"Session '{session_id}' not found.")
        concept  = concept.strip().lower()
        existing = sessions_db[session_id]["weak_concepts"]
        if concept in existing:
            return False
        sessions_db[session_id]["weak_concepts"].append(concept)
    return True


def get_active_sessions_count() -> int:
    return len(sessions_db)


def cleanup_expired_sessions() -> int:
    now = datetime.now()
    with _session_lock:
        expired = [
            sid for sid, s in sessions_db.items()
            if (now - datetime.fromisoformat(s["session_start"])).total_seconds()
               > SESSION_TTL_MINUTES * 60
        ]
        for sid in expired:
            del sessions_db[sid]
    return len(expired)


# ─────────────────────────────────────────────
# MCQ TEST STORE  (Khan-style practice quizzes / tests, PR-A)
# ─────────────────────────────────────────────
#
# `mcq_tests_db` is keyed by `test_id` and holds the FULL questions (including
# the correct_option_id). The /study/mcq/generate route strips correct ids
# before returning to the client; /study/mcq/check looks the answer up here.
#
# Tests share the same in-memory layer as study sessions but live in their
# own dict so a missing study session can never leak into an MCQ lookup and
# vice-versa. TTL matches sessions so a long-abandoned test eventually frees
# memory without an explicit close call from the client.

mcq_tests_db: dict[str, dict] = {}


def create_mcq_test(branch: str, difficulty: str, questions: list[dict]) -> str:
    """Store a freshly generated MCQ test and return its test_id.

    `questions` must be the *full* records (including correctOptionId). The
    caller is responsible for stripping fields before returning to clients.
    """
    cleanup_expired_mcq_tests()
    test_id = f"mcq-{uuid.uuid4()}"
    with _session_lock:
        mcq_tests_db[test_id] = {
            "test_id":    test_id,
            "branch":     branch,
            "difficulty": difficulty,
            "questions":  list(questions),  # shallow copy so callers can't mutate ours
            "created_at": datetime.now().isoformat(),
        }
    return test_id


def get_mcq_test(test_id: str) -> Optional[dict]:
    """Lookup an MCQ test by id. Lock-free; returns None on miss."""
    return mcq_tests_db.get(test_id)


def get_mcq_question(test_id: str, question_id: str) -> Optional[dict]:
    """Convenience: find a single question inside a stored test."""
    test = mcq_tests_db.get(test_id)
    if not test:
        return None
    for q in test.get("questions", []):
        if str(q.get("id")) == str(question_id):
            return q
    return None


def cleanup_expired_mcq_tests() -> int:
    """Drop MCQ tests older than SESSION_TTL_MINUTES. Same policy as sessions."""
    now = datetime.now()
    with _session_lock:
        expired = [
            tid for tid, t in mcq_tests_db.items()
            if (now - datetime.fromisoformat(t["created_at"])).total_seconds()
               > SESSION_TTL_MINUTES * 60
        ]
        for tid in expired:
            del mcq_tests_db[tid]
    return len(expired)


def get_active_mcq_tests_count() -> int:
    return len(mcq_tests_db)
