# Pixel Cake VERSION - Windows

## System Requirements
- Windows 10/11 (64-bit)
- Python 3.10+ (for source mode)
- 4GB+ RAM
- GPU optional (CUDA for acceleration)

## Quick Start

### Option 1: Installer (Recommended)
1. Double-click PixelCake-Setup-VERSION-Windows.exe
2. Follow the installation wizard
3. Launch from Start Menu or Desktop shortcut

### Option 2: EXE (Standalone)
1. Double-click PixelCake.exe
2. Browser opens at http://127.0.0.1:8765

### Option 3: Source Mode
1. Install Python 3.10+ from https://python.org
2. Run install.bat
3. Browser opens automatically

## Features
- AI image inpainting (LaMa / Stable Diffusion / OpenCV)
- Semantic segmentation (SAM2 / MediaPipe / Traditional CV)
- Sky replacement (6 presets: sunset, blue, cloudy, starry, golden_hour, overcast)
- 9 color filters + 16 adjustment parameters
- AI relighting, face slimming, hair smoothing, makeup
- Color matching with LAB color space
- All processing runs locally - no data sent to servers

## Uninstall
- Installer: Use Windows Settings > Apps > Uninstall
- Source/EXE: Delete the folder, run `python setup.py uninstall`

## File Locations
- Install dir: `C:\Program Files\Pixel Cake\` (installer)
- Data dir: `%APPDATA%\PixelCake\` (uploads, outputs, temp)
