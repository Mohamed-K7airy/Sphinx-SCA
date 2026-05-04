"""
MATHX — Study Mode: Session Management (v2 — Production)
"""

from typing import TypedDict, List, Optional, Literal
import uuid
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
    question:            str
    branch:              str
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


def create_session(question: str, branch: str) -> str:
    cleanup_expired_sessions()
    session_id = str(uuid.uuid4())
    sessions_db[session_id] = StudySessionState(
        session_id          = session_id,
        question            = question,
        branch              = branch,
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
    )
    return session_id


def get_session(session_id: str) -> Optional[StudySessionState]:
    return sessions_db.get(session_id)


def update_session(session_id: str, updates: dict) -> bool:
    if session_id not in sessions_db:
        raise ValueError(f"Session '{session_id}' not found.")
    valid_keys = set(StudySessionState.__annotations__.keys())
    invalid    = [k for k in updates if k not in valid_keys]
    if invalid:
        raise KeyError(f"Invalid session fields: {invalid}")
    for key, value in updates.items():
        sessions_db[session_id][key] = value
    return True


def end_session(session_id: str) -> bool:
    if session_id in sessions_db:
        del sessions_db[session_id]
        return True
    return False


def set_phase(session_id: str, phase: str) -> bool:
    if phase not in VALID_PHASES:
        raise ValueError(f"Invalid phase '{phase}'. Must be one of: {VALID_PHASES}")
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
    if session_id not in sessions_db:
        raise ValueError(f"Session '{session_id}' not found.")
    record: AttemptRecord = {
        "attempt":   attempt,
        "feedback":  feedback,
        "correct":   correct,
        "timestamp": datetime.now().isoformat(),
    }
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
    if session_id not in sessions_db:
        raise ValueError(f"Session '{session_id}' not found.")
    if not can_use_hint(session_id):
        raise ValueError(f"Hint limit reached ({MAX_HINTS}/{MAX_HINTS}).")
    sessions_db[session_id]["hints_used"] += 1
    return True


def add_weak_concept(session_id: str, concept: str) -> bool:
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
    now     = datetime.now()
    expired = [
        sid for sid, s in sessions_db.items()
        if (now - datetime.fromisoformat(s["session_start"])).total_seconds()
           > SESSION_TTL_MINUTES * 60
    ]
    for sid in expired:
        del sessions_db[sid]
    return len(expired)
