"""
Segmentation Service - AI语义分割
基于 SAM2 (Segment Anything Model 2) + MediaPipe ImageSegmenter
支持：交互式分割、自动人物检测、天空检测、肤色/牙齿/草地检测
回退链路：SAM2 Hiera-Large → SAM v1 → MediaPipe ImageSegmenter → OpenCV (GrabCut + 色彩空间)
"""

import os
import numpy as np
import cv2

# 安全导入可选依赖
HAS_TORCH = False
HAS_MEDIAPIPE = False
torch = None

try:
    import torch as _torch
    torch = _torch
    HAS_TORCH = True
except ImportError:
    pass

try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    mp = None


class SegmentationService:
    """语义分割服务"""

    def __init__(self, model_type: str = "sam2"):
        """
        Args:
            model_type: 模型类型
                - "sam2": SAM2 (精度最高)
                - "sam": SAM v1
                - "mediapipe": MediaPipe (速度快)
                - "cv": 传统CV (兜底)
        """
        self.model_type = model_type
        self.device = "cuda" if (HAS_TORCH and torch.cuda.is_available()) else "cpu"
        self._sam = None
        self._mp_segmenter = None
        self._load_model()

    def _load_model(self):
        """加载分割模型（逐级回退）"""
        if self.model_type == "sam2":
            ok = self._load_sam2()
            if not ok:
                print("[Segmentation] SAM2 failed, falling back to SAM v1")
                ok = self._load_sam_v1()
                if not ok:
                    print("[Segmentation] SAM v1 failed, falling back to MediaPipe")
                    ok = self._load_mediapipe()
                    if not ok:
                        print("[Segmentation] MediaPipe failed, falling back to traditional CV")
                        self.model_type = "cv"
                    else:
                        self.model_type = "mediapipe"
                else:
                    self.model_type = "sam"
            else:
                self.model_type = "sam2"

        elif self.model_type == "sam":
            ok = self._load_sam_v1()
            if not ok:
                print("[Segmentation] SAM v1 failed, falling back to MediaPipe")
                ok = self._load_mediapipe()
                if not ok:
                    self.model_type = "cv"
                else:
                    self.model_type = "mediapipe"

        elif self.model_type == "mediapipe":
            ok = self._load_mediapipe()
            if not ok:
                self.model_type = "cv"

    def _load_sam2(self) -> bool:
        """加载 SAM2 模型"""
        if not HAS_TORCH:
            print("[Segmentation] SAM2 requires torch")
            return False
        try:
            from sam2.build_sam import build_sam2
            from sam2.sam2_image_predictor import SAM2ImagePredictor
            self._sam = SAM2ImagePredictor.from_pretrained("facebook/sam2-hiera-large")
            print("[Segmentation] SAM2 loaded successfully")
            return True
        except ImportError:
            print("[Segmentation] sam2 package not installed")
            return False
        except Exception as e:
            print(f"[Segmentation] SAM2 load error: {e}")
            return False

    def _load_sam_v1(self) -> bool:
        """加载 SAM v1 模型"""
        if not HAS_TORCH:
            return False
        try:
            from segment_anything import sam_model_registry, SamPredictor
            sam = sam_model_registry["vit_h"](checkpoint="sam_vit_h.pth")
            sam.to(self.device)
            self._sam = SamPredictor(sam)
            print("[Segmentation] SAM (v1) loaded successfully")
            return True
        except ImportError:
            print("[Segmentation] segment_anything package not installed")
            return False
        except Exception as e:
            print(f"[Segmentation] SAM v1 load error: {e}")
            return False

    def _load_mediapipe(self) -> bool:
        """加载 MediaPipe ImageSegmenter"""
        if not HAS_MEDIAPIPE:
            print("[Segmentation] MediaPipe not installed")
            return False
        try:
            from mediapipe.tasks import python
            from mediapipe.tasks.python import vision

            model_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "models", "selfie_segmenter.tflite"
            )

            if os.path.exists(model_path):
                base_options = python.BaseOptions(model_asset_path=model_path)
                options = vision.ImageSegmenterOptions(
                    base_options=base_options,
                    output_category_mask=True
                )
                self._mp_segmenter = vision.ImageSegmenter.create_from_options(options)
                print("[Segmentation] MediaPipe ImageSegmenter loaded successfully")
                return True
            else:
                print(f"[Segmentation] MediaPipe model file not found: {model_path}")
                return False
        except Exception as e:
            print(f"[Segmentation] MediaPipe load error: {e}")
            return False

    # ──────────────────────────────────────────
    # 交互式分割
    # ──────────────────────────────────────────

    def predict(
        self,
        image: np.ndarray,
        points: list[tuple] = None,
        box: tuple = None,
    ) -> np.ndarray:
        """
        交互式分割预测

        Args:
            image: 输入图像 (H, W, 3) BGR
            points: 点列表 [(x, y, label), ...] label: 1=前景, 0=背景
            box: 边界框 (x1, y1, x2, y2)

        Returns:
            分割掩码 (H, W) 0-255
        """
        if image is None:
            return np.zeros((256, 256), dtype=np.uint8)

        if self.model_type in ("sam2", "sam") and self._sam is not None:
            try:
                return self._predict_sam(image, points, box)
            except Exception as e:
                print(f"[Segmentation] SAM inference failed: {e}, falling back to CV")
                return self._predict_cv(image, points, box)
        elif self.model_type == "mediapipe" and self._mp_segmenter is not None:
            try:
                return self._predict_mediapipe(image)
            except Exception as e:
                print(f"[Segmentation] MediaPipe inference failed: {e}, falling back to CV")
                return self._predict_cv(image, points, box)
        else:
            return self._predict_cv(image, points, box)

    def _predict_sam(
        self,
        image: np.ndarray,
        points: list[tuple] = None,
        box: tuple = None,
    ) -> np.ndarray:
        """SAM 预测"""
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        self._sam.set_image(rgb)

        input_points = None
        input_labels = None
        if points:
            input_points = np.array([(p[0], p[1]) for p in points], dtype=np.float32)
            input_labels = np.array([p[2] for p in points], dtype=np.int32)

        input_box = None
        if box:
            input_box = np.array(box, dtype=np.float32)

        masks, scores, _ = self._sam.predict(
            point_coords=input_points,
            point_labels=input_labels,
            box=input_box,
            multimask_output=True,
        )

        best_idx = np.argmax(scores)
        mask = masks[best_idx]
        return (mask * 255).astype(np.uint8)

    def _predict_mediapipe(self, image: np.ndarray) -> np.ndarray:
        """MediaPipe 分割"""
        from mediapipe import Image as MpImage
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_image = MpImage(image_format=MpImage.image_format.SRGB, data=rgb)
        result = self._mp_segmenter.segment(mp_image)
        category_mask = result.category_mask.numpy_view()
        person_mask = (category_mask > 0).astype(np.uint8) * 255
        return person_mask

    def _predict_cv(
        self,
        image: np.ndarray,
        points: list[tuple] = None,
        box: tuple = None,
    ) -> np.ndarray:
        """传统CV方法兜底"""
        h, w = image.shape[:2]

        if points and len(points) > 0:
            return self._grabcut_predict(image, points, box)
        elif box:
            mask = np.zeros((h, w), dtype=np.uint8)
            x1, y1, x2, y2 = map(int, box)
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if x2 > x1 and y2 > y1:
                mask[y1:y2, x1:x2] = 255
            else:
                mask[h//4:3*h//4, w//4:3*w//4] = 255
            return mask
        else:
            # 无提示时使用中心区域
            mask = np.zeros((h, w), dtype=np.uint8)
            cx, cy = w // 2, h // 2
            rw, rh = w // 4, h // 4
            mask[cy-rh:cy+rh, cx-rw:cx+rw] = 255
            return mask

    def _grabcut_predict(
        self,
        image: np.ndarray,
        points: list[tuple],
        box: tuple = None,
    ) -> np.ndarray:
        """GrabCut 分割"""
        h, w = image.shape[:2]
        mask = np.zeros((h, w), dtype=np.uint8)
        bgd_model = np.zeros((1, 65), np.float64)
        fgd_model = np.zeros((1, 65), np.float64)

        fg_points = [p for p in points if p[2] == 1]
        bg_points = [p for p in points if p[2] == 0]

        # 使用前景点确定初始矩形
        if fg_points:
            xs = [p[0] for p in fg_points]
            ys = [p[1] for p in fg_points]
            margin = max(50, min(w, h) // 10)
            x_min, x_max = max(0, min(xs) - margin), min(w, max(xs) + margin)
            y_min, y_max = max(0, min(ys) - margin), min(h, max(ys) + margin)
            rect = (x_min, y_min, max(1, x_max - x_min), max(1, y_max - y_min))
        elif box:
            rect = (box[0], box[1], max(1, box[2] - box[0]), max(1, box[3] - box[1]))
        else:
            rect = (w // 4, h // 4, w // 2, h // 2)

        # 使用标记点
        if bg_points:
            for p in bg_points:
                px, py = int(p[0]), int(p[1])
                if 0 <= px < w and 0 <= py < h:
                    mask[py, px] = cv2.GC_BGD
        if fg_points:
            for p in fg_points:
                px, py = int(p[0]), int(p[1])
                if 0 <= px < w and 0 <= py < h:
                    mask[py, px] = cv2.GC_FGD

        try:
            if np.count_nonzero(mask) > 0:
                cv2.grabCut(image, mask, None, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_MASK)
            else:
                cv2.grabCut(image, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)

            result_mask = np.where(
                (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0
            ).astype(np.uint8)

            # 形态学清理
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
            result_mask = cv2.morphologyEx(result_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
            result_mask = cv2.morphologyEx(result_mask, cv2.MORPH_OPEN, kernel, iterations=1)
            return result_mask
        except cv2.error:
            # GrabCut 失败，返回矩形掩码
            rmask = np.zeros((h, w), dtype=np.uint8)
            rx, ry, rw, rh = rect
            rmask[ry:ry+rh, rx:rx+rw] = 255
            return rmask

    # ──────────────────────────────────────────
    # 自动人物检测
    # ──────────────────────────────────────────

    def auto_detect_people(self, image: np.ndarray) -> list[np.ndarray]:
        """
        自动检测画面中的所有人物

        Returns:
            掩码列表，每个掩码对应一个人物
        """
        if image is None:
            return []

        if self.model_type == "mediapipe" and self._mp_segmenter is not None:
            return self._detect_people_mediapipe(image)
        elif self.model_type in ("sam2", "sam") and self._sam is not None:
            return self._detect_people_sam(image)
        else:
            return self._detect_people_cv(image)

    def _detect_people_sam(self, image: np.ndarray) -> list[np.ndarray]:
        """使用 SAM 检测人物（多点提示）"""
        h, w = image.shape[:2]
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        self._sam.set_image(rgb)

        # 使用中心区域多点提示
        cx, cy = w // 2, h // 2
        prompt_points = np.array([
            [cx, cy],                              # 中心
            [cx, int(h * 0.3)],                    # 上部
            [cx, int(h * 0.7)],                    # 下部
            [int(w * 0.3), cy],                    # 左
            [int(w * 0.7), cy],                    # 右
        ], dtype=np.float32)
        prompt_labels = np.array([1, 1, 1, 1, 1], dtype=np.int32)

        try:
            masks, scores, _ = self._sam.predict(
                point_coords=prompt_points,
                point_labels=prompt_labels,
                multimask_output=True,
            )
            best_idx = np.argmax(scores)
            mask = (masks[best_idx] * 255).astype(np.uint8)
            return self._split_connected_regions(mask, min_area=3000)
        except Exception:
            return self._detect_people_cv(image)

    def _detect_people_mediapipe(self, image: np.ndarray) -> list[np.ndarray]:
        """MediaPipe 人物分割"""
        from mediapipe import Image as MpImage
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_image = MpImage(image_format=MpImage.image_format.SRGB, data=rgb)

        try:
            result = self._mp_segmenter.segment(mp_image)
            category_mask = result.category_mask.numpy_view()
            person_mask = (category_mask > 0).astype(np.uint8) * 255

            if np.count_nonzero(person_mask) > 0:
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
                person_mask = cv2.morphologyEx(person_mask, cv2.MORPH_CLOSE, kernel, iterations=2)
                person_mask = cv2.morphologyEx(person_mask, cv2.MORPH_OPEN, kernel, iterations=1)
                return self._split_connected_regions(person_mask)
            return []
        except Exception:
            return self._detect_people_cv(image)

    def _detect_people_cv(self, image: np.ndarray) -> list[np.ndarray]:
        """传统CV方法检测人物（基于肤色+GrabCut）"""
        h, w = image.shape[:2]

        # 肤色检测作为初始区域
        ycrcb = cv2.cvtColor(image, cv2.COLOR_BGR2YCrCb)
        lower_skin = np.array([0, 125, 70])
        upper_skin = np.array([255, 180, 135])
        skin_mask = cv2.inRange(ycrcb, lower_skin, upper_skin)

        # HSV 辅助
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        lower2 = np.array([0, 15, 50])
        upper2 = np.array([25, 255, 255])
        skin_mask2 = cv2.inRange(hsv, lower2, upper2)

        skin_mask = np.maximum(skin_mask, skin_mask2)

        # 肤色区域+中心区域作为前景提示
        center_region = np.zeros((h, w), dtype=np.uint8)
        cx, cy = w // 2, h // 2
        rw, rh = int(w * 0.3), int(h * 0.4)
        center_region[max(0, cy-rh):min(h, cy+rh), max(0, cx-rw):min(w, cx+rw)] = 255

        combined = cv2.bitwise_or(skin_mask, center_region)

        # GrabCut 精细化
        try:
            refined = self._refine_with_grabcut(image, combined)
            regions = self._split_connected_regions(refined, min_area=5000)
            return regions if regions else [combined]
        except cv2.error:
            return [combined] if np.count_nonzero(combined) > 0 else []

    def _refine_with_grabcut(self, image: np.ndarray, rough_mask: np.ndarray) -> np.ndarray:
        """用 GrabCut 精细化粗掩码"""
        mask = np.where(rough_mask > 0, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
        bgd_model = np.zeros((1, 65), np.float64)
        fgd_model = np.zeros((1, 65), np.float64)

        try:
            cv2.grabCut(image, mask, None, bgd_model, fgd_model, 3, cv2.GC_INIT_WITH_MASK)
            result = np.where(
                (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0
            ).astype(np.uint8)
        except cv2.error:
            result = rough_mask

        # 形态学清理
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        result = cv2.morphologyEx(result, cv2.MORPH_CLOSE, kernel, iterations=2)
        result = cv2.morphologyEx(result, cv2.MORPH_OPEN, kernel, iterations=1)
        return result

    # ──────────────────────────────────────────
    # 天空检测（多策略融合）
    # ──────────────────────────────────────────

    def auto_detect_sky(self, image: np.ndarray) -> list[np.ndarray]:
        """自动检测天空区域（多策略融合：HSV 颜色 + 边缘密度 + 位置先验）"""
        if image is None:
            return []

        h, w = image.shape[:2]

        # 策略1: HSV颜色检测
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

        # 蓝色天空
        mask_blue = cv2.inRange(hsv, np.array([90, 30, 80]), np.array([130, 255, 255]))
        # 白色/灰色天空（阴天）
        mask_white = cv2.inRange(hsv, np.array([0, 0, 180]), np.array([180, 40, 255]))
        # 橙色天空（日落）
        mask_orange = cv2.inRange(hsv, np.array([5, 50, 80]), np.array([25, 255, 255]))
        # 夜空
        mask_night = cv2.inRange(hsv, np.array([100, 10, 10]), np.array([140, 100, 80]))

        mask_color = np.maximum(np.maximum(mask_blue, mask_white), np.maximum(mask_orange, mask_night))

        # 策略2: 边缘密度（天空区域边缘少）
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        edge_density = cv2.blur(edges.astype(np.float32), (50, 50))
        mask_edges = (edge_density < 10).astype(np.uint8) * 255

        # 策略3: 位置先验（上方更可能是天空）
        position_weight = np.zeros((h, w), dtype=np.float32)
        for i in range(h):
            position_weight[i, :] = np.clip(1.0 - (i / max(h, 1)) * 1.8, 0, 1)

        # 融合三种策略
        mask_combined = (
            mask_color.astype(np.float32) * 0.5 +
            mask_edges.astype(np.float32) * 0.2 +
            position_weight * 255 * 0.3
        )
        mask = (mask_combined > 100).astype(np.uint8) * 255

        # 形态学清理
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        # 保留最大连通区域
        n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
        if n_labels > 1:
            best_label = 0
            best_score = 0
            for i in range(1, n_labels):
                area = stats[i, cv2.CC_STAT_AREA]
                cy = stats[i, cv2.CC_STAT_TOP]
                score = area * (1.0 - cy / max(h, 1))
                if score > best_score:
                    best_score = score
                    best_label = i
            if best_label > 0:
                mask = ((labels == best_label) * 255).astype(np.uint8)

        # 边缘羽化
        if np.count_nonzero(mask) > 0:
            mask = cv2.GaussianBlur(mask, (31, 31), 0)
            return [mask]
        return []

    # ──────────────────────────────────────────
    # 肤色检测
    # ──────────────────────────────────────────

    def detect_skin(self, image: np.ndarray) -> np.ndarray:
        """肤色检测 (YCrCb + HSV 双空间)"""
        if image is None:
            return np.zeros((256, 256), dtype=np.uint8)

        ycrcb = cv2.cvtColor(image, cv2.COLOR_BGR2YCrCb)
        mask1 = cv2.inRange(ycrcb, np.array([0, 125, 70]), np.array([255, 180, 135]))

        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        mask2 = cv2.inRange(hsv, np.array([0, 15, 50]), np.array([25, 255, 255]))
        mask3 = cv2.inRange(hsv, np.array([160, 15, 50]), np.array([180, 255, 255]))

        mask = np.maximum(mask1, np.maximum(mask2, mask3))

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        return mask

    # ──────────────────────────────────────────
    # 牙齿检测
    # ──────────────────────────────────────────

    def detect_teeth(self, image: np.ndarray) -> np.ndarray:
        """牙齿检测 - 基于亮度+人脸区域启发式"""
        if image is None:
            return np.zeros((256, 256), dtype=np.uint8)

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        h, w = image.shape[:2]

        # 牙齿是明亮、低饱和度的区域
        _, bright = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)

        # 聚焦图像中下部（嘴巴所在区域）
        region_mask = np.zeros((h, w), dtype=np.uint8)
        region_mask[h//3:h*2//3, w//4:w*3//4] = 255

        mask = cv2.bitwise_and(bright, region_mask)

        # 清理噪点
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        return mask

    # ──────────────────────────────────────────
    # 草地/地面检测
    # ──────────────────────────────────────────

    def detect_ground(self, image: np.ndarray) -> np.ndarray:
        """草地/地面检测"""
        if image is None:
            return np.zeros((256, 256), dtype=np.uint8)

        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        h, w = image.shape[:2]

        # 绿色/棕色地面
        lower_green = np.array([25, 20, 20])
        upper_green = np.array([85, 255, 255])
        mask_green = cv2.inRange(hsv, lower_green, upper_green)

        lower_brown = np.array([10, 30, 20])
        upper_brown = np.array([25, 255, 200])
        mask_brown = cv2.inRange(hsv, lower_brown, upper_brown)

        mask = cv2.bitwise_or(mask_green, mask_brown)

        # 地面通常在图像下方
        weight = np.zeros((h, w), dtype=np.float32)
        for i in range(h):
            weight[i, :] = max(0, (i / max(h, 1)) - 0.3) / 0.7
        mask = (mask.astype(np.float32) * weight).astype(np.uint8)

        _, mask = cv2.threshold(mask, 50, 255, cv2.THRESH_BINARY)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        return mask

    # ──────────────────────────────────────────
    # 通用检测
    # ──────────────────────────────────────────

    def auto_detect_all(self, image: np.ndarray) -> list[np.ndarray]:
        """检测所有显著物体"""
        if image is None:
            return []

        h, w = image.shape[:2]
        mask = np.zeros((h, w), np.uint8)
        bgd_model = np.zeros((1, 65), np.float64)
        fgd_model = np.zeros((1, 65), np.float64)

        rect = (10, 10, w - 20, h - 20)
        try:
            cv2.grabCut(image, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)
            fg_mask = np.where(
                (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0
            ).astype(np.uint8)
        except cv2.error:
            fg_mask = np.zeros((h, w), dtype=np.uint8)
            fg_mask[h//4:3*h//4, w//4:3*w//4] = 255

        return self._split_connected_regions(fg_mask, min_area=5000)

    # ──────────────────────────────────────────
    # 工具方法
    # ──────────────────────────────────────────

    def _split_connected_regions(self, mask: np.ndarray, min_area: int = 1000) -> list[np.ndarray]:
        """将掩码拆分为独立连通区域"""
        if mask is None or np.count_nonzero(mask) == 0:
            return []

        n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
        regions = []
        for i in range(1, n_labels):
            area = stats[i, cv2.CC_STAT_AREA]
            if area >= min_area:
                region = ((labels == i) * 255).astype(np.uint8)
                kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
                region = cv2.morphologyEx(region, cv2.MORPH_CLOSE, kernel, iterations=2)
                regions.append(region)
        return regions

    def unload(self):
        """卸载模型释放资源"""
        self._sam = None
        self._mp_segmenter = None
        self.model_type = "cv"
        print("[Segmentation] model unloaded")