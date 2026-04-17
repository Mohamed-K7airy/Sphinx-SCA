"""
Sphinx-SCA — Study Mode Agent (v8 — Merged)
============================================

Base: study_agent_(1).py (v7.1) — الملف الأساسي للمشروع
Additions from v2:
    - Tool schemas أكثر تفصيلاً (error_type enum، correct_elements، missing_elements، key_insights)
    - ToolResult class لتنظيم نتائج الأدوات
    - give_hint progressive levels (1=subtle, 2=moderate, 3=near-solution)
    - end_session schema يشمل strengths و areas_to_review
    - generate_practice يدعم motivation_line

Related Files (unchanged):
    - study_llm.py     : All LLM functions
    - study_session.py : In-memory session store
    - app.py           : Endpoints that call get_study_agent()
    - memory_manager.py: Saves and retrieves user context
    - llm_manager.py   : Shared Groq client

Available Tools:
    1. explain_concept      -> Explains the concept and starts the session
    2. ask_socratic         -> Asks a Socratic question to make the student think
    3. give_hint            -> Gives a progressive hint (max 3)
    4. evaluate_answer      -> Evaluates the student's answer and decides next step
    5. give_full_solution   -> Gives the full solution (give up or solve)
    6. generate_practice    -> Generates a similar or harder practice problem
    7. end_session          -> Summarizes and ends the session

Stopping Condition:
    When the LLM responds without a tool_call -> "done, result is ready"

Bug Fix (v7.1 — kept):
    - max_steps = 6 to allow the LLM to write a final message after tool execution
    - _format_result_as_message() as a guaranteed fallback
    - Explicit instruction in STUDY_SYSTEM_PROMPT to always write a final response
"""

import os
import sys
import json
import logging
import threading
import asyncio
from typing import Optional, TypedDict

# ─────────────────────────────────────────────
# PATH SETUP — ensures imports work in all run contexts
# ─────────────────────────────────────────────

if __name__ == "__main__" and __package__ is None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

# ─────────────────────────────────────────────
# IMPORTS
# ─────────────────────────────────────────────

try:
    from backend.study_llm import StudyLLM
except ImportError:
    from study_llm import StudyLLM

try:
    from backend.study_session import (
        create_session, get_session, update_session,
        set_phase, add_attempt, use_hint, can_use_hint, end_session,
    )
except ImportError:
    from study_session import (
        create_session, get_session, update_session,
        set_phase, add_attempt, use_hint, can_use_hint, end_session,
    )

try:
    from backend.memory_manager import MemoryManager
except ImportError:
    from memory_manager import MemoryManager

try:
    from backend.llm_manager import client as groq_client
except ImportError:
    from llm_manager import client as groq_client

logger    = logging.getLogger("sphinx-study-agent-v8")
study_llm = StudyLLM()
_memory   = MemoryManager()


# ═══════════════════════════════════════════════════════════════════
# BACKGROUND MEMORY HELPER
# ═══════════════════════════════════════════════════════════════════

# ✅ FIX (C-07): Use a single persistent background event loop instead of
# creating a new thread + event loop for every memory task.
_bg_loop: Optional[asyncio.AbstractEventLoop] = None
_bg_thread: Optional[threading.Thread] = None
_bg_lock = threading.Lock()

def _get_background_loop() -> asyncio.AbstractEventLoop:
    """Return the shared background event loop, starting it lazily."""
    global _bg_loop, _bg_thread
    if _bg_loop is not None and _bg_loop.is_running():
        return _bg_loop
    with _bg_lock:
        if _bg_loop is not None and _bg_loop.is_running():
            return _bg_loop
        _bg_loop = asyncio.new_event_loop()
        _bg_thread = threading.Thread(
            target=_bg_loop.run_forever, daemon=True, name="study-memory-bg"
        )
        _bg_thread.start()
    return _bg_loop

