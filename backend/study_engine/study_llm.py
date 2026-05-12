"""
MATHX — Study LLM Engine (v7 — Production)
"""

import os
import sys
import re
import json
from typing import Optional

if __package__ is None:
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

try:
    from backend.llm_manager import client as groq_client
except ImportError:
    from llm_manager import client as groq_client


# ─────────────────────────────────────────────
# CANONICAL IDENTITY RESPONSE
# ─────────────────────────────────────────────
# Single source of truth for "who are you" answers across the app.
# `chat_casual` and `STUDY_SYSTEM_PROMPT` both reference this so the
# tutor cannot disclose anything else about itself or its origins.

IDENTITY_RESPONSE = "I'm MATHX, an AI math tutor in Study Mode, built at Sphinx University."

# Identity-question detector (English + Arabic). Kept conservative so it does
# NOT eat normal study questions like "what is a derivative".
_IDENTITY_PATTERNS = re.compile(
    r"\b(who\s*(?:are|r)\s*(?:you|u)|what\s*are\s*you|"
    r"what(?:'?s|s|\s+is)\s+your\s+name|"
    r"what\s+do\s+you\s+(?:do|call\s+yourself)|"
    r"introduce\s+yourself|tell\s+me\s+about\s+(?:you|yourself)|"
    r"who\s+is\s+this|who\s+made\s+you|who\s+built\s+you)\b"
    r"|من\s*ان(?:ت|تَ)|من\s*أنت|من\s+هذا|"
    r"(?:ايه|إيه|ما|ما\s+هو)\s+اسمك|اسمك\s+(?:ايه|إيه|ما)|"
    r"عرّ?فني\s+بنفسك|(?:اخبرني|أخبرني)\s+عن\s+نفسك",
    re.IGNORECASE,
)


def is_identity_question(text: str) -> bool:
    return bool(text) and bool(_IDENTITY_PATTERNS.search(text))


# ─────────────────────────────────────────────
# OUTPUT SANITIZER  (Issue #5 — malformed tool responses)
# ─────────────────────────────────────────────
# The LLM occasionally wraps responses in ```json … ``` or bare ``` fences,
# leaving stray triple-backticks in the tutor's natural-language reply. This
# helper strips those wrappers so the frontend doesn't render code blocks
# inside tutor speech. Genuine code/math fences inside the body are left alone.

_FENCE_OUTER_RE = re.compile(
    r"^\s*```(?:json|JSON|markdown|md|latex|tex|text)?\s*\n?(.*?)\n?\s*```\s*$",
    re.DOTALL,
)
_FENCE_STRAY_RE  = re.compile(r"```(?:json|JSON|markdown|md|latex|tex|text)\s*\n?")
_FENCE_BARE_RE   = re.compile(r"^\s*```+\s*$", re.MULTILINE)


def _sanitize_text(text: str) -> str:
    if not text:
        return text
    s = text
    # 1) If the WHOLE response is wrapped in ```...``` strip the outer fence
    m = _FENCE_OUTER_RE.match(s)
    if m:
        s = m.group(1)
    # 2) Strip stray opening labels like "```json\n" that leaked into prose
    s = _FENCE_STRAY_RE.sub("", s)
    # 3) Remove orphan ``` lines (closing fence without opening)
    s = _FENCE_BARE_RE.sub("", s)
    return s.strip()


# ─────────────────────────────────────────────
# LANGUAGE DETECTION
# ─────────────────────────────────────────────

def detect_language(text: str) -> str:
    arabic = sum(1 for c in text if '\u0600' <= c <= '\u06FF')
    latin  = sum(1 for c in text if c.isalpha() and c.isascii())
    return "ar" if arabic > latin else "en"


def _lang_rule(lang: str) -> str:
    if lang == "ar":
        return "Respond ENTIRELY in Arabic. Math formulas use LaTeX. Do NOT mix in English words."
    return "Respond in English. Math formulas use LaTeX."


# ─────────────────────────────────────────────
# PERSONAS
# ─────────────────────────────────────────────

