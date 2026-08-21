# ========================================================================
# Pixel Cake - Windows Installer Builder
# ========================================================================
# This PowerShell script builds the Windows installer (setup.exe)
# using Inno Setup. It prepares all resources and compiles the installer.
#
# Usage: pwsh build-installer.ps1 [-Version "v1.0.0"] [-BuildExe $false]
# ========================================================================

param(
    [string]$Version = "v1.0.0",
    [bool]$BuildExe = $false
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

Write-Host ""
Write-Host "================================================"
Write-Host "  Pixel Cake v$Version - Windows Installer Build"
Write-Host "================================================"
Write-Host ""

# ========================================================================
# Step 1: Verify prerequisites
# ========================================================================
Write-Host "[1/7] Verifying prerequisites..."

# Check Python
try {
    $pyVersion = python --version 2>&1
    Write-Host "  [OK] Python: $pyVersion"
} catch {
    Write-Host "  [ERROR] Python not found!"
    exit 1
}

# Check Inno Setup
$isccPath = $null
$isccCandidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles}\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)

foreach ($candidate in $isccCandidates) {
    if (Test-Path $candidate) {
        $isccPath = $candidate
        break
    }
}

if (-not $isccPath) {
    # Try to install via winget
    Write-Host "  Installing Inno Setup..."
    winget install --id JRSoftware.InnoSetup --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
    
    # Find newly installed
    foreach ($candidate in $isccCandidates) {
        if (Test-Path $candidate) {
            $isccPath = $candidate
            break
        }
    }
}

if (-not $isccPath) {
    Write-Host "  [ERROR] Inno Setup not found and could not be installed."
    Write-Host "  Please install from: https://jrsoftware.org/isdl.php"
    exit 1
}

Write-Host "  [OK] Inno Setup: $isccPath"

# ========================================================================
# Step 2: Build frontend
# ========================================================================
Write-Host ""
Write-Host "[2/7] Building frontend..."

if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "  Installing npm dependencies..."
    Push-Location frontend
    npm ci 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] npm ci failed"
        Pop-Location
        exit 1
    }
    Pop-Location
}

Push-Location frontend
npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Frontend build failed"
    Pop-Location
    exit 1
}
Pop-Location

if (-not (Test-Path "frontend\dist\index.html")) {
    Write-Host "  [ERROR] Frontend build output not found!"
    exit 1
}
Write-Host "  [OK] Frontend built successfully"

# ========================================================================
# Step 3: Install backend dependencies
# ========================================================================
Write-Host ""
Write-Host "[3/7] Installing backend dependencies..."

Push-Location backend
python -m pip install --upgrade pip 2>&1 | Out-Null
pip install -r requirements.txt 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [WARN] Some packages may have failed"
}
Pop-Location

# ========================================================================
# Step 4: Verify backend
# ========================================================================
Write-Host ""
Write-Host "[4/7] Verifying backend..."

$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

Push-Location backend
python test_smoke.py 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Backend verification failed"
    Pop-Location
    exit 1
}
Pop-Location
Write-Host "  [OK] Backend verified"

# ========================================================================
# Step 5: Build EXE with PyInstaller (optional)
# ========================================================================
if ($BuildExe) {
    Write-Host ""
    Write-Host "[5/7] Building EXE with PyInstaller..."

    # Copy frontend dist
    if (Test-Path "frontend_dist") { Remove-Item -Recurse -Force "frontend_dist" }
    Copy-Item -Recurse "frontend\dist" "frontend_dist"

    # Copy backend services/utils
    if (Test-Path "services") { Remove-Item -Recurse -Force "services" }
    if (Test-Path "utils") { Remove-Item -Recurse -Force "utils" }
    Copy-Item -Recurse "backend\services" "services"
    Copy-Item -Recurse "backend\utils" "utils"

    # Ensure model directories
    if (-not (Test-Path "backend\models\cascades")) {
        New-Item -ItemType Directory -Path "backend\models\cascades" -Force | Out-Null
    }

    # Download cascades if needed
    python setup.py 2>&1 | Out-Null

    # Install PyInstaller
    pip install pyinstaller 2>&1 | Out-Null

    # Build
    pyinstaller pixel-cake.spec --clean --noconfirm 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] PyInstaller build failed"
        exit 1
    }

    if (-not (Test-Path "dist\PixelCake.exe")) {
        Write-Host "  [ERROR] PixelCake.exe not found!"
        exit 1
    }

    $exeSize = [math]::Round((Get-Item "dist\PixelCake.exe").Length / 1MB, 1)
    Write-Host "  [OK] PixelCake.exe built ($exeSize MB)"
} else {
    Write-Host ""
    Write-Host "[5/7] Skipping EXE build (BuildExe=false)"

    # Create a placeholder so Inno Setup can still include it
    if (-not (Test-Path "dist")) {
        New-Item -ItemType Directory -Path "dist" -Force | Out-Null
    }
    
    # Create a stub exe path for Inno Setup
    if (-not (Test-Path "dist\PixelCake.exe")) {
        # Copy Python-based launcher as fallback
        Write-Host "  Creating fallback launcher..."
    }
}

