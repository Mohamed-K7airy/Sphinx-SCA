"""
MATHX — Backend API (v3 Stable)
"""

import os
import sys
import re
import time
import uvicorn
import logging
from typing import Optional, Any
from collections import defaultdict
from dotenv import load_dotenv
load_dotenv()
from fastapi import FastAPI, UploadFile, File, Request, Response, Form
from pydantic import BaseModel
from pydantic import Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import json
import asyncio

# ─────────────────────────────────────────────
# PATH CONFIG
# ─────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)

# Add PROJECT_ROOT and the math_engine package roots to sys.path.
# This makes imports work consistently when running via:
# - `uvicorn backend.app:app`
# - `python backend/app.py`
# - deployed process managers that set different working directories
def _safe_sys_path_prepend(p: str) -> None:
    if p and p not in sys.path:
        sys.path.insert(0, p)

_safe_sys_path_prepend(PROJECT_ROOT)
_safe_sys_path_prepend(os.path.join(BASE_DIR, "math_engine"))              # allows `import math_engine...`
_safe_sys_path_prepend(os.path.join(BASE_DIR, "math_engine", "math_engine"))  # legacy fallback (modules as top-level)

# ─────────────────────────────────────────────
# ENVIRONMENT
# ─────────────────────────────────────────────

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not GROQ_API_KEY:
    print("⚠️ GROQ_API_KEY not found in environment variables")
else:
    print("🔑 Groq API key loaded")

# ─────────────────────────────────────────────
# LOAD LLM MANAGER
# ─────────────────────────────────────────────

try:
    from backend.llm_manager import LLMManager
except ImportError:
    try:
        from llm_manager import LLMManager
    except ImportError:
        LLMManager = None

if LLMManager:
    try:
        llm = LLMManager()
        print("✅ LLM Manager loaded")
    except Exception as e:
        llm = None
        print("⚠️ LLM Manager failed:", e)
else:
    llm = None
    print("⚠️ LLM Manager class could not be imported")

# ─────────────────────────────────────────────
# LOAD SEARCH AGENT
# ─────────────────────────────────────────────

try:
    from backend.search_agent import ARIAAgent
except ImportError:
    try:
        from search_agent import ARIAAgent
    except ImportError:
        ARIAAgent = None

if ARIAAgent:
    try:
        # Pass tokens and context lengths manually if needed, or stick to defaults
        search_agent = ARIAAgent()
        print("✅ Search Agent loaded")
    except Exception as e:
        search_agent = None
        print("⚠️ Search Agent failed:", e)
else:
    search_agent = None
    print("⚠️ Search Agent class could not be imported")

# ─────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sphinx")

# ─────────────────────────────────────────────
# GROQ FALLBACK CHAIN
# ─────────────────────────────────────────────
# llama-3.3-70b-versatile has a 100k TPD limit on the Groq free tier and
# routinely returns 429 on bursty quiz/study-guide flows. The chain below is
# walked in order: 70B → 8B → Gemma. Only RATE-LIMIT failures roll forward;
# other exceptions are re-raised immediately so we don't mask real errors.

from groq import AsyncGroq  # module-level so the helper doesn't re-import per call

GROQ_MODEL_CHAIN = [
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
]


async def groq_chat_with_fallback(
    messages: list,
    max_tokens: int = 1500,
    temperature: float = 0.4,
    response_format: Optional[dict] = None,
) -> str:
    """Try models in GROQ_MODEL_CHAIN in order; on 429/rate-limit fall through.

    Returns the first non-empty assistant message content. Raises the last
    encountered exception if every model fails. `response_format` (e.g.
    `{"type": "json_object"}`) is passed through when provided.
    """
    if not GROQ_API_KEY:
        raise RuntimeError("Groq API key not configured")

    last_error: Optional[Exception] = None
    for model in GROQ_MODEL_CHAIN:
        try:
            client = AsyncGroq(api_key=GROQ_API_KEY, timeout=60.0)
            kwargs: dict[str, Any] = {
                "model":       model,
                "messages":    messages,
                "max_tokens":  max_tokens,
                "temperature": temperature,
            }
            if response_format is not None:
                kwargs["response_format"] = response_format
            response = await client.chat.completions.create(**kwargs)
            return response.choices[0].message.content or ""
        except Exception as exc:
            msg = str(exc).lower()
            is_rate_limited = (
                "429" in msg
                or "rate_limit" in msg
                or "rate limit" in msg
                or "tokens per day" in msg
                or "tokens per minute" in msg
            )
            if is_rate_limited:
                logger.warning("Groq model %s rate limited, falling through: %s", model, exc)
                last_error = exc
                continue
            # Non-rate-limit failure: surface it to the caller untouched.
            raise

    # All models exhausted by 429s.
    if last_error is not None:
        raise last_error
    raise RuntimeError("Groq fallback chain returned no models")

# ─────────────────────────────────────────────
# MATH ENGINE IMPORTS
# ─────────────────────────────────────────────

try:
    # Preferred (package) import
    # pyrefly: ignore [missing-import]
    from math_engine.algebra.algebra_engine import solve as algebra_solve
    print("✅ Algebra engine loaded")
except Exception as e:
    try:
        # Legacy fallback (when math_engine/math_engine is on sys.path)
        # pyrefly: ignore [missing-import]
        from algebra.algebra_engine import solve as algebra_solve
        print("✅ Algebra engine loaded (legacy import)")
    except Exception as e2:
        algebra_solve = None
        print(f"⚠️ Algebra engine failed: {e} / {e2}")

try:
    from math_engine import calculus as _calculus
    calculus_solve = _calculus.solve
    print("✅ Calculus engine loaded")
except Exception as e:
    try:
        # pyrefly: ignore [missing-import]
        import calculus as _calculus  # legacy fallback
        calculus_solve = _calculus.solve
        print("✅ Calculus engine loaded (legacy import)")
    except Exception as e2:
        calculus_solve = None
        print(f"⚠️ Calculus engine failed: {e} / {e2}")

try:
    from math_engine import geometry as _geometry
    geometry_solve = _geometry.solve
    print("✅ Geometry engine loaded")
except Exception as e:
    try:
        # pyrefly: ignore [missing-import]
        import geometry as _geometry  # legacy fallback
        geometry_solve = _geometry.solve
        print("✅ Geometry engine loaded (legacy import)")
    except Exception as e2:
        geometry_solve = None
        print(f"⚠️ Geometry engine failed: {e} / {e2}")

try:
    from math_engine import statistics_engine as _statistics_engine
    statistics_solve = _statistics_engine.solve
    print("✅ Statistics engine loaded")