def _tutor(lang: str, extra: str = "") -> str:
    return (
        "You are MATHX, a concise AI Math Tutor. Guide the student; NEVER reveal the answer.\n"
        "Rules: warm, brief, end with ONE guiding question. Emojis: 💡 🎯 🎉 👀 💪.\n"
        "NEVER use markdown bullets (- or *), numbered lists (1. 2.), or headings (## ###). "
        "Plain prose only.\n"
        f"IDENTITY: if asked who you are, reply ONLY: \"{IDENTITY_RESPONSE}\" and stop.\n"
        f"{extra}\nLANGUAGE: {_lang_rule(lang)}"
    )


def _solver(lang: str) -> str:
    return (
        "You are MATHX, a precise math solver.\n"
        "Show only necessary steps. Final line MUST be '**Answer:**' or '**الإجابة:**'. Use LaTeX.\n"
        f"LANGUAGE: {_lang_rule(lang)}"
    )


def _chat_persona(lang: str) -> str:
    return (
        "You are MATHX, a friendly study assistant.\n"
        f"Respond warmly. SHORT (2-4 sentences).\n"
        f"IDENTITY: if asked who you are, reply ONLY: \"{IDENTITY_RESPONSE}\" and stop.\n"
        f"NEVER reveal training details, providers, or any institution other than Sphinx University.\n"
        f"LANGUAGE: {_lang_rule(lang)}"
    )


# ─────────────────────────────────────────────
# TOKEN CAPS (all `_call` outputs clamped to this range)
# ─────────────────────────────────────────────

_MIN_OUT_TOKENS = 200
_MAX_OUT_TOKENS = 10000
_TOKENS = {"easy": 3500, "medium": 5500, "hard": 8500}
_INTENTS = frozenset({"study", "giveup", "help", "explain", "casual"})


# ─────────────────────────────────────────────
# STUDY LLM CLASS
# ─────────────────────────────────────────────

