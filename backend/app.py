"""
Sphinx-SCA — Backend API (v3)
==============================
Flow:
  classify → chat? → respond naturally
           → math? → parse → solve → steps → respond
"""

import os, sys, uvicorn, logging
from typing import Optional
from fastapi import FastAPI, UploadFile, File
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ─────────────────────────────────────────────
#  PATH CONFIGURATION
# ─────────────────────────────────────────────

BASE_DIR         = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT     = os.path.dirname(BASE_DIR)
MATH_ENGINE_PATH = os.path.join(PROJECT_ROOT, "math_engine", "math_engine")

sys.path.append(PROJECT_ROOT)
sys.path.append(MATH_ENGINE_PATH)

folders = ["algebra", "calculus_math", "geometry", "linear_algebra",
           "probability", "statistics_engine", "word_problems"]
for folder in folders:
    sys.path.append(os.path.join(MATH_ENGINE_PATH, folder))

# ─────────────────────────────────────────────
#  LLM MANAGER
# ─────────────────────────────────────────────

try:
    from llm_manager import LLMManager
    llm = LLMManager()
    print("✅ LLM Manager loaded")
except Exception as e:
    llm = None
    print(f"⚠️ LLM Manager not loaded: {e}")

# ─────────────────────────────────────────────
#  MATH ENGINES (with fallback)
# ─────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sphinx-sca")

try:
    from algebra.algebra_engine import solve as algebra_solve
except ImportError:
    algebra_solve = None
    logger.warning("⚠️  Algebra engine not found")

try:
    import calculus
    calculus_solve = calculus.solve
except ImportError:
    calculus_solve = None
    logger.warning("⚠️  Calculus engine not found")

try:
    import geometry
    geometry_solve = geometry.solve
except ImportError:
    geometry_solve = None
    logger.warning("⚠️  Geometry engine not found")

try:
    import statistics_engine
    statistics_solve = statistics_engine.solve
except ImportError:
    statistics_solve = None
    logger.warning("⚠️  Statistics engine not found")

try:
    import linear_algebra
    linear_algebra_solve = linear_algebra.solve
except ImportError:
    linear_algebra_solve = None
    logger.warning("⚠️  Linear algebra engine not found")

try:
    import word_problems
    word_solve = word_problems.solve
except ImportError:
    word_solve = None
    logger.warning("⚠️  Word problems engine not found")

# ─────────────────────────────────────────────
#  APP SETUP
# ─────────────────────────────────────────────