except Exception as e:
    try:
        # pyrefly: ignore [missing-import]        
        import statistics_engine as _statistics_engine  # legacy fallback
        statistics_solve = _statistics_engine.solve
        print("✅ Statistics engine loaded (legacy import)")
    except Exception as e2:
        statistics_solve = None
        print(f"⚠️ Statistics engine failed: {e} / {e2}")

try:
    from math_engine import linear_algebra as _linear_algebra
    linear_algebra_solve = _linear_algebra.solve
    print("✅ Linear algebra engine loaded")
except Exception as e:
    try:
        # pyrefly: ignore [missing-import]        
        import linear_algebra as _linear_algebra  # legacy fallback
        linear_algebra_solve = _linear_algebra.solve
        print("✅ Linear algebra engine loaded (legacy import)")
    except Exception as e2:
        linear_algebra_solve = None
        print(f"⚠️ Linear algebra engine failed: {e} / {e2}")

print(f"📦 Engines Loaded: Algebra={algebra_solve is not None}, Calculus={calculus_solve is not None}, Geometry={geometry_solve is not None}")

# ─────────────────────────────────────────────
# FASTAPI APP
# ─────────────────────────────────────────────

# ✅ FIX: Restrict CORS to known origins instead of wildcard
_raw_origins = os.getenv("ALLOWED_ORIGINS", "https://mathx-production.up.railway.app").split(",")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins if o.strip()]

# ✅ FIX (S-12): Only add local dev origins when not in production
_is_production = os.getenv("ENV", "development").lower() == "production"
if not _is_production:
    LOCAL_DEFAULTS = [
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://localhost:8000", "http://127.0.0.1:8000",
    ]
    for origin in LOCAL_DEFAULTS:
        if origin not in ALLOWED_ORIGINS:
            ALLOWED_ORIGINS.append(origin)

app = FastAPI(
    title="MATHX API",
    version="3.0"
)

try:
    from backend.memory.generate_embeddings import _generate_sync
except ImportError:
    try:
        from memory.generate_embeddings import _generate_sync
    except ImportError:
        _generate_sync = None

@app.on_event("startup")
async def startup_event():
    print("Application starting...")
    if _generate_sync:
        try:
            # Warm up cloud embedding connection
            import asyncio
            await asyncio.to_thread(_generate_sync, ["warmup"])
            print("✅ Embedding system ready (Cloud API)")
        except Exception as e:
            print(f"⚠️ Startup warmup failed: {e}")

# Simple In-Memory Rate Limiter (Token Bucket per IP)
from fastapi import HTTPException

# ✅ FIX (W-13): Add fallback import for presentation
try:
    from backend.presentation import attach_presentation_fields
except ImportError:
    from presentation import attach_presentation_fields

RATE_LIMIT_REQUESTS = 60
RATE_LIMIT_WINDOW_SECONDS = 60
_MAX_TRACKED_IPS = 10000  # ✅ FIX (C-04): prevent unbounded memory growth
ip_requests = defaultdict(list)

@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    # Skip rate limiting for OPTIONS preflight requests
    if request.method == "OPTIONS":
        return await call_next(request)

    client_ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Clean up old requests for this IP
    ip_requests[client_ip] = [req_time for req_time in ip_requests[client_ip] if now - req_time < RATE_LIMIT_WINDOW_SECONDS]

    # ✅ FIX (C-04): Evict stale IPs periodically to prevent memory leak
    if len(ip_requests) > _MAX_TRACKED_IPS:
        stale_ips = [ip for ip, times in ip_requests.items() if not times or (now - max(times)) > RATE_LIMIT_WINDOW_SECONDS]
        for ip in stale_ips:
            del ip_requests[ip]

    if len(ip_requests[client_ip]) >= RATE_LIMIT_REQUESTS:
        return JSONResponse(status_code=429, content={"detail": "Too Many Requests"})

    ip_requests[client_ip].append(now)
    return await call_next(request)

# ✅ FIX (C-01): Use ALLOWED_ORIGINS instead of wildcard "*"
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────

class QuestionRequest(BaseModel):
    question: str = Field(..., max_length=10000)  # ✅ FIX (S-01): limit input size
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=50)
    mode: str = "general"
    image_data: Optional[str] = None
    user_id: Optional[str] = None          # ✅ Memory: user identity

class HintRequest(BaseModel):
    question: str = Field(..., max_length=10000)
    problem_type: str = "algebra"
    num_hints: int = Field(default=3, ge=1, le=5)

class StudyRequest(BaseModel):
    question: str = Field(..., max_length=10000)
    branch: str = "algebra"
    session_id: Optional[str] = None
    user_id: Optional[str] = None          # ✅ Memory: user identity for study mode
    image_data: Optional[str] = None       # ✅ Vision: base64 image for Llama 4 Scout extraction

class CheckRequest(BaseModel):
    session_id: str
    question: str = Field(..., max_length=10000)
    branch: str = "algebra"
    student_answer: str = Field(..., max_length=5000)
    correct_answer: str = Field(..., max_length=5000)
    user_id: Optional[str] = None          # ✅ Memory: user identity for study mode
    image_data: Optional[str] = None       # ✅ Vision: base64 image for Llama 4 Scout extraction

class TitleRequest(BaseModel):
    text: str = Field(..., max_length=10000)


class MCQGenerateRequest(BaseModel):
    branch:     str = Field(default="algebra", max_length=64)
    difficulty: str = Field(default="medium",  max_length=16)
    # The UI only sends 1 or 5 — anything else gets clamped server-side in
    # study_tools.generate_mcq. Keep the range generous here so we return
    # 422 only for clearly malformed input.
    count:      int = Field(default=1, ge=1, le=10)
    source_question: Optional[str] = Field(default=None, max_length=1200)
    context: Optional[str] = ""
    unit: Optional[str] = ""
    topic: Optional[str] = ""
    user_question: Optional[str] = ""


class MCQCheckRequest(BaseModel):
    test_id:            str = Field(..., max_length=128)
    question_id:        str = Field(..., max_length=128)
    selected_option_id: str = Field(..., max_length=8)

class QuizPanelGenerateRequest(BaseModel):
    topic: str = Field(..., max_length=100)
    unit: str = Field(..., max_length=200)
    difficulty: str = Field(default="medium", max_length=20)
    context: Optional[str] = ""


class StudyGuideRequest(BaseModel):
    unit: str = Field(..., max_length=200)
    topic: str = Field(..., max_length=100)


