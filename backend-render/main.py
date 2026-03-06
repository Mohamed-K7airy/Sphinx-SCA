from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
from transformers import pipeline, AutoModelForSequenceClassification, AutoTokenizer
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the Model & Tokenizer from the local 'model' directory
MODEL_PATH = "./model"

try:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)
    pipe = pipeline("text-classification", model=model, tokenizer=tokenizer)
    print("Model loaded successfully!")
except Exception as e:
    print(f"Error loading model: {e}")
    pipe = None

class Question(BaseModel):
    text: str

@app.get("/")
def home():
    return {"message": "Sphinx AI Backend is running on Render!"}

@app.post("/chat")
def chat(q: Question):
    if not pipe:
        return {"error": "Model failed to load. Please check server logs."}
    
    try:
        # Run classification
        prediction = pipe(q.text)
        return {"prediction": prediction}
    except Exception as e:
        return {"error": str(e)}