def _fire_and_forget(coro):
    """
    Schedule an async coroutine on the shared background event loop.
    No new thread or event loop is created per call.
    """
    loop = _get_background_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    # Attach a callback to log any exceptions without blocking
    def _on_done(fut):
        try:
            fut.result()
        except Exception as e:
            logger.warning("[Memory background task] %s", e)
    future.add_done_callback(_on_done)


# ═══════════════════════════════════════════════════════════════════
# SYSTEM PROMPT
# ═══════════════════════════════════════════════════════════════════

STUDY_SYSTEM_PROMPT = """You are Sphinx-SCA, an AI Math Tutor Agent.
You were built by students at Sphinx University, Egypt.

YOUR GOAL: Guide the student to UNDERSTAND and SOLVE the problem themselves.
You decide which tool to call based on the current session state.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RESPONSE RULE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After calling ANY tool and receiving the result, you MUST write a final
text response to the student using that result. Do NOT stop after the
tool call — always deliver the content to the student in a warm,
encouraging message. Failing to respond after a tool call is an error.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION RULES — follow these strictly:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. NEW SESSION (action=start):
   - If difficulty=easy  -> call give_full_solution directly (saves time)
   - If difficulty=hard  -> call explain_concept, then ask_socratic
   - If difficulty=medium -> call explain_concept only

2. STUDENT SUBMITTED ANSWER (action=check):
   - Always call evaluate_answer first
   - If correct  -> call generate_practice
   - If wrong, attempt_count=1 -> call ask_socratic (give them a chance)
   - If wrong, attempt_count>=2 -> call give_hint

3. STUDENT ASKED FOR HINT (action=hint):
   - Check hints_used in session — if >= 3, call give_full_solution instead
   - Otherwise call give_hint

4. STUDENT GAVE UP (action=giveup or action=solve):
   - Always call give_full_solution — no questions, no hints

5. STUDENT WANTS NEXT PROBLEM (action=next):
   - Call generate_practice with difficulty=similar

6. SESSION END (action=summary or action=finish):
   - Call end_session to generate summary

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE RULES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Detect the language from the question (Arabic or English)
- Respond in the SAME language throughout the session
- Math formulas always use LaTeX

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERSONALITY:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Warm, encouraging, patient
- Never give the answer unless explicitly asked (giveup/solve)
- End every response with a guiding question (except give_full_solution and end_session)
- Use emojis naturally: 💡 🎯 🎉 👀 💪
- NEVER use the words 'wrong' or 'incorrect' — say 'almost there' or 'قريب جداً'

IMPORTANT: When memory context is provided, use it silently to personalize — never mention it.
"""


# ═══════════════════════════════════════════════════════════════════
# TOOL SCHEMAS — Enhanced with detailed fields from v2
# ═══════════════════════════════════════════════════════════════════

