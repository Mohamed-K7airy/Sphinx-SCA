"""
Sphinx-SCA — LLM Manager (Groq + GPT-OSS)
==========================================
Roles:
  0. Classifier       → classify problem branch & type  ← BERT replacement
  1. Problem Parser   → raw text to structured JSON
  2. Step Generator   → educational step-by-step solution  ← IMPROVED
  3. Hint Generator   → progressive hints without spoiling ← IMPROVED
  4. Word Problem     → extract equation from natural language
  5. OCR Validator    → fix LaTeX from image and convert to SymPy
  6. Chat             → natural conversation + math solving ← IMPROVED

Improvements over previous version:
  - generate_steps   : deeper explanations, steps connected to each other,
                       "connects_to_next" field, key insight at the end
  - generate_hints   : hints explain WHY not just WHAT, structured by principle/method/bridge
  - SYSTEM_PROMPT    : math-specific guidance, logical thread between steps
  - chat_with_math   : solution presented as a story, highlights the key insight
  - classify_problem : added confidence threshold retry for low-confidence results

Requirements:
    pip install groq
"""

import sys
import json
import re
import asyncio
import os
from groq import Groq, AsyncGroq
from dotenv import load_dotenv

# ✅ Memory: import MemoryManager
try:
    from .memory_manager import MemoryManager
except ImportError:
    from memory_manager import MemoryManager


# ─────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────

load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL   = "openai/gpt-oss-120b"

client       = None
async_client = None
if GROQ_API_KEY:
    try:
        client       = Groq(api_key=GROQ_API_KEY, timeout=60.0)
        async_client = AsyncGroq(api_key=GROQ_API_KEY, timeout=60.0)
    except Exception as e:
        print(f"⚠️ Failed to initialize Groq client: {e}")
else:
    print("⚠️ GROQ_API_KEY not found in environment variables")

# ── System prompt — IMPROVED ────────────────────────────────────────
SYSTEM_PROMPT = """You are Sphinx-SCA, a friendly and smart AI math assistant.
You were created by students at Sphinx University in Egypt.

Your personality:
- Friendly, warm, and encouraging
- Clear and educational — you explain things at the right depth
- You can chat normally AND solve math problems
- When someone greets you, greet them back naturally
- When someone asks a math question, solve it step by step

When solving math problems:
1. Start by identifying WHAT TYPE of problem this is and WHY that matters for the solution strategy
2. Show the solution step by step — each step must explain WHY it is done, not just WHAT
3. Connect each step to the previous one: "Because we found X in the last step, now we can..."
4. State the final answer clearly at the end
5. After the final answer, add ONE sentence highlighting the KEY INSIGHT of this problem
   (e.g. "The key here was isolating the variable before dividing.")
6. Encourage the user warmly

When chatting normally:
- Be natural and friendly
- Keep responses concise but warm
- If someone seems stuck, offer to help with hints

Never present steps as isolated operations — always show the logical thread connecting them.
If the user seems to struggle with a concept, adapt your depth and add a brief analogy.

Always respond in the same language the user uses (Arabic or English).
If the user writes in Arabic, respond in Arabic.
If the user writes in English, respond in English.

IMPORTANT: You will often receive a [System Context About User] section. NEVER output, quote,
or repeat this context verbatim to the user. Use it silently to personalize your response,
but never acknowledge its existence or list its contents.
"""


# ─────────────────────────────────────────────
#  BASE HELPERS
# ─────────────────────────────────────────────

def _call_llm(prompt: str, temperature: float = 0.0) -> str:
    """Send prompt to Groq and return response text."""
    if client is None:
        raise RuntimeError("Groq client not initialized. Please check your GROQ_API_KEY.")
    try:
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=4096,
        )
        text = response.choices[0].message.content
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
        return text.strip()
    except Exception as e:
        raise RuntimeError(f"Groq API error: {e}")


