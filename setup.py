#!/usr/bin/env python3
"""
Setup script for Pixel Cake
Downloads Haar cascade files required for face detection support.
"""
import os
import sys
import urllib.request

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
    return os.path.dirname(os.path.abspath(__file__))

def download_cascades():
    """Download Haar cascade files to backend/models/cascades/"""
    base = get_base_dir()
    cascade_dir = os.path.join(base, "backend", "models", "cascades")
    os.makedirs(cascade_dir, exist_ok=True)
    
    downloaded = 0
    failed = 0
    for fname in CASCADE_FILES:
        fpath = os.path.join(cascade_dir, fname)
        if os.path.exists(fpath) and os.path.getsize(fpath) > 1000:
            print(f"  [SKIP] {fname} already exists")
            continue
        url = BASE_URL + fname
        try:
            print(f"  [DOWNLOAD] {fname} ...")
            urllib.request.urlretrieve(url, fpath)
            size_kb = os.path.getsize(fpath) / 1024
            print(f"  [OK] {fname} ({size_kb:.0f}KB)")
            downloaded += 1
        except Exception as e:
            print(f"  [FAIL] {fname}: {e}")
            # Remove partial download
            if os.path.exists(fpath):
                os.remove(fpath)
            failed += 1
    
    print(f"\nCascades: {downloaded} downloaded, {failed} failed")
    return failed == 0

def main():
    print("=" * 50)
    print("Pixel Cake - Setup Script")
    print("=" * 50)
    
    print("\n[1/2] Downloading Haar cascade files...")
    ok = download_cascades()
    
    print("\n[2/2] Checking Python dependencies...")
    try:
        import fastapi
        import uvicorn
        import cv2
        import numpy
        print("  [OK] Dependencies available")
    except ImportError as e:
        print(f"  [WARN] Missing deps: {e}")
        print("  Run: pip install -r backend/requirements.txt")
    
    print("\n[DONE] Setup complete!")
    print("  Run: python launcher.py")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
