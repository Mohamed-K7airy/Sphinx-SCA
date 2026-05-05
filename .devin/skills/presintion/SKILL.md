---
name: presintion
description: Restores context of the MATHX (ex Sphinx-SCA) project session — 10-slide presentation content, service-worker fix, MATHX rename details, and open follow-ups. Invoke when user says "open presintion", "presintion", or asks to continue the presentation / rename / SW work.
---

# presintion — MATHX project session snapshot

This skill restores everything produced during the 2026-05-04 session on the
MATHX (ex-Sphinx-SCA) repo. Treat it as a read-only memo of the state and
decisions; re-read the actual files for current content.

---

## 1. Project at a glance

- **Product name:** MATHX (renamed from Sphinx-SCA this session)
- **Built at:** MATHX University, Egypt (formerly Sphinx University — renamed on user request)
- **Aliases still present in comments:** IntelliMath AI
- **Stack:**
  - Backend: FastAPI (Python), Groq (`openai/gpt-oss-120b`) + Gemini 2.5 Flash, Llama 4 Scout for vision OCR
  - Frontend: Vite + vanilla JS (no React for main app), one React island for `team_revamp`
  - DB / Auth / Storage: Supabase
  - Math engines: SymPy (algebra, calculus, geometry, statistics, linear_algebra)
  - Memory: vector embeddings (Qdrant-style), fire-and-forget background thread
  - Deploy: Docker + Render (Railway URL retained as CORS fallback)

### Key architecture files
- `backend/app.py` — FastAPI entrypoint, routing, rate-limit, solve/stream/OCR/admin
- `backend/study_agent.py` — Study Mode agent loop, 7 tools, state machine
- `backend/llm_manager.py` — LLM wrapper, classifier, parser, steps, hints, streaming
- `backend/memory_manager.py` — Memory vector store interface
- `backend/vision_scout.py` — Llama 4 Scout vision OCR
- `frontend/app.js` — Main chat page entry
- `frontend/study-mode.js` — Study mode UI
- `frontend/lib/chat.js` — Chat rendering, streaming, send handler
- `frontend/lib/ui.js` — Sidebar, theme, modals, math toolbar, graph, calculator
- `frontend/public/sw.js` — Service worker (rewritten this session)

### Study Mode — 7 tools
`explain_concept`, `ask_socratic`, `give_hint`, `evaluate_answer`,
`give_full_solution`, `generate_practice`, `end_session`.

### State machine
`explain → socratic → check → practice → summary`
- `check` + wrong answer → back to `socratic`
- `check` + correct → `practice`

### Decision logic (inside the agent prompt, enforced by code)
- `difficulty=easy` → solve directly
- `difficulty=hard` → explain → socratic
- wrong answer, attempt 1 → socratic; attempt ≥ 2 → hint
- `hints_used ≥ 3` → reveal full solution
- `MAX_HINTS = 3`

---

## 2. The 10-slide presentation (full content)

### 01 — Title
> # MATHX
> ### A Bilingual AI Math Tutor that Teaches, Not Just Solves
> MATHX University — Computer Science · [Team names]

### 02 — The problem
- **No instant feedback** — homework graded days later, misunderstanding locks in
- **Language barrier** — most AI tutors are English-only; Arabic students lose nuance
- **Generic AI tools** — ChatGPT gives answers, doesn't teach

### 03 — Our solution
| Feature | What it does |
|---|---|
| Bilingual AI tutor | Auto-detects Arabic/English, responds in same language |
| OCR | Photo of homework → Llama 4 Scout extracts equation |
| Study Mode | Socratic agent: guides, hints, then solves |
| Instant Solve | Symbolic math engines + LLM verification |

### 04 — Why not fine-tuning?
- Data cost — quality bilingual math datasets don't exist at scale
- Compute cost — single fine-tune run ≈ thousands of dollars
- Behavior > weights — tutoring is about flow control, not raw knowledge
- **"The intelligence isn't in the weights. It's in the orchestration."**

### 05 — More than just APIs
- Image 1 (basic agent): `User → LLM → Answer`
- Image 2 (router): `User → Classifier → [Math Engine | Vision | Study Agent | Search | Chat]` with Memory + Session State + 7 Tools
- **"Anyone can call an API. The engineering is what you build around it."**

