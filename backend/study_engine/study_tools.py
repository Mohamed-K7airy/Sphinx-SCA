"""
MATHX — Study Mode: Tool Layer (v9 — Production)

Defines the 7 LLM-facing tools (schemas), their pure implementations, and the
dispatcher that routes a tool name + args to the right implementation.

This module purposely owns NO orchestration logic — no agent loop, no LLM client,
no system prompt. Bugs in tool behaviour live here; bugs in how tools are chosen
or sequenced live in study_loop.py.

Audit fixes applied here:
  • Fix #1 (stale practice question): generate_practice anchors to
    session.original_question and updates session.question to the new practice,
    so analyze_mistake / display use the *active* problem instead of the original.
  • Fix #4 (evaluator degraded mode): on LLM failure we keep a strict-equality
    fallback BUT surface `evaluator_degraded: True` so the route can warn
    instead of silently marking a correct student "wrong".
  • Atomic error-counter increment via study_session.increment_error_counter.
"""

import os
import sys
import logging
from typing import Optional

if __package__ is None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

try:
    from backend.study_engine.study_llm import detect_language
except ImportError:
    from .study_llm import detect_language

try:
    from backend.study_engine.study_session import (
        get_session, update_session, set_phase, add_attempt,
        try_use_hint, increment_error_counter, MAX_HINTS,
        create_mcq_test, get_mcq_test, get_mcq_question,
    )
except ImportError:
    from .study_session import (
        get_session, update_session, set_phase, add_attempt,
        try_use_hint, increment_error_counter, MAX_HINTS,
        create_mcq_test, get_mcq_test, get_mcq_question,
    )

try:
    from backend.study_engine.study_llm import strip_correct_option
except ImportError:
    from .study_llm import strip_correct_option

# Module-level reference (NOT name imports) to break the
# study_agent ↔ study_tools cycle. Attribute access happens at call time, by
# which point study_agent has fully defined its singletons.
try:
    from backend.study_engine import study_agent as _agent_mod
except ImportError:
    from . import study_agent as _agent_mod

logger = logging.getLogger("mathx-study-tools-v9")


# ─────────────────────────────────────────────
# TOOL SCHEMAS  (session_id NEVER exposed to the LLM)
# ─────────────────────────────────────────────