class CheatsheetRequest(BaseModel):
    unit: str = Field(..., max_length=200)
    topic: str = Field(..., max_length=100)


# ─────────────────────────────────────────────
# SOLVER HELPER
# ─────────────────────────────────────────────

def run_solver(fn, *args, **kwargs):

    if fn is None:
        return {"success": False, "error": "engine not available"}

    try:
        result = fn(*args, **kwargs)

        if isinstance(result, dict):
            # Preserve the engine's own success flag if present.
            if "success" in result:
                return result
            return {"success": True, **result}

        return {
            "success": True,
            "final_answer": str(result)
        }

    except Exception as e:
        # ✅ FIX: Log the actual error instead of swallowing it silently
        logger.error("Solver error in %s: %s", fn.__name__ if hasattr(fn, '__name__') else str(fn), e, exc_info=True)
        return {
            "success": False,
            "error": str(e)
        }

# ─────────────────────────────────────────────
# MAIN PIPELINE
# ─────────────────────────────────────────────

async def route_and_solve(
    question: str,
    history: Optional[list[dict[str, Any]]] = None,
    mode: str = "general",
    user_id: Optional[str] = None,          # ✅ Memory: passed through pipeline
) -> dict[str, Any]:

    if history is None:
        history = []

    raw_question = (question or "").strip()
    logger.info("Question: %s | User: %s", raw_question, user_id)

    if llm is None:
        return {
            "success": False,
            "error": "LLM not available"
        }

    def _normalize_mode(m: str) -> str:
        m = (m or "").strip().lower()
        return m if m in {"general", "think", "steps"} else "general"

    mode = _normalize_mode(mode)

    # ── Track who solved the problem ──
    solved_by = "none"

    def _parser_key_for_branch(b: str) -> str:
        """
        `LLMManager.parse()` expects a parser key, not necessarily the classifier branch.
        - classifier uses: linear_algebra
        - parser prompt uses: matrix
        """
        if b == "linear_algebra":
            return "matrix"
        return b

    def _heuristic_engine_input(raw: str) -> str:
        """
        Best-effort fallback when LLM parsing is unavailable.
        Strips common instruction prefixes that break SymPy parsing.
        """
        s = (raw or "").strip()
        s = re.sub(r"^(please\s+)?(solve|simplify|factor|expand|differentiate|derive|integrate|find)\b[:\s]+", "", s, flags=re.I)
        s = s.strip()
        return s or raw

    # 1️⃣ classify
    try:
        c = llm.classify(raw_question)
        branch = c.get("branch", "algebra")
        problem_type = c.get("problem_type", "solve")
        is_math = c.get("is_math", True)
    except Exception as e:
        logger.warning("Classification failed, defaulting to algebra: %s", e)
        branch = "algebra"
        problem_type = "solve"
        is_math = True

    # 2️⃣ chat
    if not is_math or branch == "chat":
        solved_by = "LLM"

        try:
            chat_question = raw_question
            if mode == "think":
                chat_question = f"{raw_question}\n\nPlease explain thoroughly and clearly."
            elif mode == "steps":
                chat_question = f"{raw_question}\n\nPlease respond with a clear step-by-step explanation."

            # ✅ Memory: pass user_id to chat so memory is loaded/saved
            answer = await llm.chat(chat_question, history, user_id=user_id)

            return attach_presentation_fields(
                question=raw_question,
                branch="chat",
                mode=mode,
                result={
                    "success": True,
                    "branch": "chat",
                    "final_answer": answer,
                    "is_chat": True,
                    "llm_steps": [],
                    "solved_by": solved_by,
                },
            )

        except Exception as e:
            logger.error("Chat error: %s", e, exc_info=True)
            return {
                "success": False,
                "error": str(e)
            }

    # 3️⃣ parse
    try:
        parsed = llm.parse(raw_question, _parser_key_for_branch(branch))
    except Exception as e:
        logger.warning("Parse failed: %s", e)
        parsed = {}

    # 4️⃣ solve
    result: dict[str, Any] = {"success": False}

    if branch == "algebra":
        expr = parsed.get("expression") or _heuristic_engine_input(raw_question)
        result = run_solver(algebra_solve, expr)

    elif branch == "calculus":
        expr = parsed.get("expression") or _heuristic_engine_input(raw_question)
        result = run_solver(calculus_solve, expr)

    elif branch == "geometry":
        shape = parsed.get("shape")
        find = parsed.get("find")
        known = parsed.get("known", {})
        result = run_solver(geometry_solve, shape, find, **known)

    elif branch == "statistics":
        data = parsed.get("data", [])
        op = parsed.get("operation", "mean")
        result = run_solver(statistics_solve, op, data=data)

    elif branch == "linear_algebra":
        op = parsed.get("operation", "determinant")
        matrix = parsed.get("matrix_a")
        result = run_solver(linear_algebra_solve, op, matrix=matrix)

    if result.get("success"):
        solved_by = "Math Engine"

    # 5️⃣ fallback to LLM
    if not result.get("success"):
        if branch == "word_problem":
            try:
                wp = llm.word_problem(question)
                result = {
                    "success": True,
                    "final_answer": wp.get("answer_sentence")
                }
                solved_by = "LLM"
            except Exception as e:
                logger.error("Word problem fallback failed: %s", e, exc_info=True)
                result["error"] = str(e)
        else:
            result = {"success": False, "error": "Math engine failed to solve the problem."}

    # 6️⃣ steps
    if result.get("success"):
        try:
            steps = llm.steps(
                raw_question,
                str(result.get("final_answer", "")),
                branch
            )
        except Exception as e:
            logger.warning("Steps generation failed: %s", e)
            steps = []

        result["llm_steps"] = steps

    result["branch"] = branch
    result["problem_type"] = problem_type
    result["is_chat"] = False
    result["mode"] = mode
    result["solved_by"] = solved_by

    # ✅ FIX (M-10): Removed dead duplicate steps code — steps are already
    # generated in section 6️⃣ above when result is successful.

    # 7️⃣ ✅ Memory: wrap math result in friendly memory-aware response if user_id present
    if user_id and result.get("success"):
        try:
            friendly_answer = await llm.chat_with_math(raw_question, result, history, user_id=user_id)
            result["final_answer"] = friendly_answer
        except Exception as e:
            logger.warning("Friendly math response failed: %s", e)

    return attach_presentation_fields(
        question=raw_question,
        branch=branch,
        mode=mode,
        result=result,
    )

# ─────────────────────────────────────────────
# STUDY MODE HELPERS
# ─────────────────────────────────────────────

