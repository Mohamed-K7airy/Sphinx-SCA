import os, sys, uvicorn, re, math
from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

# 1. Path Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(BASE_DIR)
MATH_ENGINE_PATH = os.path.join(PROJECT_ROOT, "math_engine", "math_engine")

sys.path.append(PROJECT_ROOT)
sys.path.append(MATH_ENGINE_PATH)

folders = ["algebra", "calculus_math", "geometry", "linear_algebra", "probability", "statistics_engine", "word_problems"]
for folder in folders:
    sys.path.append(os.path.join(MATH_ENGINE_PATH, folder))

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class QuestionRequest(BaseModel):
    question: str

@app.post("/solve")
async def solve(request: QuestionRequest):
    try:
        q = request.question.lower().strip()
        nums = [float(n) for n in re.findall(r"[-+]?\d*\.\d+|\d+", q)]
        
        # --- 1. CALCULUS (Dynamic Derivative/Integral) ---
        if any(w in q for w in ["derivative", "integral"]):
            if "x^" in q:
                p = int(nums[0]) if nums else 1
                if "derivative" in q:
                    return {"success": True, "engine": "Calculus", "answer": f"{p}x^{p-1}", "steps": f"Power Rule: d/dx(x^{p}) = {p}x^{p-1}"}
                else:
                    return {"success": True, "engine": "Calculus", "answer": f"(x^{p+1})/{p+1} + C", "steps": f"Power Rule: ∫x^{p} dx = (x^{p+1})/{p+1} + C"}

        # --- 2. ALGEBRA (Dynamic Linear Solver) ---
        if "solve" in q or "x" in q:
            if len(nums) >= 2:
                a, b = nums[0], nums[1]
                # Handles ax - b = 0 or ax = b
                result = b / a
                return {"success": True, "engine": "Algebra", "answer": f"x = {result}", "steps": f"{a}x = {b} \n x = {b} / {a} \n x = {result}"}

        # --- 3. GEOMETRY (Circle) ---
        if "circle" in q or "radius" in q:
            if nums:
                r = nums[0]
                return {"success": True, "engine": "Geometry", "answer": f"{math.pi*(r**2):.2f}"}

        # --- 4. PROBABILITY ---
        if "die" in q or "coin" in q:
            return {"success": True, "engine": "Probability", "answer": "0.167" if "die" in q else "0.5"}

        # --- 5. STATISTICS ---
        if any(w in q for w in ["mean", "average"]):
            if nums: return {"success": True, "engine": "Statistics", "answer": f"{sum(nums)/len(nums):.2f}"}

        return {"success": False, "error": "Type not recognized."}
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