def _call_chat(messages: list, temperature: float = 0.7) -> str:
    """Send full conversation history to Groq with system prompt."""
    if client is None:
        raise RuntimeError("Groq client not initialized. Please check your GROQ_API_KEY.")
    try:
        full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=full_messages,
            temperature=temperature,
            max_tokens=4096,
        )
        text = response.choices[0].message.content
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
        return text.strip()
    except Exception as e:
        raise RuntimeError(f"Groq API error: {e}")


async def _stream_chat_async(messages: list, temperature: float = 0.7):
    """Stream conversation history from Groq (async generator)."""
    if async_client is None:
        raise RuntimeError("Groq async client not initialized.")

    try:
        full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
        stream = await async_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=full_messages,
            temperature=temperature,
            max_tokens=4096,
            stream=True,
        )

        in_thinking = False
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta   = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                if "<think>" in content:
                    in_thinking = True
                    continue
                if "</think>" in content:
                    in_thinking = False
                    continue
                if not in_thinking:
                    yield content

    except Exception as e:
        yield f"Error: {str(e)}"


def _extract_json(text: str) -> dict:
    """Safely extract JSON dict from LLM response."""
    text = re.sub(r"```(?:json)?", "", text).strip().rstrip("`")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise ValueError(f"Could not parse JSON:\n{text}")


def _extract_json_array(text: str) -> list:
    """Safely extract JSON array from LLM response."""
    text = re.sub(r"```(?:json)?", "", text).strip().rstrip("`")
    try:
        result = json.loads(text)
        return result if isinstance(result, list) else [result]
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        return []


# ─────────────────────────────────────────────
#  ROLE 0 — CLASSIFIER  (+ low-confidence retry)
# ─────────────────────────────────────────────

def classify_problem(raw_text: str) -> dict:
    """
    Role 0 — Classify input as math problem or chat.
    Returns is_math=True/False so app.py routes correctly.
    Retries once with higher temperature if confidence < 0.6.
    """
    prompt = f"""
You are a math problem classifier.
Classify this input and return ONLY valid JSON, no explanation, no markdown.

Input: "{raw_text}"

Return this exact structure:
{{
  "branch": "algebra | calculus | geometry | statistics | linear_algebra | word_problem | search | chat",
  "problem_type": "solve | simplify | factor | differentiate | integrate | limit | area | perimeter | volume | mean | median | std | determinant | inverse | eigenvalues | multiply | calculate | search | conversation",
  "confidence": 0.0 to 1.0,
  "is_math": true or false
}}

Rules:
- search  : requests for information, news, videos, or real-time details from the web or YouTube
- chat    : greetings, small talk, questions about the bot, anything NOT math and NOT a search
- is_math : false for chat and search, true for all math problems

Examples:
- "hi"                            → {{"branch": "chat",          "problem_type": "conversation", "confidence": 1.0,  "is_math": false}}
- "what can you do?"              → {{"branch": "chat",          "problem_type": "conversation", "confidence": 1.0,  "is_math": false}}
- "ابحث عن أخبار الذكاء الاصطناعي"   → {{"branch": "search",        "problem_type": "search",       "confidence": 0.98, "is_math": false}}
- "search for Python tutorials"   → {{"branch": "search",        "problem_type": "search",       "confidence": 0.98, "is_math": false}}
- "فيديو عن الجبر"                 → {{"branch": "search",        "problem_type": "search",       "confidence": 0.97, "is_math": false}}
- "what's happening in the world today" → {{"branch": "search",  "problem_type": "search",       "confidence": 0.96, "is_math": false}}
- "find me videos about calculus" → {{"branch": "search",        "problem_type": "search",       "confidence": 0.99, "is_math": false}}
- "solve 2x + 5 = 11"            → {{"branch": "algebra",        "problem_type": "solve",        "confidence": 0.98, "is_math": true}}
- "differentiate x^2 + 3x"       → {{"branch": "calculus",       "problem_type": "differentiate","confidence": 0.97, "is_math": true}}
- "area of circle with radius 5"  → {{"branch": "geometry",       "problem_type": "area",         "confidence": 0.96, "is_math": true}}
"""
    response = _call_llm(prompt, temperature=0.0)
    result   = _extract_json(response)

    # ── Low-confidence retry ──────────────────────────────────────
    # If the model is unsure (< 0.6), retry once with slight temperature
    # so it reconsiders rather than defaulting to a wrong branch.
    if result.get("confidence", 1.0) < 0.6:
        response2 = _call_llm(prompt, temperature=0.2)
        try:
            result2 = _extract_json(response2)
            if result2.get("confidence", 0) > result.get("confidence", 0):
                result = result2
        except Exception:
            pass  # keep original result if retry fails

    valid_branches = {"algebra", "calculus", "geometry", "statistics", "linear_algebra", "word_problem", "search", "chat"}
    if result.get("branch") not in valid_branches:
        result["branch"]  = "algebra"
        result["is_math"] = True

    return result