# ✅ FIX (W-14): Add fallback import for study_agent
try:
    from backend.study_engine.study_agent import get_study_agent
except ImportError:
    from study_engine.study_agent import get_study_agent


async def _extract_image_text(image_data: Optional[str]) -> Optional[str]:
    """
    ✅ Vision: Use Llama 4 Scout to extract text/equations from an uploaded image.
    Returns the extracted text or None if no image or extraction fails.
    """
    if not image_data:
        return None
    try:
        try:
            import backend.vision_scout as vision_scout
        except ImportError:
            import vision_scout
        extracted = await asyncio.to_thread(vision_scout.analyze_image_base64, image_data)
        if extracted and not extracted.startswith("Error"):
            return extracted
    except Exception as e:
        logger.warning("Vision Scout extraction failed: %s", e)
    return None


def _enhance_question_with_image(question: str, image_text: str) -> str:
    """
    ✅ Vision: Prepend extracted image content to the user's question.
    """
    return (
        f"[Content extracted from uploaded image]:\n{image_text}\n\n"
        f"User question: {question}"
    )

def render_study_markdown(result: dict) -> str:
    """
    Renders study result into clean markdown — NO fixed section headers.
    """
    parts = []

    if result.get("concept_explanation"):
        parts.append(result["concept_explanation"])

    if result.get("socratic_question"):
        parts.append(result["socratic_question"])

    if result.get("hint_text"):
        hints_left = result.get("hints_remaining", 0)
        parts.append(f"*({hints_left} hint{'s' if hints_left != 1 else ''} remaining)*\n\n" + result["hint_text"])

    if result.get("solve_output"):
        parts.append(result["solve_output"])

    if result.get("mistake_feedback"):
        parts.append(result["mistake_feedback"])

    if result.get("practice_problem"):
        parts.append(result["practice_problem"])

    if result.get("session_summary"):
        parts.append(result["session_summary"])
        stats = result.get("stats", {})
        if stats:
            parts.append(
                f"**{stats.get('problems_solved', 0)}** solved · "
                f"**{stats.get('hints_used', 0)}** hints · "
                f"**{stats.get('total_attempts', 0)}** attempts"
            )

    if not parts:
        parts.append(result.get("error") or "Session updated.")

    return "\n\n".join(parts)

# ─────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────

# ── Intent-based fast endpoints ──────────────────────────────────
#khairy update اضافة خاصية استنتاج عنوان المحادثة   
@app.post("/generate_title")
async def generate_title(req: TitleRequest):
    """Generate a short Arabic title for a conversation."""
    # ✅ FIX (C-06): Sanitize input to prevent prompt injection
    sanitized_text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', req.text)[:2000]
    if llm is None:
        return {"title": sanitized_text[:30]}
    try:
        title = await asyncio.to_thread(llm.generate_title, sanitized_text)
        return {"title": title}
    except Exception as e:
        logger.error("Title generation failed: %s", e)  # ✅ FIX (L-07): %s logging
        return {"title": sanitized_text[:30]}


# Req #4: Public read of a shared chat session.
# When a user shares a chat link, the recipient is usually a different account
# (or signed out entirely). Supabase RLS would normally hide those rows, so we
# fetch them server-side using the service_role_key and return the public-safe
# fields (no user_id) ordered by created_at.
_SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')

@app.get("/shared_chat/{session_id}")
async def shared_chat(session_id: str):
    """Return all messages for a shared session id, bypassing RLS."""
    if not _SESSION_ID_RE.match(session_id):
        return JSONResponse({"success": False, "error": "Invalid session_id"}, status_code=400)

    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    anon_key = os.getenv("SUPABASE_KEY")

    if not supabase_url or not (service_role_key or anon_key):
        return JSONResponse(
            {"success": False, "error": "Missing Supabase configuration"},
            status_code=500,
        )

    import httpx
    headers = {
        "apikey": service_role_key or anon_key,
        "Authorization": f"Bearer {service_role_key or anon_key}",
    }
    # Cap at 500 messages so a long session can't blow up the response.
    url = (
        f"{supabase_url}/rest/v1/messages"
        f"?session_id=eq.{session_id}"
        f"&select=content,sender,image_url,created_at"
        f"&order=created_at.asc&limit=500"
    )

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            res = await client.get(url, headers=headers)
            if res.status_code != 200:
                logger.warning(
                    "shared_chat: supabase responded %s: %s",
                    res.status_code, res.text[:200],
                )
                return JSONResponse(
                    {"success": False, "error": "Could not fetch shared chat"},
                    status_code=502,
                )
            messages = res.json() or []
            return {"success": True, "messages": messages}
        except Exception as e:
            logger.error("shared_chat failed: %s", e)
            return JSONResponse(
                {"success": False, "error": "Server error"},
                status_code=500,
            )

@app.post("/study/chat")
async def study_chat(req: StudyRequest):
    """Casual chat — no graph, direct LLM."""
    question = req.question
    # ✅ Vision: extract image content if present
    image_text = await _extract_image_text(req.image_data)
    if image_text:
        question = _enhance_question_with_image(question, image_text)
    agent = get_study_agent()
    result = await agent.chat(question, user_id=req.user_id or "")
    return result

@app.post("/study/explain")
async def study_explain(req: StudyRequest):
    """Explain a concept — direct LLM, no graph."""
    question = req.question
    # ✅ Vision: extract image content if present
    image_text = await _extract_image_text(req.image_data)
    if image_text:
        question = _enhance_question_with_image(question, image_text)
    agent = get_study_agent()
    result = await agent.explain(question, req.branch, user_id=req.user_id or "")
    return result

@app.post("/study/help")
async def study_help(req: StudyRequest):
    """Help confused user — direct LLM, no graph."""
    question = req.question
    # ✅ Vision: extract image content if present
    image_text = await _extract_image_text(req.image_data)
    if image_text:
        question = _enhance_question_with_image(question, image_text)
    agent = get_study_agent()
    result = await agent.help_user(question, req.branch, user_id=req.user_id or "")
    return result

@app.post("/study/classify")
async def study_classify(req: StudyRequest):
    """Classify user intent — returns casual/study/explain/help."""
    agent = get_study_agent()
    intent = agent.classify_intent(req.question)
    return {"intent": intent}

# ── Graph-based study endpoints (memory-enriched) ─────────────────

