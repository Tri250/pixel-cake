@echo off
chcp 65001 >nul 2>&1

echo.
echo ================================================
echo   Pixel Cake - Build Windows EXE v1.0.0
echo ================================================
echo.

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo [1/6] Checking environment...

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found.
    echo Please install Python 3.10+ from https://python.org
    echo IMPORTANT: Check "Add Python to PATH" during install.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install from https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [OK] Python: %%i
for /f "tokens=*" %%i in ('node --version 2^>^&1') do echo [OK] Node: %%i
echo.

echo [2/6] Building frontend...

cd /d "%PROJECT_DIR%\frontend"
if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed.
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"
if exist "frontend_dist" rmdir /s /q "frontend_dist"
xcopy /e /i /q "frontend\dist" "frontend_dist" >nul

echo [OK] Frontend built.
echo.

echo [3/6] Installing Python packages...
cd /d "%PROJECT_DIR%\backend"
python -m pip install --upgrade pip -q
pip install -r requirements.txt -q
if errorlevel 1 (
    echo [WARN] Some packages failed. Trying without -q...
    pip install -r requirements.txt
)
cd /d "%PROJECT_DIR%"

echo Installing PyInstaller...
pip install pyinstaller -q
echo [OK] Python packages installed.
echo.

echo [4/6] Preparing resources...

REM Copy backend services and utils
if exist "services" rmdir /s /q "services"
if exist "utils" rmdir /s /q "utils"
xcopy /e /i /q "backend\services" "services" >nul
xcopy /e /i /q "backend\utils" "utils" >nul

REM Ensure model directories exist
if not exist "backend\models\cascades" mkdir "backend\models\cascades"

REM Download cascade files if missing
if not exist "backend\models\cascades\haarcascade_frontalface_default.xml" (
    echo Downloading cascade files...
    python setup.py
)

echo [OK] Resources prepared.
echo.

echo [5/6] Running PyInstaller analysis...
echo.

pyinstaller pixel-cake.spec --clean --noconfirm
if errorlevel 1 (
    echo [ERROR] PyInstaller build failed.
    echo.
    echo Troubleshooting:
    echo   1. Ensure all dependencies are installed: pip install -r backend/requirements.txt
    echo   2. Clear cache: pyinstaller --clean
    echo   3. Check that frontend was built: cd frontend ^&^& npm run build
    echo.
    pause
    exit /b 1
)

echo.
echo [6/6] Verifying build...
if not exist "dist\PixelCake.exe" (
    echo [ERROR] dist\PixelCake.exe not found!
    pause
    exit /b 1
)

for %%A in ("dist\PixelCake.exe") do set "EXE_SIZE=%%~zA"
set /a EXE_SIZE_MB=%EXE_SIZE% / 1048576

echo.
echo ================================================
echo   BUILD SUCCESS!
echo   Output: dist\PixelCake.exe
echo   Size: %EXE_SIZE_MB% MB
echo   Double-click PixelCake.exe to run!
echo ================================================
echo.
echo   First run will:
echo   1. Start the AI server on http://127.0.0.1:8765
echo   2. Open your browser automatically
echo   3. Create data directory in %%APPDATA%%\PixelCake
echo.
echo   To uninstall: Just delete the folder.
echo.

explorer dist
pause
