@echo off
echo ==========================================
echo  Sphinx-SCA Backend Server - Starting...
echo ==========================================
echo.

REM Make sure we're in the right directory
cd /d "%~dp0"

REM Check if .venv exists
if not exist ".venv\Scripts\uvicorn.exe" (
    echo ERROR: .venv not found or uvicorn not installed.
    echo Please run: python -m pip install -r requirements.txt
    pause
    exit /b
)

REM Kill any process on port 8000 first
echo Stopping any existing server on port 8000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do taskkill /F /PID %%a 2>nul

echo.
echo Starting Sphinx-SCA backend on http://127.0.0.1:8000
echo.
.venv\Scripts\uvicorn main:app --host 127.0.0.1 --port 8000 --reload
pause