# ─────────────────────────────────────────────
#  ROLE 1 — PROBLEM PARSER
# ─────────────────────────────────────────────

PARSER_PROMPTS = {

    "algebra": """
You are a math expression parser. Convert the problem to JSON.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "expression": "sympy-compatible expression (move everything to left side)",
  "variables": ["list of variables"],
  "operation": "solve | simplify | factor | expand"
}}

Examples:
- "solve 2x + 5 = 11" → {{"expression": "2*x+5-11", "variables": ["x"], "operation": "solve"}}
- "factor x^2 - 4"    → {{"expression": "x**2-4",   "variables": ["x"], "operation": "factor"}}
""",

    "calculus": """
You are a calculus expression parser. Convert the problem to JSON.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "expression": "sympy-compatible expression",
  "variable": "main variable",
  "operation": "differentiate | integrate | limit",
  "limit_point": null
}}

Examples:
- "differentiate x^3 + 2x" → {{"expression": "x**3+2*x", "variable": "x", "operation": "differentiate", "limit_point": null}}
- "integrate sin(x)"        → {{"expression": "sin(x)",   "variable": "x", "operation": "integrate",     "limit_point": null}}
""",

    "matrix": """
You are a matrix parser. Convert the problem to JSON.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "matrix_a": [[row1], [row2]],
  "matrix_b": [[row1], [row2]] or null,
  "operation": "determinant | inverse | multiply | eigenvalues | transpose"
}}

Example:
- "determinant of [[1,2],[3,4]]" → {{"matrix_a": [[1,2],[3,4]], "matrix_b": null, "operation": "determinant"}}
""",

    "statistics": """
You are a statistics parser. Convert the problem to JSON.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "data": [list of numbers],
  "operation": "mean | median | mode | std | variance | all"
}}

Example:
- "mean of 4, 8, 15, 16, 23" → {{"data": [4,8,15,16,23], "operation": "mean"}}
""",

    "geometry": """
You are a geometry parser. Convert the problem to JSON.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "shape": "circle | triangle | rectangle | square | sphere | cylinder | cone",
  "known": {{"param": value}},
  "find": "area | perimeter | volume | surface_area"
}}

Example:
- "area of circle with radius 5" → {{"shape": "circle", "known": {{"radius": 5}}, "find": "area"}}
""",

    "linear_equations": """
You are a linear equations parser. Convert the problem to JSON.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "equations": ["sympy eq1 (left - right)", "sympy eq2", ...],
  "variables": ["x", "y", ...]
}}

Example:
- "x + y = 5 and x - y = 1" → {{"equations": ["x+y-5", "x-y-1"], "variables": ["x","y"]}}
""",

    "word_problem": """
You are a math word problem parser. Extract the core equation.
Return ONLY valid JSON, no explanation, no markdown.

Problem: "{problem}"

Return this exact structure:
{{
  "expression": "the core math expression",
  "variables": ["variables if any"],
  "operation": "solve | calculate"
}}
"""
}


def parse_problem(raw_text: str, problem_type: str) -> dict:
    """Role 1 — Convert raw user text to structured JSON for the Solver."""
    template = PARSER_PROMPTS.get(problem_type, PARSER_PROMPTS["algebra"])
    prompt   = template.format(problem=raw_text)
    response = _call_llm(prompt, temperature=0.0)
    return _extract_json(response)