app = FastAPI(title="Sphinx-SCA API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# الصفحة الرئيسية
@app.get("/")
async def home():
    return {"message": "Sphinx API is running"}

# ─────────────────────────────────────────────
#  SERVE FRONTEND
# ─────────────────────────────────────────────

FRONTEND_DIR = os.path.join(PROJECT_ROOT)

# serve index.html
@app.get("/")
async def home():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

# serve static files (css / js / images)
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

# ─────────────────────────────────────────────
#  REQUEST MODELS
# ─────────────────────────────────────────────

class QuestionRequest(BaseModel):
    question: str
    user_id:  Optional[str]  = None
    history:  Optional[list] = []

class HintRequest(BaseModel):
    question:     str
    problem_type: str = "algebra"
    num_hints:    int = 3

# ─────────────────────────────────────────────
#  SOLVER HELPER
# ─────────────────────────────────────────────

def _run_solver(solver_fn, *args, **kwargs) -> dict:
    if solver_fn is None:
        return {"success": False, "error": "Engine not available"}
    try:
        result = solver_fn(*args, **kwargs)
        if isinstance(result, dict) and result.get("error"):
            return {"success": False, "error": result["error"]}
        return {"success": True, **(result if isinstance(result, dict) else {"final_answer": str(result)})}
    except Exception as e:
        return {"success": False, "error": str(e)}

# ─────────────────────────────────────────────
#  MAIN PIPELINE
# ─────────────────────────────────────────────

def route_and_solve(question: str, history: list = None) -> dict:
    """
    Full pipeline:
      classify → chat? → llm.chat()
               → math? → parse → solve → llm.steps() → response
    """
    if history is None:
        history = []

    logger.info(f"📥 Question: {question}")

    # ── No LLM → basic fallback ───────────────
    if not llm:
        return {
            "success":      False,
            "final_answer": None,
            "error":        "LLM not available. Please check your API key.",
        }

    # ── Step 1: Classify ─────────────────────
    try:
        classification = llm.classify(question)
        branch         = classification.get("branch",       "algebra")
        problem_type   = classification.get("problem_type", "solve")
        is_math        = classification.get("is_math",      True)
        logger.info(f"🧠 branch={branch}, is_math={is_math}")
    except Exception as e:
        logger.warning(f"Classification failed: {e}")
        branch, problem_type, is_math = "algebra", "solve", True

    # ── Step 2: Chat branch ───────────────────
    if not is_math or branch == "chat":
        try:
            chat_response = llm.chat(question, history)
            return {
                "success":      True,
                "branch":       "chat",
                "problem_type": "conversation",
                "final_answer": chat_response,
                "is_chat":      True,
                "llm_steps":    [],
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Step 3: Word problems → LLM directly ──
    if branch == "word_problem":
        try:
            res = llm.word_problem(question)
            steps = []
            for s in res.get("steps", []):
                steps.append({
                    "step":        s.get("step", 1),
                    "title":       s.get("description", ""),
                    "action":      s.get("math", ""),
                    "explanation": ""
                })
            return {
                "success":      True,
                "branch":       "word_problem",
                "problem_type": problem_type,
                "final_answer": res.get("answer_sentence") or res.get("solution", ""),
                "is_chat":      False,
                "llm_steps":    steps,
            }
        except Exception as e:
            logger.error(f"Word problem error: {e}")

    # ── Step 4: Parse ─────────────────────────
    parser_map = {
        "algebra":       "algebra",
        "calculus":      "calculus",
        "geometry":      "geometry",
        "statistics":    "statistics",
        "linear_algebra":"matrix",
    }
    parsed = {}
    try:
        parsed = llm.parse(question, parser_map.get(branch, "algebra"))
        logger.info(f"📋 Parsed: {parsed}")
    except Exception as e:
        logger.warning(f"Parse failed: {e}")

    # ── Step 5: Solve ─────────────────────────
    result = {"success": False, "error": "No solver available"}

    try:
        if branch == "algebra":
            expr = parsed.get("expression", question)
            result = _run_solver(algebra_solve, expr)
            if not result["success"]:
                result = _run_solver(algebra_solve, question)

        elif branch == "calculus":
            expr = parsed.get("expression", question)
            result = _run_solver(calculus_solve, expr)
            if not result["success"]:
                result = _run_solver(calculus_solve, question)

        elif branch == "geometry":
            shape = parsed.get("shape", "")
            find  = parsed.get("find", "area")
            known = parsed.get("known", {})
            result = _run_solver(geometry_solve, shape, find, **known)

        elif branch == "statistics":
            data = parsed.get("data", [])
            op   = parsed.get("operation", "mean")
            result = _run_solver(statistics_solve, op, data=data)

        elif branch == "linear_algebra":
            op       = parsed.get("operation", "determinant")
            matrix_a = parsed.get("matrix_a")
            result   = _run_solver(linear_algebra_solve, op, matrix=matrix_a)

    except Exception as e:
        logger.error(f"Solver error: {e}")
        result = {"success": False, "error": str(e)}

    # ── Step 6: Fallback to LLM word_problem ──
    if not result.get("success") and llm:
        try:
            res = llm.word_problem(question)
            result = {
                "success":      True,
                "final_answer": res.get("answer_sentence") or res.get("solution", ""),
            }
        except:
            pass

    # ── Step 7: Generate Steps ────────────────
    if result.get("success") and llm:
        answer = str(result.get("final_answer", result.get("answer", "")))
        try:
            result["llm_steps"] = llm.steps(question, answer, branch)
        except:
            result["llm_steps"] = []

    # ── Step 8: Add metadata ──────────────────
    result["branch"]       = branch
    result["problem_type"] = problem_type
    result["is_chat"]      = False

    # normalize answer key
    if "answer" in result and "final_answer" not in result:
        result["final_answer"] = result["answer"]

    logger.info(f"✅ Done: success={result.get('success')}, branch={branch}")
    return result


# ─────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/solve")
async def solve(request: QuestionRequest):
    try:
        return route_and_solve(request.question, request.history or [])
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/hints")
async def get_hints(request: HintRequest):
    try:
        if not llm:
            return {"success": False, "error": "LLM not available"}
        hints = llm.hints(request.question, request.problem_type, request.num_hints)
        return {"success": True, "hints": hints}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/ocr")
async def ocr_solve(file: UploadFile = File(...)):
    try:
        image_bytes = await file.read()
        try:
            from ocr_module import extract_math_from_image
            extracted = extract_math_from_image(image_bytes)
        except ImportError:
            import google.generativeai as genai
            import PIL.Image, io
            img      = PIL.Image.open(io.BytesIO(image_bytes))
            model    = genai.GenerativeModel("gemini-2.0-flash")
            response = model.generate_content([
                "Extract the math expression from this image. Return ONLY the math expression.",
                img
            ])
            extracted = response.text.strip()

        clean_expr = llm.ocr_fix(extracted) if llm else extracted
        solution   = route_and_solve(clean_expr)
        return {"success": True, "extracted": extracted, "cleaned": clean_expr, "solution": solution}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/health")
async def health():
    return {
        "status":  "ok",
        "service": "Sphinx-SCA API",
        "version": "3.0.0",
        "llm":     llm is not None,
        "solvers": {
            "algebra":       algebra_solve       is not None,
            "calculus":      calculus_solve       is not None,
            "geometry":      geometry_solve       is not None,
            "statistics":    statistics_solve     is not None,
            "linear_algebra":linear_algebra_solve is not None,
            "word_problems": word_solve           is not None,
        }
    }


# ─────────────────────────────────────────────
#  RUN
# ─────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "backend.app:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000))
    )