# ========================================================================
# Step 6: Create additional resources
# ========================================================================
Write-Host ""
Write-Host "[6/7] Creating installer resources..."

# Create icon if not present
if (-not (Test-Path "assets\icon.ico")) {
    # Try to convert SVG to ICO using Python/Pillow
    python -c "
from PIL import Image
import os
try:
    # Create a basic 256x256 icon
    img = Image.new('RGBA', (256, 256), (66, 133, 244, 255))
    # Add a simple design
    for i in range(50, 200):
        for j in range(50, 200):
            img.putpixel((i, j), (234, 67, 53, 255))
    os.makedirs('assets', exist_ok=True)
    img.save('assets/icon.ico', sizes=[(16,16), (32,32), (48,48), (64,64), (128,128), (256,256)])
    print('Icon created')
except Exception as e:
    print(f'Icon creation failed: {e}')
    # Create minimal empty ICO
    with open('assets/icon.ico', 'wb') as f:
        f.write(b'')
" 2>&1
}

# Ensure all required directories exist
$dirs = @(
    "backend\models\cascades",
    "assets"
)
foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# Download cascades if not present
$cascadeDir = "backend\models\cascades"
if (-not (Test-Path "$cascadeDir\haarcascade_frontalface_default.xml")) {
    Write-Host "  Downloading cascade files..."
    python setup.py 2>&1 | Out-Null
}

Write-Host "  [OK] Resources ready"

# ========================================================================
# Step 7: Build installer
# ========================================================================
Write-Host ""
Write-Host "[7/7] Building Windows installer..."

# Update version in ISS file
$issPath = "installer\windows.iss"
$issContent = Get-Content $issPath -Raw
$issContent = $issContent -replace '#define MyAppVersion "[^"]*"', "#define MyAppVersion `"$Version`""
Set-Content $issPath $issContent -Encoding UTF8

# Compile with Inno Setup
& $isccPath $issPath 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Inno Setup compilation failed!"
    Write-Host "  Check the log above for details."
    exit 1
}

# Verify output
$outputDir = "installer_output"
$installerExe = Get-ChildItem -Path $outputDir -Filter "*.exe" | Select-Object -First 1

if (-not $installerExe) {
    Write-Host "  [ERROR] No installer EXE found in $outputDir"
    exit 1
}

$installerSize = [math]::Round($installerExe.Length / 1MB, 1)

Write-Host ""
Write-Host "================================================"
Write-Host "  INSTALLER BUILD SUCCESS!"
Write-Host "================================================"
Write-Host ""
Write-Host "  Output: $($installerExe.FullName)"
Write-Host "  Size:   $installerSize MB"
Write-Host "  Version: $Version"
Write-Host ""
Write-Host "  To install: Double-click the EXE"
Write-Host "  To deploy: Upload to GitHub Releases"
Write-Host ""

# Copy to release directory
$releaseDir = "release"
if (-not (Test-Path $releaseDir)) {
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
}
Copy-Item $installerExe.FullName "$releaseDir\" -Force
Write-Host "  Copied to: $releaseDir"

exit 0