STUDY_TOOLS = [

    # ── Tool 1: Concept Explanation ──────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "explain_concept",
            "description": "Explain the math concept behind the problem. Use at the START of a session to orient the student. NEVER reveal the solution — frame it as context, then end with a guiding question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question":        {"type": "string", "description": "The math problem"},
                    "branch":          {"type": "string", "description": "Math branch (algebra, calculus, etc.)"},
                    "difficulty":      {"type": "string", "description": "easy | medium | hard"},
                    "analogy":         {"type": "string", "description": "Optional real-world analogy to make the concept intuitive"},
                    "guiding_question":{"type": "string", "description": "One question at the end to activate the student's thinking"},
                },
                "required": ["question", "branch", "difficulty"],
            },
        },
    },

    # ── Tool 2: Socratic Question ─────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "ask_socratic",
            "description": "Ask a Socratic guiding question to push the student toward the solution without giving it away. Use after explanation or after a wrong answer. Questions must be specific to this problem — not generic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question":        {"type": "string", "description": "The math problem"},
                    "branch":          {"type": "string", "description": "Math branch"},
                    "attempt":         {"type": "string", "description": "Student's last attempt (empty if none yet)"},
                    "acknowledgement": {"type": "string", "description": "Brief, warm acknowledgement of the student's attempt (if any)"},
                },
                "required": ["question", "branch"],
            },
        },
    },

    # ── Tool 3: Progressive Hint ──────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "give_hint",
            "description": (
                "Give a progressive hint. "
                "Hint 1=subtle nudge (technique category). "
                "Hint 2=moderate (name the formula). "
                "Hint 3=near-solution (show first calculation step). "
                "Check hints_used before calling — max 3 hints per session."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question":      {"type": "string",  "description": "The math problem"},
                    "branch":        {"type": "string",  "description": "Math branch"},
                    "difficulty":    {"type": "string",  "description": "easy | medium | hard"},
                    "hint_number":   {"type": "integer", "description": "Which hint to give: 1, 2, or 3"},
                    "micro_question":{"type": "string",  "description": "A short follow-up question to keep the student engaged"},
                },
                "required": ["question", "branch", "difficulty", "hint_number"],
            },
        },
    },

    # ── Tool 4: Answer Evaluation ─────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "evaluate_answer",
            "description": "Evaluate the student's answer. Returns is_correct, feedback, and error analysis. Always call this when the student submits an answer. NEVER use the words 'wrong' or 'incorrect'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question":         {"type": "string",  "description": "The math problem"},
                    "correct_answer":   {"type": "string",  "description": "The correct answer"},
                    "student_answer":   {"type": "string",  "description": "The student's submitted answer"},
                    "attempt_count":    {"type": "integer", "description": "How many attempts the student has made so far"},
                    "is_partial":       {"type": "boolean", "description": "Whether the answer captures some correct elements"},
                    "correct_elements": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Parts the student got right",
                    },
                    "missing_elements": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "What was missing or needs correction",
                    },
                    "error_type": {
                        "type": "string",
                        "enum": ["sign_error", "calculation_error", "wrong_formula",
                                 "missing_step", "conceptual_error", "none"],
                        "description": "Category of the error (or 'none' if correct)",
                    },
                },
                "required": ["question", "correct_answer", "student_answer"],
            },
        },
    },

    # ── Tool 5: Full Solution ─────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "give_full_solution",
            "description": "Give the complete step-by-step solution with key insights. Use ONLY when student gives up (action=giveup/solve) or has used all 3 hints. Always explain the reasoning — not just the answer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question":         {"type": "string", "description": "The math problem"},
                    "branch":           {"type": "string", "description": "Math branch"},
                    "difficulty":       {"type": "string", "description": "easy | medium | hard"},
                    "key_insights": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "2–3 key takeaways the student should internalize",
                    },
                    "giveup_triggered": {"type": "boolean", "description": "True if student explicitly gave up; False if auto-triggered"},
                },
                "required": ["question", "branch", "difficulty"],
            },
        },
    },

    # ── Tool 6: Practice Problem Generator ───────────────────────
    {
        "type": "function",
        "function": {
            "name": "generate_practice",
            "description": "Generate a new practice problem after the student solves one. Problem statement ONLY — NO solution or hints embedded. Adjust difficulty based on performance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "branch":            {"type": "string", "description": "Math branch"},
                    "original_question": {"type": "string", "description": "The original problem (for context)"},
                    "difficulty":        {"type": "string", "description": "similar | harder"},
                    "motivation_line":   {"type": "string", "description": "Short motivating closing line (e.g. '🔥 Level up!')"},
                },
                "required": ["branch", "original_question", "difficulty"],
            },
        },
    },

    # ── Tool 7: End Session ───────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "end_session",
            "description": "Generate a session summary and end the session. Call when student asks to finish or action=summary/finish. Celebrate wins, flag areas to review, close warmly.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id":     {"type": "string", "description": "The session UUID"},
                    "strengths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "What the student demonstrated well",
                    },
                    "areas_to_review": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Topics to revisit in the next session",
                    },
                    "encouragement":  {"type": "string", "description": "Warm, motivating closing message"},
                },
                "required": ["session_id"],
            },
        },
    },
]


