"""
MATHX — Study Mode Agent (v9 — Production)

Public entry point. Owns:
  • Module-level singletons used across all study_engine submodules:
      - study_llm   (StudyLLM)
      - _memory     (MemoryManager)
      - groq_client (Groq SDK)
  • Background asyncio event loop + _fire_and_forget for memory writes.
  • Post-summary cleanup scheduler (with per-session cancellation so retries
    don't pile up coroutines for the full grace window).
  • The StudyAgent class — the only object app.py instantiates.

Implementation layers (kept small + single-purpose so bugs are easy to localize):
  • study_tools.py — what tools exist + what each tool does + dispatcher.
  • study_loop.py  — system prompt + decision gate + agent loop + fallback formatter.
  • study_agent.py — this file: shared infra + the public StudyAgent class.

NOTE: study_tools.py and study_loop.py reference back into THIS module for
the singletons (study_llm, _memory, _fire_and_forget, groq_client). They use
`from . import study_agent as _agent_mod` — module-level reference, attribute
lookup at call time — so the circular import resolves cleanly as long as the
singletons below are defined BEFORE we import the layered modules at the
bottom of this file.
"""

import os
import sys
import logging
import threading
import asyncio
from typing import Optional

if __package__ is None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

# ─────────────────────────────────────────────
# EXTERNAL DEPENDENCIES
# ─────────────────────────────────────────────

try:
    from backend.study_engine.study_llm import StudyLLM, detect_language
except ImportError:
    from .study_llm import StudyLLM, detect_language

try:
    from backend.study_engine.study_session import (
        create_session, get_session, update_session,
        set_phase, add_attempt, can_use_hint, end_session,
        try_use_hint,
        MAX_HINTS,
    )
except ImportError:
    from .study_session import (
        create_session, get_session, update_session,
        set_phase, add_attempt, can_use_hint, end_session,
        try_use_hint,
        MAX_HINTS,
    )

try:
    from backend.memory_manager import MemoryManager
except ImportError:
    from memory_manager import MemoryManager

try:
    from backend.llm_manager import client as groq_client
except ImportError:
    from llm_manager import client as groq_client

logger    = logging.getLogger("mathx-study-agent-v9")
study_llm = StudyLLM()
_memory   = MemoryManager()


# ─────────────────────────────────────────────
# BACKGROUND EVENT LOOP (single, persistent)
# ─────────────────────────────────────────────

_bg_loop:   Optional[asyncio.AbstractEventLoop] = None
_bg_thread: Optional[threading.Thread]          = None
_bg_lock    = threading.Lock()


def _get_background_loop() -> asyncio.AbstractEventLoop:
    global _bg_loop, _bg_thread
    if _bg_loop is not None and _bg_loop.is_running():
        return _bg_loop
    with _bg_lock:
        # NOTE: gate on `is not None` (not is_running). Thread.start() only schedules
        # the thread; run_forever may not have begun yet, so is_running() can briefly
        # return False on a freshly-created loop and would otherwise spawn a duplicate.
        if _bg_loop is not None:
            return _bg_loop
        policy   = asyncio.WindowsSelectorEventLoopPolicy() if sys.platform == "win32" else None
        _bg_loop = policy.new_event_loop() if policy else asyncio.new_event_loop()
        _bg_thread = threading.Thread(target=_bg_loop.run_forever, daemon=True, name="study-memory-bg")
        _bg_thread.start()
    return _bg_loop


def _fire_and_forget(coro) -> None:
    loop   = _get_background_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)

    def _on_done(fut):
        try:
            fut.result()
        except Exception as exc:
            logger.warning("[Memory bg] %s", exc)

    future.add_done_callback(_on_done)


# ─────────────────────────────────────────────
# SESSION CLEANUP (post-summary grace window)
# ─────────────────────────────────────────────

# Sessions are kept readable for a short window after summary so the client can
# safely retry /study/summary (e.g. on tab reload, share-link open). Past this
# window we delete; the 180-min TTL in study_session.py is the final backstop.
SUMMARY_GRACE_SECONDS = 600  # 10 minutes

# Audit fix: track in-flight cleanup futures by session_id so a 2nd /study/summary
# call cancels the previous pending cleanup instead of stacking another 10-min
# coroutine on top of it. Keeps the bg loop's queue bounded under retries.
_pending_cleanups: dict = {}
_cleanup_lock = threading.Lock()


