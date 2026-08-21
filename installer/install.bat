@echo off
chcp 65001 >nul 2>&1
echo ================================================
echo   Pixel Cake v1.0.0 - Installation
echo ================================================
echo.

set "INSTALL_DIR=%~dp0"
cd /d "%INSTALL_DIR%"

REM Check for EXE first
if exist "PixelCake.exe" (
    echo [OK] Found PixelCake.exe - launching...
    start "" PixelCake.exe
    exit /b 0
)

REM Source mode: check Python
where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found!
    echo Please install Python 3.10+ from https://python.org
    echo IMPORTANT: Check "Add to PATH" during installation.
    pause
    exit /b 1
)

echo [OK] Python found.
echo Installing dependencies (first run takes a few minutes)...

python -m pip install --upgrade pip -q 2>nul
python -m pip install -r backend\requirements.txt -q
if errorlevel 1 (
    echo [WARNING] Some packages failed. Trying without quiet mode...
    python -m pip install -r backend\requirements.txt
)

if not exist "frontend_dist" (
    echo Building frontend...
    if not exist "frontend\node_modules" (
        cd frontend
        call npm install
        cd /d "%INSTALL_DIR%"
    )
    cd frontend && call npm run build
    cd /d "%INSTALL_DIR%"
    xcopy /e /i /q "frontend\dist" "frontend_dist" >nul
)

echo.
echo ================================================
echo   Starting Pixel Cake...
echo   Browser will open at http://127.0.0.1:8765
echo   Press Ctrl+C to stop
echo ================================================
echo.

python launcher.py
pause