### 06 — Architecture
```
User → FastAPI → Agent Loop → {7 Tools, Session State, Memory}
External: Groq · Gemini · Supabase · Llama 4 Scout · Background memory thread
```
FastAPI handles auth, rate limiting (60 req/min/IP), CORS, OCR uploads.

### 07 — Deep dive: Study Mode agent
State machine + decision logic (see section 1 above).
Two engineering wins:
- **Fire-and-forget memory** — background thread writes embeddings, never blocks
- **`asyncio.to_thread`** — wraps every sync LLM call so event loop stays free

### 08 — Tech stack
FastAPI · Vite · Groq + Gemini · Llama 4 Scout · Supabase · SymPy · Docker · Render

### 09 — User journey
1. Student snaps photo of homework
2. OCR → Llama 4 Scout
3. Student picks Study Mode
4. Agent classifies difficulty → solves or explains
5. Practice problem generated
6. Wrong attempt 1 → Socratic question
7. Wrong attempt 2 → Progressive hint
8. Correct → next practice
9. Session summary with strengths + review areas

### 10 — Thank you + Q&A
GitHub link · Team · Questions

---

## 3. Service worker fix (applied this session)

**Problem:** Deployed site had all buttons dead on Render. Root cause: old SW
(`sca-v1`) was cache-first for `/index.html`, serving stale HTML that
referenced deleted hashed JS bundles → silent 404 → no JS → no listeners.

**Fix in `frontend/public/sw.js`:**
- Bumped cache name to `sca-v3`
- Network-first for navigation (HTML)
- Cache-first only for `/manifest.json`, `/logo.png`
- Never caches hashed JS/CSS bundles
- `skipWaiting()` + `clients.claim()`
- `activate` handler deletes old cache versions
- Explicitly skips POST and `/api`, `/solve`, `/study`, `/ocr`, `/hints`, `/generate_title`, `/admin`

**User recovery path:**
Existing stuck users should hard-reset the SW:
DevTools → Application → Service Workers → Unregister → Clear site data → Ctrl+Shift+R

---

## 4. MATHX rename (applied this session)

**81 replacements across 25 files.** Names changed:
- `Sphinx-SCA` / `Sphinx-sca` / `SPHINX-SCA` / `Sphinx-GPT` / `SphinxSCA` → `MATHX`
- `sphinx-sca` / `sphinx_sca` → `mathx`
- `Sphinx University` → `MATHX University` (user opted in)
- `Sphinx` (standalone in logo/prompts) → `MATHX`

**HTML logo structure** now reads:
```html
<span class="logo-sphinx">MATH</span><span class="logo-sca">X</span>
```
(kept dual-span for the two-tone color styling)

**Intentionally NOT renamed:**
- `https://sphinx-sca-production.up.railway.app` — live Railway CORS fallback
- CSS class names `logo-sphinx`, `logo-sca`, `logo-gpt` — internal hooks
- `logging.getLogger("sphinx")`, `getLogger("sphinx-study-agent-v9")` — log channels
- `frontend/app.js.bak`, `frontend/study-mode.js.bak` — backups
- `backend/dbg.json` — stale debug data with Arabic chat history

---

## 5. Open follow-ups (not yet done)

1. **Commit and push** the SW fix + MATHX rename. User asked to push but then
   pivoted to the rename; neither has been committed yet.
2. **Update `ALLOWED_ORIGINS` env var on Render** for new MATHX domain if one exists.
3. **Replace `frontend/public/logo.png`** if the current wordmark still shows "Sphinx-SCA".
4. **`IntelliMath AI` alias** in code comments — user didn't ask to remove, could be cleaned up later.
5. **Consider renaming the Render service** from `sphinx-sca-...` to `mathx-...`.

---

## 6. How to resume

When this skill is invoked, ask the user which thread to resume:
- Presentation content (slides 1-10)
- Service worker / deployed buttons debugging
- MATHX rename polish (logo image, env vars, commit)
- Something new on the project

Always re-read the relevant source files before making changes — the
snapshot above captures session *decisions*, not current file contents.
