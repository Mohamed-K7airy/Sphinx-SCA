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
    from backend.llm_manager import client as groq_client, gemini_client
except ImportError:
    from llm_manager import client as groq_client, gemini_client


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
        "You are MATHX, a friendly study assistant built at MATHX University, Egypt.\n"
        f"Respond warmly. SHORT (2-4 sentences).\nLANGUAGE: {_lang_rule(lang)}"
    )


# ─────────────────────────────────────────────
# TOKEN CAPS
# ─────────────────────────────────────────────

_TOKENS = {"easy": 1000, "medium": 1500, "hard": 2500}


# ─────────────────────────────────────────────
# STUDY LLM CLASS
# ─────────────────────────────────────────────

class StudyLLM:

    def __init__(self):
        self.client = groq_client
        self.model  = "openai/gpt-oss-120b"

    # ── Core LLM caller ───────────────────────────────────────────

    def _call(self, system: str, user: str, *,
              json_mode: bool = False,
              temperature: float = 0.4,
              max_tokens: int = 300) -> str:
        
        # ── Gemini Fast Path ──
        if gemini_client is not None:
            try:
                g_kwargs = {
                    "model":       "gemini-2.5-flash",
                    "temperature": temperature,
                    "max_tokens":  max_tokens,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user",   "content": user},
                    ],
                }
                if json_mode:
                    g_kwargs["response_format"] = {"type": "json_object"}
                resp = gemini_client.chat.completions.create(**g_kwargs)
                text = resp.choices[0].message.content
                return text.strip() if text else ""
            except Exception as exc:
                print(f"⚠️ Gemini API error (falling back to Groq): {exc}")

        # ── Groq Path ──
        try:
            kwargs: dict = {
                "model":       self.model,
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
            return text if text else ""
        except Exception as exc:
            return json.dumps({"error": str(exc)}) if json_mode else f"Error: {exc}"

    # ── Intent classification ─────────────────────────────────────

    def classify_intent(self, text: str) -> str:
        t = text.strip().lower()

        if re.search(r'[\d]+\s*[+\-*/^=×÷]\s*[\d]', t): return "study"
        if re.search(r'[a-zA-Z]\s*[+\-*/^=]',        t): return "study"
        if re.search(r'\\frac|\\sqrt|\\int|\\sum',    t): return "study"
        if re.search(r'\d+[xyz]',                      t): return "study"

        if re.search(r'(i give up|show.?solution|show.?answer|استسلم|وريني الحل|ورني الحل|حل لي|حلها)', t):
            return "giveup"
        if re.search(r'(مش فاهم|مش عارف|لا أفهم|لا افهم|ساعدني|help me|confused|stuck|i.?m lost|don.?t understand)', t):
            return "help"
        if re.search(r'(explain|اشرح|وضح|فهمني|ايه هو|what is|what are|يعني ايه|definition|concept)', t):
            return "explain"
        if re.search(r'^(hi|hello|hey|مرحبا|اهلا|السلام|ازيك|صباح|مساء|شكرا|thanks|bye|كيفك|عامل ايه)[\s!?.]*$', t):
            return "casual"
        if re.search(r'(about me|about you|my name|who am i|do you know|tell me|what do you|who are you|how are you|what can you|عني|اسمي|من انا|هل تعرفني|ماذا تعرف|اخبرني|كيف حالك|من انت)', t):
            return "casual"
        if re.search(r'(solve|حل|factor|simplify|differentiate|integrate|calculate|find|evaluate|compute|limit|derive|prove|احسب|بسّط|اشتق|تكامل|عامل|حدد|how many|how much|total|sum|difference|average|calculus|algebra|geometry|math|equation|derivative|integral|practice|problem|تفاضل|جبر|هندسة|رياضيات|مسألة)', t):
            return "study"
        if not any(c in t for c in '+-*/=^()[]{}'):
            return "casual"
        return "study"

    # ── Difficulty ────────────────────────────────────────────────

    def classify_difficulty(self, question: str, branch: str) -> str:
        r = self._call(
            "Classify math problem difficulty. Output ONLY one word: easy, medium, or hard.\n"
            "easy=basic arithmetic/one-step | medium=quadratics/basic calculus | hard=complex integrals/proofs",
            f"Problem: {question}\nBranch: {branch}",
            temperature=0.0, max_tokens=5,
        ).lower()
        return r if r in ("easy", "medium", "hard") else "medium"

    # ── Casual chat ───────────────────────────────────────────────

    def chat_casual(self, message: str, memory_ctx: str = "") -> str:
        lang   = detect_language(message)
        system = _chat_persona(lang)
        if memory_ctx:
            system += f"\n\n[User context — use silently: {memory_ctx[:300]}]"
        return self._call(system, message, temperature=0.7, max_tokens=200)

    # ── Explain topic (concept questions, no problem) ─────────────

    def explain_topic(self, question: str, branch: str, memory_ctx: str = "") -> str:
        lang = detect_language(question)
        ctx  = f"\nStudent background (subtle): {memory_ctx[:300]}" if memory_ctx else ""
        system = _tutor(lang,
                        f"Explain concept in 3-4 sentences, give one example, end with a check question.{ctx}")
        return self._call(system, f"Topic: {question}\nBranch: {branch}",
                          temperature=0.3, max_tokens=400)

    # ── Session intro (NEVER leaks answer) ───────────────────────

    def explain_concept(self, question: str, branch: str,
                        difficulty: str = "medium", memory_ctx: str = "") -> str:
        lang  = detect_language(question)
        depth = {
            "easy":   "One sentence. Identify the type. Ask the first step.",
            "medium": "1-2 sentences. Name the concept. Ask what approach to try.",
            "hard":   "2-3 sentences. Name concept + complexity. Ask a strategic question.",
        }.get(difficulty, "1-2 sentences. Name the concept. Ask what approach to try.")
        ctx = f"\nStudent background: {memory_ctx[:300]}" if memory_ctx else ""
        system = _tutor(lang,
                        f"{depth}{ctx}\nNEVER reveal solution steps, formulas, or the answer.")
        return self._call(system, f"Problem: {question}\nBranch: {branch}",
                          temperature=0.4, max_tokens=_TOKENS.get(difficulty, 200))

    # ── Hint (NEVER leaks answer) ─────────────────────────────────

    def generate_hint(self, question: str, branch: str, hint_number: int,
                      difficulty: str = "medium", memory_ctx: str = "") -> str:
        lang  = detect_language(question)
        level = {
            1: "Point ONLY to the technique/formula category. No calculations.",
            2: "Name the EXACT formula or operation structure. No numbers yet.",
            3: "Show the FIRST calculation step only. Stop before the answer.",
        }.get(hint_number, "Point to the technique needed.")
        ctx = f"\nStudent weakness (subtle): {memory_ctx[:200]}" if memory_ctx else ""
        system = _tutor(lang,
                        f"Hint #{hint_number}/3. Level: {level}{ctx}\n"
                        "MAX 2 sentences. Do NOT solve. Do NOT reveal the answer.")
        return self._call(system,
                          f"Problem: {question}\nBranch: {branch}\nHint #{hint_number}:",
                          temperature=0.35, max_tokens=120)

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
                          max_tokens=_TOKENS.get(difficulty, 300))

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
                          temperature=0.4, max_tokens=120)

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
            json_mode=True, max_tokens=220,
        )
        try:
            data     = json.loads(raw)
            feedback = str(data.get("feedback", ""))
            hint     = str(data.get("hint", ""))
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
            temperature=0.0, max_tokens=5,
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
                          temperature=0.6, max_tokens=150)

    def generate_harder_practice(self, branch: str, original_question: str = "") -> str:
        lang   = detect_language(original_question)
        system = _tutor(lang,
                        "Generate ONE harder problem. More steps or extra twist.\n"
                        "Problem statement ONLY — NO solution. 1-3 lines. End with '🔥 Level up!'")
        return self._call(system,
                          f"Original: {original_question}\nBranch: {branch}",
                          temperature=0.6, max_tokens=150)

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
                          temperature=0.5, max_tokens=220)

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
                          temperature=0.5, max_tokens=200)