@app.post("/study/start")
async def study_start(req: StudyRequest):
    question = req.question
    # ✅ Vision: extract image content and use it as the study question
    image_text = await _extract_image_text(req.image_data)
    if image_text:
        question = _enhance_question_with_image(question, image_text)
    agent = get_study_agent()
    result = await agent.start(question, req.branch, user_id=req.user_id or "")
    result["display_markdown"] = render_study_markdown(result)
    return result

@app.post("/study/hint")
async def study_hint(req: StudyRequest):
    if not req.session_id:
        return {"success": False, "error": "session_id is required"}
    agent = get_study_agent()
    result = await agent.hint(req.session_id, req.question, req.branch, user_id=req.user_id or "")
    result["display_markdown"] = render_study_markdown(result)
    return result

@app.post("/study/solve")
async def study_solve(req: StudyRequest):
    """Immediately solve — full solution, no Socratic."""
    if not req.session_id:
        return {"success": False, "error": "session_id is required"}
    agent = get_study_agent()
    result = await agent.solve(req.session_id, req.question, req.branch, user_id=req.user_id or "")
    result["display_markdown"] = render_study_markdown(result)
    return result

@app.post("/study/check")
async def study_check(req: CheckRequest):
    agent = get_study_agent()
    result = await agent.check(
        req.session_id,
        req.question,
        req.branch,
        req.student_answer,
        req.correct_answer,
        user_id=req.user_id or ""
    )
    result["display_markdown"] = render_study_markdown(result)
    return result

@app.post("/study/next")
async def study_next(req: StudyRequest):
    if not req.session_id:
        return {"success": False, "error": "session_id is required"}
    agent = get_study_agent()
    result = await agent.next(req.session_id, req.question, req.branch, user_id=req.user_id or "")
    result["display_markdown"] = render_study_markdown(result)
    return result

@app.post("/study/next_harder")
async def study_next_harder(req: StudyRequest):
    if not req.session_id:
        return {"success": False, "error": "session_id is required"}
    agent = get_study_agent()
    result = await agent.next_harder(req.session_id, req.question, req.branch, user_id=req.user_id or "")
    result["display_markdown"] = render_study_markdown(result)
    return result

@app.post("/study/summary")
async def study_summary(req: StudyRequest):
    if not req.session_id:
        return {"success": False, "error": "session_id is required"}
    agent = get_study_agent()
    result = await agent.finish(req.session_id, req.question, req.branch, user_id=req.user_id or "")
    result["display_markdown"] = render_study_markdown(result)
    return result


# ── Khan-style MCQ endpoints (PR-A) ────────────────────────────────
#
# These two endpoints are independent of study sessions — a student can
# generate a quiz without starting Study Mode first. The generated test
# lives in `mcq_tests_db` with the same TTL as study sessions. The route
# layer is intentionally thin so all branching logic stays testable in
# study_tools.{generate_mcq, check_mcq_answer}.

try:
    from backend.study_engine.study_tools import (
        generate_mcq as _mcq_generate,
        check_mcq_answer as _mcq_check,
    )
except ImportError:
    from study_engine.study_tools import (
        generate_mcq as _mcq_generate,
        check_mcq_answer as _mcq_check,
    )


@app.post("/study/mcq/generate")
async def study_mcq_generate(req: MCQGenerateRequest):
    """Generate N MCQs for a given branch + difficulty.

    Returns the test_id and a CLIENT-SAFE questions list (no correct ids,
    no explanations). LLM calls run on the threadpool so the event loop
    stays free.
    """
    try:
        source = req.source_question or ""
        if getattr(req, "context", None):
            source += f"\n\nContext: The student is currently studying this topic based on this conversation context:\n---\n{req.context[:600]}\n---\nGenerate questions that are DIRECTLY related to the concept above. The questions MUST test understanding of what was just explained."
        result = await asyncio.to_thread(
            _mcq_generate, req.branch, req.difficulty, req.count, source
        )
        # Defence-in-depth: even if a future tool implementation forgot to
        # strip the correct id, scrub it once more before serialising. This
        # is the assertion the regression test pins on.
        for q in result.get("questions", []):
            q.pop("correctOptionId", None)
            q.pop("correct_option_id", None)
            q.pop("explanation", None)
            q.pop("explanationAr", None)
        return result
    except ValueError as exc:
        logger.warning("MCQ generation failed: %s", exc)
        return JSONResponse(
            {"success": False, "error": "MCQ generation failed"},
            status_code=502,
        )
    except Exception as exc:
        logger.error("MCQ generation crashed: %s", exc)
        return JSONResponse(
            {"success": False, "error": "Server error"},
            status_code=500,
        )


@app.post("/study/mcq/check")
async def study_mcq_check(req: MCQCheckRequest):
    """Score one MCQ answer against the server-side record."""
    try:
        result = await asyncio.to_thread(
            _mcq_check, req.test_id, req.question_id, req.selected_option_id
        )
        if result.get("error") == "test_not_found":
            return JSONResponse(
                {"success": False, "error": "Test not found or expired"},
                status_code=404,
            )
        if result.get("error") == "question_not_found":
            return JSONResponse(
                {"success": False, "error": "Question not found"},
                status_code=404,
            )
        return result
    except Exception as exc:
        logger.error("MCQ check crashed: %s", exc)
        return JSONResponse(
            {"success": False, "error": "Server error"},
            status_code=500,
        )

