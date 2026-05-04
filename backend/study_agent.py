"""
MATHX — Study Mode Agent (v9 — Production)

Key changes vs v8:
  - session_id REMOVED from end_session tool schema (backend-injected only)
  - _run_agent_loop always builds a FRESH message list (zero context bleed)
  - Max 4 steps (2 tool round-trips) — prevents runaway loops
  - All tool dispatches null-safe with defaults
  - hint() is a direct fast-path (no agent loop)
  - next_harder() is a direct fast-path (no agent loop)
  - asyncio.to_thread wraps every sync LLM/agent call
  - Singleton thread-safe via double-checked lock
"""

import os
import sys
import json
import logging
import threading
import asyncio
import re
from typing import Optional

if __package__ is None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

try:
    from backend.study_llm import StudyLLM
except ImportError:
    from study_llm import StudyLLM

try:
    from backend.study_session import (
        create_session, get_session, update_session,
        set_phase, add_attempt, use_hint, can_use_hint, end_session,
        MAX_HINTS,
    )
except ImportError:
    from study_session import (
        create_session, get_session, update_session,
        set_phase, add_attempt, use_hint, can_use_hint, end_session,
        MAX_HINTS,
    )

try:
    from backend.memory_manager import MemoryManager
except ImportError:
    from memory_manager import MemoryManager

try:
    from backend.llm_manager import client as groq_client, gemini_client
except ImportError:
    from llm_manager import client as groq_client, gemini_client

logger    = logging.getLogger("sphinx-study-agent-v9")
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
        if _bg_loop is not None and _bg_loop.is_running():
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
# SYSTEM PROMPT
# ─────────────────────────────────────────────

STUDY_SYSTEM_PROMPT = """\
You are MATHX, an AI Math Tutor built at MATHX University, Egypt.
GOAL: Guide the student to understand and solve problems themselves.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL: After ANY tool call you MUST write a final text response to the student.
Never stop after a tool call. Always deliver the content warmly.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DECISION RULES:
1. action=start, difficulty=easy  → give_full_solution directly
   action=start, difficulty=hard  → explain_concept then ask_socratic
   action=start, difficulty=medium → explain_concept only
2. action=check → evaluate_answer first
   if correct   → generate_practice
   if wrong, attempt=1 → ask_socratic
   if wrong, attempt≥2 → give_hint
3. action=hint  → give_hint (if hints_used≥3 → give_full_solution)
4. action=giveup / action=solve → give_full_solution
5. action=next  → generate_practice (difficulty=similar)
6. action=summary / action=finish → end_session

LANGUAGE: Detect from the question. Respond in the SAME language throughout.
Math formulas always use LaTeX.

PERSONALITY: Warm, encouraging, patient. Never say 'wrong' or 'incorrect'.
Use: 'almost there' or 'قريب جداً'. End every response (except solve/summary) with a guiding question.
Emojis: 💡 🎯 🎉 👀 💪

Memory context is provided silently — use it to personalize. Never mention it.
"""


# ─────────────────────────────────────────────
# TOOL SCHEMAS  (session_id NEVER exposed)
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
            "description": "Give a progressive hint. Hint 1=subtle, 2=formula name, 3=first step. Max 3 hints per session.",
            "parameters": {
                "type": "object",
                "properties": {
                    "difficulty":    {"type": "string",  "description": "easy | medium | hard"},
                    "hint_number":   {"type": "integer", "description": "1, 2, or 3"},
                    "micro_question": {"type": "string", "description": "Short follow-up to keep student engaged"},
                },
                "required": ["difficulty", "hint_number"],
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
# TOOL IMPLEMENTATIONS
# ─────────────────────────────────────────────

def _tool_explain_concept(session_id: str, question: str, branch: str,
                           difficulty: str, memory_ctx: str = "",
                           analogy: str = "", guiding_question: str = "") -> dict:
    explanation = study_llm.explain_concept(question, branch, difficulty, memory_ctx=memory_ctx)
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
    socratic_q = study_llm.generate_socratic_question(question, branch, attempt)
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
                     memory_ctx: str = "", micro_question: str = "") -> dict:
    if not can_use_hint(session_id):
        return {
            "tool":               "give_hint",
            "hint_text":          "💪 You've used all your hints! Try solving it or press Solve for the full solution.",
            "hints_remaining":    0,
            "hint_limit_reached": True,
        }
    hint_text = study_llm.generate_hint(question, branch, hint_number, difficulty, memory_ctx=memory_ctx)
    try:
        use_hint(session_id)
    except Exception:
        pass
    session         = get_session(session_id)
    hints_used      = session["hints_used"] if session else hint_number
    hints_remaining = max(0, MAX_HINTS - hints_used)
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
    try:
        is_correct = study_llm.evaluate_answer(correct_answer, student_answer)
    except Exception:
        is_correct = (
            student_answer.strip().lower().replace(" ", "") ==
            correct_answer.strip().lower().replace(" ", "")
        )

    if is_correct:
        feedback   = "✅ Correct! 🎉 Well done!"
        next_phase = "practice"
    else:
        feedback   = study_llm.analyze_mistake(question, correct_answer, student_answer, attempt_count)
        next_phase = "socratic"

    try:
        add_attempt(session_id, student_answer, feedback, is_correct)
        set_phase(session_id, next_phase)
    except Exception:
        pass

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
                              difficulty: str, key_insights: Optional[list] = None,
                              giveup_triggered: bool = True) -> dict:
    solution = study_llm.solve_direct(question, branch, difficulty)
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
        practice = study_llm.generate_harder_practice(branch, original_question)
    else:
        practice = study_llm.generate_practice(branch, original_question, difficulty="similar")

    try:
        update_session(session_id, {"practice_problems": [{"question": practice, "difficulty": difficulty, "branch": branch}]})
        set_phase(session_id, "practice")
    except Exception:
        pass

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
        "next_phase":       "practice",
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
    summary = study_llm.summarize_session(history, stats)
    try:
        set_phase(session_id, "summary")
    except Exception:
        pass

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