# ═══════════════════════════════════════════════════════════════════
# TOOL RESULT — wraps tool execution outcome (from v2)
# Separates display (shown to student) from content (returned to LLM)
# ═══════════════════════════════════════════════════════════════════

class ToolResult:
    """Wraps the outcome of a tool execution."""

    def __init__(
        self,
        tool_name:   str,
        content:     str,
        display:     str,
        state_delta: dict = None,
        should_end:  bool = False,
    ):
        self.tool_name   = tool_name
        self.content     = content       # text returned to the LLM as tool result
        self.display     = display       # markdown shown to the student
        self.state_delta = state_delta or {}
        self.should_end  = should_end


# ═══════════════════════════════════════════════════════════════════
# TOOL IMPLEMENTATIONS
# ═══════════════════════════════════════════════════════════════════

def _tool_explain_concept(session_id: str, question: str, branch: str,
                          difficulty: str, memory_ctx: str = "",
                          analogy: str = "", guiding_question: str = "") -> dict:
    explanation = study_llm.explain_concept(question, branch, difficulty, memory_ctx=memory_ctx)
    update_session(session_id, {"concept_explanation": explanation})
    set_phase(session_id, "socratic")
    return {
        "tool":                "explain_concept",
        "concept_explanation": explanation,
        "analogy":             analogy,
        "guiding_question":    guiding_question,
        "next_phase":          "socratic",
    }


def _tool_ask_socratic(session_id: str, question: str, branch: str,
                       attempt: str = "", acknowledgement: str = "") -> dict:
    socratic_q = study_llm.generate_socratic_question(question, branch, attempt)

    session = get_session(session_id)
    if session:
        existing = session.get("socratic_questions", [])
        update_session(session_id, {"socratic_questions": existing + [socratic_q]})
    set_phase(session_id, "check")

    return {
        "tool":              "ask_socratic",
        "socratic_question": socratic_q,
        "acknowledgement":   acknowledgement,
        "next_phase":        "check",
    }


def _tool_give_hint(session_id: str, question: str, branch: str,
                    difficulty: str, hint_number: int,
                    memory_ctx: str = "", micro_question: str = "") -> dict:
    if not can_use_hint(session_id):
        return {
            "tool":               "give_hint",
            "hint_text":          "💪 You've used all your hints! Try solving it or press Solve for the full solution.",
            "hints_remaining":    0,
            "hint_limit_reached": True,
        }

    hint_text = study_llm.generate_hint(
        question, branch, hint_number, difficulty, memory_ctx=memory_ctx
    )
    use_hint(session_id)

    session         = get_session(session_id)
    hints_used      = session["hints_used"] if session else hint_number
    hints_remaining = max(0, 3 - hints_used)

    return {
        "tool":            "give_hint",
        "hint_text":       hint_text,
        "hint_level":      hint_number,
        "micro_question":  micro_question,
        "hints_remaining": hints_remaining,
        "next_phase":      "check",
    }


def _tool_evaluate_answer(session_id: str, user_id: str, question: str,
                           branch: str, correct_answer: str,
                           student_answer: str, attempt_count: int = 1,
                           correct_elements: list = None,
                           missing_elements: list = None,
                           error_type: str = "none") -> dict:
    try:
        is_correct = study_llm.evaluate_answer(correct_answer, student_answer)
    except Exception:
        is_correct = (student_answer.strip().lower().replace(" ", "") ==
                      correct_answer.strip().lower().replace(" ", ""))

    if is_correct:
        feedback   = "✅ Correct! 🎉 Well done!"
        next_phase = "practice"
    else:
        feedback   = study_llm.analyze_mistake(
            question, correct_answer, student_answer, attempt_count
        )
        next_phase = "socratic"

    add_attempt(session_id, student_answer, feedback, is_correct)
    set_phase(session_id, next_phase)

    if user_id:
        _fire_and_forget(_memory.learn(user_id, [
            {"role": "user",      "content": f"[Check] Problem: {question} | Branch: {branch} | Student: {student_answer} | Correct: {correct_answer}"},
            {"role": "assistant", "content": f"Result: {'correct' if is_correct else 'incorrect'}. Feedback: {feedback}"},
        ]))

    return {
        "tool":             "evaluate_answer",
        "is_correct":       is_correct,
        "mistake_feedback": feedback,
        "correct_elements": correct_elements or [],
        "missing_elements": missing_elements or [],
        "error_type":       error_type,
        "next_phase":       next_phase,
    }