# ─────────────────────────────────────────────
#  ROLE 2 — STEP GENERATOR  ← IMPROVED
# ─────────────────────────────────────────────

def generate_steps(problem: str, solution: str, problem_type: str) -> list:
    """
    Role 2 — Generate deep, connected, educational step-by-step solution.

    Improvements:
    - Each step explains WHY, not just WHAT
    - Each step references the result of the previous step
    - 'connects_to_next' field shows the logical thread
    - Final step includes a key_insight summarizing the solution strategy
    """
    prompt = f"""
You are an expert math teacher. Generate a detailed, deeply connected step-by-step solution.
Return ONLY a valid JSON array, no explanation, no markdown.

Problem: "{problem}"
Type: {problem_type}
Final answer: {solution}

Return this exact structure:
[
  {{
    "step": 1,
    "title": "Short step title (e.g. 'Identify the equation type')",
    "action": "The exact math shown (e.g. '2x + 5 = 11  →  2x = 11 - 5')",
    "explanation": "WHY we do this step AND how it follows from the previous step. Be specific — never say just 'simplify' without showing what simplification happens.",
    "connects_to_next": "One sentence: what does this result allow us to do in the next step?"
  }}
]

RULES:
- First step: identify the problem type and the overall solution strategy BEFORE any calculation
- Every explanation must answer WHY, not just describe WHAT happened
- Every step (except step 1) must reference the result from the previous step:
  use phrases like "Since we found X...", "Using the value from step N...", "Now that we have..."
- Never say "simplify" without specifying exactly what simplification is done
- Max 7 steps — but NEVER skip important reasoning to hit the limit
- Last step: state the final answer AND include a "key_insight" field (string) that summarizes
  the core mathematical idea that made this problem solvable
  (e.g. "The key insight was isolating the variable by applying inverse operations in the correct order.")
- Use clear math notation in the action field (arrows → to show transformations)
"""
    response = _call_llm(prompt, temperature=0.1)
    steps    = _extract_json_array(response)
    if not steps:
        return [{"step": 1, "title": "Solution", "action": str(solution),
                 "explanation": "Final answer", "connects_to_next": ""}]
    return steps


# ─────────────────────────────────────────────
#  ROLE 3 — HINT GENERATOR  ← IMPROVED
# ─────────────────────────────────────────────

def generate_hints(problem: str, problem_type: str, num_hints: int = 3) -> list:
    """
    Role 3 — Generate progressive hints that teach the WHY, not just the HOW.

    Hint structure:
    - Hint 1 (Principle)  : WHY this approach — what mathematical principle applies
    - Hint 2 (Method)     : HOW to start — first concrete operation, without numbers
    - Hint 3 (Bridge)     : Show the equation structure with variables, not final values
    """
    prompt = f"""
You are a math tutor who teaches through understanding, not just steps.
Generate {num_hints} progressive hints that guide the student toward the solution
without giving it away. Return ONLY a valid JSON array of strings. No explanation, no markdown.

Problem: "{problem}"
Type: {problem_type}

Hint levels — follow this exactly:
- Hint 1 (Principle): Explain WHICH mathematical principle or concept applies to this problem and WHY.
  Do NOT mention any calculation yet. Example: "This is a linear equation — the goal is always to
  isolate the unknown by undoing operations in reverse order."
- Hint 2 (Method): Describe the FIRST concrete action the student should take, without using the
  actual numbers from the problem. Example: "Start by moving the constant term to the right side
  of the equation by subtracting it from both sides."
- Hint 3 (Bridge): Show the STRUCTURE of the solution using the actual variable names but not the
  final answer. Example: "After isolating 2x, your next step is to divide both sides by the
  coefficient of x to get x alone."

Return format: ["hint1 text", "hint2 text", "hint3 text"]
"""
    response = _call_llm(prompt, temperature=0.2)
    hints    = _extract_json_array(response)
    if not hints:
        return [
            "Think about which mathematical principle applies to this type of problem.",
            "Identify the first operation you need to undo to isolate the unknown.",
            "Apply the inverse operation step by step, keeping both sides balanced."
        ]
    return hints


