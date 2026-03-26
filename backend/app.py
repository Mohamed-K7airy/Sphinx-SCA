"""
Sphinx-SCA — Backend API (v3 Stable)
"""

import os
import sys
from dotenv import load_dotenv
load_dotenv()
import uvicorn
import logging
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Request, Form
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from PIL import Image
import io, base64, httpx, re, json
import asyncio

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
sys.path.append(PROJECT_ROOT)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
if not GROQ_API_KEY:
    print("⚠️ GROQ_API_KEY not found")
else:
    print("🔑 Groq API key loaded")

try:
    from backend.llm_manager import LLMManager
except ImportError:
    try:
        from llm_manager import LLMManager
    except ImportError:
        LLMManager = None

try:
    llm = LLMManager()
    print("✅ LLM Manager loaded")
except Exception as e:
    llm = None
    print("⚠️ LLM Manager failed:", e)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sphinx")

try:
    from algebra.algebra_engine import solve as algebra_solve
except:
    algebra_solve = None

try:
    import calculus
    calculus_solve = calculus.solve
except:
    calculus_solve = None

try:
    import geometry
    geometry_solve = geometry.solve
except:
    geometry_solve = None

try:
    import statistics_engine
    statistics_solve = statistics_engine.solve
except:
    statistics_solve = None

try:
    import linear_algebra
    linear_algebra_solve = linear_algebra.solve
except:
    linear_algebra_solve = None

print(f"📦 Engines Loaded: Algebra={algebra_solve is not None}, Calculus={calculus_solve is not None}, Geometry={geometry_solve is not None}")