class StudyLLM:

    def __init__(self):
        self.client      = groq_client
        self.smart_model = "openai/gpt-oss-120b"
        # fast_model: aligned to the primary model used by app.py's
        # GROQ_MODEL_CHAIN to fix 429s on llama-3.3-70b-versatile. This is
        # the model used by classify_intent, classify_difficulty, and the
        # MCQ generator behind /study/mcq/generate.
        self.fast_model  = "openai/gpt-oss-120b"

    # ── Core LLM caller ───────────────────────────────────────────

    def _call(self, system: str, user: str, *,
              json_mode: bool = False,
              temperature: float = 0.4,
              max_tokens: int = 1200,
              use_fast: bool = False) -> str:
        max_tokens = max(_MIN_OUT_TOKENS, min(_MAX_OUT_TOKENS, max_tokens))

        # ── Groq Path ──
        try:
            kwargs: dict = {
                "model":       self.fast_model if use_fast else self.smart_model,
                "temperature": temperature,
                "max_tokens":  max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user},
                ],
            }
            if json_mode:
                kwargs["response_format"] = {"type": "json_object"}
            resp = self.client.chat.completions.create(**kwargs)
            text = resp.choices[0].message.content
            # Remove reasoning tags if model emits them
            if text:
                text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
            if not text:
                return ""
            # Issue #5: strip stray ```json / ``` wrappers from natural-language
            # replies. We DON'T sanitize JSON-mode output because that's parsed
            # downstream and needs the raw structure.
            return text if json_mode else _sanitize_text(text)
        except Exception as exc:
            return json.dumps({"error": str(exc)}) if json_mode else f"Error: {exc}"

    # ── Intent classification (LLM — no regex heuristics) ──────────

    def classify_intent(self, text: str) -> str:
        t = (text or "").strip()
        if not t:
            return "casual"
        # Issue #4: identity questions are ALWAYS casual — short-circuit so
        # they cannot accidentally trigger a study session or leak system info.
        if is_identity_question(t):
            return "casual"
        snippet = t[:3000] if len(t) > 3000 else t
        raw = self._call(
            "Classify the user's message for a math tutoring app.\n"
            'Return ONLY valid JSON: {"intent":"<one word>"}\n'
            "intent must be exactly one of: study, giveup, help, explain, casual\n"
            "Definitions:\n"
            "- study: ANY math problem to solve OR any vague math-adjacent request "
            "(e.g. 'help me with algebra', 'I want to practice calculus', 'give me a problem'). "
            "When in doubt → study.\n"
            "- giveup: explicitly says 'give up' / 'show me the answer' / 'I want the solution'\n"
            "- help: stuck on a SPECIFIC exercise already in progress — needs gentle guidance\n"
            "- explain: wants a pure definition/concept explained (NOT a problem to solve)\n"
            "- casual: ONLY greetings, thanks, bye, or identity questions ('who are you'). "
            "Nothing math-adjacent.\n"
            "Arabic and English both allowed. Vague math requests → study. Default → study.",
            f"Message:\n{snippet}",
            json_mode=True,
            temperature=0.0,
            max_tokens=256,
            use_fast=True,
        )
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and "error" in data and len(data) == 1:
                return "study"
            intent = str(data.get("intent", "")).strip().lower()
            if intent in _INTENTS:
                return intent
        except (json.JSONDecodeError, TypeError, AttributeError, ValueError):
            pass
        return "study"

    # ── Difficulty ────────────────────────────────────────────────

    def classify_difficulty(self, question: str, branch: str) -> str:
        r = self._call(
            "Classify math problem difficulty. Output ONLY one word: easy, medium, or hard.\n"
            "easy=basic arithmetic/one-step | medium=quadratics/basic calculus | hard=complex integrals/proofs",
            f"Problem: {question}\nBranch: {branch}",
            temperature=0.0, max_tokens=512, use_fast=True
        ).lower()
        return r if r in ("easy", "medium", "hard") else "medium"

    # ── Casual chat ───────────────────────────────────────────────

    def chat_casual(self, message: str, memory_ctx: str = "") -> str:
        # Issue #4: identity questions get the canonical line and nothing else.
        # Deterministic — no LLM call, so the wording cannot drift over time.
        if is_identity_question(message or ""):
            return IDENTITY_RESPONSE
        lang   = detect_language(message)
        system = _chat_persona(lang)
        if memory_ctx:
            system += f"\n\n[User context — use silently: {memory_ctx[:300]}]"
        return self._call(system, message, temperature=0.7, max_tokens=900)

    # ── Explain topic (concept questions, no problem) ─────────────

    def explain_topic(self, question: str, branch: str, memory_ctx: str = "") -> str:
        lang = detect_language(question)
        ctx  = f"\nStudent background (subtle): {memory_ctx[:300]}" if memory_ctx else ""
        system = _tutor(lang,
                        f"Explain concept in 3-4 sentences, give one example, end with a check question.{ctx}")
        return self._call(system, f"Topic: {question}\nBranch: {branch}",
                          temperature=0.3, max_tokens=1800)

    # ── Session intro (NEVER leaks answer) ───────────────────────

    def explain_concept(self, question: str, branch: str,
                        difficulty: str = "medium", memory_ctx: str = "") -> str:
        lang  = detect_language(question)
        # Issue #2: STRICT sentence counts. Each tier folds the guiding
        # question (if any) into its own sentence budget — easy is *literally*
        # one sentence, not "1 explanation + 1 question = 2 sentences".
        depth = {
            "easy":   "EXACTLY 1 sentence TOTAL. Name the technique and end with '?' to invite a first step. No extra sentences. No bullets.",
            "medium": "1 to 2 sentences TOTAL. Name the concept; the final sentence may end with '?' for a guiding question. No bullets, no lists.",
            "hard":   "2 to 3 sentences TOTAL. Name the concept and the complexity twist; the last sentence may end with '?' for a strategic guiding question. No bullets, no lists.",
        }.get(difficulty,
              "1 to 2 sentences TOTAL. Name the concept; the final sentence may end with '?'. No bullets.")
        ctx = f"\nStudent background: {memory_ctx[:300]}" if memory_ctx else ""
        system = _tutor(lang,
                        f"{depth}{ctx}\n"
                        "NEVER reveal solution steps, formulas, or the answer.\n"
                        "Plain prose ONLY. No '-', '*', '1.', headings, or line breaks unless absolutely required by LaTeX.")
        return self._call(system, f"Problem: {question}\nBranch: {branch}",
                          temperature=0.4, max_tokens=_TOKENS.get(difficulty, 5500))

    # ── Hint (NEVER leaks answer, ALWAYS for the current problem) ─

    def generate_hint(self, question: str, branch: str, hint_number: int,
                      difficulty: str = "medium", memory_ctx: str = "",
                      hint_type: str = "general", student_bottleneck: str = "") -> str:
        lang  = detect_language(question)
        level = {
            1: "Point ONLY to the technique/formula category. No calculations.",
            2: "Name the EXACT formula or operation structure. No numbers yet.",
            3: "Show the FIRST calculation step only. Stop before the answer.",
        }.get(hint_number, "Point to the technique needed.")

        dynamic_ctx = ""
        if hint_type and hint_type != "general":
            dynamic_ctx += f" Hint style: {hint_type}."
        if student_bottleneck:
            dynamic_ctx += f" The student is struggling with: {student_bottleneck}. Address this specifically."

        ctx = f"\nStudent weakness (subtle): {memory_ctx[:200]}" if memory_ctx else ""
        # Issue #3: hints MUST stay anchored to the current problem. The model
        # was occasionally drifting into "here's another problem to try" — that
        # is a different tool (generate_practice). Hard-coded refusal here.
        system = _tutor(lang,
                        f"Hint #{hint_number}/3. Level: {level}{dynamic_ctx}{ctx}\n"
                        "MAX 2 sentences. Do NOT solve. Do NOT reveal the answer.\n"
                        "STRICT: the hint must reference THE EXACT PROBLEM the student is "
                        "working on right now (cite its numbers, variables, or wording when "
                        "natural). NEVER pose a new problem, a 'try this instead', or any "
                        "practice exercise — that is a different tool. If you cannot help "
                        "without revealing the answer, say 'Try the first step.' in one short "
                        "sentence and stop.")
        return self._call(system,
                          f"CURRENT PROBLEM (give the hint for THIS, never invent another):\n"
                          f"{question}\nBranch: {branch}\nHint #{hint_number}:",
                          temperature=0.35, max_tokens=800)

    # ── Solve (give-up only — full answer allowed) ────────────────

    def solve_direct(self, question: str, branch: str, difficulty: str = "medium") -> str:
        lang  = detect_language(question)
        depth = {
            "easy":   "Direct answer in 1-2 lines.",
            "medium": "Key steps only (max 4 lines). Clear final answer.",
            "hard":   "Structured steps (max 6), each labeled. Clear final answer.",
        }.get(difficulty, "Key steps only. Clear final answer.")
        system = _solver(lang) + f"\nDepth: {depth}\nJump straight into math — NO intro sentence."
        return self._call(system, question, temperature=0.1,
                          max_tokens=_TOKENS.get(difficulty, 5500))

    # ── Socratic question ─────────────────────────────────────────

    def generate_socratic_question(self, question: str, branch: str,
                                    attempt: str = "") -> str:
        lang = detect_language(question)
        ctx  = f"Student attempt: {attempt}" if attempt else "No attempt yet."
        system = _tutor(lang,
                        "Ask ONE specific guiding question (1-2 sentences). "
                        "If student attempted: acknowledge then redirect. "
                        "Specific to THIS problem. Never answer your own question.")
        return self._call(system,
                          f"Problem: {question}\nBranch: {branch}\n{ctx}",
                          temperature=0.4, max_tokens=800)

    # ── Mistake analysis ──────────────────────────────────────────

    def analyze_mistake(self, question: str, correct_answer: str,
                        student_answer: str, attempt_count: int = 1) -> str:
        lang = detect_language(question)
        raw  = self._call(
            'Return ONLY valid JSON (no extra text):\n'
            '{"feedback":"Supportive 1-2 sentence feedback. NEVER say wrong/incorrect. '
            'Say \'Almost there! 👀\' or \'قريب جداً 👀\'. End with a guiding question.",'
            '"hint":"One sentence pointing to what to recheck"}\n'
            f'Language: {"Arabic" if lang == "ar" else "English"}\n'
            'NEVER use: wrong, incorrect, خطأ (as judgment)',
            f"Problem: {question}\nCorrect: {correct_answer}\n"
            f"Student: {student_answer}\nAttempt #{attempt_count}",
            json_mode=True, max_tokens=1200,
        )
        try:
            data     = json.loads(raw)
            # Issue #5: the JSON parses fine but the LLM occasionally puts
            # stray ```json fences INSIDE the string values. Sanitize each.
            feedback = _sanitize_text(str(data.get("feedback", "")))
            hint     = _sanitize_text(str(data.get("hint", "")))
            if hint:
                feedback = f"{feedback}\n💡 {hint}"
            return feedback or self._fallback_feedback(lang)
        except (json.JSONDecodeError, KeyError, ValueError):
            return self._fallback_feedback(lang)

    def _fallback_feedback(self, lang: str) -> str:
        if lang == "ar":
            return "قريب جداً 👀 راجع خطواتك — فين بالظبط الخطوة اللي مش متأكد منها؟"
        return "Almost there! 👀 Review your steps — which part are you least confident about?"

    # ── Answer evaluation ─────────────────────────────────────────

    def evaluate_answer(self, correct_answer: str, student_answer: str) -> bool:
        r = self._call(
            "Are these two math answers equivalent? Consider simplified forms, equivalent fractions.\n"
            "Output ONLY: TRUE or FALSE",
            f"Correct: {correct_answer}\nStudent: {student_answer}",
            temperature=0.0, max_tokens=512, use_fast=True
        )
        return "TRUE" in r.upper()

    # ── Practice generation ───────────────────────────────────────

    def generate_practice(self, branch: str, original_question: str = "",
                           difficulty: str = "similar") -> str:
        lang   = detect_language(original_question)
        system = _tutor(lang,
                        "Generate ONE practice problem. Same concept, different numbers.\n"
                        "Problem statement ONLY — NO solution, NO answer, NO hints. 1-3 lines.")
        return self._call(system,
                          f"Original: {original_question}\nBranch: {branch}\nDifficulty: {difficulty}",
                          temperature=0.6, max_tokens=1000)

    def generate_harder_practice(self, branch: str, original_question: str = "") -> str:
        lang   = detect_language(original_question)
        system = _tutor(lang,
                        "Generate ONE harder problem. More steps or extra twist.\n"
                        "Problem statement ONLY — NO solution. 1-3 lines. End with '🔥 Level up!'")
        return self._call(system,
                          f"Original: {original_question}\nBranch: {branch}",
                          temperature=0.6, max_tokens=1000)

    # ── Help response ─────────────────────────────────────────────

    def help_response(self, question: str, branch: str, memory_ctx: str = "") -> str:
        lang = detect_language(question)
        ctx  = f"\nStudent background: {memory_ctx[:300]}" if memory_ctx else ""
        system = _tutor(lang,
                        f"Student is CONFUSED. Be extra gentle.{ctx}\n"
                        "1) Acknowledge it's okay (1 sentence)  "
                        "2) Simplify in plain language (1-2 sentences)  "
                        "3) Gentle nudge about where to start. NO solution, NO formulas.")
        return self._call(system, f"Problem: {question}\nBranch: {branch}",
                          temperature=0.5, max_tokens=1400)

    # ── Session summary ───────────────────────────────────────────

    def summarize_session(self, session_history: list,
                           stats: Optional[dict] = None) -> str:
        lang = "ar" if any(
            '\u0600' <= c <= '\u06FF'
            for item in session_history
            for c in str(item)
        ) else "en"
        stats_str = ""
        if stats:
            stats_str = (
                f"\nStats: {stats.get('problems_solved', 0)} solved, "
                f"{stats.get('total_attempts', 0)} attempts, "
                f"{stats.get('hints_used', 0)} hints."
            )
        system = _tutor(lang,
                        "Write a SESSION SUMMARY (3-4 sentences): "
                        "1) 🎉 Celebrate what went well  "
                        "2) 🎯 One focus area next time  "
                        "3) 💪 Motivating close. Short and warm.")
        return self._call(system, f"History: {session_history}{stats_str}",
                          temperature=0.5, max_tokens=1400)

    # ── MCQ generation (Khan-style quiz, PR-A) ────────────────────
    #
    # Returns a list of fully-formed MCQ dicts:
    #   [{ id, question, questionAr, options:[{id,label,labelAr}], correctOptionId,
    #      explanation, explanationAr, hint, hintAr }, …]
    #
    # The route layer strips `correctOptionId` and the `*Ar` variants are kept
    # so the frontend can show the question in the user's language without a
    # second LLM round-trip.

    def generate_mcq(self, branch: str, difficulty: str, count: int, source_question: str = "") -> list[dict]:
        # Hard caps so a bad payload can't make the model emit a 50-question test.
        count = max(1, min(int(count or 1), 10))
        if difficulty not in ("easy", "medium", "hard"):
            difficulty = "medium"
        if not branch:
            branch = "algebra"

        # Strict JSON contract. The schema is enumerated in the system prompt
        # so the model has no excuse to invent fields. We always ask for both
        # English and Arabic to keep the UI bilingual without a second call.
        system = (
            "You are MATHX, a senior math item-writer.\n"
            "Generate exactly N high-quality multiple-choice math questions.\n"
            "Output **ONLY** valid JSON with this exact shape — no commentary:\n"
            "{\n"
            '  "questions": [\n'
            "    {\n"
            '      "id": "<short-slug>",\n'
            '      "question": "<English question. LaTeX inside $…$>",\n'
            '      "questionAr": "<Arabic translation of the question>",\n'
            '      "options": [\n'
            '        { "id": "a", "label": "<En>", "labelAr": "<Ar>" },\n'
            '        { "id": "b", "label": "<En>", "labelAr": "<Ar>" },\n'
            '        { "id": "c", "label": "<En>", "labelAr": "<Ar>" },\n'
            '        { "id": "d", "label": "<En>", "labelAr": "<Ar>" }\n'
            "      ],\n"
            '      "correctOptionId": "<a|b|c|d>",\n'
            '      "explanation": "<2-4 sentence English explanation, LaTeX allowed>",\n'
            '      "explanationAr": "<Arabic translation of the explanation>",\n'
            '      "hint": "<1 sentence English hint, no answer leakage>",\n'
            '      "hintAr": "<Arabic translation of the hint>"\n'
            "    }\n"
            "  ]\n"
            "}\n"
            "STRICT RULES:\n"
            "• Exactly 4 options per question, ids must be 'a','b','c','d' in that order.\n"
            "• correctOptionId MUST be one of 'a','b','c','d' and MUST match an option.\n"
            "• All 4 option labels must be unique.\n"
            "• Distractors must be plausible mistakes (sign error, wrong rule, off-by-one).\n"
            "• Difficulty levels: easy=1-step / medium=2-3 steps / hard=multi-step or proof-ish.\n"
            "• Never reveal the correct option inside the question or option labels (no 'this is correct').\n"
            "• English and Arabic must be semantically identical — no extra info on either side.\n"
            "• If Source question/context is provided, every MCQ must target the same underlying concept and context.\n"
        )
        source_question = str(source_question or "").strip()
        if len(source_question) > 1200:
            source_question = source_question[:1200]
        user_lines = [
            f"N = {count}",
            f"Branch = {branch}",
            f"Difficulty = {difficulty}",
        ]
        if source_question:
            user_lines.append(f"Source question/context = {source_question}")
        user_lines.append("Generate the JSON now.")
        user = "\n".join(user_lines)
        raw = self._call(
            system, user,
            json_mode=True,
            temperature=0.4,
            max_tokens=min(_MAX_OUT_TOKENS, 1500 + count * 800),
        )
        return parse_mcq_payload(raw, count)


