"""
MATHX — Study Mode: Agent Loop (v9 — Production)

Owns the conversation with the LLM:
  • The Socratic system prompt that tells the model how to teach.
  • The decision gate that forces the correct *first* tool per ACTION
    (so action=check always starts with evaluate_answer, etc).
  • The fallback formatter that synthesises a user-visible message when
    the LLM forgets to write one after tool calls.
  • _run_agent_loop — the actual stepper that calls Groq, executes tools,
    injects mini-lessons, and stops when a natural-language reply lands.

Tool *behaviour* lives in study_tools.py; tool *orchestration* lives here.
This separation lets you isolate "did the right tool fire?" (loop bug) from
"did the tool do the right thing?" (tools bug) when debugging.
"""

import os
import sys
import json
import logging
import re
from typing import Optional

if __package__ is None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

# Module references — accessed lazily at call time so the
# study_agent ↔ study_loop ↔ study_tools cycle resolves cleanly.
try:
    from backend.study_engine import study_tools as _tools_mod
    from backend.study_engine import study_agent as _agent_mod
    from backend.study_engine.study_llm import _sanitize_text
except ImportError:
    from . import study_tools as _tools_mod
    from . import study_agent as _agent_mod
    from .study_llm import _sanitize_text

logger = logging.getLogger("mathx-study-loop-v9")


# ─────────────────────────────────────────────
# SYSTEM PROMPT
# ─────────────────────────────────────────────

STUDY_SYSTEM_PROMPT = """\
You are MATHX, an AI math tutor in Study Mode, built at Sphinx University.
Your job is Socratic tutoring: help the student reason through THIS session's problem — not generic math chat.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT-FIRST (read before you act)
Every user message includes ACTION, QUESTION, BRANCH, DIFFICULTY, and SESSION STATE
(phase, hints_used, attempts_so_far). Long-term MEMORY CONTEXT may appear — it is background only.
Before choosing tools or wording:
• Anchor to the exact QUESTION text and BRANCH (algebra / calculus / …). Do not swap in a different problem.
• Respect SESSION STATE: more attempts or hints means tighter, more concrete scaffolding — not repeating the same vague prompt.
• If STUDENT ANSWER or CORRECT ANSWER is present, your reasoning must reference them; acknowledge specific steps or symbols they used when relevant.
• Use MEMORY silently to adapt tone, pace, and what to revisit — never quote it, never say "according to memory" or similar.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL — TOOLING + FINAL MESSAGE
After ANY tool call you MUST write a complete final message to the student in natural language.
Never end your turn with only tool output. Weave tool results into one coherent reply that fits the current phase.

OUTPUT FORMAT (Issue #5 — no malformed wrappers)
• Write plain prose. Math goes inside LaTeX delimiters ($…$ inline, $$…$$ block).
• Do NOT wrap your reply in ``` fences (no ```json, no ```markdown, no ```latex).
• Do NOT emit raw tool-result JSON in your text. Only the user-facing prose.
• Do NOT use markdown bullets (- or *), numbered lists (1. 2.), or headings (##) inside tutor replies — write conversational prose.

CONCEPT LENGTH (Issue #2 — explain_concept tool output)
When you weave an `explain_concept` result into your reply, keep the length tier:
• difficulty=easy   → 1 sentence TOTAL.
• difficulty=medium → 1–2 sentences TOTAL.
• difficulty=hard   → 2–3 sentences TOTAL.
No bullets, no lists, no headings. The guiding question, if any, counts toward the sentence budget.

HINTS (Issue #3 — give_hint output)
A hint is ALWAYS for the CURRENT QUESTION above. Never propose a new problem, a "try this instead",
or any practice exercise in a hint. If you cannot scaffold without revealing the answer, write a single
short nudge ("Try the first step.") and stop. Practice problems are a different tool (generate_practice).

IDENTITY (Issue #4 — who-are-you questions)
If the student asks who you are, your name, who built you, or any identity question:
reply ONLY with this exact line and STOP — do not call any tool, do not elaborate, do not add emojis:
"I'm MATHX, an AI math tutor in Study Mode, built at Sphinx University."

DECISION RULES (strict order of operations)
1. action=start
   • difficulty=easy  → give_full_solution (still encourage them to verify).
   • difficulty=medium → explain_concept only (no solution leak).
   • difficulty=hard  → explain_concept then ask_socratic.
2. action=check → call evaluate_answer first.
   • If correct → generate_practice; celebrate what they did in context of THIS question.
   • If wrong and attempts_so_far≤1 → ask_socratic (reference their attempt if provided).
   • If wrong and attempts_so_far≥2 → give_hint (escalate hint level with hints_used + difficulty).
3. action=hint → give_hint. If hints_used≥3 (max hints) → give_full_solution instead of another hint.
4. action=giveup or action=solve → give_full_solution.
5. action=next → generate_practice (difficulty=similar) tied to the original_question.
6. action=summary or action=finish → end_session.

LANGUAGE
Infer from the QUESTION and the student's wording. Reply in the SAME language throughout (Arabic or English).
Math: LaTeX only. Keep notation consistent with the problem statement.

TONE & SAFETY
Warm, clear, patient. Never say "wrong", "incorrect", or harsh judgment — use "almost there" / "قريب جداً" and redirect.
End with ONE focused guiding question when you are teaching (not after a full solution or session summary).
Emojis sparingly: 💡 🎯 🎉 👀 💪
"""


# ─────────────────────────────────────────────
# DECISION GATE (first tool per ACTION)
# ─────────────────────────────────────────────

ALLOWED_FIRST_TOOL = {
    "check":  "evaluate_answer",
    "giveup": "give_full_solution",
    "solve":  "give_full_solution",
    "finish": "end_session",
    "start":  None,
    "next":   "generate_practice",
}