@app.post("/study/quiz_panel/generate")
async def study_quiz_panel_generate(req: QuizPanelGenerateRequest):
    """Generate 5 MCQ questions for the Quiz Panel via the Groq fallback chain."""
    if not GROQ_API_KEY:
        return JSONResponse(
            {"success": False, "error": "Groq API key not configured"},
            status_code=500,
        )

    context_block = ""
    if req.context:
        context_block = f"""
The student is currently studying this topic based on this conversation context:
---
{req.context[:600]}
---
Generate MCQ questions that are DIRECTLY related to the concept above.
The questions must test understanding of what was just explained."""

    system_prompt = (
        f"You are a math quiz generator. Generate exactly 5 MCQ questions about {req.topic} - {req.unit}. "
        f"Difficulty: {req.difficulty}. {context_block}\nReturn ONLY valid JSON, no markdown, no explanation:\n"
        "{\n"
        "  \"questions\": [\n"
        "    {\n"
        "      \"question\": \"latex math question here\",\n"
        "      \"options\": [\"A) ...\", \"B) ...\", \"C) ...\", \"D) ...\"],\n"
        "      \"correct\": \"A\",\n"
        "      \"steps\": [\n"
        "        {\"title\": \"Step 1: ...\", \"explanation\": \"...\", \"formula\": \"latex here\"},\n"
        "        {\"title\": \"Step 2: ...\", \"explanation\": \"...\", \"formula\": \"latex here\"}\n"
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}"
    )

    try:
        content = await groq_chat_with_fallback(
            messages=[{"role": "system", "content": system_prompt}],
            max_tokens=2000,
            temperature=0.7,
            response_format={"type": "json_object"},
        )

        # Strip stray ```json fences in case any fallback model wraps the payload.
        raw = re.sub(r"^```(?:json)?\s*", "", (content or "").strip(), flags=re.IGNORECASE)
        raw = re.sub(r"\s*```\s*$", "", raw)

        payload = json.loads(raw)
        questions = payload.get("questions")
        if not isinstance(questions, list) or not questions:
            raise ValueError(
                f"Quiz payload missing non-empty 'questions' list (got keys={list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__})"
            )

        return JSONResponse(payload)

    except Exception as exc:
        logger.error("Quiz generation failed: %s", exc, exc_info=True)
        error_msg = str(exc)
        if "429" in error_msg or "rate_limit" in error_msg.lower() or "rate limit" in error_msg.lower():
            user_msg = "Rate limit reached. Please wait 1-2 minutes and try again."
        elif "API key" in error_msg or "api key" in error_msg.lower():
            user_msg = "API key not configured correctly."
        else:
            user_msg = f"Quiz generation failed: {error_msg[:200]}"
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": user_msg},
        )


# ── Study Guide and Cheatsheet generation (both JSON, both fallback) ──
#
# Both endpoints proxy Groq from the backend so the API key never leaves
# the server. Both return JSON (not SSE) so they share the same fallback
# helper and the frontend has one consistent response shape per FIX 5 audit.
# Frontend renders progressively via word-reveal on the returned markdown.

@app.post("/study/study_guide/generate")
async def study_guide_generate(req: StudyGuideRequest):
    """Return a markdown study guide for the given unit/topic as JSON."""
    if not GROQ_API_KEY:
        return JSONResponse(
            {"success": False, "error": "Groq API key not configured"},
            status_code=500,
        )

    system_prompt = (
        f"You are an expert math educator. Generate a comprehensive study guide for "
        f"{req.unit} in {req.topic}. Structure it as follows, using LaTeX for all "
        f"formulas (wrap in $$ $$):\n\n"
        "## [Main Concept 1 Title]\n"
        "[2-3 sentence explanation]\n"
        "Core formula or rule:\n"
        "$$[LaTeX formula]$$\n"
        "[1-2 sentence practical application note]\n\n"
        "## [Main Concept 2 Title]\n"
        "... (repeat pattern)\n\n"
        "Cover 4-6 key concepts. Keep each explanation clear and exam-focused.\n"
        "End with: ## Key Takeaways\n"
        "- bullet point 1\n"
        "- bullet point 2\n"
        "- bullet point 3"
    )
    user_prompt = f"Generate study guide for {req.unit} - {req.topic}"

    try:
        markdown = await groq_chat_with_fallback(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
            max_tokens=2500,
            temperature=0.4,
        )
        if not (markdown or "").strip():
            raise ValueError("Study guide came back empty")
        return {"markdown": markdown}

    except Exception as exc:
        logger.error("Study guide generation failed: %s", exc, exc_info=True)
        error_msg = str(exc)
        if "429" in error_msg or "rate_limit" in error_msg.lower() or "rate limit" in error_msg.lower():
            user_msg = "Rate limit reached. Please wait 1-2 minutes and try again."
        elif "API key" in error_msg or "api key" in error_msg.lower():
            user_msg = "API key not configured correctly."
        else:
            user_msg = f"Study guide generation failed: {error_msg[:200]}"
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": user_msg},
        )


@app.post("/study/cheatsheet/generate")
async def cheatsheet_generate(req: CheatsheetRequest):
    """Return a 6-8 entry cheatsheet as JSON: {cheatsheet: [{title, formula, note}, ...]}"""
    if not GROQ_API_KEY:
        return JSONResponse(
            {"success": False, "error": "Groq API key not configured"},
            status_code=500,
        )

    system_prompt = (
        f"Generate a compact cheatsheet for {req.unit} in {req.topic}.\n"
        "Return ONLY a valid JSON object with this exact shape:\n"
        "{\"cheatsheet\":[{\"title\":\"FORMULA NAME\",\"formula\":\"LaTeX here\",\"note\":\"one line tip\"}]}\n"
        "Generate 6-8 entries. The 'title' should be UPPERCASE. 'formula' is raw LaTeX "
        "WITHOUT $$ delimiters. 'note' is one short sentence."
    )

    try:
        content = await groq_chat_with_fallback(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": f"Generate cheatsheet for {req.unit} - {req.topic}"},
            ],
            max_tokens=1500,
            temperature=0.1,
            response_format={"type": "json_object"},
        )

        raw = re.sub(r"^```(?:json)?\s*", "", (content or "").strip(), flags=re.IGNORECASE)
        raw = re.sub(r"\s*```\s*$", "", raw)

        data = json.loads(raw)
        # Accept a couple of shapes the LLM occasionally produces.
        cheatsheet = None
        if isinstance(data, list):
            cheatsheet = data
        elif isinstance(data, dict):
            cheatsheet = (
                data.get("cheatsheet")
                or data.get("formulas")
                or data.get("entries")
            )
            if cheatsheet is None:
                # Fall back to the first list value in the object.
                for v in data.values():
                    if isinstance(v, list):
                        cheatsheet = v
                        break

        if not isinstance(cheatsheet, list) or not cheatsheet:
            raise ValueError("Missing non-empty cheatsheet list in response")

        return {"cheatsheet": cheatsheet}

    except Exception as exc:
        logger.error("Cheatsheet generation failed: %s", exc, exc_info=True)
        error_msg = str(exc)
        if "429" in error_msg or "rate_limit" in error_msg.lower() or "rate limit" in error_msg.lower():
            user_msg = "Rate limit reached. Please wait 1-2 minutes and try again."
        elif "API key" in error_msg or "api key" in error_msg.lower():
            user_msg = "API key not configured correctly."
        else:
            user_msg = f"Cheatsheet generation failed: {error_msg[:200]}"
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": user_msg},
        )

#مجرد اختبار لعدد المستخدمين محدش يهتم بيها خالص
# ── Admin Endpoints ───────────────────────────────────────────────