def _schedule_session_cleanup(session_id: str, delay: int = SUMMARY_GRACE_SECONDS) -> None:
    """Defer end_session(session_id) so the client retains a grace window.

    Calling this twice for the same session cancels the previous pending
    cleanup before scheduling the new one — repeated /study/summary requests
    won't accumulate coroutines.
    """
    async def _delayed():
        await asyncio.sleep(delay)
        try:
            removed = end_session(session_id)
            if removed:
                logger.info("[Cleanup] Removed session %s after %ds grace window", session_id, delay)
        except Exception as exc:
            logger.warning("[Cleanup] %s", exc)
        finally:
            with _cleanup_lock:
                _pending_cleanups.pop(session_id, None)

    loop   = _get_background_loop()
    future = asyncio.run_coroutine_threadsafe(_delayed(), loop)

    with _cleanup_lock:
        prev = _pending_cleanups.get(session_id)
        if prev is not None and not prev.done():
            # cancel() on a coroutine future requests CancelledError inside the
            # awaiting task; the asyncio.sleep above will raise it.
            prev.cancel()
        _pending_cleanups[session_id] = future

    def _on_done(fut):
        try:
            fut.result()
        except asyncio.CancelledError:
            pass  # superseded by a newer schedule — expected
        except Exception as exc:
            logger.warning("[Cleanup bg] %s", exc)

    future.add_done_callback(_on_done)


# ─────────────────────────────────────────────
# LAYERED IMPORTS (must come AFTER singletons above)
# ─────────────────────────────────────────────
# study_tools and study_loop reference _agent_mod.study_llm / _memory /
# _fire_and_forget / groq_client — those are defined above, so by the time the
# imports below trigger module load, the attribute lookups at call-time resolve.

try:
    from backend.study_engine.study_tools import _hint_limit_message
    from backend.study_engine.study_loop  import _run_agent_loop
except ImportError:
    from .study_tools import _hint_limit_message
    from .study_loop  import _run_agent_loop


# ─────────────────────────────────────────────
# STUDY AGENT CLASS
# ─────────────────────────────────────────────

