@echo off
chcp 65001 >nul 2>&1
echo ================================================
echo   Pixel Cake v1.0.0 - Uninstall
echo ================================================
echo.

set "INSTALL_DIR=%~dp0"
cd /d "%INSTALL_DIR%"

REM Remove APPDATA data
set "DATA_DIR=%APPDATA%\PixelCake"
if exist "%DATA_DIR%" (
    echo Removing user data: %DATA_DIR%
    rd /s /q "%DATA_DIR%" 2>nul
    if errorlevel 1 (
        echo [WARN] Could not fully remove data dir.
        echo Please manually delete: %DATA_DIR%
    ) else (
        echo [OK] User data removed.
    )
)

echo.
echo Removing desktop shortcut...
del "%USERPROFILE%\Desktop\PixelCake.lnk" 2>nul

echo.
echo Removing Start Menu shortcuts...
set "SM_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Pixel Cake"
if exist "%SM_DIR%" (
    rd /s /q "%SM_DIR%" 2>nul
)

echo.
echo ================================================
echo   To complete uninstall:
echo   1. Delete this folder: %INSTALL_DIR%
echo   2. Optionally run: pip uninstall -r backend\requirements.txt
echo ================================================
echo.
pause