STUDY_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "explain_concept",
            "description": "Explain the concept behind the problem. Use at session start. NEVER reveal the solution.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question":         {"type": "string", "description": "The math problem"},
                    "branch":           {"type": "string", "description": "Math branch"},
                    "difficulty":       {"type": "string", "description": "easy | medium | hard"},
                    "analogy":          {"type": "string", "description": "Optional real-world analogy"},
                    "guiding_question": {"type": "string", "description": "Closing guiding question"},
                },
                "required": ["question", "branch", "difficulty"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_socratic",
            "description": "Ask a Socratic guiding question. Use after explanation or wrong answer. Specific to this problem.",
            "parameters": {
                "type": "object",
                "properties": {
                    "attempt":         {"type": "string", "description": "Student's last attempt (empty if none)"},
                    "acknowledgement": {"type": "string", "description": "Warm acknowledgement of the attempt"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "give_hint",
            "description": "Give a progressive hint. Hint 1=subtle, 2=formula name, 3=first step. Highly dynamic based on student bottleneck.",
            "parameters": {
                "type": "object",
                "properties": {
                    "difficulty":    {"type": "string",  "description": "easy | medium | hard"},
                    "hint_number":   {"type": "integer", "description": "1, 2, or 3"},
                    "hint_type":     {"type": "string",  "enum": ["conceptual", "formula", "next_step", "debugging", "general"], "description": "Type of hint suited for the student's current struggle"},
                    "student_bottleneck": {"type": "string", "description": "Brief description of where the student is stuck (e.g. 'sign error', 'forgot chain rule')"},
                    "micro_question": {"type": "string", "description": "Short follow-up to keep student engaged"},
                },
                "required": ["difficulty", "hint_number", "hint_type", "student_bottleneck"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "evaluate_answer",
            "description": "Evaluate the student's answer. Always call when student submits. NEVER say wrong/incorrect.",
            "parameters": {
                "type": "object",
                "properties": {
                    "correct_answer":   {"type": "string",  "description": "The correct answer"},
                    "student_answer":   {"type": "string",  "description": "The student's answer"},
                    "attempt_count":    {"type": "integer", "description": "Total attempts so far"},
                    "correct_elements": {"type": "array", "items": {"type": "string"}, "description": "What student got right"},
                    "missing_elements": {"type": "array", "items": {"type": "string"}, "description": "What was missing"},
                    "error_type": {
                        "type": "string",
                        "enum": ["sign_error", "calculation_error", "wrong_formula",
                                 "missing_step", "conceptual_error", "none"],
                        "description": "Error category",
                    },
                },
                "required": ["correct_answer", "student_answer"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "give_full_solution",
            "description": "Full step-by-step solution. Use ONLY when student gives up or all 3 hints exhausted.",
            "parameters": {
                "type": "object",
                "properties": {
                    "difficulty":       {"type": "string", "description": "easy | medium | hard"},
                    "key_insights":     {"type": "array", "items": {"type": "string"}, "description": "2-3 key takeaways"},
                    "giveup_triggered": {"type": "boolean", "description": "True if student gave up explicitly"},
                },
                "required": ["difficulty"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_practice",
            "description": "Generate a new practice problem. Problem statement ONLY — NO solution embedded.",
            "parameters": {
                "type": "object",
                "properties": {
                    "branch":            {"type": "string", "description": "Math branch"},
                    "original_question": {"type": "string", "description": "Original problem for context"},
                    "difficulty":        {"type": "string", "description": "similar | harder"},
                    "motivation_line":   {"type": "string", "description": "Short motivating closing line"},
                },
                "required": ["branch", "original_question", "difficulty"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "end_session",
            "description": "Generate session summary and end the session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "strengths":       {"type": "array", "items": {"type": "string"}, "description": "What student did well"},
                    "areas_to_review": {"type": "array", "items": {"type": "string"}, "description": "Topics to revisit"},
                    "encouragement":   {"type": "string", "description": "Warm closing message"},
                },
                "required": [],
            },
        },
    },
]


# ─────────────────────────────────────────────
# SHARED HELPER (also used by StudyAgent.hint fast-path)
# ─────────────────────────────────────────────

def _hint_limit_message(question: str) -> str:
    """Localised message shown when the hint quota (MAX_HINTS) is exhausted."""
    if detect_language(question) == "ar":
        return "💪 لقد استخدمت كل التلميحات! حاول الحل بنفسك أو اضغط على \"الحل\" للحصول على الحل الكامل."
    return "💪 You've used all your hints! Try solving it or press Solve for the full solution."


# ─────────────────────────────────────────────
# TOOL IMPLEMENTATIONS
# ─────────────────────────────────────────────

def _tool_explain_concept(session_id: str, question: str, branch: str,
                           difficulty: str, memory_ctx: str = "",
                           analogy: str = "", guiding_question: str = "") -> dict:
    explanation = _agent_mod.study_llm.explain_concept(question, branch, difficulty, memory_ctx=memory_ctx)
    try:
        update_session(session_id, {"concept_explanation": explanation})
        set_phase(session_id, "socratic")
    except Exception:
        pass
    return {
        "tool":                "explain_concept",
        "concept_explanation": explanation,
        "analogy":             analogy,
        "guiding_question":    guiding_question,
        "next_phase":          "socratic",
    }


def _tool_ask_socratic(session_id: str, question: str, branch: str,
                        attempt: str = "", acknowledgement: str = "") -> dict:
    socratic_q = _agent_mod.study_llm.generate_socratic_question(question, branch, attempt)
    try:
        session  = get_session(session_id)
        existing = session.get("socratic_questions", []) if session else []
        update_session(session_id, {"socratic_questions": existing + [socratic_q]})
        set_phase(session_id, "check")
    except Exception:
        pass
    return {
        "tool":              "ask_socratic",
        "socratic_question": socratic_q,
        "acknowledgement":   acknowledgement,
        "next_phase":        "check",
    }


def _tool_give_hint(session_id: str, question: str, branch: str,
                     difficulty: str, hint_number: int,
                     hint_type: str = "general", student_bottleneck: str = "",
                     memory_ctx: str = "", micro_question: str = "") -> dict:
    # Audit fix #3: atomic check-and-increment so two parallel hint requests
    # cannot both pass the gate and grant 4 hints out of 3. If reservation
    # fails the slot is unchanged and we surface the limit message.
    granted, hints_used_after = try_use_hint(session_id)
    if not granted:
        return {
            "tool":               "give_hint",
            "hint_text":          _hint_limit_message(question),
            "hints_remaining":    0,
            "hint_limit_reached": True,
        }

    hint_text = _agent_mod.study_llm.generate_hint(
        question, branch, hint_number, difficulty, memory_ctx=memory_ctx,
        hint_type=hint_type, student_bottleneck=student_bottleneck
    )
    hints_remaining = max(0, MAX_HINTS - hints_used_after)
    return {
        "tool":            "give_hint",
        "hint_text":       hint_text,
        "hint_level":      hint_number,
        "micro_question":  micro_question,
        "hints_remaining": hints_remaining,
        "next_phase":      "check",
    }


def _tool_evaluate_answer(session_id: str, user_id: str, question: str,
                           branch: str, correct_answer: str, student_answer: str,
                           attempt_count: int = 1,
                           correct_elements: Optional[list] = None,
                           missing_elements: Optional[list] = None,
                           error_type: str = "none") -> dict:
    # Audit fix #4: surface evaluator degradation rather than silently
    # falling back to whitespace-strip equality (which marks "1/2" vs "0.5"
    # wrong without any signal to the caller).
    evaluator_degraded = False
    try:
        is_correct = _agent_mod.study_llm.evaluate_answer(correct_answer, student_answer)
    except Exception as exc:
        logger.warning(
            "[Evaluator] LLM check failed (%s); using strict-equality fallback. "
            "Result will be flagged as evaluator_degraded.", exc,
        )
        evaluator_degraded = True
        is_correct = (
            student_answer.strip().lower().replace(" ", "") ==
            correct_answer.strip().lower().replace(" ", "")
        )

    if is_correct:
        lang       = detect_language(question or student_answer)
        feedback   = "✅ ممتاز! 🎉 إجابة صحيحة!" if lang == "ar" else "✅ Correct! 🎉 Well done!"
        next_phase = "practice"
        needs_mini_lesson = False
    else:
        try:
            feedback = _agent_mod.study_llm.analyze_mistake(question, correct_answer, student_answer, attempt_count)
        except Exception as exc:
            logger.warning("[Evaluator] analyze_mistake failed: %s", exc)
            feedback = (
                "قريب جداً 👀 — راجع خطواتك خطوة بخطوة."
                if detect_language(question or student_answer) == "ar"
                else "Almost there 👀 — review your steps one by one."
            )
        next_phase = "socratic"
        needs_mini_lesson = False
        et_key = str(error_type or "none").strip() or "none"
        # Only count *classified* errors. "none" means the model didn't categorise the
        # mistake — counting it would trigger a mini-lesson on a non-existent error type.
        if et_key != "none":
            new_count = increment_error_counter(session_id, et_key)
            needs_mini_lesson = new_count >= 2

    try:
        add_attempt(session_id, student_answer, feedback, is_correct)
        set_phase(session_id, next_phase)
    except Exception:
        pass

    if user_id:
        _agent_mod._fire_and_forget(_agent_mod._memory.learn(user_id, [
            {"role": "user",      "content": f"[Check] Problem: {question} | Branch: {branch} | Student: {student_answer} | Correct: {correct_answer}"},
            {"role": "assistant", "content": f"Result: {'correct' if is_correct else 'incorrect'}. Feedback: {feedback}"},
        ]))

    return {
        "tool":               "evaluate_answer",
        "is_correct":         is_correct,
        "mistake_feedback":   feedback,
        "correct_elements":   correct_elements or [],
        "missing_elements":   missing_elements or [],
        "error_type":         error_type,
        "next_phase":         next_phase,
        "needs_mini_lesson":  needs_mini_lesson,
        "evaluator_degraded": evaluator_degraded,
    }


def _tool_give_full_solution(session_id: str, question: str, branch: str,
                              difficulty: str, key_insights: Optional[list] = None,
                              giveup_triggered: bool = True) -> dict:
    solution = _agent_mod.study_llm.solve_direct(question, branch, difficulty)
    try:
        set_phase(session_id, "practice")
    except Exception:
        pass
    return {
        "tool":             "give_full_solution",
        "solve_output":     solution,
        "key_insights":     key_insights or [],
        "giveup_triggered": giveup_triggered,
        "next_phase":       "practice",
    }


def _tool_generate_practice(session_id: str, user_id: str, branch: str,
                              original_question: str, difficulty: str = "similar",
                              motivation_line: str = "") -> dict:
    if difficulty == "harder":
        practice = _agent_mod.study_llm.generate_harder_practice(branch, original_question)
    else:
        practice = _agent_mod.study_llm.generate_practice(branch, original_question, difficulty="similar")

    # Audit fix #1: the *active* problem is now this practice. Subsequent
    # check / hint / solve actions read session.question, so we must update it
    # — otherwise analyze_mistake references the original problem while the
    # student is solving the new practice. session.original_question is left
    # untouched so future generate_practice calls still anchor to the source.
    try:
        existing = list((get_session(session_id) or {}).get("practice_problems") or [])
        existing.append({"question": practice, "difficulty": difficulty, "branch": branch})
        update_session(session_id, {
            "practice_problems": existing,
            "question":          practice,
        })
        set_phase(session_id, "practice")
    except Exception:
        pass

    if user_id:
        _agent_mod._fire_and_forget(_agent_mod._memory.learn(user_id, [
            {"role": "user",      "content": f"[Practice] Original: {original_question} | Branch: {branch}"},
            {"role": "assistant", "content": f"Generated practice ({difficulty}): {practice}"},
        ]))

    return {
        "tool":             "generate_practice",
        "practice_problem": practice,
        "difficulty_level": difficulty,
        "motivation_line":  motivation_line,
        "next_phase":       "practice",
    }


# ─────────────────────────────────────────────
# MCQ TOOLS  (Khan-style quiz, PR-A)
# ─────────────────────────────────────────────
#
# These two helpers wrap the LLM + the MCQ test store. They are intentionally
# kept OUT of STUDY_TOOLS (the agent's tool registry) because MCQ generation
# is route-initiated, not agent-initiated — the tutoring agent has no reason
# to invent a 4-option quiz mid-conversation.

def generate_mcq(branch: str, difficulty: str, count: int, source_question: str = "") -> dict:
    """Generate an MCQ test, persist it, return a CLIENT-SAFE payload.

    Steps:
      1) Ask the LLM for `count` questions in JSON
      2) Persist the FULL records (including correctOptionId) under a fresh test_id
      3) Return the test_id + the same questions with correctOptionId / explanation
         stripped so the answer never leaves the server.

    Raises ValueError if the LLM payload cannot be parsed; the route turns
    that into a 502 for the client.
    """
    if count not in (1, 5):
        # The frontend only ever asks for 1 or 5, but defend against random
        # callers — clamp to 5 max to avoid blowing the token budget.
        count = 1 if count <= 1 else 5

    full_questions = _agent_mod.study_llm.generate_mcq(branch, difficulty, count, source_question=source_question)
    if not full_questions:
        raise ValueError("LLM returned no MCQs")

    test_id = create_mcq_test(branch, difficulty, full_questions)

    return {
        "test_id":    test_id,
        "branch":     branch,
        "difficulty": difficulty,
        # MCQ-SAFE: every question is run through `strip_correct_option` so
        # `correctOptionId` and `explanation` are NEVER serialised here.
        "questions":  [strip_correct_option(q) for q in full_questions],
    }


def check_mcq_answer(test_id: str, question_id: str, selected_option_id: str) -> dict:
    """Score one MCQ answer against the server-side record.

    Returns the canonical response shape consumed by /study/mcq/check:
      { is_correct, correct_option_id, explanation, points_awarded }

    Returns `error` if the test or question is unknown — the route maps that
    to a 404 so the client can show a friendly "test expired" message.
    """
    test = get_mcq_test(test_id)
    if not test:
        return {"error": "test_not_found"}

    question = get_mcq_question(test_id, question_id)
    if not question:
        return {"error": "question_not_found"}

    correct = str(question.get("correctOptionId") or "").lower()
    selected = str(selected_option_id or "").lower()
    is_correct = (selected == correct and correct in ("a", "b", "c", "d"))

    # Bilingual explanation — pick by the question text's own language so we
    # don't need the client to forward a `lang` header (it can render the
    # English version regardless, but Arabic UI gets the Arabic explanation).
    explanation_en = str(question.get("explanation") or "").strip()
    explanation_ar = str(question.get("explanationAr") or "").strip()
    qtext = str(question.get("question") or "")
    explanation = explanation_ar if detect_language(qtext) == "ar" and explanation_ar else explanation_en

    return {
        "is_correct":        is_correct,
        "correct_option_id": correct,
        "explanation":       explanation,
        "explanation_ar":    explanation_ar,
        "explanation_en":    explanation_en,
        "points_awarded":    1 if is_correct else 0,
    }


def _tool_end_session(session_id: str, user_id: str, question: str, branch: str,
                       strengths: Optional[list] = None,
                       areas_to_review: Optional[list] = None,
                       encouragement: str = "") -> dict:
    session = get_session(session_id)
    if not session:
        return {"tool": "end_session", "session_summary": "Session not found.", "stats": {}}

    history = session.get("attempt_history", [])
    stats   = {
        "problems_solved": session["problems_solved"],
        "hints_used":      session["hints_used"],
        "total_attempts":  len(history),
    }
    summary = _agent_mod.study_llm.summarize_session(history, stats)
    try:
        set_phase(session_id, "summary")
    except Exception:
        pass

    if user_id:
        _agent_mod._fire_and_forget(_agent_mod._memory.learn(user_id, [
            {"role": "user",      "content": f"[Summary] Branch: {branch} | Question: {question}"},
            {"role": "assistant", "content": f"Stats: {stats}. Summary: {summary}"},
        ]))

    return {
        "tool":            "end_session",
        "session_summary": summary,
        "stats":           stats,
        "strengths":       strengths or [],
        "areas_to_review": areas_to_review or [],
        "encouragement":   encouragement,
        "next_phase":      "summary",
        "success":         True,
    }


# ─────────────────────────────────────────────
# TOOL DISPATCHER (all args null-safe)
# ─────────────────────────────────────────────

def _dispatch_tool(tool_name: str, args: dict, context: dict) -> dict:
    sid        = context["session_id"]
    uid        = context.get("user_id", "") or ""
    memory_ctx = context.get("memory_ctx", "") or ""
    question   = context.get("question", "") or ""
    branch     = context.get("branch", "algebra") or "algebra"

    logger.info("[Tools] Dispatch: %s | keys: %s", tool_name, list(args.keys()))

    try:
        if tool_name == "explain_concept":
            # SAFETY: question is locked to the session's active problem. The model
            # may try to "clean up" the question via args["question"] — we ignore
            # that to prevent silent problem-swaps mid-session. (System prompt
            # also forbids it.)
            return _tool_explain_concept(
                sid, question,
                str(args.get("branch", branch) or branch),
                str(args.get("difficulty", "medium") or "medium"),
                memory_ctx,
                str(args.get("analogy", "") or ""),
                str(args.get("guiding_question", "") or ""),
            )

        if tool_name == "ask_socratic":
            return _tool_ask_socratic(
                sid, question, branch,
                str(args.get("attempt", "") or ""),
                str(args.get("acknowledgement", "") or ""),
            )

        if tool_name == "give_hint":
            hn = args.get("hint_number", 1)
            try:
                hn = int(hn)
            except (TypeError, ValueError):
                hn = 1
            return _tool_give_hint(
                sid, question, branch,
                str(args.get("difficulty", "medium") or "medium"),
                max(1, min(3, hn)),
                str(args.get("hint_type", "general") or "general"),
                str(args.get("student_bottleneck", "") or ""),
                memory_ctx,
                str(args.get("micro_question", "") or ""),
            )

        if tool_name == "evaluate_answer":
            ac = args.get("attempt_count", 1)
            try:
                ac = int(ac)
            except (TypeError, ValueError):
                ac = 1
            return _tool_evaluate_answer(
                sid, uid, question, branch,
                str(args.get("correct_answer", "") or ""),
                str(args.get("student_answer", "") or ""),
                ac,
                args.get("correct_elements") if isinstance(args.get("correct_elements"), list) else None,
                args.get("missing_elements")  if isinstance(args.get("missing_elements"),  list) else None,
                str(args.get("error_type", "none") or "none"),
            )

        if tool_name == "give_full_solution":
            ki = args.get("key_insights")
            return _tool_give_full_solution(
                sid, question, branch,
                str(args.get("difficulty", "medium") or "medium"),
                ki if isinstance(ki, list) else None,
                bool(args.get("giveup_triggered", True)),
            )

        if tool_name == "generate_practice":
            diff = str(args.get("difficulty", "similar") or "similar")
            if diff not in ("similar", "harder"):
                diff = "similar"
            # Audit fix #1: anchor practice generation to the IMMUTABLE
            # original problem so successive practices don't drift further
            # and further away from what the student started with.
            session = get_session(sid) or {}
            base_q  = (
                session.get("original_question")
                or session.get("question")
                or question
            )
            return _tool_generate_practice(
                sid, uid,
                str(args.get("branch", branch) or branch),
                base_q,
                diff,
                str(args.get("motivation_line", "") or ""),
            )

        if tool_name == "end_session":
            # session_id is ALWAYS injected from backend — never from args
            s = args.get("strengths")
            a = args.get("areas_to_review")
            return _tool_end_session(
                sid, uid, question, branch,
                s if isinstance(s, list) else None,
                a if isinstance(a, list) else None,
                str(args.get("encouragement", "") or ""),
            )

    except Exception as exc:
        logger.error("[Dispatch] Tool %s failed: %s", tool_name, exc)
        return {"error": str(exc), "tool": tool_name}

    return {"error": f"Unknown tool: {tool_name}"}
