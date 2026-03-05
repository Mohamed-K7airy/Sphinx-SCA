from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import pipeline
import uvicorn
import os

app = FastAPI()

# السماح لموقعك بالاتصال بهذا الخادم
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # يمكنك تقييده برابط موقعك لاحقاً
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# معرف الموديل الخاص بك على Hugging Face
MODEL_PATH = "KHAIRY5/Sphinx-SCA"

# محاولة تحميل الموديل عند بدء تشغيل الخادم
try:
    print("جاري تحميل الموديل من Hugging Face، يرجى الانتظار...")
    classifier = pipeline("text-classification", model=MODEL_PATH, tokenizer=MODEL_PATH)
    print("✅ تم تحميل الموديل بنجاح!")
except Exception as e:
    print(f"❌ حدث خطأ أثناء تحميل الموديل: {e}")
    classifier = None

class MathProblem(BaseModel):
    text: str

@app.post("/classify")
async def classify_problem(problem: MathProblem):
    if not classifier:
        return {"error": "الموديل غير متاح حالياً. تأكد من مسار الموديل في الخادم."}
    
    # تصنيف المسألة باستخدام الموديل
    try:
        result = classifier(problem.text)
        return {"prediction": result}
    except Exception as e:
        return {"error": str(e)}

@app.get("/")
def read_root():
    return {"status": "خادم الذكاء الاصطناعي يعمل بنجاح 🚀"}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