# ─────────────────────────────────────────────
# MCQ PAYLOAD PARSER  (kept module-level so unit tests can import it
# without instantiating an LLM client)
# ─────────────────────────────────────────────

_VALID_OPTION_IDS = ("a", "b", "c", "d")


def parse_mcq_payload(raw: str, expected_count: int) -> list[dict]:
    """Defensive parser for the JSON the LLM returns from `generate_mcq`.

    Handles three failure modes seen in production:
      • Wrapped in ```json fences (despite json_mode)
      • Missing `correctOptionId` (e.g. comes back as "" or "A")
      • Duplicate option ids (e.g. ['a','a','b','c'])

    Raises ValueError on unrecoverable input; caller decides whether to retry.
    """
    if not raw:
        raise ValueError("Empty MCQ payload")

    # Strip stray ```json wrappers (json_mode usually prevents this but the
    # fast model occasionally emits them anyway).
    text = _sanitize_text(raw) or raw

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ValueError("MCQ payload must be a JSON object")

    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        raise ValueError("MCQ payload missing non-empty 'questions' list")

    out: list[dict] = []
    for idx, q in enumerate(questions[:expected_count]):
        if not isinstance(q, dict):
            continue
        question_text   = str(q.get("question") or "").strip()
        question_ar     = str(q.get("questionAr") or "").strip()
        options_raw     = q.get("options") or []
        correct_id_raw  = str(q.get("correctOptionId") or "").strip().lower()
        explanation     = str(q.get("explanation") or "").strip()
        explanation_ar  = str(q.get("explanationAr") or "").strip()
        hint            = str(q.get("hint") or "").strip()
        hint_ar         = str(q.get("hintAr") or "").strip()

        if not question_text or not isinstance(options_raw, list):
            continue

        # Normalise options to exactly 4 with ids 'a'..'d'. If the LLM emitted
        # duplicate ids, fall back to positional ids (a,b,c,d in order).
        cleaned_options: list[dict] = []
        seen_ids: set[str] = set()
        for opt_idx, opt in enumerate(options_raw[:4]):
            if not isinstance(opt, dict):
                continue
            opt_id  = str(opt.get("id") or "").strip().lower()
            if opt_id not in _VALID_OPTION_IDS or opt_id in seen_ids:
                opt_id = _VALID_OPTION_IDS[opt_idx]
            seen_ids.add(opt_id)
            cleaned_options.append({
                "id":      opt_id,
                "label":   str(opt.get("label") or "").strip(),
                "labelAr": str(opt.get("labelAr") or "").strip(),
            })

        # Pad if the model returned <4 options (very rare in json_mode).
        while len(cleaned_options) < 4:
            cleaned_options.append({
                "id":      _VALID_OPTION_IDS[len(cleaned_options)],
                "label":   "",
                "labelAr": "",
            })

        # Resolve correctOptionId. Accept 'a'/'A'/'1'/'option_a' style.
        if correct_id_raw in _VALID_OPTION_IDS:
            correct_id = correct_id_raw
        elif correct_id_raw in ("1", "2", "3", "4"):
            correct_id = _VALID_OPTION_IDS[int(correct_id_raw) - 1]
        else:
            # Last-resort: if the explanation references a label verbatim,
            # pick that option. Otherwise refuse this question.
            match = None
            for opt in cleaned_options:
                if opt["label"] and opt["label"] in explanation:
                    match = opt["id"]
                    break
            if match is None:
                continue
            correct_id = match

        out.append({
            "id":              str(q.get("id") or f"q{idx + 1}"),
            "question":        question_text,
            "questionAr":      question_ar,
            "options":         cleaned_options,
            "correctOptionId": correct_id,
            "explanation":     explanation,
            "explanationAr":   explanation_ar,
            "hint":            hint,
            "hintAr":          hint_ar,
        })

    if not out:
        raise ValueError("No valid MCQs parsed from payload")
    return out


def strip_correct_option(question: dict) -> dict:
    """Return a copy of `question` with the answer removed.

    Used by the /study/mcq/generate route so the correct answer NEVER leaves
    the server. The route also drops the explanation since the student hasn't
    answered yet.
    """
    return {
        "id":         question.get("id"),
        "question":   question.get("question") or "",
        "questionAr": question.get("questionAr") or "",
        "options": [
            {
                "id":      str(opt.get("id") or ""),
                "label":   str(opt.get("label") or ""),
                "labelAr": str(opt.get("labelAr") or ""),
            }
            for opt in (question.get("options") or [])
        ],
        "hint":   question.get("hint") or "",
        "hintAr": question.get("hintAr") or "",
    }