@app.get("/admin/stats")
async def get_admin_stats(request: Request):
    """Fetch real platform statistics from Supabase Database."""
    # ✅ FIX (H-09): Require ADMIN_SECRET header for authentication
    admin_secret = os.getenv("ADMIN_SECRET", "")
    if admin_secret:
        provided = request.headers.get("X-Admin-Secret", "")
        if provided != admin_secret:
            return JSONResponse({"success": False, "error": "Unauthorized"}, status_code=401)

    import httpx
    # ✅ FIX (H-08): Removed per-request .env reload — env is loaded at startup
    
    supabase_url = os.getenv("SUPABASE_URL")
    
    # We explicitly check for SERVICE_ROLE_KEY to hit the admin API for exact users
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    anon_key = os.getenv("SUPABASE_KEY")

    if not supabase_url or not anon_key:
        return {"success": False, "error": "Missing Supabase configuration"}

    async with httpx.AsyncClient() as client:
        try:
            # Prepare best headers for messages table
            msg_headers = {
                "apikey": service_role_key or anon_key,
                "Authorization": f"Bearer {service_role_key or anon_key}"
            }

            # 1. Total Messages (queries)
            msg_req = await client.get(
                f"{supabase_url}/rest/v1/messages?select=id",
                headers={**msg_headers, "Prefer": "count=exact,return=minimal"}
            )
            
            # Fallback if service_role_key is invalid/expired
            if msg_req.status_code in (401, 403) and service_role_key:
                msg_headers = {
                    "apikey": anon_key,
                    "Authorization": f"Bearer {anon_key}"
                }
                msg_req = await client.get(
                    f"{supabase_url}/rest/v1/messages?select=id",
                    headers={**msg_headers, "Prefer": "count=exact,return=minimal"}
                )
            
            total_messages = 0
            if "content-range" in msg_req.headers:
                range_str = msg_req.headers["content-range"]
                total_messages = int(range_str.split("/")[-1])
            elif msg_req.status_code == 200:
                total_messages = len(msg_req.json())

            # 2. Active users from unique user_ids in messages table
            users_req = await client.get(
                f"{supabase_url}/rest/v1/messages?select=user_id",
                headers=msg_headers
            )
            
            active_users = 0
            unique_users = set()
            if users_req.status_code == 200:
                data = users_req.json()
                for row in data:
                    uid = row.get("user_id")
                    if uid:
                        unique_users.add(uid)
                active_users = len(unique_users)

            # 3. Exact Total Users from Auth schema (Requires Service Role Key)
            exact_total_users = active_users
            recent_users = []
            chart_labels = []
            chart_data = []
            
            if service_role_key:
                auth_headers = {
                    "apikey": service_role_key,
                    "Authorization": f"Bearer {service_role_key}"
                }
                auth_req = await client.get(
                    f"{supabase_url}/auth/v1/admin/users",
                    headers=auth_headers
                )
                if auth_req.status_code == 200:
                    auth_data = auth_req.json()
                    users_list = auth_data.get('users', []) if isinstance(auth_data, dict) else auth_data
                    exact_total_users = len(users_list)
                    
                    # Sort by created_at descending
                    users_list.sort(key=lambda x: x.get('created_at', ''), reverse=True)
                    
                    # Fetch top 5 recent users with real emails
                    for u in users_list[:5]:
                        email = u.get("email", "Unknown")
                        name = email.split('@')[0] if "@" in email else "User"
                        recent_users.append({
                            "name": name,
                            "email": email,
                            "status": "offline" if u.get("id") not in unique_users else "online"
                        })
                        
                    # Calculate real user growth history (Last 6 Months)
                    from datetime import datetime, timezone
                    from collections import defaultdict
                    
                    counts_by_my = defaultdict(int)
                    for u in users_list:
                        c_at = u.get("created_at")
                        if c_at:
                            try:
                                y_m = c_at[:7] # YYYY-MM
                                counts_by_my[y_m] += 1
                            except:
                                pass
                                
                    now = datetime.now(timezone.utc)
                    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
                    
                    for i in range(5, -1, -1):
                        target_month = now.month - i
                        target_year = now.year
                        while target_month <= 0:
                            target_month += 12
                            target_year -= 1
                            
                        y_m = f"{target_year:04d}-{target_month:02d}"
                        
                        # Cumulative sum
                        c_sum = 0
                        for m_str, count in counts_by_my.items():
                            if m_str <= y_m:
                                c_sum += count
                                
                        chart_labels.append(months[target_month - 1])
                        chart_data.append(c_sum)
            
            # Formatting fallback for recent users if no service key
            if not recent_users and unique_users:
                for u in list(unique_users)[:5]:
                    short_id = str(u)[:6]
                    recent_users.append({
                        "name": f"User_{short_id}", 
                        "email": f"user_{short_id}@mathx.com", 
                        "status": "online"
                    })

            return {
                "success": True,
                "total_users": max(exact_total_users, 1),
                "active_users": active_users,
                "total_queries": total_messages,
                "recent_users": recent_users,
                "chart": {
                    "labels": chart_labels,
                    "data": chart_data
                }
            }

        except Exception as e:
            return {"success": False, "error": str(e)}

# ── Main solve endpoints ──────────────────────────────────────────

@app.post("/solve")
async def solve(req: QuestionRequest):
    # ✅ Memory: pass user_id through to pipeline
    return await route_and_solve(req.question, req.history, req.mode, user_id=req.user_id)


import time