app = FastAPI(title="Sphinx-SCA API", version="3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class QuestionRequest(BaseModel):
    question: str
    history: Optional[list] = []
    mode: Optional[str] = "general"

class HintRequest(BaseModel):
    question: str
    problem_type: str = "algebra"
    num_hints: int = 3

def run_solver(fn, *args, **kwargs):
    if fn is None:
        return {"success": False, "error": "engine not available"}
    try:
        result = fn(*args, **kwargs)
        if isinstance(result, dict):
            return {"success": True, **result}
        return {"success": True, "final_answer": str(result)}
    except Exception as e:
        return {"success": False, "error": str(e)}

def route_and_solve(question: str, history: list = None, mode: str = "general"):
    if history is None:
        history = []
    logger.info("Question: %s", question)
    if llm is None:
        return {"success": False, "error": "LLM not available"}
    if mode == "think":
        question = f"[Think Deeply and Explain Thoroughly] {question}"
    elif mode == "steps":
        question = f"[Provide detailed step-by-step solution] {question}"
    try:
        c = llm.classify(question)
        branch = c.get("branch", "algebra")
        problem_type = c.get("problem_type", "solve")
        is_math = c.get("is_math", True)
    except:
        branch = "algebra"
        problem_type = "solve"
        is_math = True
    if not is_math or branch == "chat":
        try:
            answer = llm.chat(question, history)
            return {"success": True, "branch": "chat", "final_answer": answer, "is_chat": True, "llm_steps": []}
        except Exception as e:
            return {"success": False, "error": str(e)}
    try:
        parsed = llm.parse(question, branch)
    except:
        parsed = {}
    result = {"success": False}
    if branch == "algebra":
        result = run_solver(algebra_solve, parsed.get("expression", question))
    elif branch == "calculus":
        result = run_solver(calculus_solve, parsed.get("expression", question))
    elif branch == "geometry":
        result = run_solver(geometry_solve, parsed.get("shape"), parsed.get("find"), **parsed.get("known", {}))
    elif branch == "statistics":
        result = run_solver(statistics_solve, parsed.get("operation", "mean"), data=parsed.get("data", []))
    elif branch == "linear_algebra":
        result = run_solver(linear_algebra_solve, parsed.get("operation", "determinant"), matrix=parsed.get("matrix_a"))
    if not result.get("success"):
        try:
            wp = llm.word_problem(question)
            result = {"success": True, "final_answer": wp.get("answer_sentence")}
        except:
            pass
    if result.get("success"):
        try:
            steps = llm.steps(question, result.get("final_answer", ""), branch)
        except:
            steps = []
        result["llm_steps"] = steps
    result["branch"] = branch
    result["problem_type"] = problem_type
    result["is_chat"] = False
    result["mode"] = mode
    return result

@app.post("/solve")
async def solve(req: QuestionRequest):
    return route_and_solve(req.question, req.history, req.mode)

@app.post("/solve_stream")
async def solve_stream(req: QuestionRequest):
    if llm is None:
        return JSONResponse({"success": False, "error": "LLM not initialized"}, status_code=500)
    messages = []
    if req.history:
        for m in req.history:
            role = m.get('role') or ("user" if m.get("sender") == "user" else "assistant")
            messages.append({"role": role, "content": m.get("content", "")})
    prompt = req.question
    if req.mode == "think":
        prompt = f"Please solve this and explain your deep thinking process: {req.question}"
    elif req.mode == "steps":
        prompt = f"Please provide a detailed step-by-step solution for: {req.question}"
    messages.append({"role": "user", "content": prompt})
    def chunk_generator():
        for chunk in llm.stream_chat(messages):
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(chunk_generator(), media_type="text/event-stream")

@app.post("/hints")
async def hints(req: HintRequest):
    if llm is None:
        return {"success": False}
    try:
        hints = llm.hints(req.question, req.problem_type, req.num_hints)
        return {"success": True, "hints": hints}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/health")
async def health():
    return {"status": "ok", "llm_loaded": llm is not None}

FRONTEND_DIR = PROJECT_ROOT

@app.get("/")
async def home():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

@app.get("/index.html")
async def index():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

@app.get("/dashboard.html")
async def dashboard():
    return FileResponse(os.path.join(FRONTEND_DIR, "dashboard.html"))

@app.get("/login.html")
async def login():
    return FileResponse(os.path.join(FRONTEND_DIR, "login.html"))

@app.get("/signup.html")
async def signup():
    return FileResponse(os.path.join(FRONTEND_DIR, "signup.html"))

@app.get("/style.css")
async def style():
    return FileResponse(os.path.join(FRONTEND_DIR, "style.css"))

@app.get("/logo.png")
async def logo():
    return FileResponse(os.path.join(FRONTEND_DIR, "logo.png"))

@app.get("/user.png")
async def user_img():
    return FileResponse(os.path.join(FRONTEND_DIR, "user.png"))

@app.get("/bg.jpg")
async def bg():
    return FileResponse(os.path.join(FRONTEND_DIR, "bg.jpg"))

@app.get("/supabaseClient.js")
async def supabase_client():
    return FileResponse(os.path.join(FRONTEND_DIR, "supabaseClient.js"))

# ─────────────────────────────────────────────
# OCR ENDPOINT
import re as re_module

try:
    import easyocr
    ocr_reader = easyocr.Reader(['en'])
except Exception as e:
    print(f"⚠️ easyocr not available: {e}")
    ocr_reader = None

try:
    from pix2tex.cli import LatexOCR
    pix_model = LatexOCR()
except Exception as e:
    print(f"⚠️ pix2tex not available: {e}")
    pix_model = None

def clean_math(text):
    text = text.replace('÷','/')
    text = text.replace('×','*')
    text = text.replace('x','*')
    text = text.replace('X','*')
    text = text.replace('−','-')
    return text
# ─────────────────────────────────────────────

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_SIZE_MB = 5

@app.post("/ocr")
async def ocr_endpoint(
    file: UploadFile = File(...),
    user_id: Optional[str] = Form(None),
):
    if file.content_type not in ALLOWED_TYPES:
        return {"success": False, "error": "Invalid file type"}
    image_bytes = await file.read()
    if len(image_bytes) > MAX_SIZE_MB * 1024 * 1024:
        return {"success": False, "error": f"File too large. Max {MAX_SIZE_MB}MB"}
    # OCR doesn't strictly need GROQ, so we proceed without the check
    try:
        img = Image.open(io.BytesIO(image_bytes))
        import numpy as np
        img_array = np.array(img)

        # EasyOCR
        results = ocr_reader.readtext(img_array)
        easy_text = " ".join([r[1] for r in results])
        easy_text = clean_math(easy_text)

        # Pix2Tex LaTeX
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        latex = pix_model(img)

        ocr_result = {"raw_text": easy_text, "latex": latex}

    except Exception as e:
        return {"success": False, "error": f"OCR failed: {str(e)}"}
    storage_result = {"success": False, "image_url": ""}
    try:
        from backend.supabase_ocr import store_ocr
        storage_result = await store_ocr(
            image_bytes=image_bytes,
            filename=file.filename or "image.jpg",
            content_type=file.content_type,
            raw_text=ocr_result.get("raw_text", ""),
            latex=ocr_result.get("latex", ""),
            sympy_expr=ocr_result.get("latex", ""),
            user_id=user_id,
        )
    except Exception as e:
        storage_result = {"success": False, "error": str(e)}
    return {
        "success": True,
        "raw_text": ocr_result.get("raw_text", ""),
        "latex": ocr_result.get("latex", ""),
        "image_url": storage_result.get("image_url", ""),
        "stored": storage_result.get("success", False),
    }

if __name__ == "__main__":
    uvicorn.run(
        "backend.app:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000))
    )