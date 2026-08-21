"""
Pixel Cake - Launcher
Serves frontend static files + API in one process.

FIXED VERSION - resolves frontend/backend API mismatches
"""

import os
import sys
import webbrowser
import threading
import time
from pathlib import Path


def get_base_dir():
    """Get resource base dir (compatible with PyInstaller)"""
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS)
    return Path(__file__).parent.resolve()


def main():
    import uvicorn
    from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel
    from typing import Optional
    import io
    import uuid

    import cv2
    import numpy as np
    from PIL import Image

    base = get_base_dir()
    UPLOAD_DIR = base / "uploads"
    OUTPUT_DIR = base / "outputs"
    TEMP_DIR = base / "temp"
    FRONTEND_DIR = base / "frontend" / "dist"
    FRONTEND_FALLBACK = base / "frontend_dist"

    for d in [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]:
        d.mkdir(exist_ok=True)

    print(f"Base dir: {base}")
    # Resolve frontend dir: prefer frontend/dist (Vite output), fallback to frontend_dist
    if not FRONTEND_DIR.exists() and FRONTEND_FALLBACK.exists():
        FRONTEND_DIR = FRONTEND_FALLBACK
    print(f"Frontend: {FRONTEND_DIR} (exists: {FRONTEND_DIR.exists()})")

    app = FastAPI(title="Pixel Cake", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Lazy-loaded services
    _services = {}

    def get_service(name):
        if name not in _services:
            try:
                if name == "inpainting":
                    from services.inpainting import InpaintingService
                    _services[name] = InpaintingService()
                elif name == "segmentation":
                    from services.segmentation import SegmentationService
                    _services[name] = SegmentationService()
                elif name == "sky":
                    from services.sky import SkyService
                    _services[name] = SkyService()
                elif name == "enhance":
                    from services.enhance import EnhanceService
                    _services[name] = EnhanceService()
            except Exception as e:
                print(f"[Warning] Failed to load {name}: {e}")
                _services[name] = None
        return _services.get(name)

    def load_image(path: str):
        """安全加载图像 - 支持中文路径"""
        img_array = np.fromfile(path, dtype=np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError(f"Cannot load: {path}")
        return img

    def imwrite_safe(path, image, params=None):
        """安全写入图像 - 支持中文路径"""
        ext = Path(path).suffix.lower()
        if params is None:
            if ext in (".jpg", ".jpeg"):
                params = [cv2.IMWRITE_JPEG_QUALITY, 95]
            elif ext == ".png":
                params = [cv2.IMWRITE_PNG_COMPRESSION, 3]
        success, buf = cv2.imencode(ext, image, params or [])
        if success:
            Path(path).write_bytes(buf.tobytes())
        return success

    def imread_safe(path, flags=cv2.IMREAD_COLOR):
        """安全读取图像 - 支持中文路径"""
        img_array = np.fromfile(path, dtype=np.uint8)
        return cv2.imdecode(img_array, flags)

    # -- Skin detection fallback (for tattoo/stubble removal) --
    def detect_skin_mask(image: np.ndarray) -> np.ndarray:
        """Detect skin regions using HSV + YCrCb color space"""
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        ycrcb = cv2.cvtColor(image, cv2.COLOR_BGR2YCrCb)

        # HSV skin range
        lower_hsv = np.array([0, 20, 70], dtype=np.uint8)
        upper_hsv = np.array([20, 255, 255], dtype=np.uint8)
        mask_hsv = cv2.inRange(hsv, lower_hsv, upper_hsv)

        # YCrCb skin range
        lower_ycrcb = np.array([0, 133, 77], dtype=np.uint8)
        upper_ycrcb = np.array([255, 173, 127], dtype=np.uint8)
        mask_ycrcb = cv2.inRange(ycrcb, lower_ycrcb, upper_ycrcb)

        # Combine
        mask = cv2.bitwise_or(mask_hsv, mask_ycrcb)

        # Clean up
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        return mask

    def detect_teeth_mask(image: np.ndarray) -> np.ndarray:
        """Detect teeth region using brightness + face area heuristic"""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        h, w = image.shape[:2]

        # Teeth are bright, low-saturation regions in the lower-center of the face
        # Simple approach: detect bright white regions
        _, bright = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)

        # Focus on center-lower portion of image (where mouths are)
        region_mask = np.zeros((h, w), dtype=np.uint8)
        region_mask[h//3:h*2//3, w//4:w*3//4] = 255

        mask = cv2.bitwise_and(bright, region_mask)

        # Clean up small noise
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        return mask

    def detect_ground_mask(image: np.ndarray) -> np.ndarray:
        """Detect ground/grass regions"""
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        h, w = image.shape[:2]

        # Green/brown ground colors
        lower_green = np.array([25, 20, 20], dtype=np.uint8)
        upper_green = np.array([85, 255, 255], dtype=np.uint8)
        mask_green = cv2.inRange(hsv, lower_green, upper_green)

        # Brown/dirt colors
        lower_brown = np.array([10, 30, 20], dtype=np.uint8)
        upper_brown = np.array([25, 255, 200], dtype=np.uint8)
        mask_brown = cv2.inRange(hsv, lower_brown, upper_brown)

        mask = cv2.bitwise_or(mask_green, mask_brown)

        # Ground is usually in the lower portion
        weight = np.zeros((h, w), dtype=np.float32)
        for i in range(h):
            weight[i, :] = max(0, (i / h) - 0.3) / 0.7
        mask = (mask.astype(np.float32) * weight).astype(np.uint8)

        _, mask = cv2.threshold(mask, 50, 255, cv2.THRESH_BINARY)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        return mask

    # -- Models --
    class InpaintRequest(BaseModel):
        image_id: str
        mask_id: str
        prompt: str = ""
        fill_type: Optional[str] = None  # FIX: accept fill_type from frontend

    class SkyReplaceRequest(BaseModel):
        image_id: str
        sky_type: str = "sunset"
        blend_strength: float = 0.7

    class EnhanceRequest(BaseModel):
        image_id: str
        brightness: float = 0.0
        contrast: float = 0.0
        saturation: float = 0.0
        warmth: float = 0.0
        sharpness: float = 0.0
        denoise: float = 0.0
        # FIX: Add missing fields that frontend sends
        highlights: float = 0.0
        shadows: float = 0.0
        whites: float = 0.0
        blacks: float = 0.0
        vibrance: float = 0.0
        clarity: float = 0.0
        tint: float = 0.0
        filter: Optional[str] = None
        filter_intensity: float = 1.0
        skin_smooth: bool = False

    # -- API Routes --

    @app.get("/api/health")
    async def health():
        gpu_available = False
        try:
            import torch
            gpu_available = torch.cuda.is_available()
        except Exception:
            pass
        return {
            "status": "ok",
            "gpu": gpu_available,
            "frontend": FRONTEND_DIR.exists(),
        }

    @app.post("/api/upload")
    async def upload(file: UploadFile = File(...)):
        image_id = str(uuid.uuid4())[:8]
        ext = Path(file.filename).suffix or ".jpg"
        save_path = UPLOAD_DIR / f"{image_id}{ext}"
        content = await file.read()
        save_path.write_bytes(content)
        img = Image.open(io.BytesIO(content))
        w, h = img.size
        return {"image_id": image_id, "filename": file.filename, "width": w, "height": h}

    @app.get("/api/image/{image_id}")
    async def get_image(image_id: str):
        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            matches = list(OUTPUT_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        return FileResponse(str(matches[0]))

    @app.post("/api/auto-segment")
    async def auto_segment(image_id: str = Form(...), mode: str = Form("person")):
        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))
        seg = get_service("segmentation")

        if seg is not None:
            if mode == "person":
                masks = seg.auto_detect_people(img)
            elif mode == "sky":
                masks = seg.auto_detect_sky(img)
            # FIX: Add missing modes
            elif mode == "skin":
                skin = detect_skin_mask(img)
                masks = [skin] if cv2.countNonZero(skin) > 0 else []
            elif mode == "teeth":
                teeth = detect_teeth_mask(img)
                masks = [teeth] if cv2.countNonZero(teeth) > 0 else []
            elif mode == "ground":
                ground = detect_ground_mask(img)
                masks = [ground] if cv2.countNonZero(ground) > 0 else []
            else:
                masks = seg.auto_detect_all(img)

            if masks:
                combined = np.zeros_like(masks[0])
                for m in masks:
                    combined = np.maximum(combined, m)
            else:
                combined = np.zeros(img.shape[:2], dtype=np.uint8)
        else:
            # FIX: Fallback with mode support when segmentation service unavailable
            if mode == "skin":
                combined = detect_skin_mask(img)
            elif mode == "teeth":
                combined = detect_teeth_mask(img)
            elif mode == "ground":
                combined = detect_ground_mask(img)
            elif mode == "sky":
                # Simple sky detection fallback
                hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
                lower_blue = np.array([90, 30, 80])
                upper_blue = np.array([130, 255, 255])
                combined = cv2.inRange(hsv, lower_blue, upper_blue)
            else:
                # person/all - use skin-tone + center-weighted detection
                hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
                # Skin color range
                lower_skin = np.array([0, 20, 60])
                upper_skin = np.array([20, 150, 255])
                skin_mask = cv2.inRange(hsv, lower_skin, upper_skin)
                # Also detect face-like regions (center-biased)
                h, w = img.shape[:2]
                combined = np.zeros((h, w), dtype=np.uint8)
                # Add center region as potential person area
                center_region = np.zeros((h, w), dtype=np.uint8)
                cx, cy = w // 2, h // 2
                rw, rh = int(w * 0.3), int(h * 0.4)
                center_region[max(0, cy-rh):min(h, cy+rh), max(0, cx-rw):min(w, cx+rw)] = 255
                # Combine skin mask with center region
                combined = cv2.bitwise_or(skin_mask, center_region)
                # Clean up
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
                combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)
                combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel)

        mask_id = str(uuid.uuid4())[:8]
        mask_path = OUTPUT_DIR / f"{mask_id}_mask.png"
        imwrite_safe(str(mask_path), combined)
        return FileResponse(str(mask_path), headers={"X-Mask-Id": mask_id})

    @app.post("/api/inpaint")
    async def inpaint(req: InpaintRequest):
        img_matches = list(UPLOAD_DIR.glob(f"{req.image_id}.*"))
        mask_matches = list(OUTPUT_DIR.glob(f"{req.mask_id}_mask.png"))
        if not img_matches:
            raise HTTPException(404, "Image not found")
        if not mask_matches:
            # FIX: Also check if mask was uploaded as a regular image
            mask_matches = list(UPLOAD_DIR.glob(f"{req.mask_id}.*"))
        if not mask_matches:
            raise HTTPException(404, "Mask not found")
        img = load_image(str(img_matches[0]))
        mask = imread_safe(str(mask_matches[0]), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise HTTPException(404, "Mask file unreadable")

        # FIX: handle fill_type (whiten, grass) before standard inpaint
        if req.fill_type == "whiten":
            # Teeth whitening: adjust brightness in masked area
            enh = get_service("enhance")
            if enh:
                result = enh.local_adjust(img, mask, brightness=0.3, saturation=-0.2)
            else:
                # Fallback: simple brightness boost in mask area
                result = img.copy().astype(np.float32)
                mask_norm = mask.astype(np.float32) / 255.0
                mask_3ch = np.stack([mask_norm] * 3, axis=-1)
                result = result + mask_3ch * 60
                result = result.clip(0, 255).astype(np.uint8)
        elif req.fill_type == "grass":
            # Generate green texture in masked area
            result = img.copy()
            mask_bool = mask > 127
            green = np.array([50, 140, 50], dtype=np.uint8)
            noise = np.random.randint(-20, 20, img.shape, dtype=np.int16)
            grass_color = np.clip(green.astype(np.int16) + noise, 0, 255).astype(np.uint8)
            result[mask_bool] = grass_color[mask_bool]
        else:
            inp = get_service("inpainting")
            if inp:
                result = inp.inpaint(img, mask, prompt=req.prompt)
            else:
                # Fallback: OpenCV inpainting
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
                mask_dilated = cv2.dilate(mask, kernel, iterations=2)
                result = cv2.inpaint(img, mask_dilated, inpaintRadius=7, flags=cv2.INPAINT_TELEA)

        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    @app.post("/api/enhance")
    async def enhance(req: EnhanceRequest):
        matches = list(UPLOAD_DIR.glob(f"{req.image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))
        enh = get_service("enhance")

        # FIX: Handle filter mode
        if req.filter:
            if enh:
                result = enh.apply_filter(img, req.filter, intensity=req.filter_intensity)
            else:
                # Fallback: return original
                result = img
        # FIX: Handle skin smooth mode
        elif req.skin_smooth:
            if enh:
                result = enh.skin_smooth(img)
            else:
                # Fallback: bilateral filter for smooth effect
                result = cv2.bilateralFilter(img, 9, 75, 75)
        else:
            # FIX: Pass ALL parameters to adjust (including highlights, shadows, etc.)
            if enh:
                result = enh.adjust(
                    img,
                    brightness=req.brightness,
                    contrast=req.contrast,
                    saturation=req.saturation,
                    warmth=req.warmth,
                    sharpness=req.sharpness,
                    denoise=req.denoise,
                    highlights=req.highlights,
                    shadows=req.shadows,
                    whites=req.whites,
                    blacks=req.blacks,
                    vibrance=req.vibrance,
                    clarity=req.clarity,
                    tint=req.tint,
                )
            else:
                # Fallback: basic OpenCV adjustments
                result = img.astype(np.float32)
                if req.brightness != 0 or req.contrast != 0:
                    result = result * (1.0 + req.contrast) + req.brightness * 255
                if req.saturation != 0:
                    hsv = cv2.cvtColor(result.clip(0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
                    hsv[:, :, 1] = hsv[:, :, 1] * (1.0 + req.saturation)
                    hsv[:, :, 1] = np.clip(hsv[:, :, 1], 0, 255)
                    result = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
                if req.warmth != 0:
                    result[:, :, 2] += req.warmth * 30
                    result[:, :, 0] -= req.warmth * 20
                if req.denoise > 0:
                    h_param = int(req.denoise * 15) + 3
                    result = cv2.fastNlMeansDenoisingColored(
                        result.clip(0, 255).astype(np.uint8), None, h_param, h_param, 7, 21
                    ).astype(np.float32)
                if req.sharpness > 0:
                    blurred = cv2.GaussianBlur(result, (0, 0), 3)
                    result = result + (result - blurred) * req.sharpness * 3
                result = result.clip(0, 255).astype(np.uint8)

        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    @app.get("/api/download/{result_id}")
    async def download(result_id: str):
        """下载指定 ID 的结果图"""
        matches = list(OUTPUT_DIR.glob(f"{result_id}.*"))
        if not matches:
            # Fallback: try uploads
            matches = list(UPLOAD_DIR.glob(f"{result_id}.*"))
        if not matches:
            raise HTTPException(404, "Result not found")
        file_path = matches[0]
        ext = file_path.suffix.lower()
        media_type = "image/png" if ext == ".png" else "image/jpeg"
        return FileResponse(
            str(file_path),
            media_type=media_type,
            filename=f"pixel-cake-{result_id}{ext}",
        )

    @app.post("/api/sky/replace")
    async def sky_replace(request: Request):
        """天空替换 - 支持 JSON body 和 Form-data"""
        # Try JSON body first, then form
        try:
            body = await request.json()
        except Exception:
            body = {}
            form = await request.form()
            body = dict(form)

        image_id = body.get("image_id", "")
        sky_type = body.get("sky_type", "sunset")
        blend_strength = float(body.get("blend_strength", "0.7"))

        if not image_id:
            raise HTTPException(400, "image_id is required")

        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))

        sky_svc = get_service("sky")
        if sky_svc:
            result = sky_svc.replace(img, sky_type=sky_type, blend=blend_strength)
        else:
            # Fallback: simple color-based sky detection and replacement
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            lower_blue = np.array([90, 30, 80])
            upper_blue = np.array([130, 255, 255])
            sky_mask = cv2.inRange(hsv, lower_blue, upper_blue)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            _, bright_mask = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
            combined_mask = cv2.bitwise_or(sky_mask, bright_mask)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            combined_mask = cv2.morphologyEx(combined_mask, cv2.MORPH_CLOSE, kernel)
            combined_mask = cv2.GaussianBlur(combined_mask, (15, 15), 0)
            h, w = img.shape[:2]
            sky_overlay = img.copy()
            for y in range(h):
                ratio = y / max(h, 1)
                if sky_type == "sunset":
                    sky_overlay[y, :, 0] = int(255 * ratio * 0.5)
                    sky_overlay[y, :, 1] = int(100 + 80 * (1 - ratio))
                    sky_overlay[y, :, 2] = int(200 + 55 * (1 - ratio))
                elif sky_type == "cloudy":
                    sky_overlay[y, :, 0] = int(180 + 40 * ratio)
                    sky_overlay[y, :, 1] = int(180 + 40 * ratio)
                    sky_overlay[y, :, 2] = int(200 + 40 * ratio)
                elif sky_type == "starry":
                    sky_overlay[y, :, 0] = int(20 + 30 * ratio)
                    sky_overlay[y, :, 1] = int(15 + 20 * ratio)
                    sky_overlay[y, :, 2] = int(10 + 15 * ratio)
                elif sky_type == "golden_hour":
                    sky_overlay[y, :, 0] = int(50 + 30 * (1 - ratio))
                    sky_overlay[y, :, 1] = int(150 + 50 * (1 - ratio))
                    sky_overlay[y, :, 2] = int(200 + 55 * (1 - ratio))
                else:  # blue / overcast
                    sky_overlay[y, :, 0] = int(200 + 55 * (1 - ratio))
                    sky_overlay[y, :, 1] = int(150 + 80 * (1 - ratio))
                    sky_overlay[y, :, 2] = int(100 + 100 * (1 - ratio))
            mask_3ch = cv2.cvtColor(combined_mask, cv2.COLOR_GRAY2BGR).astype(np.float32) / 255.0
            result = (img.astype(np.float32) * (1 - mask_3ch) + sky_overlay.astype(np.float32) * mask_3ch).clip(0, 255).astype(np.uint8)

        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    @app.post("/api/relight")
    async def relight(request: Request):
        """AI 补光 - 支持 JSON body 和 Form-data"""
        try:
            body = await request.json()
        except Exception:
            body = {}
            form = await request.form()
            body = dict(form)

        image_id = body.get("image_id", "")
        brightness = float(body.get("brightness", "0.3"))
        warmth = float(body.get("warmth", "0.1"))
        direction = body.get("direction", "natural")

        if not image_id:
            raise HTTPException(400, "image_id is required")

        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))

        enh = get_service("enhance")
        if enh:
            result = enh.relight(img, brightness=brightness, warmth=warmth, direction=direction)
        else:
            # Fallback: basic brightness + warmth via OpenCV
            result = img.astype(np.float32)
            result = np.clip(result * (1 + brightness), 0, 255).astype(np.uint8)
            if warmth != 0:
                b, g, r = cv2.split(result)
                r = np.clip(r.astype(np.float32) * (1 + warmth * 0.5), 0, 255).astype(np.uint8)
                b = np.clip(b.astype(np.float32) * (1 - warmth * 0.5), 0, 255).astype(np.uint8)
                result = cv2.merge([b, g, r])

        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    # -- 3D 美型 --
    @app.post("/api/face-slim")
    async def face_slim(image_id: str = Form(...), strength: float = Form(0.3)):
        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))
        enh = get_service("enhance")
        if enh:
            result = enh.face_slim(img, strength=strength)
        else:
            # Fallback: simple horizontal squeeze using skin-tone face detection
            h, w = img.shape[:2]
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
            # 肤色检测
            mask = cv2.inRange(hsv, (0, 30, 80), (20, 180, 255))
            mask2 = cv2.inRange(hsv, (170, 30, 80), (180, 180, 255))
            mask = cv2.bitwise_or(mask, mask2)
            # 找最大肤色区域
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                largest = max(contours, key=cv2.contourArea)
                x, y, fw, fh = cv2.boundingRect(largest)
                if fw >= 30 and fh >= 40:
                    cx = x + fw // 2
                    squeeze = int(fw * strength * 0.15)
                    result = img.copy()
                    M = np.float32([[1, 0, -squeeze], [0, 1, 0]])
                    result[y:y+fh, x:cx] = cv2.warpAffine(
                        result[y:y+fh, x:cx], M, (cx - x, fh)
                    )
                else:
                    result = img
            else:
                result = img
        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    # -- 发丝处理 --
    @app.post("/api/hair-smooth")
    async def hair_smooth(image_id: str = Form(...), strength: float = Form(0.5)):
        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))
        enh = get_service("enhance")
        if enh:
            result = enh.hair_smooth(img, strength=strength)
        else:
            # Fallback: Gaussian blur on edge regions
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray, 30, 100)
            h, w = img.shape[:2]
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            edges_dilated = cv2.dilate(edges, kernel, iterations=2)
            blur_size = int(strength * 20) * 2 + 3
            blurred = cv2.GaussianBlur(img, (blur_size, blur_size), 0)
            mask_3ch = np.stack([edges_dilated.astype(np.float32) / 255.0 * strength] * 3, axis=-1)
            result = img.astype(np.float32) * (1 - mask_3ch) + blurred.astype(np.float32) * mask_3ch
            result = result.clip(0, 255).astype(np.uint8)
        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    # -- 妆容调整 --
    class MakeupRequest(BaseModel):
        image_id: str
        lipstick: float = 0.0
        blush: float = 0.0
        eyeshadow: float = 0.0
        lip_color: Optional[list] = None
        blush_color: Optional[list] = None
        eyeshadow_color: Optional[list] = None

    @app.post("/api/makeup")
    async def makeup(req: MakeupRequest):
        matches = list(UPLOAD_DIR.glob(f"{req.image_id}.*"))
        if not matches:
            raise HTTPException(404, "Image not found")
        img = load_image(str(matches[0]))
        enh = get_service("enhance")
        lip_c = tuple(req.lip_color) if req.lip_color else (0, 0, 200)
        blush_c = tuple(req.blush_color) if req.blush_color else (100, 100, 230)
        eye_c = tuple(req.eyeshadow_color) if req.eyeshadow_color else (120, 50, 50)
        if enh:
            result = enh.apply_makeup(
                img,
                lipstick=req.lipstick,
                blush=req.blush,
                eyeshadow=req.eyeshadow,
                lip_color=lip_c,
                blush_color=blush_c,
                eyeshadow_color=eye_c,
            )
        else:
            result = img  # No fallback for makeup
        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    # -- AI 追色 2.0 --
    @app.post("/api/color-match")
    async def color_match(image_id: str = Form(...), reference: UploadFile = File(...)):
        matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
        if not matches:
            raise HTTPException(404, "Source image not found")
        img = load_image(str(matches[0]))
        ref_content = await reference.read()
        ref_array = np.frombuffer(ref_content, dtype=np.uint8)
        ref_img = cv2.imdecode(ref_array, cv2.IMREAD_COLOR)
        if ref_img is None:
            raise HTTPException(400, "Cannot read reference image")
        enh = get_service("enhance")
        if enh:
            result = enh.color_match_advanced(img, ref_img)
        else:
            # Fallback: basic LAB mean/std matching
            src_lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
            ref_lab = cv2.cvtColor(ref_img, cv2.COLOR_BGR2LAB).astype(np.float32)
            for i in range(3):
                src_mean, src_std = src_lab[:, :, i].mean(), src_lab[:, :, i].std()
                ref_mean, ref_std = ref_lab[:, :, i].mean(), ref_lab[:, :, i].std()
                if src_std > 0:
                    src_lab[:, :, i] = (src_lab[:, :, i] - src_mean) * (ref_std / src_std) + ref_mean
            result = cv2.cvtColor(src_lab.clip(0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    # -- 局部调色 --
    class LocalAdjustRequest(BaseModel):
        image_id: str
        mask_id: str
        brightness: float = 0.0
        contrast: float = 0.0
        saturation: float = 0.0
        warmth: float = 0.0

    @app.post("/api/local-adjust")
    async def local_adjust(req: LocalAdjustRequest):
        img_matches = list(UPLOAD_DIR.glob(f"{req.image_id}.*"))
        if not img_matches:
            raise HTTPException(404, "Image not found")
        mask_matches = list(OUTPUT_DIR.glob(f"{req.mask_id}_mask.png"))
        if not mask_matches:
            mask_matches = list(UPLOAD_DIR.glob(f"{req.mask_id}.*"))
        if not mask_matches:
            raise HTTPException(404, "Mask not found")
        img = load_image(str(img_matches[0]))
        mask = imread_safe(str(mask_matches[0]), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise HTTPException(404, "Mask unreadable")
        enh = get_service("enhance")
        if enh:
            result = enh.local_adjust(
                img, mask,
                brightness=req.brightness,
                contrast=req.contrast,
                saturation=req.saturation,
                warmth=req.warmth,
            )
        else:
            # Fallback: simple mask blending
            adjusted = img.astype(np.float32)
            if req.brightness != 0:
                adjusted += req.brightness * 100
            if req.saturation != 0:
                hsv = cv2.cvtColor(adjusted.clip(0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
                hsv[:, :, 1] *= (1.0 + req.saturation)
                adjusted = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
            mask_blur = cv2.GaussianBlur(mask, (21, 21), 0).astype(np.float32) / 255.0
            mask_3ch = np.stack([mask_blur] * 3, axis=-1)
            result = img.astype(np.float32) * (1 - mask_3ch) + adjusted * mask_3ch
            result = result.clip(0, 255).astype(np.uint8)
        rid = str(uuid.uuid4())[:8]
        rpath = OUTPUT_DIR / f"{rid}.jpg"
        imwrite_safe(str(rpath), result)
        return FileResponse(str(rpath), headers={"X-Result-Id": rid})

    # -- Frontend --
    if FRONTEND_DIR.exists() and (FRONTEND_DIR / "index.html").exists():
        @app.get("/")
        async def root():
            return FileResponse(str(FRONTEND_DIR / "index.html"))

        # Serve static assets
        if (FRONTEND_DIR / "assets").exists():
            app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")

        @app.api_route("/{full_path:path}", methods=["GET"], include_in_schema=False)
        async def spa_fallback(full_path: str):
            file_path = FRONTEND_DIR / full_path
            if file_path.is_file():
                return FileResponse(str(file_path))
            return FileResponse(str(FRONTEND_DIR / "index.html"))
    else:
        @app.get("/")
        async def root_fallback():
            return {
                "message": "Pixel Cake API is running.",
                "note": "Frontend not built yet. Run: cd frontend && npm run build"
            }

    # -- Start --
    host = "127.0.0.1"
    port = 8765
    url = f"http://{host}:{port}"

    print()
    print("=" * 50)
    print(f"  Pixel Cake - AI Photo Editor")
    print(f"  URL: {url}")
    print("=" * 50)
    print()

    def open_browser_delayed():
        time.sleep(2)
        webbrowser.open(url)

    threading.Thread(target=open_browser_delayed, daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