@app.post("/solve_stream")
async def solve_stream(req: QuestionRequest):
    start_time = time.time()
    """Streaming endpoint for chat-like experience."""
    if llm is None:
        return JSONResponse({"success": False, "error": "LLM not initialized"}, status_code=500)

    # Capture a non-None reference for type checkers and closures.
    llm_local = llm

    messages = []
    if req.history:
        for m in req.history:
            # Handle both 'sender' and 'role' for compatibility
            role = m.get('role') or ("user" if m.get("sender") == "user" else "assistant")
            content = m.get("content", "")
            if role and content:
                messages.append({"role": role, "content": content})

    # Add current question
    prompt = req.question
    if req.mode == "think":
        prompt = f"Please solve this and explain your deep thinking process: {req.question}"
    elif req.mode == "steps":
        prompt = f"Please provide a detailed step-by-step solution for: {req.question}"

    messages.append({"role": "user", "content": prompt})

    # Prepare parallel tasks for classification and memory context
    async def get_classification():
        try:
            class_start = time.time()
            c = await asyncio.to_thread(llm_local.classify, req.question)
            class_duration = time.time() - class_start
            logger.info(f"Classification took {class_duration:.2f}s (Branch: {c.get('branch')})")
            return c.get("branch", "algebra")
        except Exception as e:
            logger.warning(f"Classification failed: {e}")
            return "algebra"

    async def get_memory():
        if req.user_id:
            try:
                mem_start = time.time()
                context = await llm_local.memory.get_context(req.user_id, req.question)
                mem_duration = time.time() - mem_start
                logger.info(f"Memory fetch took {mem_duration:.2f}s")
                return context
            except Exception as e:
                logger.warning(f"Memory fetch failed: {e}")
        return ""

    # Start both tasks in parallel
    branch_task = asyncio.create_task(get_classification())
    memory_task = asyncio.create_task(get_memory())

    # Wait for both to complete before proceeding
    branch, memory_context = await asyncio.gather(branch_task, memory_task)

    async def chunk_generator():
        try:
            # Inject memory context into the messages before streaming
            if memory_context:
                messages[-1]["content"] = f"[System Context About User: {memory_context}]\n\n{messages[-1]['content']}"

            if req.image_data:
                try:
                    import backend.vision_scout as vision_scout
                except ImportError:
                    import vision_scout

                vision_start = time.time()
                image_context = await asyncio.to_thread(vision_scout.analyze_image_base64, req.image_data)
                vision_duration = time.time() - vision_start
                logger.info(f"Vision Analysis took {vision_duration:.2f}s")

                # Inject the extracted context into the main LLM's prompt
                enhanced_prompt = f"Image Description (extracted by Vision Scout):\n{image_context}\n\nUser Question:\n{messages[-1]['content']}"
                messages[-1]["content"] = enhanced_prompt

            if branch == "search" and search_agent is not None:
                # Use ARIA search agent stream
                async for chunk in search_agent.stream_search(messages):
                    yield f"data: {json.dumps({'content': chunk})}\n\n"
            else:
                # ✅ Memory: stream with user_id
                async for chunk in llm_local.stream_chat(messages, user_id=req.user_id):
                    yield f"data: {json.dumps({'content': chunk})}\n\n"
        except asyncio.CancelledError:
            logger.info("Client disconnected during stream")
        except Exception as e:
            logger.error("Streaming error: %s", e, exc_info=True)
            yield f"data: {json.dumps({'error': 'Stream interrupted'})}\n\n"
        finally:
            total_duration = time.time() - start_time
            logger.info(f"Total stream duration: {total_duration:.2f}s")
            yield "data: [DONE]\n\n"

    return StreamingResponse(chunk_generator(), media_type="text/event-stream")


@app.post("/ocr")
async def process_ocr(file: UploadFile = File(...), user_id: str = Form(None)):
    try:
        # ✅ FIX (C-02): Limit upload size to 10MB to prevent DoS
        MAX_UPLOAD_SIZE = 10 * 1024 * 1024  # 10MB
        content = await file.read()
        if len(content) > MAX_UPLOAD_SIZE:
            return JSONResponse(
                {"success": False, "error": f"File too large. Maximum size is {MAX_UPLOAD_SIZE // (1024*1024)}MB."},
                status_code=413,
            )

        # Optionally upload to supabase if configured (silent fail if not)
        image_url = None
        try:
            # ✅ FIX (W-11): Removed duplicate `import os` — already imported at top
            if os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_KEY"):
                try:
                    from backend.supabase_ocr import upload_image
                except ImportError:
                    from supabase_ocr import upload_image
                image_url = await upload_image(
                    content,
                    file.filename or "upload",
                    file.content_type or "application/octet-stream",
                )
        except Exception as e:
            logger.warning("Supabase upload failed or not available: %s", e)  # ✅ FIX (L-07)

        try:
            import backend.vision_scout as vision_scout
        except ImportError:
            import vision_scout

        # ✅ FIX (W-15): Use asyncio.to_thread to avoid blocking the event loop
        extracted_text = await asyncio.to_thread(vision_scout.analyze_image_bytes, content)

        return {
            "success": True,
            "raw_text": extracted_text,
            "image_url": image_url
        }
    except Exception as e:
        logger.error("OCR failed: %s", e, exc_info=True)  # ✅ FIX (L-07)
        return {"success": False, "error": str(e)}


@app.post("/hints")
async def hints(req: HintRequest):

    if llm is None:
        return {"success": False}

    try:
        hints = llm.hints(req.question, req.problem_type, req.num_hints)

        return {
            "success": True,
            "hints": hints
        }

    except Exception as e:
        logger.error("Hints error: %s", e, exc_info=True)
        return {
            "success": False,
            "error": str(e)
        }

# ─────────────────────────────────────────────
# HEALTH
# ─────────────────────────────────────────────

@app.get("/health")
async def health(response: Response):

    is_healthy = llm is not None and (algebra_solve is not None)
    if not is_healthy:
        response.status_code = 503

    return {
        "status": "ok" if is_healthy else "degraded",
        "llm_loaded": llm is not None,
        "engines": {
            "algebra": algebra_solve is not None,
            "calculus": calculus_solve is not None,
            "geometry": geometry_solve is not None,
            "statistics": statistics_solve is not None,
            "linear_algebra": linear_algebra_solve is not None,
        }
    }

# ─────────────────────────────────────────────
# SERVE FRONTEND
# ─────────────────────────────────────────────

FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

ALLOWED_FILES = [
    "index.html",
    "dashboard.html",
    "login.html",
    "signup.html",
    "about.html",
    "study-mode.html",
    "study-mode.js",
    "app.js",
    "style.css",
    "logo.png",
    "user.png",
    "bg.jpg",
    "supabaseClient.js",
    "admin-dashboard.html"
]

@app.get("/")
async def home():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

@app.get("/{file_path:path}")
async def serve_static(file_path: str):
    # ✅ FIX (C-03): Block access to sensitive files and directories
    _blocked_patterns = ('.env', 'node_modules', '.git', '__pycache__', '.DS_Store')
    if any(seg.startswith('.') or seg in _blocked_patterns for seg in file_path.replace('\\', '/').split('/')):
        return JSONResponse({"error": "Forbidden"}, status_code=403)

    full_path = os.path.join(FRONTEND_DIR, file_path)
    # Basic directory traversal protection
    if os.path.abspath(full_path).startswith(os.path.abspath(FRONTEND_DIR)):
        if os.path.exists(full_path) and os.path.isfile(full_path):
            return FileResponse(full_path)
    return JSONResponse({"error": "File not found"}, status_code=404)

# ─────────────────────────────────────────────
# RUN SERVER
# ─────────────────────────────────────────────

if __name__ == "__main__":

    uvicorn.run(
        "backend.app:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000))
    )