class StudyAgent:

    def __init__(self):
        self.memory = _memory
        logger.info("[StudyAgent v9] Ready ✓")

    # ── Memory helper ─────────────────────────────────────────────

    async def _get_memory_ctx(self, user_id: str, query: str) -> str:
        if not user_id:
            return ""
        try:
            return await self.memory.get_context(user_id, query)
        except Exception as exc:
            logger.warning("[Memory] get_context failed: %s", exc)
            return ""

    def _hints_remaining(self, session_id: str) -> int:
        session = get_session(session_id)
        return max(0, MAX_HINTS - session["hints_used"]) if session else MAX_HINTS

    # ── Fast-path helpers (no agent loop) ────────────────────────

    def classify_intent(self, text: str) -> str:
        return study_llm.classify_intent(text)

    async def chat(self, message: str, user_id: str = "") -> dict:
        memory_ctx    = await self._get_memory_ctx(user_id, message)
        response_text = await asyncio.to_thread(study_llm.chat_casual, message, memory_ctx=memory_ctx)
        if user_id:
            _fire_and_forget(self.memory.learn(user_id, [
                {"role": "user",      "content": message},
                {"role": "assistant", "content": response_text},
            ]))
        return {"success": True, "intent": "casual", "display_markdown": response_text, "agent_message": response_text}

    async def explain(self, question: str, branch: str, user_id: str = "") -> dict:
        memory_ctx    = await self._get_memory_ctx(user_id, question)
        response_text = await asyncio.to_thread(study_llm.explain_topic, question, branch, memory_ctx=memory_ctx)
        if user_id:
            _fire_and_forget(self.memory.learn(user_id, [
                {"role": "user",      "content": f"[Explain] {question}"},
                {"role": "assistant", "content": response_text},
            ]))
        return {"success": True, "intent": "explain", "display_markdown": response_text, "agent_message": response_text}

    async def help_user(self, question: str, branch: str, user_id: str = "") -> dict:
        memory_ctx    = await self._get_memory_ctx(user_id, question)
        response_text = await asyncio.to_thread(study_llm.help_response, question, branch, memory_ctx=memory_ctx)
        if user_id:
            _fire_and_forget(self.memory.learn(user_id, [
                {"role": "user",      "content": f"[Help] {question}"},
                {"role": "assistant", "content": response_text},
            ]))
        return {"success": True, "intent": "help", "display_markdown": response_text, "agent_message": response_text}

    # ── User message builder ──────────────────────────────────────

    def _build_user_message(self, action: str, session_id: str,
                             question: str, branch: str,
                             difficulty: str = "", student_answer: str = "",
                             correct_answer: str = "", memory_ctx: str = "") -> str:
        session    = get_session(session_id)
        hints_used = session["hints_used"]           if session else 0
        attempts   = len(session["attempt_history"]) if session else 0
        phase      = session["phase"]                if session else "explain"

        parts = [
            f"ACTION: {action}",
            f"QUESTION: {question}",
            f"BRANCH: {branch}",
            f"DIFFICULTY: {difficulty or 'medium'}",
            f"SESSION STATE:",
            f"  phase: {phase}",
            f"  hints_used: {hints_used}/{MAX_HINTS}",
            f"  attempts_so_far: {attempts}",
        ]
        if student_answer:
            parts.append(f"STUDENT ANSWER: {student_answer}")
        if correct_answer:
            parts.append(f"CORRECT ANSWER: {correct_answer}")
        if memory_ctx:
            parts.append(f"MEMORY CONTEXT (use silently): {memory_ctx[:400]}")
        return "\n".join(parts)

    # ── Agent-loop paths ──────────────────────────────────────────

    async def start(self, question: str, branch: str, user_id: str = "") -> dict:
        memory_ctx = await self._get_memory_ctx(user_id, question)
        session_id = create_session(question, branch)

        try:
            difficulty = await asyncio.to_thread(study_llm.classify_difficulty, question, branch)
        except Exception:
            difficulty = "medium"
        # Validate so a hallucinated value doesn't silently break the system
        # prompt's decision rules (which only branch on easy/medium/hard).
        if difficulty not in ("easy", "medium", "hard"):
            logger.warning("[Start] classify_difficulty returned %r — coercing to 'medium'", difficulty)
            difficulty = "medium"

        # Persist on the session so fast-paths (hint/etc.) can reuse it instead of
        # hard-coding "medium".
        try:
            update_session(session_id, {"difficulty": difficulty})
        except Exception:
            pass

        context  = {"session_id": session_id, "user_id": user_id,
                     "question": question, "branch": branch, "memory_ctx": memory_ctx}
        user_msg = self._build_user_message(
            "start", session_id, question, branch, difficulty, memory_ctx=memory_ctx
        )

        result                    = await asyncio.to_thread(_run_agent_loop, user_msg, context)
        result["session_id"]      = session_id
        result["difficulty"]      = difficulty
        result["hints_remaining"] = self._hints_remaining(session_id)

        session = get_session(session_id)
        if session:
            result["session_question"] = session["question"]

        return result

    async def hint(self, session_id: str, question: str, branch: str,
                   user_id: str = "") -> dict:
        """Direct fast-path — no agent loop. Always uses session's stored question."""
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err}

        actual_question   = session["question"]
        actual_branch     = session["branch"]
        actual_difficulty = session.get("difficulty") or "medium"
        is_arabic         = detect_language(actual_question) == "ar"

        # Audit fix #3: atomic check-and-increment closes the race where two
        # concurrent /study/hint calls both pass `can_use_hint(==2 < 3)` and
        # both increment to 4. try_use_hint reserves the slot in one critical
        # section; if reservation fails we surface the limit message.
        granted, hints_used_after = try_use_hint(session_id)
        if not granted:
            limit_msg = _hint_limit_message(actual_question)
            return {
                "success": True, "session_id": session_id,
                "hint_text": limit_msg, "agent_message": limit_msg,
                "hints_remaining": 0, "hint_limit_reached": True,
            }

        hint_number = hints_used_after  # we just incremented to this number
        try:
            hint_text = await asyncio.to_thread(
                study_llm.generate_hint, actual_question, actual_branch, hint_number, actual_difficulty
            )
        except Exception as exc:
            logger.error("[Hint] generate_hint failed: %s", exc)
            hint_text = ""

        if not hint_text or hint_text.startswith("Error:"):
            if is_arabic:
                hint_text = {
                    1: "💡 فكّر في القاعدة أو الصيغة المناسبة. ما أول خطوة؟ 🤔",
                    2: "💡 جزّئ المسألة إلى خطوات أصغر. أي عملية تبدأ بها؟ 👀",
                    3: "💡 أنت قريب جداً! جرّب أول خطوة حسابية. ماذا تحصل؟ 💪",
                }.get(hint_number, "💡 فكّر في الطريقة المناسبة. بماذا ستبدأ؟")
            else:
                hint_text = {
                    1: "💡 Think about which technique or formula applies. What's the first step? 🤔",
                    2: "💡 Break the problem into smaller parts. Which operation starts it? 👀",
                    3: "💡 You're close! Try the first calculation step. What do you get? 💪",
                }.get(hint_number, "💡 Think about the approach. What would you try first?")

        return {
            "success":         True,
            "session_id":      session_id,
            "hint_text":       hint_text,
            "hint_level":      hint_number,
            "hints_remaining": max(0, MAX_HINTS - hints_used_after),
            "agent_message":   hint_text,
        }

    async def solve(self, session_id: str, question: str, branch: str,
                    user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err, "session_id": session_id}
        q        = session["question"]
        b        = session["branch"]
        context  = {"session_id": session_id, "user_id": user_id, "question": q, "branch": b}
        user_msg = self._build_user_message("solve", session_id, q, b)
        result               = await asyncio.to_thread(_run_agent_loop, user_msg, context)
        result["session_id"] = session_id
        return result

    async def giveup(self, session_id: str, question: str, branch: str,
                     user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err, "session_id": session_id}
        q        = session["question"]
        b        = session["branch"]
        context  = {"session_id": session_id, "user_id": user_id, "question": q, "branch": b}
        user_msg = self._build_user_message("giveup", session_id, q, b)
        result               = await asyncio.to_thread(_run_agent_loop, user_msg, context)
        result["session_id"] = session_id
        return result

    async def check(self, session_id: str, question: str, branch: str,
                    student_answer: str, correct_answer: str,
                    user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err, "session_id": session_id}
        q          = session["question"]
        b          = session["branch"]
        memory_ctx = await self._get_memory_ctx(user_id, q)
        context    = {"session_id": session_id, "user_id": user_id,
                       "question": q, "branch": b, "memory_ctx": memory_ctx}
        user_msg   = self._build_user_message(
            "check", session_id, q, b,
            student_answer=student_answer,
            correct_answer=correct_answer,
            memory_ctx=memory_ctx,
        )
        result                    = await asyncio.to_thread(_run_agent_loop, user_msg, context)
        result["session_id"]      = session_id
        result["hints_remaining"] = self._hints_remaining(session_id)
        return result

    async def next(self, session_id: str, question: str, branch: str,
                   user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err, "session_id": session_id}
        q        = session["question"]
        b        = session["branch"]
        context  = {"session_id": session_id, "user_id": user_id, "question": q, "branch": b}
        user_msg = self._build_user_message("next", session_id, q, b)
        result               = await asyncio.to_thread(_run_agent_loop, user_msg, context)
        result["session_id"] = session_id
        return result

    async def next_harder(self, session_id: str, question: str, branch: str,
                          user_id: str = "") -> dict:
        """Direct fast-path — no agent loop."""
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err, "session_id": session_id}
        # Audit fix #1: anchor "harder" generation to the IMMUTABLE original
        # problem so successive Next-Harder presses don't drift further from
        # what the student actually started with. Then update session.question
        # to the new harder problem so subsequent check/hint/solve operate on
        # what's currently in front of the student.
        b = session["branch"]
        anchor = session.get("original_question") or session["question"]

        practice = await asyncio.to_thread(study_llm.generate_harder_practice, b, anchor)
        try:
            existing = list((get_session(session_id) or {}).get("practice_problems") or [])
            existing.append({"question": practice, "difficulty": "harder", "branch": b})
            update_session(session_id, {
                "practice_problems": existing,
                "question":          practice,
            })
        except Exception:
            pass

        if user_id:
            _fire_and_forget(_memory.learn(user_id, [
                {"role": "user",      "content": f"[Harder] Original: {anchor} | Branch: {b}"},
                {"role": "assistant", "content": f"Harder practice: {practice}"},
            ]))

        return {
            "success":          True,
            "session_id":       session_id,
            "practice_problem": practice,
            "next_phase":       "practice",
            "difficulty_bump":  True,
            "agent_message":    practice,
        }

    async def finish(self, session_id: str, question: str, branch: str,
                     user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            err = "Session not found."
            return {"success": False, "error": err, "agent_message": err, "session_id": session_id}
        q        = session["question"]
        b        = session["branch"]
        context  = {"session_id": session_id, "user_id": user_id, "question": q, "branch": b}
        user_msg = self._build_user_message("summary", session_id, q, b)
        result               = await asyncio.to_thread(_run_agent_loop, user_msg, context)
        result["session_id"] = session_id

        # Attach stats from final session state
        session = get_session(session_id)
        if session:
            result["stats"] = {
                "problems_solved": session["problems_solved"],
                "hints_used":      session["hints_used"],
                "total_attempts":  len(session["attempt_history"]),
            }

        # Bound in-memory leakage: schedule deletion after a grace window so retries
        # of /study/summary still work, but stale sessions don't linger for the full TTL.
        _schedule_session_cleanup(session_id)
        return result


# ─────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────

_instance: Optional[StudyAgent] = None
_lock = threading.Lock()


def get_study_agent() -> StudyAgent:
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = StudyAgent()
    return _instance