# ─────────────────────────────────────────────
#  ROLE 4 — WORD PROBLEM SOLVER
# ─────────────────────────────────────────────

def solve_word_problem(problem_text: str) -> dict:
    """Role 4 — Understand and solve a natural language math problem."""
    prompt = f"""
You are a math expert. Solve this word problem.
Return ONLY valid JSON, no explanation outside JSON, no markdown.

Problem: "{problem_text}"

Return this exact structure:
{{
  "extracted_equation": "the math equation from the text",
  "variables_defined": {{"var": "what it represents"}},
  "solution": "final numerical answer",
  "steps": [
    {{"step": 1, "description": "what we do", "math": "the operation"}}
  ],
  "answer_sentence": "Full sentence stating the answer clearly."
}}
"""
    response = _call_llm(prompt, temperature=0.1)
    return _extract_json(response)


# ─────────────────────────────────────────────
#  ROLE 5 — OCR VALIDATOR
# ─────────────────────────────────────────────

def validate_ocr(latex_text: str) -> str:
    """Role 5 — Fix OCR errors in LaTeX and convert to SymPy expression."""
    prompt = f"""
You are a LaTeX to SymPy converter.
Fix any OCR errors and convert to SymPy-compatible format.
Return ONLY the clean expression as plain text. No JSON, no explanation, no markdown.

LaTeX input: "{latex_text}"

Conversion rules:
- x^{{2}}          → x**2
- \\frac{{a}}{{b}} → a/b
- \\sqrt{{x}}      → sqrt(x)
- \\sin, \\cos     → sin, cos
- × or \\times     → *
- Move = to make expression = 0

Return ONLY the expression:
"""
    response = _call_llm(prompt, temperature=0.0)
    return response.replace("`", "").replace('"', "").strip()


# ─────────────────────────────────────────────
#  ROLE 6 — CHAT (with Memory)
# ─────────────────────────────────────────────

async def chat(
    message: str,
    history: list = None,
    user_id: str = None,
    memory_manager: "MemoryManager" = None,
) -> str:
    """
    Role 6 — Natural conversation with memory integration.

    Args:
        message        : current user message
        history        : [{"role": "user", "content": "..."}, ...]
        user_id        : optional — enables memory load/save
        memory_manager : MemoryManager instance

    Returns:
        AI response string
    """
    if history is None:
        history = []

    # ✅ Memory: load relevant context for this user
    memory_context = ""
    if memory_manager and user_id:
        memory_context = await memory_manager.get_context(user_id, message)

    messages = history + [{"role": "user", "content": message}]

    if memory_context:
        # Inject memory context into the final user message to avoid system role leakage
        messages[-1]["content"] = f"[System Context About User: {memory_context}]\n\n{message}"

    response = _call_chat(messages, temperature=0.7)

    # ✅ Memory: save this interaction in the background
    if memory_manager and user_id:
        asyncio.create_task(
            memory_manager.learn(user_id, messages + [{"role": "assistant", "content": response}])
        )

    return response