def _parse_action_from_user_message(user_message: str) -> str:
    for raw in user_message.splitlines():
        line = raw.strip()
        if line.upper().startswith("ACTION:"):
            return line.split(":", 1)[1].strip()
    return ""


def _forced_first_tool_name(action: str) -> Optional[str]:
    a = (action or "").strip().lower()
    if a == "summary":
        a = "finish"
    return ALLOWED_FIRST_TOOL.get(a)


# ─────────────────────────────────────────────
# FALLBACK FORMATTER
# ─────────────────────────────────────────────

def _format_result_as_message(result: dict) -> str:
    # Pair-aware: feedback + next-step belong together. After a wrong-answer turn the
    # agent typically calls evaluate_answer (mistake_feedback) then ask_socratic
    # (socratic_question). If the model forgets the natural-language summary, return
    # both — otherwise the student sees only the question with no explanation.
    feedback = (result.get("mistake_feedback") or "").strip()
    socratic = (result.get("socratic_question") or "").strip()
    if feedback and socratic:
        return f"{feedback}\n\n{socratic}"

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
    groq_client = _agent_mod.groq_client
    if groq_client is None:
        msg = "I encountered an error. Please try again!"
        return {"success": False, "error": msg, "agent_message": msg}

    # Always start fresh — zero context bleed between calls
    messages = [
        {"role": "system", "content": STUDY_SYSTEM_PROMPT},
        {"role": "user",   "content": user_message},
    ]

    accumulated: dict = {"success": True}
    max_steps    = 4
    action       = _parse_action_from_user_message(user_message)
    forced_first = _forced_first_tool_name(action)

    for step in range(max_steps):
        logger.info("[Loop] Step %d (action=%s)", step + 1, action or "<none>")
        create_kwargs: dict = {
            "model":       "openai/gpt-oss-120b",
            "messages":    messages,
            "tools":       _tools_mod.STUDY_TOOLS,
            "temperature": 0.4,
            "max_tokens":  2500,
        }
        if step == 0 and forced_first:
            create_kwargs["tool_choice"] = {"type": "function", "function": {"name": forced_first}}
        else:
            create_kwargs["tool_choice"] = "auto"

        try:
            completion = groq_client.chat.completions.create(**create_kwargs)
        except Exception as exc:
            logger.error("[Loop] LLM call failed: %s", exc)
            err = str(exc).lower()
            if any(x in err for x in ("failed to parse", "parseerror", "400")):
                msg = "🚧 Encountered a formatting error. Please try again or simplify the problem."
            else:
                msg = "I encountered an error. Please try again!"
            # Preserve any successful tool work from earlier steps so the user still
            # sees feedback / hints / etc. instead of a bare error.
            accumulated["success"] = False
            accumulated["error"]   = msg
            if not accumulated.get("agent_message"):
                accumulated["agent_message"] = _format_result_as_message(accumulated) or msg
            return accumulated

        assistant_msg = completion.choices[0].message
        messages.append(assistant_msg.model_dump(exclude_none=True))

        # No tool calls → LLM is done
        if not assistant_msg.tool_calls:
            content = assistant_msg.content or ""
            if content:
                content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
                # Issue #5: strip stray ```json / ``` fences from the final
                # natural-language reply before handing back to the route.
                content = _sanitize_text(content)
            accumulated["agent_message"] = content
            logger.info("[Loop] Done at step %d (no tool call)", step + 1)
            break

        # Execute tools. NOTE: when the model emits parallel tool calls in a single
        # step, dict.update lets later results clobber earlier `tool` / `next_phase`
        # values. We keep a `tools_fired` history so callers can still see the full
        # sequence; each tool's *content* keys (mistake_feedback, socratic_question,
        # …) merge in naturally because they don't collide.
        tools_fired: list = list(accumulated.get("tools_fired") or [])
        for tool_call in assistant_msg.tool_calls:
            name = tool_call.function.name
            try:
                args = json.loads(tool_call.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}

            result = _tools_mod._dispatch_tool(name, args, context)
            accumulated.update(result)
            tools_fired.append(name)

            messages.append({
                "role":         "tool",
                "tool_call_id": tool_call.id,
                "content":      json.dumps(result, ensure_ascii=False),
            })
        accumulated["tools_fired"] = tools_fired

        # Decision-gate sanity check: if we *required* a specific first tool but
        # the LLM ignored tool_choice and called something else, log it loudly
        # so behaviour-bugs surface in logs rather than silently skipping the
        # state-mutating step (e.g., evaluate_answer never runs on /study/check).
        if step == 0 and forced_first and forced_first not in tools_fired:
            logger.warning(
                "[Loop] forced_first=%s was ignored by LLM; tools_fired=%s",
                forced_first, tools_fired,
            )

        if accumulated.get("needs_mini_lesson"):
            et = str(accumulated.get("error_type", "none"))
            messages.append({
                "role":    "user",
                "content": (
                    f"INTERVENTION: Student repeated {et} twice. "
                    "Deliver a focused 2-sentence mini-lesson on this specific error "
                    "before asking the next Socratic question."
                ),
            })
            del accumulated["needs_mini_lesson"]

    # Fallback: if LLM never wrote a final message, synthesise from tool output
    if not accumulated.get("agent_message"):
        fallback = _format_result_as_message(accumulated)
        if fallback:
            # Issue #5: tool-result text fields are already sanitized at the
            # study_llm._call level, but apply one more pass in case multiple
            # fields are concatenated by the formatter and a fence straddles
            # the join.
            accumulated["agent_message"] = _sanitize_text(fallback)
            logger.info("[Loop] Used fallback formatter")

    return accumulated
