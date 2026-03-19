"""
Sphinx-SCA — Supabase OCR Storage
===================================
Tasks:
  1. Upload image to Supabase Storage (bucket: ocr-images)
  2. Save OCR result to database (table: ocr_results)
"""

import os
import uuid
import httpx
from datetime import datetime

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────

SUPABASE_URL = "https://twkbvvinlzdvtqkauvkv.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3a2J2dmlubHpkdnRxa2F1dmt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NTI0ODksImV4cCI6MjA4ODAyODQ4OX0.PVUSz03RkXKlMky_qf_U5pAvLU7_CBhB1PaRgTWJ4Zk"

BUCKET_NAME = "ocr-images"
TABLE_NAME  = "ocr_results"

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
}

# ─────────────────────────────────────────────
# 1. UPLOAD IMAGE TO STORAGE
# ─────────────────────────────────────────────

async def upload_image(image_bytes: bytes, filename: str, content_type: str = "image/jpeg") -> str:
    """
    Upload image to Supabase Storage bucket.
    Returns the public URL of the uploaded image.
    """
    # Generate unique filename to avoid conflicts
    ext = filename.rsplit(".", 1)[-1] if "." in filename else "jpg"
    unique_name = f"{uuid.uuid4().hex}.{ext}"
    
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{unique_name}"
    
    upload_headers = {
        **HEADERS,
        "Content-Type": content_type,
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            upload_url,
            content=image_bytes,
            headers=upload_headers,
        )
    
    if response.status_code not in (200, 201):
        raise Exception(f"Upload failed: {response.status_code} — {response.text}")
    
    # Build public URL
    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/{unique_name}"
    return public_url


# ─────────────────────────────────────────────
# 2. SAVE OCR RESULT TO DATABASE
# ─────────────────────────────────────────────

async def save_ocr_result(
    image_url: str,
    raw_text: str,
    latex: str,
    sympy_expr: str,
    user_id: str = None,
) -> dict:
    """
    Save OCR result to Supabase table: ocr_results
    
    Table structure:
        id          uuid primary key default uuid_generate_v4()
        user_id     uuid references auth.users (nullable)
        image_url   text
        raw_text    text
        latex       text
        sympy_expr  text
        created_at  timestamp default now()
    """
    insert_url = f"{SUPABASE_URL}/rest/v1/{TABLE_NAME}"
    
    insert_headers = {
        **HEADERS,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    
    payload = {
        "image_url":  image_url,
        "raw_text":   raw_text,
        "latex":      latex,
        "sympy_expr": sympy_expr,
        "created_at": datetime.utcnow().isoformat(),
    }
    
    if user_id:
        payload["user_id"] = user_id
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            insert_url,
            json=payload,
            headers=insert_headers,
        )
    
    if response.status_code not in (200, 201):
        raise Exception(f"DB insert failed: {response.status_code} — {response.text}")
    
    return response.json()[0] if response.json() else payload


# ─────────────────────────────────────────────
# 3. COMBINED — UPLOAD + SAVE
# ─────────────────────────────────────────────

async def store_ocr(
    image_bytes: bytes,
    filename: str,
    content_type: str,
    raw_text: str,
    latex: str,
    sympy_expr: str,
    user_id: str = None,
) -> dict:
    """
    Full pipeline:
      1. Upload image to Storage
      2. Save OCR result to DB
      3. Return full result dict
    """
    # Step 1 — Upload image
    image_url = await upload_image(image_bytes, filename, content_type)
    
    # Step 2 — Save to DB
    db_record = await save_ocr_result(
        image_url=image_url,
        raw_text=raw_text,
        latex=latex,
        sympy_expr=sympy_expr,
        user_id=user_id,
    )
    
    return {
        "success":    True,
        "image_url":  image_url,
        "db_record":  db_record,
    }
