"""
Enhance Service - 图像增强与调色
包含：16 参数基础调色、9 款滤镜预设、AI追色2.0、中性灰磨皮、局部调色、
     4 种补光模式、3D 美型、发丝处理、妆容调整
"""

import os
import numpy as np
import cv2
from typing import Optional


class EnhanceService:
    """图像增强服务"""

    # ─── 内置滤镜预设（全参数支持） ───
    FILTER_PRESETS = {
        "青木胶片": {
            "brightness": 0.05, "contrast": 0.1, "saturation": -0.15,
            "warmth": -0.1, "tint": 0.0, "vibrance": -0.1,
            "tint_shift": [0, -10, 5], "vignette": 0.3,
            "clarity": -0.1, "grain": 0.1,
        },
        "暖咖画报": {
            "brightness": 0.08, "contrast": 0.15, "saturation": 0.05,
            "warmth": 0.25, "tint": 0.0, "vibrance": 0.05,
            "tint_shift": [10, 15, -5], "vignette": 0.2,
            "clarity": 0.1, "grain": 0.05,
        },
        "日系清新": {
            "brightness": 0.12, "contrast": -0.05, "saturation": -0.05,
            "warmth": -0.05, "tint": 0.05, "vibrance": 0.1,
            "tint_shift": [-5, 5, 10], "vignette": 0.0,
            "clarity": 0.05, "grain": 0.0,
        },
        "复古胶片": {
            "brightness": -0.05, "contrast": 0.2, "saturation": -0.2,
            "warmth": 0.15, "tint": -0.05, "vibrance": -0.15,
            "tint_shift": [15, 10, -10], "vignette": 0.4,
            "clarity": 0.15, "grain": 0.15,
        },
        "森系自然": {
            "brightness": 0.05, "contrast": 0.05, "saturation": 0.1,
            "warmth": 0.05, "tint": -0.05, "vibrance": 0.05,
            "tint_shift": [-10, 5, -5], "vignette": 0.1,
            "clarity": 0.05, "grain": 0.05,
        },
        "赛博朋克": {
            "brightness": -0.1, "contrast": 0.3, "saturation": 0.4,
            "warmth": -0.2, "tint": 0.15, "vibrance": 0.3,
            "tint_shift": [-20, 10, 30], "vignette": 0.5,
            "clarity": 0.3, "grain": 0.1,
        },
        "莫兰迪": {
            "brightness": 0.05, "contrast": -0.1, "saturation": -0.3,
            "warmth": 0.05, "tint": 0.0, "vibrance": -0.2,
            "tint_shift": [5, 5, 5], "vignette": 0.1,
            "clarity": -0.05, "grain": 0.05,
        },
        "哈苏色彩": {
            "brightness": 0.03, "contrast": 0.08, "saturation": 0.05,
            "warmth": 0.02, "tint": 0.02, "vibrance": 0.05,
            "tint_shift": [2, 3, 5], "vignette": 0.15,
            "clarity": 0.05, "grain": 0.0,
        },
        "徕卡色调": {
            "brightness": -0.03, "contrast": 0.18, "saturation": -0.1,
            "warmth": 0.08, "tint": -0.03, "vibrance": -0.05,
            "tint_shift": [8, -3, -5], "vignette": 0.35,
            "clarity": 0.15, "grain": 0.08,
        },
    }

    def __init__(self):
        pass

    # ──────────────────────────────────────────
    # 基础调色 (16 参数, Lightroom 风格)
    # ──────────────────────────────────────────

    def adjust(
        self,
        image: np.ndarray,
        brightness: float = 0.0,
        contrast: float = 0.0,
        saturation: float = 0.0,
        warmth: float = 0.0,
        sharpness: float = 0.0,
        denoise: float = 0.0,
        highlights: float = 0.0,
        shadows: float = 0.0,
        whites: float = 0.0,
        blacks: float = 0.0,
        tint: float = 0.0,
        vibrance: float = 0.0,
        clarity: float = 0.0,
    ) -> np.ndarray:
        """
        全面色彩调整

        参数范围: brightness/contrast/saturation/warmth/highlights/shadows/
                  whites/blacks/tint/vibrance/clarity: -1.0~1.0
                 sharpness: 0~1.0
                 denoise: 0~1.0
        """
        if image is None:
            return image

        result = image.astype(np.float32)

        # 亮度
        if abs(brightness) > 0.001:
            result = np.clip(result + brightness * 255, 0, 255)

        # 对比度
        if abs(contrast) > 0.001:
            factor = 1.0 + contrast
            mean = np.mean(result)
            result = np.clip((result - mean) * factor + mean, 0, 255)

        # 高光 / 阴影
        if abs(highlights) > 0.001 or abs(shadows) > 0.001:
            gray = cv2.cvtColor(
                np.clip(result, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY
            ).astype(np.float32)
            highlight_mask = np.clip((gray - 128) / 127, 0, 1)
            shadow_mask = np.clip((128 - gray) / 128, 0, 1)

            for c in range(3):
                result[:, :, c] = np.clip(
                    result[:, :, c] + highlight_mask * highlights * 80 -
                    shadow_mask * shadows * 80,
                    0, 255
                )

        # 白色色阶
        if abs(whites) > 0.001:
            result = np.clip(result + whites * 50, 0, 255)

        # 黑色色阶
        if abs(blacks) > 0.001:
            result = np.clip(result + blacks * 30, 0, 255)

        # 饱和度 + Vibrance
        if abs(saturation) > 0.001 or abs(vibrance) > 0.001:
            hsv = cv2.cvtColor(
                np.clip(result, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV
            ).astype(np.float32)
            hsv[:, :, 1] = hsv[:, :, 1] * (1.0 + saturation)
            if abs(vibrance) > 0.001:
                sat_norm = hsv[:, :, 1] / 255.0
                vibrance_mask = 1.0 - sat_norm
                hsv[:, :, 1] = np.clip(
                    hsv[:, :, 1] + vibrance * vibrance_mask * 100, 0, 255
                )
            hsv[:, :, 1] = np.clip(hsv[:, :, 1], 0, 255)
            result = cv2.cvtColor(
                hsv.astype(np.uint8), cv2.COLOR_HSV2BGR
            ).astype(np.float32)

        # 色温 (暖→红增加蓝减少)
        if abs(warmth) > 0.001:
            result[:, :, 2] = np.clip(result[:, :, 2] + warmth * 30, 0, 255)
            result[:, :, 0] = np.clip(result[:, :, 0] - warmth * 20, 0, 255)

        # 色调偏移 (G 通道)
        if abs(tint) > 0.001:
            result[:, :, 1] = np.clip(result[:, :, 1] + tint * 20, 0, 255)

        # 锐化
        if sharpness > 0.001:
            result = self._sharpen(result, sharpness)

        # 去噪
        if denoise > 0.001:
            h_param = int(denoise * 15) + 3
            result_uint8 = np.clip(result, 0, 255).astype(np.uint8)
            result = cv2.fastNlMeansDenoisingColored(
                result_uint8, None, h_param, h_param, 7, 21
            ).astype(np.float32)

        # 清晰度 (Clarity)
        if abs(clarity) > 0.001:
            result = self._apply_clarity(result, clarity)

        return np.clip(result, 0, 255).astype(np.uint8)

    def _sharpen(self, image: np.ndarray, amount: float) -> np.ndarray:
        """USM 锐化"""
        blurred = cv2.GaussianBlur(image, (0, 0), 3)
        sharpened = image + (image - blurred) * amount * 3
        return np.clip(sharpened, 0, 255)

    def _apply_clarity(self, image: np.ndarray, amount: float) -> np.ndarray:
        """清晰度调整（中频增强）"""
        low_freq = cv2.GaussianBlur(image, (0, 0), 15)
        mid_freq = image - low_freq
        result = image + mid_freq * amount * 2
        return np.clip(result, 0, 255)

    # ──────────────────────────────────────────
    # 滤镜预设 (全参数支持)
    # ──────────────────────────────────────────

    def apply_filter(self, image: np.ndarray, filter_name: str,
                     intensity: float = 1.0) -> np.ndarray:
        """应用滤镜预设 - 使用所有参数（含 tint_shift, vignette, grain）"""
        if image is None:
            return image

        preset = self.FILTER_PRESETS.get(filter_name)
        if not preset:
            return image

        # 基础调色 - 传递所有可用参数
        result = self.adjust(
            image,
            brightness=preset.get("brightness", 0) * intensity,
            contrast=preset.get("contrast", 0) * intensity,
            saturation=preset.get("saturation", 0) * intensity,
            warmth=preset.get("warmth", 0) * intensity,
            tint=preset.get("tint", 0) * intensity,
            vibrance=preset.get("vibrance", 0) * intensity,
            clarity=preset.get("clarity", 0) * intensity,
            highlights=preset.get("highlights", 0) * intensity,
            shadows=preset.get("shadows", 0) * intensity,
            whites=preset.get("whites", 0) * intensity,
            blacks=preset.get("blacks", 0) * intensity,
        )

        # 色调偏移 (tint_shift)
        tint_shift = preset.get("tint_shift")
        if tint_shift:
            b_shift, g_shift, r_shift = [v * intensity for v in tint_shift]
            result = result.astype(np.float32)
            result[:, :, 0] = np.clip(result[:, :, 0] + b_shift, 0, 255)
            result[:, :, 1] = np.clip(result[:, :, 1] + g_shift, 0, 255)
            result[:, :, 2] = np.clip(result[:, :, 2] + r_shift, 0, 255)
            result = result.clip(0, 255).astype(np.uint8)

        # 暗角 (Vignette)
        vignette = preset.get("vignette", 0)
        if vignette > 0:
            h, w = result.shape[:2]
            Y, X = np.ogrid[:h, :w]
            cx, cy = w / 2, h / 2
            dist = np.sqrt((X - cx) ** 2 + (Y - cy) ** 2) / (max(w, h) / 2)
            vignette_mask = 1.0 - vignette * intensity * np.clip(dist, 0, 1)
            mask_3ch = np.stack([vignette_mask] * 3, axis=-1)
            result = (result.astype(np.float32) * mask_3ch).clip(0, 255).astype(np.uint8)

        # 胶片颗粒 (Grain)
        grain = preset.get("grain", 0)
        if grain > 0:
            result = self._add_grain(result, grain * intensity)

        return result

    def _add_grain(self, image: np.ndarray, amount: float) -> np.ndarray:
        """添加胶片颗粒"""
        h, w = image.shape[:2]
        noise = np.random.normal(0, amount * 25, (h, w, 3)).astype(np.float32)
        result = image.astype(np.float32) + noise
        # 颗粒只在中暗部可见
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        grain_mask = np.clip(1.0 - gray * 0.5, 0, 1)
        grain_mask_3ch = np.stack([grain_mask] * 3, axis=-1)
        result = image.astype(np.float32) + noise * grain_mask_3ch
        return np.clip(result, 0, 255).astype(np.uint8)

    def get_filters(self) -> dict:
        """获取所有可用滤镜"""
        return {name: list(params.keys()) for name, params in self.FILTER_PRESETS.items()}

    # ──────────────────────────────────────────
    # AI 追色 2.0 (LAB 均值方差 + 直方图规定化 + 对比度迁移)
    # ──────────────────────────────────────────

    def color_match(self, source: np.ndarray,
                    reference: np.ndarray) -> np.ndarray:
        """AI追色 - LAB 空间均值方差匹配"""
        if source is None or reference is None:
            return source

        src_lab = cv2.cvtColor(source, cv2.COLOR_BGR2LAB).astype(np.float32)
        ref_lab = cv2.cvtColor(reference, cv2.COLOR_BGR2LAB).astype(np.float32)

        for i in range(3):
            src_mean, src_std = src_lab[:, :, i].mean(), src_lab[:, :, i].std()
            ref_mean, ref_std = ref_lab[:, :, i].mean(), ref_lab[:, :, i].std()
            if src_std > 0 and ref_std > 0:
                src_lab[:, :, i] = (
                    (src_lab[:, :, i] - src_mean) * (ref_std / src_std) + ref_mean
                )

        result = cv2.cvtColor(
            src_lab.clip(0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR
        )
        return result

    def color_match_advanced(self, source: np.ndarray,
                              reference: np.ndarray) -> np.ndarray:
        """高级 AI 追色 2.0 - LAB + 直方图规定化 + 对比度迁移 + 暗部保留"""
        if source is None or reference is None:
            return source

        # 1. 基础颜色匹配
        result = self.color_match(source, reference)

        # 2. 直方图规定化 (每个通道)
        for c in range(3):
            result[:, :, c] = self._match_histogram(
                result[:, :, c].astype(np.uint8),
                reference[:, :, c]
            )

        # 3. 对比度迁移
        src_contrast = np.std(
            cv2.cvtColor(source, cv2.COLOR_BGR2GRAY).astype(np.float32)
        )
        ref_contrast = np.std(
            cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY).astype(np.float32)
        )
        if src_contrast > 0 and ref_contrast > 0:
            contrast_ratio = np.clip(ref_contrast / src_contrast, 0.5, 2.0)
            mean = np.mean(result.astype(np.float32))
            result = ((result.astype(np.float32) - mean) * contrast_ratio +
                      mean).clip(0, 255).astype(np.uint8)

        # 4. 局部细节保留 (暗部保留原图纹理)
        result_lab = cv2.cvtColor(result, cv2.COLOR_BGR2LAB)
        src_lab = cv2.cvtColor(source, cv2.COLOR_BGR2LAB)
        l_channel = result_lab[:, :, 0].astype(np.float32)
        dark_mask = np.clip(1.0 - l_channel / 100, 0, 1)
        for c in range(3):
            result_lab[:, :, c] = (
                result_lab[:, :, c].astype(np.float32) * (1 - dark_mask * 0.3) +
                src_lab[:, :, c].astype(np.float32) * (dark_mask * 0.3)
            )
        result = cv2.cvtColor(
            result_lab.clip(0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR
        )

        return result

    def _match_histogram(self, source: np.ndarray,
                         reference: np.ndarray) -> np.ndarray:
        """直方图匹配 (使用 LUT 加速)"""
        src_hist, _ = np.histogram(source.flatten(), 256, [0, 256])
        ref_hist, _ = np.histogram(reference.flatten(), 256, [0, 256])

        src_cdf = np.cumsum(src_hist).astype(np.float32)
        ref_cdf = np.cumsum(ref_hist).astype(np.float32)

        if src_cdf[-1] == 0 or ref_cdf[-1] == 0:
            return source

        src_cdf /= src_cdf[-1]
        ref_cdf /= ref_cdf[-1]

        # 构建 LUT
        lut = np.zeros(256, dtype=np.uint8)
        for i in range(256):
            lut[i] = np.searchsorted(ref_cdf, src_cdf[i])

        return lut[source]

    # ──────────────────────────────────────────
    # 局部调色
    # ──────────────────────────────────────────

    def local_adjust(
        self,
        image: np.ndarray,
        mask: np.ndarray,
        brightness: float = 0.0,
        contrast: float = 0.0,
        saturation: float = 0.0,
        warmth: float = 0.0,
    ) -> np.ndarray:
        """基于掩码的局部调色"""
        if image is None or mask is None:
            return image

        adjusted = self.adjust(
            image, brightness=brightness, contrast=contrast,
            saturation=saturation, warmth=warmth
        )
        mask_blur = cv2.GaussianBlur(mask, (21, 21), 0).astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_blur] * 3, axis=-1)
        result = image.astype(np.float32) * (1 - mask_3ch) + \
                 adjusted.astype(np.float32) * mask_3ch
        return result.clip(0, 255).astype(np.uint8)

    # ──────────────────────────────────────────
    # 补光 (4 种模式)
    # ──────────────────────────────────────────

    def relight(
        self,
        image: np.ndarray,
        brightness: float = 0.3,
        warmth: float = 0.1,
        direction: str = "natural",
    ) -> np.ndarray:
        """AI 补光: natural / dramatic / soft / backlight"""
        if image is None:
            return image

        h, w = image.shape[:2]

        if direction == "natural":
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
            shadow_weight = np.clip(1.0 - gray * 2, 0, 1)
            result = image.astype(np.float32)
            for c in range(3):
                result[:, :, c] += shadow_weight * brightness * 150
            result = np.clip(result, 0, 255).astype(np.uint8)

        elif direction == "dramatic":
            result = self.adjust(
                image, brightness=brightness * 0.5,
                contrast=0.3, clarity=0.4
            )

        elif direction == "soft":
            result = self.adjust(
                image, brightness=brightness,
                contrast=-0.1, denoise=0.3
            )

        elif direction == "backlight":
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
            shadow_mask = np.clip(1.0 - gray * 1.5, 0, 1)
            result = image.astype(np.float32)
            for c in range(3):
                result[:, :, c] += shadow_mask * brightness * 200
            result = np.clip(result, 0, 255).astype(np.uint8)
            result = cv2.fastNlMeansDenoisingColored(
                result, None, 10, 10, 7, 21
            )
        else:
            result = image.copy()

        if abs(warmth) > 0.001:
            result = self.adjust(result, warmth=warmth)

        return result

    # ──────────────────────────────────────────
    # 中性灰磨皮
    # ──────────────────────────────────────────

    def skin_smooth(
        self,
        image: np.ndarray,
        skin_mask: Optional[np.ndarray] = None,
        strength: float = 0.5,
        preserve_texture: float = 0.6,
    ) -> np.ndarray:
        """中性灰磨皮 - 光影分离 + 双边滤波保边 + 纹理保留 (性能优化版)"""
        if image is None:
            return image

        h, w = image.shape[:2]

        if skin_mask is None:
            skin_mask = self._detect_skin(image)

        has_skin = cv2.countNonZero(skin_mask) > (h * w * 0.005)
        if not has_skin:
            skin_mask = np.ones((h, w), dtype=np.uint8) * 255

        # 性能优化: 大图下采样处理后再放大
        max_dim = 1280
        scale = min(1.0, max_dim / max(h, w))
        if scale < 1.0:
            img_small = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            mask_small = cv2.resize(skin_mask, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        else:
            img_small = image
            mask_small = skin_mask
            scale = 1.0

        sh, sw = img_small.shape[:2]

        # 双边滤波参数
        d = int(strength * 20) * 2 + 1
        d = min(d, 15)
        sigma_color = strength * 120 + 60
        sigma_space = strength * 120 + 60

        # 分离高频纹理和低频颜色
        smooth = cv2.bilateralFilter(img_small, d, sigma_color, sigma_space)
        texture = cv2.subtract(img_small, smooth)

        # 大尺度光影
        large_scale = cv2.GaussianBlur(smooth, (0, 0), 25)
        detail = cv2.subtract(smooth, large_scale)

        # 清理细节层瑕疵
        detail_blur = cv2.GaussianBlur(detail.astype(np.float32), (7, 7), 0)
        detail_cleaned = cv2.addWeighted(
            detail.astype(np.float32), preserve_texture,
            detail_blur, 1 - preserve_texture, 0
        )

        # 重组
        smooth_cleaned = cv2.add(
            large_scale, detail_cleaned.clip(0, 255).astype(np.uint8)
        )

        # 混合纹理 (在小图上操作)
        if preserve_texture > 0:
            texture_preserved = cv2.addWeighted(
                smooth_cleaned, 1.0, texture, preserve_texture * 0.3, 0
            )
        else:
            texture_preserved = smooth_cleaned

        # 若进行了下采样, 先上采样回原始尺寸
        if scale < 1.0:
            texture_preserved = cv2.resize(texture_preserved, (w, h), interpolation=cv2.INTER_LINEAR)
            skin_mask = cv2.resize(skin_mask, (w, h), interpolation=cv2.INTER_LINEAR)

        # 掩码融合
        mask_norm = skin_mask.astype(np.float32) / 255.0
        mask_3ch = np.stack([mask_norm] * 3, axis=-1)
        result = (image.astype(np.float32) * (1 - mask_3ch) +
                  texture_preserved.astype(np.float32) * mask_3ch)

        return result.clip(0, 255).astype(np.uint8)

    def _detect_skin(self, image: np.ndarray) -> np.ndarray:
        """肤色检测 (YCrCb + HSV 双空间)"""
        if image is None:
            return np.zeros((256, 256), dtype=np.uint8)

        ycrcb = cv2.cvtColor(image, cv2.COLOR_BGR2YCrCb)
        mask1 = cv2.inRange(ycrcb, np.array([0, 125, 70]),
                            np.array([255, 180, 135]))

        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        mask2 = cv2.inRange(hsv, np.array([0, 15, 50]),
                            np.array([25, 255, 255]))
        mask3 = cv2.inRange(hsv, np.array([160, 15, 50]),
                            np.array([180, 255, 255]))

        mask = np.maximum(mask1, np.maximum(mask2, mask3))

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)

        return mask

    # ──────────────────────────────────────────
    # 牙齿美白
    # ──────────────────────────────────────────

    def teeth_whiten(self, image: np.ndarray, mask: np.ndarray,
                     strength: float = 0.5) -> np.ndarray:
        """牙齿美白"""
        if image is None:
            return image

        result = image.astype(np.float32)
        mask_norm = mask.astype(np.float32) / 255.0

        for c in range(3):
            result[:, :, c] += mask_norm * strength * 80
        result[:, :, 2] -= mask_norm * strength * 20
        result[:, :, 1] += mask_norm * strength * 5

        return result.clip(0, 255).astype(np.uint8)

    # ──────────────────────────────────────────
    # 3D 美型 (瘦脸) - 向量化优化版
    # ──────────────────────────────────────────

    def _get_cascade_path(self, filename: str) -> str:
        """获取 Haar cascade 文件路径 - 支持本地 models/cascades 回退"""
        # 优先使用项目本地存储
        local_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "models", "cascades"
        )
        local_path = os.path.join(local_dir, filename)
        if os.path.exists(local_path):
            return local_path
        # 回退到 OpenCV 自带（部分版本可能为空）
        opencv_path = cv2.data.haarcascades + filename
        if os.path.exists(opencv_path):
            return opencv_path
        return ""

    def _detect_faces(self, image: np.ndarray, min_size: int = 60) -> list[tuple]:
        """人脸检测 - 多级回退 (Haar Cascade → 肤色+区域启发式)"""
        if image is None:
            return []

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        h, w = image.shape[:2]

        # 路径 1: Haar Cascade (OpenCV 4.x)
        cascade_path = self._get_cascade_path("haarcascade_frontalface_default.xml")
        if cascade_path and hasattr(cv2, "CascadeClassifier"):
            try:
                cascade = cv2.CascadeClassifier(cascade_path)
                faces = cascade.detectMultiScale(gray, 1.1, 4, minSize=(min_size, min_size))
                faces_list = [(int(x), int(y), int(fw), int(fh)) for (x, y, fw, fh) in faces]
                if len(faces_list) > 0:
                    return faces_list
            except Exception:
                pass

        # 路径 2: OpenCV DNN (readNet 支持 ONNX/TFLite/TensorFlow)
        dnn_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "models", "dnn"
        )
        onnx_path = os.path.join(dnn_dir, "face_detection.onnx")
        if os.path.exists(onnx_path) and hasattr(cv2, "dnn") and hasattr(cv2.dnn, "readNet"):
            try:
                net = cv2.dnn.readNet(onnx_path)
                blob = cv2.dnn.blobFromImage(image, 1.0 / 255, (300, 300), (0, 0, 0), swapRB=True)
                net.setInput(blob)
                output = net.forward()
                # 简化解析: 假设 SSD-like 输出 [1, N, 7] 或 [N, 5]
                faces_list = []
                if output.ndim == 3 and output.shape[-1] >= 7:
                    for det in output[0]:
                        if float(det[1]) > 0.5:
                            x1 = int(max(0, det[2]) * w)
                            y1 = int(max(0, det[3]) * h)
                            x2 = int(min(w, det[4]) * w)
                            y2 = int(min(h, det[5]) * h)
                            if x2 - x1 >= min_size and y2 - y1 >= min_size:
                                faces_list.append((x1, y1, x2 - x1, y2 - y1))
                elif output.ndim == 2 and output.shape[-1] >= 5:
                    for det in output:
                        if float(det[0]) > 0.5:
                            x1 = int(max(0, det[1]) * w)
                            y1 = int(max(0, det[2]) * h)
                            x2 = int(min(w, det[3]) * w)
                            y2 = int(min(h, det[4]) * h)
                            if x2 - x1 >= min_size and y2 - y1 >= min_size:
                                faces_list.append((x1, y1, x2 - x1, y2 - y1))
                if faces_list:
                    return faces_list
            except Exception:
                pass

        # 路径 3: 肤色 + 中心区域启发式 (跨平台兜底)
        skin_mask = self._detect_skin(image)
        if np.count_nonzero(skin_mask) > 0:
            # 找最大肤色连通区域
            num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(skin_mask)
            if num_labels > 1:
                # 最大区域 (跳过背景)
                largest_label = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
                x = int(stats[largest_label, cv2.CC_STAT_LEFT])
                y = int(stats[largest_label, cv2.CC_STAT_TOP])
                fw = int(stats[largest_label, cv2.CC_STAT_WIDTH])
                fh = int(stats[largest_label, cv2.CC_STAT_HEIGHT])
                area_ratio = (fw * fh) / (w * h)
                # 合理人脸面积比: 5%~80%, 排除整个图像都是肤色的情况
                if fw >= min_size // 2 and fh >= min_size // 2 and 0.05 < area_ratio < 0.8:
                    return [(x, y, fw, fh)]

        # 路径 4: 默认中心区域
        cx, cy = w // 2, h // 2
        fw, fh = int(w * 0.3), int(h * 0.4)
        return [(cx - fw // 2, cy - fh // 2, fw, fh)]

    def face_slim(self, image: np.ndarray,
                  strength: float = 0.3) -> np.ndarray:
        """3D 美型 - 瘦脸效果 (向量化优化)"""
        if image is None:
            return image

        h, w = image.shape[:2]

        faces = self._detect_faces(image, min_size=60)

        if len(faces) == 0:
            return image

        result = image.copy()

        for (fx, fy, fw, fh) in faces:
            cx, cy = fx + fw // 2, fy + fh // 2
            cheek_top = fy + int(fh * 0.35)
            cheek_bot = min(h, fy + int(fh * 0.85))
            squeeze = int(fw * strength * 0.15)

            if cheek_bot <= cheek_top or squeeze <= 0:
                continue

            # 向量化挤压：使用 numpy 索引映射
            row_indices = np.arange(cheek_top, cheek_bot)
            row_t = (row_indices - cheek_top) / max(1, cheek_bot - cheek_top)
            bells = (np.sin(row_t * np.pi) * squeeze).astype(np.int32)

            # 左脸颊
            left_start = max(0, fx)
            left_end = min(w, cx)
            left_width = left_end - left_start
            if left_width > squeeze * 2:
                for i, y in enumerate(row_indices):
                    s = bells[i]
                    if s == 0:
                        continue
                    row_data = result[y, left_start:left_end].copy()
                    src_x = np.clip(
                        np.arange(left_width) + s, 0, left_width - 1
                    ).astype(np.int32)
                    result[y, left_start:left_end] = row_data[src_x]

            # 右脸颊
            right_start = max(0, cx)
            right_end = min(w, fx + fw)
            right_width = right_end - right_start
            if right_width > squeeze * 2:
                for i, y in enumerate(row_indices):
                    s = bells[i]
                    if s == 0:
                        continue
                    row_data = result[y, right_start:right_end].copy()
                    src_x = np.clip(
                        np.arange(right_width) - s, 0, right_width - 1
                    ).astype(np.int32)
                    result[y, right_start:right_end] = row_data[src_x]

        # 轻微平滑过渡
        result = cv2.bilateralFilter(result, 5, 50, 50)
        return result

    # ──────────────────────────────────────────
    # 发丝处理
    # ──────────────────────────────────────────

    def hair_smooth(self, image: np.ndarray,
                    strength: float = 0.5) -> np.ndarray:
        """发丝处理 - 祛碎发/毛躁发丝"""
        if image is None:
            return image

        h, w = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # 边缘检测
        edges = cv2.Canny(gray, 30, 100)
        kernel_dilate = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        edges_dilated = cv2.dilate(edges, kernel_dilate, iterations=2)

        # 头发颜色区域
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        dark_hair = cv2.inRange(gray, 0, 100)
        warm_hair = cv2.inRange(hsv, np.array([10, 20, 50]),
                                 np.array([30, 255, 200]))
        black_hair = cv2.inRange(gray, 0, 60)

        hair_mask = np.maximum(dark_hair, np.maximum(warm_hair, black_hair))

        # 碎发 = 边缘 ∩ 头发区域
        flyaway = cv2.bitwise_and(edges_dilated, hair_mask)

        # 保留小面积+细长连通区域
        min_area = max(h * w * 0.0003, 50)
        n_labels, labels, stats, _ = cv2.connectedComponentsWithStats(flyaway)
        flyaway_clean = np.zeros_like(flyaway)
        for i in range(1, n_labels):
            area = stats[i, cv2.CC_STAT_AREA]
            if area < max(h * w * 0.005, 1000):
                flyaway_clean[labels == i] = 255

        if cv2.countNonZero(flyaway_clean) == 0:
            return image

        # 形态学闭运算
        kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        flyaway_mask = cv2.morphologyEx(
            flyaway_clean, cv2.MORPH_CLOSE, kernel_close, iterations=2
        )

        blur_size = int(strength * 20) * 2 + 3
        blurred = cv2.GaussianBlur(image, (blur_size, blur_size), 0)

        mask_3ch = np.stack(
            [flyaway_mask.astype(np.float32) / 255.0 * strength] * 3, axis=-1
        )
        result = (image.astype(np.float32) * (1 - mask_3ch) +
                  blurred.astype(np.float32) * mask_3ch)

        return result.clip(0, 255).astype(np.uint8)

    # ──────────────────────────────────────────
    # 妆容调整
    # ──────────────────────────────────────────

    def apply_makeup(
        self,
        image: np.ndarray,
        lipstick: float = 0.0,
        blush: float = 0.0,
        eyeshadow: float = 0.0,
        lip_color: tuple = (0, 0, 200),
        blush_color: tuple = (100, 100, 230),
        eyeshadow_color: tuple = (120, 50, 50),
    ) -> np.ndarray:
        """妆容调整 - 基于人脸关键点"""
        if image is None:
            return image

        h, w = image.shape[:2]
        result = image.astype(np.float32)

        faces = self._detect_faces(image, min_size=60)

        if len(faces) == 0:
            return image

        # 眼睛位置基于人脸区域估算 (无需单独 cascade)
        # 左眼: 上半脸部左侧 30% 区域，右眼: 上半脸部右侧 30% 区域

        for (fx, fy, fw, fh) in faces:
            # 口红
            if lipstick > 0:
                mouth_x1 = fx + int(fw * 0.3)
                mouth_x2 = fx + int(fw * 0.7)
                mouth_y1 = fy + int(fh * 0.62)
                mouth_y2 = fy + int(fh * 0.78)

                lip_mask = np.zeros((h, w), dtype=np.float32)
                lip_cx = (mouth_x1 + mouth_x2) // 2
                lip_cy = (mouth_y1 + mouth_y2) // 2
                lip_rx = max(1, (mouth_x2 - mouth_x1) // 2)
                lip_ry = max(1, (mouth_y2 - mouth_y1) // 2)
                cv2.ellipse(lip_mask, (lip_cx, lip_cy),
                           (lip_rx, lip_ry), 0, 0, 360, 1.0, -1)
                lip_mask = cv2.GaussianBlur(lip_mask, (15, 15), 0)

                for c in range(3):
                    result[:, :, c] += lip_mask * lip_color[c] * lipstick * 0.5

            # 腮红
            if blush > 0:
                for side in [-1, 1]:
                    cheek_cx = fx + (fw // 4 if side < 0 else fw * 3 // 4)
                    cheek_cy = fy + int(fh * 0.55)
                    cheek_rx = max(1, fw // 6)
                    cheek_ry = max(1, fh // 8)

                    blush_mask = np.zeros((h, w), dtype=np.float32)
                    cv2.ellipse(blush_mask, (cheek_cx, cheek_cy),
                               (cheek_rx, cheek_ry), 0, 0, 360, 1.0, -1)
                    blush_mask = cv2.GaussianBlur(blush_mask, (31, 31), 0)

                    for c in range(3):
                        result[:, :, c] += blush_mask * blush_color[c] * blush * 0.3

            # 眼影 - 使用人脸区域启发式位置 (左/右眼)
            if eyeshadow > 0:
                for side in [-1, 1]:
                    eye_cx = fx + (fw // 3 if side < 0 else fw * 2 // 3)
                    eye_cy = fy + int(fh * 0.35)

                    eye_mask = np.zeros((h, w), dtype=np.float32)
                    cv2.ellipse(eye_mask, (eye_cx, eye_cy),
                               (fw // 8, fh // 12), 0, 0, 360, 1.0, -1)
                    eye_mask = cv2.GaussianBlur(eye_mask, (21, 21), 0)

                    for c in range(3):
                        result[:, :, c] += (
                            eye_mask * eyeshadow_color[c] * eyeshadow * 0.35
                        )

        return result.clip(0, 255).astype(np.uint8)