def _tool_give_full_solution(session_id: str, question: str, branch: str,
                              difficulty: str,
                              key_insights: list = None,
                              giveup_triggered: bool = True) -> dict:
    solution = study_llm.solve_direct(question, branch, difficulty)
    set_phase(session_id, "practice")

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
        practice = study_llm.generate_harder_practice(branch, original_question)
    else:
        practice = study_llm.generate_practice(branch, original_question, difficulty="similar")

    update_session(session_id, {
        "practice_problems": [{
            "question":   practice,
            "difficulty": difficulty,
            "branch":     branch,
        }]
    })
    set_phase(session_id, "summary")

    if user_id:
        _fire_and_forget(_memory.learn(user_id, [
            {"role": "user",      "content": f"[Practice] Original: {original_question} | Branch: {branch}"},
            {"role": "assistant", "content": f"Generated practice ({difficulty}): {practice}"},
        ]))

    return {
        "tool":             "generate_practice",
        "practice_problem": practice,
        "difficulty_level": difficulty,
        "motivation_line":  motivation_line,
        "next_phase":       "summary",
    }


def _tool_end_session(session_id: str, user_id: str,
                       question: str, branch: str,
                       strengths: list = None,
                       areas_to_review: list = None,
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

    summary = study_llm.summarize_session(history, stats)
    set_phase(session_id, "summary")

    if user_id:
        _fire_and_forget(_memory.learn(user_id, [
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


# ═══════════════════════════════════════════════════════════════════
# TOOL DISPATCHER
# ═══════════════════════════════════════════════════════════════════

def _dispatch_tool(tool_name: str, arguments: dict, context: dict) -> dict:
    """
    Routes each tool_call to the correct implementation function.
    context: session_id, user_id, memory_ctx, question, branch
    """
    sid        = context["session_id"]
    uid        = context.get("user_id", "")
    memory_ctx = context.get("memory_ctx", "")
    question   = context.get("question", "")
    branch     = context.get("branch", "algebra")

    logger.info(f"[Agent] Calling tool: {tool_name} | args: {list(arguments.keys())}")

    if tool_name == "explain_concept":
        return _tool_explain_concept(
            sid,
            arguments.get("question", question),
            arguments.get("branch", branch),
            arguments.get("difficulty", "medium"),
            memory_ctx,
            arguments.get("analogy", ""),
            arguments.get("guiding_question", ""),
        )

    elif tool_name == "ask_socratic":
        return _tool_ask_socratic(
            sid,
            arguments.get("question", question),
            arguments.get("branch", branch),
            arguments.get("attempt", ""),
            arguments.get("acknowledgement", ""),
        )

    elif tool_name == "give_hint":
        return _tool_give_hint(
            sid,
            arguments.get("question", question),
            arguments.get("branch", branch),
            arguments.get("difficulty", "medium"),
            arguments.get("hint_number", 1),
            memory_ctx,
            arguments.get("micro_question", ""),
        )

    elif tool_name == "evaluate_answer":
        return _tool_evaluate_answer(
            sid, uid,
            arguments.get("question", question),
            arguments.get("branch", branch),
            arguments.get("correct_answer", ""),
            arguments.get("student_answer", ""),
            arguments.get("attempt_count", 1),
            arguments.get("correct_elements"),
            arguments.get("missing_elements"),
            arguments.get("error_type", "none"),
        )

    elif tool_name == "give_full_solution":
        return _tool_give_full_solution(
            sid,
            arguments.get("question", question),
            arguments.get("branch", branch),
            arguments.get("difficulty", "medium"),
            arguments.get("key_insights"),
            arguments.get("giveup_triggered", True),
        )

    elif tool_name == "generate_practice":
        return _tool_generate_practice(
            sid, uid,
            arguments.get("branch", branch),
            arguments.get("original_question", question),
            arguments.get("difficulty", "similar"),
            arguments.get("motivation_line", ""),
        )

    elif tool_name == "end_session":
        return _tool_end_session(
            arguments.get("session_id", sid),
            uid, question, branch,
            arguments.get("strengths"),
            arguments.get("areas_to_review"),
            arguments.get("encouragement", ""),
        )

    else:
        return {"error": f"Unknown tool: {tool_name}"}


# ═══════════════════════════════════════════════════════════════════
# RESULT FORMATTER — fallback for when the LLM exits without a
# final text message (v7.1 bug fix — kept)
# ═══════════════════════════════════════════════════════════════════

def _format_result_as_message(result: dict) -> str:
    if "hint_text" in result:
        return result["hint_text"]
    if "solve_output" in result:
        return result["solve_output"]
    if "concept_explanation" in result:
        return result["concept_explanation"]
    if "socratic_question" in result:
        return result["socratic_question"]
    if "practice_problem" in result:
        return result["practice_problem"]
    if "session_summary" in result:
        return result["session_summary"]
    if "mistake_feedback" in result:
        return result["mistake_feedback"]
    return ""


# ═══════════════════════════════════════════════════════════════════
# AGENT LOOP
# ═══════════════════════════════════════════════════════════════════

def _is_done(messages: list) -> bool:
    if len(messages) < 2:
        return False
    last = messages[-1]
    return (
        last.get("role") == "assistant"
        and not last.get("tool_calls")
    )


def _run_agent_loop(user_message: str, context: dict) -> dict:
    """
    The main agent loop.
    Flow: send message -> LLM picks tool -> execute -> LLM thinks again -> done (no tool_call)
    max_steps=6 gives the LLM room to write a final response after tool execution.
    """
    if groq_client is None:
        return {"success": False, "error": "Groq client not initialized"}

    messages = [
        {"role": "system", "content": STUDY_SYSTEM_PROMPT},
        {"role": "user",   "content": user_message},
    ]

    accumulated_result = {"success": True}
    max_steps = 6

    for step in range(max_steps):
        logger.info(f"[Agent Loop] Step {step + 1}")

        try:
            completion = groq_client.chat.completions.create(
                model="openai/gpt-oss-120b",
                messages=messages,
                tools=STUDY_TOOLS,
                temperature=0.4,
                max_tokens=1000,
            )
        except Exception as e:
            logger.error(f"[Agent] LLM call failed: {e}")
            return {"success": False, "error": str(e)}

        assistant_msg = completion.choices[0].message
        messages.append(assistant_msg.model_dump(exclude_none=True))

        if _is_done(messages):
            final_text = assistant_msg.content or ""
            accumulated_result["agent_message"] = final_text
            logger.info(f"[Agent] Done after {step + 1} steps")
            break

        if not assistant_msg.tool_calls:
            break

        for tool_call in assistant_msg.tool_calls:
            tool_name = tool_call.function.name
            try:
                arguments = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                arguments = {}

            tool_result = _dispatch_tool(tool_name, arguments, context)
            accumulated_result.update(tool_result)

            messages.append({
                "role":         "tool",
                "tool_call_id": tool_call.id,
                "content":      json.dumps(tool_result, ensure_ascii=False),
            })

    # Guaranteed fallback (v7.1 bug fix)
    if "agent_message" not in accumulated_result:
        fallback = _format_result_as_message(accumulated_result)
        if fallback:
            accumulated_result["agent_message"] = fallback
            logger.info("[Agent] Used fallback formatter for agent_message")

    return accumulated_result


# ═══════════════════════════════════════════════════════════════════
# STUDY AGENT CLASS — same public API as v7 (app.py unchanged)
# ═══════════════════════════════════════════════════════════════════

class StudyAgent:
    """
    Main interface for Study Mode.
    Same methods as v7 — app.py doesn't need to change.
    """

    def __init__(self):
        self.memory = _memory
        logger.info("[StudyAgent v8] Ready ✓")

    # ── Memory Helper ─────────────────────────────────────────────

    async def _get_memory_ctx(self, user_id: str, query: str) -> str:
        if not user_id:
            return ""
        try:
            return await self.memory.get_context(user_id, query)
        except Exception as e:
            logger.warning(f"[Memory] get_context failed: {e}")
            return ""

    def _hints_remaining(self, session_id: str) -> int:
        session = get_session(session_id)
        return max(0, 3 - session["hints_used"]) if session else 3

    # ── Fast paths (no agent loop) ────────────────────────────────

    def classify_intent(self, text: str) -> str:
        return study_llm.classify_intent(text)

    def chat(self, message: str) -> dict:
        return {
            "success":          True,
            "intent":           "casual",
            "display_markdown": study_llm.chat_casual(message),
        }

    def explain(self, question: str, branch: str) -> dict:
        return {
            "success":          True,
            "intent":           "explain",
            "display_markdown": study_llm.explain_topic(question, branch),
        }

    def help_user(self, question: str, branch: str) -> dict:
        return {
            "success":          True,
            "intent":           "help",
            "display_markdown": study_llm.help_response(question, branch),
        }

    # ── Agent-based paths ─────────────────────────────────────────

    def _build_user_message(self, action: str, session_id: str,
                             question: str, branch: str,
                             difficulty: str = "", student_answer: str = "",
                             correct_answer: str = "", memory_ctx: str = "") -> str:
        session    = get_session(session_id)
        hints_used = session["hints_used"] if session else 0
        attempts   = len(session["attempt_history"]) if session else 0
        phase      = session["phase"] if session else "explain"

        msg = f"""ACTION: {action}
QUESTION: {question}
BRANCH: {branch}
DIFFICULTY: {difficulty or 'medium'}
SESSION STATE:
  - phase: {phase}
  - hints_used: {hints_used}/3
  - attempts_so_far: {attempts}"""

        if student_answer:
            msg += f"\nSTUDENT ANSWER: {student_answer}"
        if correct_answer:
            msg += f"\nCORRECT ANSWER: {correct_answer}"
        if memory_ctx:
            msg += f"\nMEMORY CONTEXT (use silently): {memory_ctx}"

        return msg

    async def start(self, question: str, branch: str, user_id: str = "") -> dict:
        memory_ctx = await self._get_memory_ctx(user_id, question)
        session_id = create_session(question, branch)

        try:
            difficulty = study_llm.classify_difficulty(question, branch)
        except Exception:
            difficulty = "medium"

        # ✅ FIX (M-04): Removed empty update_session(session_id, {}) — it did nothing

        context = {
            "session_id": session_id,
            "user_id":    user_id,
            "question":   question,
            "branch":     branch,
            "memory_ctx": memory_ctx,
        }

        user_msg = self._build_user_message(
            "start", session_id, question, branch, difficulty, memory_ctx=memory_ctx
        )

        result                    = _run_agent_loop(user_msg, context)
        result["session_id"]      = session_id
        result["difficulty"]      = difficulty
        result["hints_remaining"] = self._hints_remaining(session_id)
        return result

    async def hint(self, session_id: str, question: str, branch: str,
                   user_id: str = "") -> dict:
        memory_ctx = await self._get_memory_ctx(user_id, question)
        context    = {"session_id": session_id, "user_id": user_id,
                      "question": question, "branch": branch, "memory_ctx": memory_ctx}
        user_msg   = self._build_user_message(
            "hint", session_id, question, branch, memory_ctx=memory_ctx
        )
        result                    = _run_agent_loop(user_msg, context)
        result["session_id"]      = session_id
        result["hints_remaining"] = self._hints_remaining(session_id)
        return result

    async def solve(self, session_id: str, question: str, branch: str,
                    user_id: str = "") -> dict:
        context  = {"session_id": session_id, "user_id": user_id,
                    "question": question, "branch": branch}
        user_msg = self._build_user_message("solve", session_id, question, branch)
        result               = _run_agent_loop(user_msg, context)
        result["session_id"] = session_id
        return result

    async def giveup(self, session_id: str, question: str, branch: str,
                     user_id: str = "") -> dict:
        context  = {"session_id": session_id, "user_id": user_id,
                    "question": question, "branch": branch}
        user_msg = self._build_user_message("giveup", session_id, question, branch)
        result               = _run_agent_loop(user_msg, context)
        result["session_id"] = session_id
        return result

    async def check(self, session_id: str, question: str, branch: str,
                    student_answer: str, correct_answer: str,
                    user_id: str = "") -> dict:
        memory_ctx = await self._get_memory_ctx(user_id, question)
        context    = {"session_id": session_id, "user_id": user_id,
                      "question": question, "branch": branch, "memory_ctx": memory_ctx}
        user_msg   = self._build_user_message(
            "check", session_id, question, branch,
            student_answer=student_answer,
            correct_answer=correct_answer,
            memory_ctx=memory_ctx,
        )
        result                    = _run_agent_loop(user_msg, context)
        result["session_id"]      = session_id
        result["hints_remaining"] = self._hints_remaining(session_id)
        return result

    async def next(self, session_id: str, question: str, branch: str,
                   user_id: str = "") -> dict:
        context  = {"session_id": session_id, "user_id": user_id,
                    "question": question, "branch": branch}
        user_msg = self._build_user_message("next", session_id, question, branch)
        result               = _run_agent_loop(user_msg, context)
        result["session_id"] = session_id
        return result

    async def next_harder(self, session_id: str, question: str, branch: str,
                          user_id: str = "") -> dict:
        """Fast path — no agent loop needed."""
        practice = study_llm.generate_harder_practice(branch, question)

        session = get_session(session_id)
        if session:
            update_session(session_id, {
                "practice_problems": [{
                    "question":   practice,
                    "difficulty": "harder",
                    "branch":     branch,
                }]
            })

        if user_id:
            _fire_and_forget(_memory.learn(user_id, [
                {"role": "user",      "content": f"[Harder] Original: {question} | Branch: {branch}"},
                {"role": "assistant", "content": f"Harder practice: {practice}"},
            ]))

        return {
            "success":          True,
            "session_id":       session_id,
            "practice_problem": practice,
            "next_phase":       "summary",
            "difficulty_bump":  True,
        }

    async def finish(self, session_id: str, question: str, branch: str,
                     user_id: str = "") -> dict:
        context  = {"session_id": session_id, "user_id": user_id,
                    "question": question, "branch": branch}
        user_msg = self._build_user_message("summary", session_id, question, branch)

        result               = _run_agent_loop(user_msg, context)
        result["session_id"] = session_id

        session = get_session(session_id)
        if session:
            result["stats"] = {
                "problems_solved": session["problems_solved"],
                "hints_used":      session["hints_used"],
                "total_attempts":  len(session["attempt_history"]),
            }

        return result


# ═══════════════════════════════════════════════════════════════════
# SINGLETON
# ═══════════════════════════════════════════════════════════════════

_instance: Optional[StudyAgent] = None
_lock = threading.Lock()


def get_study_agent() -> StudyAgent:
    """Singleton factory — always returns the same StudyAgent instance (thread-safe)."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = StudyAgent()
    return _instance