async def chat_with_math(
    message: str,
    math_result: dict,
    history: list = None,
    user_id: str = None,
    memory_manager: "MemoryManager" = None,
) -> str:
    """
    Role 6b — Wrap a math solution in a natural, story-driven friendly response.

    Improvements:
    - Solution presented as a narrative, not an isolated list
    - Highlights the KEY MOMENT where the problem "clicks"
    - Ends with one insight about this type of problem
    - Directly acknowledges the user's specific question

    Args:
        message        : original user question
        math_result    : result dict from SymPy solver
        history        : conversation history
        user_id        : optional — enables memory
        memory_manager : MemoryManager instance

    Returns:
        Natural language response with math solution embedded
    """
    if history is None:
        history = []

    answer = math_result.get("final_answer") or math_result.get("answer") or "unknown"
    steps  = math_result.get("llm_steps", [])

    # Build a narrative steps block that shows connections between steps
    steps_text = ""
    if steps:
        steps_lines = []
        for i, s in enumerate(steps):
            step_no     = s.get("step", i + 1)
            title       = s.get("title", "")
            action      = s.get("action", "")
            explanation = s.get("explanation", "")
            connects    = s.get("connects_to_next", "")
            key_insight = s.get("key_insight", "")

            line = f"Step {step_no} — {title}: {action} | {explanation}"
            if connects:
                line += f" → {connects}"
            if key_insight:
                line += f"\n💡 Key Insight: {key_insight}"
            steps_lines.append(line)
        steps_text = "\n".join(steps_lines)

    # ✅ Memory: load context
    memory_context = ""
    if memory_manager and user_id:
        memory_context = await memory_manager.get_context(user_id, message)

    steps_block = f"Solution path:\n{steps_text}" if steps_text else ""

    context = f"""{memory_context}
The user asked: "{message}"
The math solver found the answer: {answer}
{steps_block}

Now respond as Sphinx-SCA. Follow these guidelines:
1. Directly acknowledge their specific question in the first sentence
2. Present the solution as a STORY — each step leads naturally to the next,
   use connective language: "First...", "Because of that...", "This means...", "Finally..."
3. Highlight the KEY MOMENT where the problem becomes clear
   (e.g. "The turning point was when we isolated 2x — after that, the answer was one step away.")
4. End with ONE insight about this TYPE of problem that will help them next time
5. Close with a short warm encouragement

Do NOT just list the steps mechanically — weave them into a clear explanation.
"""

    messages = history + [{"role": "user", "content": context}]
    response = _call_chat(messages, temperature=0.5)

    # ✅ Memory: save this interaction in the background
    if memory_manager and user_id:
        asyncio.create_task(
            memory_manager.learn(
                user_id,
                [{"role": "user", "content": message}, {"role": "assistant", "content": response}]
            )
        )

    return response


# ─────────────────────────────────────────────
#  UNIFIED INTERFACE
# ─────────────────────────────────────────────

class LLMManager:
    """
    Single interface for all LLM roles in Sphinx-SCA.

    ─────────────────────────────────────────────
    When BERT is ready — replace classify() only:
    ─────────────────────────────────────────────
        classification = bert_classifier.predict(question)
        # Must return: {"branch": "...", "problem_type": "...", "confidence": ..., "is_math": true/false}
    """

    def __init__(self):
        # ✅ Memory: initialize MemoryManager once per LLMManager instance
        self.memory = MemoryManager()

    def classify(self, raw_text: str) -> dict:
        return classify_problem(raw_text)

    def parse(self, raw_text: str, problem_type: str) -> dict:
        return parse_problem(raw_text, problem_type)

    def steps(self, problem: str, solution: str, problem_type: str) -> list:
        return generate_steps(problem, solution, problem_type)

    def hints(self, problem: str, problem_type: str, num: int = 3) -> list:
        return generate_hints(problem, problem_type, num)

    def word_problem(self, problem_text: str) -> dict:
        return solve_word_problem(problem_text)

    def ocr_fix(self, latex_text: str) -> str:
        return validate_ocr(latex_text)

    async def chat(self, message: str, history: list = None, user_id: str = None) -> str:
        """Chat normally — greetings, questions, small talk."""
        return await chat(message, history, user_id, self.memory)

    async def chat_with_math(
        self,
        message: str,
        math_result: dict,
        history: list = None,
        user_id: str = None,
    ) -> str:
        """Wrap math solution in natural story-driven friendly response."""
        return await chat_with_math(message, math_result, history, user_id, self.memory)

    async def stream_chat(self, messages: list, temperature: float = 0.7, user_id: str = None):
        """
        Stream conversation history from Groq with memory integration.
        Async generator — yields chunks.
        """
        # ✅ Memory: inject context before streaming
        if user_id and messages:
            last_msg = messages[-1]["content"] if messages[-1]["role"] == "user" else ""
            if last_msg:
                try:
                    memory_context = await asyncio.wait_for(
                        self.memory.get_context(user_id, last_msg), timeout=45.0
                    )
                    if memory_context:
                        messages[-1]["content"] = f"[System Context About User: {memory_context}]\n\n{last_msg}"
                except asyncio.TimeoutError:
                    print("⚠️ Memory fetch timed out during stream (HF cold), skipping context.")
                except Exception as e:
                    print(f"⚠️ Memory fetch error: {e}")

        full_content = ""
        async for chunk in _stream_chat_async(messages, temperature):
            full_content += chunk
            yield chunk

        # ✅ Memory: save full conversation after stream finishes
        if user_id and full_content:
            asyncio.create_task(
                self.memory.learn(
                    user_id,
                    messages + [{"role": "assistant", "content": full_content}]
                )
            )


