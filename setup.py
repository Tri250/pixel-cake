#!/usr/bin/env python3
"""
Pixel Cake - Setup Script
Downloads Haar cascade files and verifies installation.
Supports Windows and Unix platforms.
"""
import os
import sys
import shutil
import urllib.request
from pathlib import Path

VERSION = "1.0.0"

CASCADE_FILES = [
    "haarcascade_frontalface_default.xml",
    "haarcascade_frontalface_alt2.xml",
    "haarcascade_eye.xml",
    "haarcascade_smile.xml",
    "haarcascade_profileface.xml",
    "haarcascade_fullbody.xml",
    "haarcascade_upperbody.xml",
    "haarcascade_lowerbody.xml",
]

BASE_URL = "https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/"


def get_base_dir():
    """Get project root directory."""
    return Path(__file__).parent.resolve()


def get_data_dir():
    """Get user data directory."""
    base = get_base_dir()
    if sys.platform == 'win32':
        return Path(os.environ.get('APPDATA', base)) / 'PixelCake'
    return Path.home() / '.pixel-cake'


def download_cascades():
    """Download Haar cascade files to backend/models/cascades/"""
    base = get_base_dir()
    cascade_dir = base / "backend" / "models" / "cascades"
    cascade_dir.mkdir(parents=True, exist_ok=True)
    
    downloaded = 0
    failed = 0
    skipped = 0
    for fname in CASCADE_FILES:
        fpath = cascade_dir / fname
        if fpath.exists() and fpath.stat().st_size > 1000:
            print(f"  [SKIP] {fname} already exists")
            skipped += 1
            continue
        url = BASE_URL + fname
        try:
            print(f"  [DOWNLOAD] {fname} ...")
            urllib.request.urlretrieve(url, str(fpath))
            size_kb = fpath.stat().st_size / 1024
            print(f"  [OK] {fname} ({size_kb:.0f}KB)")
            downloaded += 1
        except Exception as e:
            print(f"  [FAIL] {fname}: {e}")
            if fpath.exists():
                fpath.unlink()
            failed += 1
    
    print(f"\nCascades: {downloaded} downloaded, {skipped} skipped, {failed} failed")
    return failed == 0


def check_dependencies():
    """Check Python dependencies."""
    missing = []
    try:
        import fastapi
    except ImportError:
        missing.append("fastapi")
    try:
        import uvicorn
    except ImportError:
        missing.append("uvicorn")
    try:
        import cv2
    except ImportError:
        missing.append("opencv-python-headless")
    try:
        import numpy
    except ImportError:
        missing.append("numpy")
    
    if missing:
        print(f"  [WARN] Missing: {', '.join(missing)}")
        print("  Run: pip install -r backend/requirements.txt")
        return False
    else:
        print("  [OK] All core dependencies available")
        return True


def install_shortcut():
    """Create desktop shortcut on Windows."""
    if sys.platform != 'win32':
        return
    
    try:
        import subprocess
        desktop = Path.home() / "Desktop"
        shortcut_path = desktop / "PixelCake.lnk"
        target = get_base_dir() / "run.bat"
        
        if not target.exists():
            print("  [WARN] run.bat not found, skipping shortcut creation")
            return
        
        # Create VBS script for shortcut
        vbs_content = f'''Set oWS = WScript.Shell
sLinkFile = "{shortcut_path}"
Set oLink = oWS.CreateShortcut(sLinkFile)
oLink.TargetPath = "{target}"
oLink.WorkingDirectory = "{get_base_dir()}"
oLink.Description = "Pixel Cake - AI Photo Editor"
oLink.Save
'''
        vbs_path = get_base_dir() / "_create_shortcut.vbs"
        vbs_path.write_text(vbs_content)
        
        result = subprocess.run(['cscript', '//nologo', str(vbs_path)], capture_output=True)
        vbs_path.unlink(missing_ok=True)
        
        if result.returncode == 0:
            print(f"  [OK] Desktop shortcut created: {shortcut_path}")
        else:
            print(f"  [WARN] Could not create desktop shortcut")
    except Exception as e:
        print(f"  [WARN] Shortcut creation failed: {e}")


def uninstall():
    """Remove Pixel Cake data files."""
    data_dir = get_data_dir()
    if data_dir.exists():
        try:
            shutil.rmtree(data_dir)
            print(f"  [OK] Removed: {data_dir}")
        except Exception as e:
            print(f"  [WARN] Could not remove {data_dir}: {e}")
    
    print("\nTo complete uninstall:")
    print("  1. Delete the Pixel Cake installation folder")
    if sys.platform == 'win32':
        print("  2. Delete the desktop shortcut if present")
        print("  3. Optionally: pip uninstall -r backend/requirements.txt")
    else:
        print("  2. Optionally: pip uninstall -r backend/requirements.txt")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'uninstall':
        print("=" * 50)
        print("Pixel Cake - Uninstall")
        print("=" * 50)
        print()
        uninstall()
        print("\n[DONE] Uninstall complete!")
        return 0
    
    print("=" * 50)
    print(f"Pixel Cake v{VERSION} - Setup Script")
    print("=" * 50)
    
    print("\n[1/3] Downloading Haar cascade files...")
    cascades_ok = download_cascades()
    
    print("\n[2/3] Checking Python dependencies...")
    deps_ok = check_dependencies()
    
    if sys.platform == 'win32':
        print("\n[3/3] Creating desktop shortcut...")
        install_shortcut()
    else:
        print("\n[3/3] Setup complete.")
    
    print("\n" + "=" * 50)
    if cascades_ok and deps_ok:
        print("  [DONE] Setup complete!")
    else:
        print("  [WARN] Setup completed with warnings.")
    print(f"  Run: python launcher.py")
    print("  Or:  Double-click run.bat (Windows)")
    print("=" * 50)
    return 0 if (cascades_ok and deps_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