# ─────────────────────────────────────────────
# TOOL DISPATCHER (all args null-safe)
# ─────────────────────────────────────────────

def _dispatch_tool(tool_name: str, args: dict, context: dict) -> dict:
    sid        = context["session_id"]
    uid        = context.get("user_id", "") or ""
    memory_ctx = context.get("memory_ctx", "") or ""
    question   = context.get("question", "") or ""
    branch     = context.get("branch", "algebra") or "algebra"

    logger.info("[Agent] Tool: %s | keys: %s", tool_name, list(args.keys()))

    try:
        if tool_name == "explain_concept":
            llm_question = str(args.get("question", question) or question)
            if llm_question and llm_question != question:
                try:
                    update_session(sid, {"question": llm_question})
                except Exception:
                    pass
            return _tool_explain_concept(
                sid, llm_question,
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
            return _tool_generate_practice(
                sid, uid,
                str(args.get("branch", branch) or branch),
                str(args.get("original_question", question) or question),
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


# ─────────────────────────────────────────────
# FALLBACK FORMATTER
# ─────────────────────────────────────────────

def _format_result_as_message(result: dict) -> str:
    for key in ("hint_text", "solve_output", "concept_explanation",
                "socratic_question", "practice_problem",
                "session_summary", "mistake_feedback"):
        if key in result and result[key]:
            return str(result[key])
    return ""


# ─────────────────────────────────────────────
# AGENT LOOP  (fresh messages every call, max 4 steps)
# ─────────────────────────────────────────────

def _run_agent_loop(user_message: str, context: dict) -> dict:
    if groq_client is None:
        return {"success": False, "error": "Groq client not initialized"}

    # Always start fresh — zero context bleed between calls
    messages = [
        {"role": "system", "content": STUDY_SYSTEM_PROMPT},
        {"role": "user",   "content": user_message},
    ]

    accumulated: dict = {"success": True}
    max_steps = 4

    for step in range(max_steps):
        logger.info("[Agent] Step %d", step + 1)
        try:
            if gemini_client is not None:
                completion = gemini_client.chat.completions.create(
                    model       = "gemini-2.5-flash",
                    messages    = messages,
                    tools       = STUDY_TOOLS,
                    temperature = 0.4,
                    max_tokens  = 2500,
                )
            else:
                completion = groq_client.chat.completions.create(
                    model       = "openai/gpt-oss-120b",
                    messages    = messages,
                    tools       = STUDY_TOOLS,
                    temperature = 0.4,
                    max_tokens  = 2500,
                )
        except Exception as exc:
            logger.error("[Agent] LLM call failed: %s", exc)
            err = str(exc).lower()
            if any(x in err for x in ("failed to parse", "parseerror", "400")):
                msg = "🚧 Encountered a formatting error. Please try again or simplify the problem."
            else:
                msg = "I encountered an error. Please try again!"
            return {"success": False, "error": msg}

        assistant_msg = completion.choices[0].message
        messages.append(assistant_msg.model_dump(exclude_none=True))

        # No tool calls → LLM is done
        if not assistant_msg.tool_calls:
            content = assistant_msg.content or ""
            if content:
                content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
            accumulated["agent_message"] = content
            logger.info("[Agent] Done at step %d (no tool call)", step + 1)
            break

        # Execute tools
        for tool_call in assistant_msg.tool_calls:
            name = tool_call.function.name
            try:
                args = json.loads(tool_call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            result = _dispatch_tool(name, args, context)
            accumulated.update(result)

            messages.append({
                "role":         "tool",
                "tool_call_id": tool_call.id,
                "content":      json.dumps(result, ensure_ascii=False),
            })

    # Fallback: if LLM never wrote a final message, synthesise from tool output
    if not accumulated.get("agent_message"):
        fallback = _format_result_as_message(accumulated)
        if fallback:
            accumulated["agent_message"] = fallback
            logger.info("[Agent] Used fallback formatter")

    return accumulated


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
        response_text = study_llm.chat_casual(message, memory_ctx=memory_ctx)
        if user_id:
            _fire_and_forget(self.memory.learn(user_id, [
                {"role": "user",      "content": message},
                {"role": "assistant", "content": response_text},
            ]))
        return {"success": True, "intent": "casual", "display_markdown": response_text}

    async def explain(self, question: str, branch: str, user_id: str = "") -> dict:
        memory_ctx    = await self._get_memory_ctx(user_id, question)
        response_text = study_llm.explain_topic(question, branch, memory_ctx=memory_ctx)
        if user_id:
            _fire_and_forget(self.memory.learn(user_id, [
                {"role": "user",      "content": f"[Explain] {question}"},
                {"role": "assistant", "content": response_text},
            ]))
        return {"success": True, "intent": "explain", "display_markdown": response_text}

    async def help_user(self, question: str, branch: str, user_id: str = "") -> dict:
        memory_ctx    = await self._get_memory_ctx(user_id, question)
        response_text = study_llm.help_response(question, branch, memory_ctx=memory_ctx)
        if user_id:
            _fire_and_forget(self.memory.learn(user_id, [
                {"role": "user",      "content": f"[Help] {question}"},
                {"role": "assistant", "content": response_text},
            ]))
        return {"success": True, "intent": "help", "display_markdown": response_text}

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
            difficulty = study_llm.classify_difficulty(question, branch)
        except Exception:
            difficulty = "medium"

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
            return {"success": False, "error": "Session not found."}

        actual_question = session["question"]
        actual_branch   = session["branch"]

        if not can_use_hint(session_id):
            return {
                "success": True, "session_id": session_id,
                "hint_text": "💪 You've used all your hints! Try solving it or press Solve for the full solution.",
                "hints_remaining": 0, "hint_limit_reached": True,
            }

        hint_number = session["hints_used"] + 1
        try:
            hint_text = await asyncio.to_thread(
                study_llm.generate_hint, actual_question, actual_branch, hint_number, "medium"
            )
        except Exception as exc:
            logger.error("[Hint] generate_hint failed: %s", exc)
            hint_text = ""

        if not hint_text or hint_text.startswith("Error:"):
            hint_text = {
                1: "💡 Think about which technique or formula applies. What's the first step? 🤔",
                2: "💡 Break the problem into smaller parts. Which operation starts it? 👀",
                3: "💡 You're close! Try the first calculation step. What do you get? 💪",
            }.get(hint_number, "💡 Think about the approach. What would you try first?")

        try:
            use_hint(session_id)
        except Exception:
            pass

        return {
            "success":         True,
            "session_id":      session_id,
            "hint_text":       hint_text,
            "hint_level":      hint_number,
            "hints_remaining": self._hints_remaining(session_id),
            "agent_message":   hint_text,
        }

    async def solve(self, session_id: str, question: str, branch: str,
                    user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            return {"success": False, "error": "Session not found."}
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
            return {"success": False, "error": "Session not found."}
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
            return {"success": False, "error": "Session not found."}
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
            return {"success": False, "error": "Session not found."}
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
            return {"success": False, "error": "Session not found."}
        q = session["question"]
        b = session["branch"]

        practice = await asyncio.to_thread(study_llm.generate_harder_practice, b, q)
        try:
            update_session(session_id, {"practice_problems": [{"question": practice, "difficulty": "harder", "branch": b}]})
        except Exception:
            pass

        if user_id:
            _fire_and_forget(_memory.learn(user_id, [
                {"role": "user",      "content": f"[Harder] Original: {q} | Branch: {b}"},
                {"role": "assistant", "content": f"Harder practice: {practice}"},
            ]))

        return {
            "success":          True,
            "session_id":       session_id,
            "practice_problem": practice,
            "next_phase":       "practice",
            "difficulty_bump":  True,
        }

    async def finish(self, session_id: str, question: str, branch: str,
                     user_id: str = "") -> dict:
        session = get_session(session_id)
        if not session:
            return {"success": False, "error": "Session not found.", "session_id": session_id}
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