# ─────────────────────────────────────────────
#  QUICK TEST
# ─────────────────────────────────────────────

if __name__ == "__main__":
    llm = LLMManager()

    print("=" * 55)
    print("TEST 0 — Classifier (math)")
    print(json.dumps(llm.classify("solve 2x + 5 = 11"), indent=2))

    print("\n" + "=" * 55)
    print("TEST 0b — Classifier (chat)")
    print(json.dumps(llm.classify("hi, how are you?"), indent=2))

    print("\n" + "=" * 55)
    print("TEST 0c — Classifier (low confidence retry)")
    print(json.dumps(llm.classify("find the value"), indent=2))

    print("\n" + "=" * 55)
    print("TEST 2 — Steps (connected)")
    steps = llm.steps("solve 2x + 5 = 11", "x = 3", "algebra")
    for s in steps:
        print(json.dumps(s, indent=2))

    print("\n" + "=" * 55)
    print("TEST 3 — Hints (principled)")
    hints = llm.hints("solve 2x + 5 = 11", "algebra")
    for i, h in enumerate(hints, 1):
        print(f"Hint {i}: {h}")

    print("\n" + "=" * 55)
    print("TEST 6a — Chat (English greeting)")
    print(asyncio.run(llm.chat("hi! what can you do?")))

    print("\n" + "=" * 55)
    print("TEST 6b — Chat (Arabic)")
    print(asyncio.run(llm.chat("مرحبا، كيف حالك؟")))

    print("\n" + "=" * 55)
    print("TEST 6c — Chat with math (story-driven)")
    fake_result = {
        "final_answer": "x = 3",
        "llm_steps": [
            {
                "step": 1,
                "title": "Identify equation type",
                "action": "2x + 5 = 11  →  linear equation in one variable",
                "explanation": "This is a linear equation. Our goal is to isolate x by undoing operations in reverse order.",
                "connects_to_next": "Knowing this, we move the constant to the right side first."
            },
            {
                "step": 2,
                "title": "Move constant",
                "action": "2x = 11 - 5 = 6",
                "explanation": "We subtract 5 from both sides to eliminate the constant on the left, keeping the equation balanced.",
                "connects_to_next": "Now that 2x = 6, we can divide both sides by 2 to find x."
            },
            {
                "step": 3,
                "title": "Isolate x",
                "action": "x = 6 / 2 = 3",
                "explanation": "Dividing both sides by 2 gives us x alone. Since 2x = 6, x must equal 3.",
                "connects_to_next": "",
                "key_insight": "The key was applying inverse operations in reverse order: subtraction before division."
            }
        ]
    }
    print(asyncio.run(llm.chat_with_math("solve 2x + 5 = 11", fake_result)))

    print("\n" + "=" * 55)
    print("TEST 6d — Multi-turn conversation")
    history = [
        {"role": "user",      "content": "hi!"},
        {"role": "assistant", "content": "Hello! I'm Sphinx-SCA. How can I help you?"}
    ]
    print(asyncio.run(llm.chat("can you solve quadratic equations?", history)))