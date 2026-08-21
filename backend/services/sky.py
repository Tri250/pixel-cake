"""
Sky Service - AI天空替换
基于天空分割 + 图像融合 + 颜色迁移
支持 6 种预设: sunset、blue、cloudy、starry、golden_hour、overcast
技术流程: 天空分割 → 渐变生成 → LAB 颜色迁移 → 羽化融合 → 大气透视
"""

import numpy as np
import cv2
from pathlib import Path


class SkyService:
    """天空替换服务"""

    # 内置天空素材（渐变色模拟，BGR 格式）
    # 颜色顺序: 从上到下 / 从左到右
    SKY_PRESETS = {
        "sunset": {
            "colors": [
                (20, 10, 60),    # 顶部深紫/深蓝 (BGR)
                (80, 60, 200),   # 中间橙红
                (40, 120, 255),  # 底部金橙
                (100, 200, 255), # 地平线金黄
            ],
            "direction": "vertical",
        },
        "blue": {
            "colors": [
                (255, 100, 50),  # 顶部深蓝 (BGR)
                (255, 180, 100), # 中间天蓝
                (235, 206, 135), # 底部浅蓝
                (200, 230, 180), # 地平线淡蓝
            ],
            "direction": "vertical",
        },
        "cloudy": {
            "colors": [
                (200, 200, 210), # 顶部灰白
                (190, 190, 200), # 中间灰白
                (170, 170, 180), # 底部暗灰
                (150, 150, 160), # 地平线更暗
            ],
            "direction": "vertical",
        },
        "starry": {
            "colors": [
                (15, 5, 10),     # 顶部深黑 (BGR)
                (25, 10, 15),    # 中间深蓝黑
                (35, 15, 25),    # 底部深紫黑
                (50, 25, 40),    # 地平线微弱亮
            ],
            "direction": "vertical",
            "stars": True,
        },
        "golden_hour": {
            "colors": [
                (90, 120, 200),  # 顶部暖蓝 (BGR)
                (60, 150, 240),  # 中间金黄
                (40, 180, 255),  # 底部金橙
                (80, 220, 255),  # 地平线亮金
            ],
            "direction": "vertical",
        },
        "overcast": {
            "colors": [
                (170, 170, 180), # 顶部阴灰
                (160, 160, 170), # 中间阴灰
                (150, 150, 160), # 底部更暗
                (140, 140, 150), # 地平线最暗
            ],
            "direction": "vertical",
        },
    }

    def __init__(self):
        self._sky_masks_dir = Path("assets/sky_masks")
        self._sky_images_dir = Path("assets/sky_images")
        self._sky_masks_dir.mkdir(parents=True, exist_ok=True)
        self._sky_images_dir.mkdir(parents=True, exist_ok=True)

    def replace(
        self,
        image: np.ndarray,
        sky_type: str = "sunset",
        sky_image: np.ndarray = None,
        blend: float = 0.7,
    ) -> np.ndarray:
        """
        替换天空

        Args:
            image: 输入图像 (BGR)
            sky_type: 天空类型
            sky_image: 自定义天空图片 (BGR)
            blend: 融合强度 0-1

        Returns:
            替换后的图像 (BGR)
        """
        if image is None:
            return image

        h, w = image.shape[:2]

        # 1. 分割天空
        sky_mask = self._detect_sky(image)
        if np.count_nonzero(sky_mask) == 0:
            return image  # 未检测到天空

        # 2. 生成/加载天空
        if sky_image is not None:
            sky = cv2.resize(sky_image, (w, h))
        else:
            sky = self._generate_sky(w, h, sky_type)

        # 3. LAB 颜色迁移使天空与环境协调
        sky = self._color_transfer(image, sky, sky_mask)

        # 4. 羽化融合
        result = self._blend(image, sky, sky_mask, blend)

        # 5. 添加大气透视效果
        result = self._add_atmosphere(result, sky_mask)

        return result

    def _detect_sky(self, image: np.ndarray) -> np.ndarray:
        """天空检测（多种策略融合：HSV颜色 + 边缘密度 + 位置先验）"""
        h, w = image.shape[:2]

        # 策略1: HSV颜色检测
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)

        # 蓝色天空
        mask_blue = cv2.inRange(hsv, np.array([90, 30, 80]), np.array([130, 255, 255]))
        # 白色/灰色天空（阴天）
        mask_white = cv2.inRange(hsv, np.array([0, 0, 180]), np.array([180, 40, 255]))
        # 橙色天空（日落）
        mask_sunset = cv2.inRange(hsv, np.array([0, 30, 100]), np.array([30, 255, 255]))
        # 夜空
        mask_night = cv2.inRange(hsv, np.array([100, 10, 10]), np.array([140, 100, 80]))

        mask_color = np.maximum(np.maximum(mask_blue, mask_white),
                                 np.maximum(mask_sunset, mask_night))

        # 策略2: 边缘密度（天空区域边缘少）
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        edge_density = cv2.blur(edges.astype(np.float32), (50, 50))
        mask_edges = (edge_density < 10).astype(np.uint8) * 255

        # 策略3: 位置先验（上方更可能是天空）- 向量化
        y_coords = np.arange(h, dtype=np.float32).reshape(-1, 1)
        position_weight = np.clip(1.0 - (y_coords / max(h, 1)) * 1.8, 0, 1)
        position_weight = np.broadcast_to(position_weight, (h, w))

        # 融合
        mask_combined = (
            mask_color.astype(np.float32) * 0.5 +
            mask_edges.astype(np.float32) * 0.2 +
            position_weight * 255.0 * 0.3
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
        mask = cv2.GaussianBlur(mask, (31, 31), 0)
        return mask

    def _generate_sky(self, w: int, h: int, sky_type: str) -> np.ndarray:
        """生成天空图像 - 向量化渐变 (BGR)"""
        preset = self.SKY_PRESETS.get(sky_type, self.SKY_PRESETS["blue"])
        colors = np.array(preset["colors"], dtype=np.float32)  # (N, 3) BGR
        direction = preset["direction"]
        n_colors = len(colors)

        if direction == "vertical":
            # 向量化生成垂直渐变
            t = np.linspace(0, 1, h, dtype=np.float32)
            idx = t * (n_colors - 1)
            idx_int = np.floor(idx).astype(np.int32)
            idx_int = np.clip(idx_int, 0, n_colors - 2)
            local_t = idx - idx_int

            c0 = colors[idx_int]       # (h, 3)
            c1 = colors[idx_int + 1]   # (h, 3)
            sky = (c0 * (1 - local_t[:, None]) + c1 * local_t[:, None])
            sky = np.clip(sky, 0, 255).astype(np.uint8)
            sky = np.tile(sky[:, np.newaxis, :], (1, w, 1))  # (h, w, 3)
        else:
            # 向量化生成水平渐变
            t = np.linspace(0, 1, w, dtype=np.float32)
            idx = t * (n_colors - 1)
            idx_int = np.floor(idx).astype(np.int32)
            idx_int = np.clip(idx_int, 0, n_colors - 2)
            local_t = idx - idx_int

            c0 = colors[idx_int]       # (w, 3)
            c1 = colors[idx_int + 1]   # (w, 3)
            sky = (c0 * (1 - local_t[:, None]) + c1 * local_t[:, None])
            sky = np.clip(sky, 0, 255).astype(np.uint8)
            sky = np.tile(sky[np.newaxis, :, :], (h, 1, 3))  # (h, w, 3)

        # 添加星星
        if preset.get("stars"):
            rng = np.random.default_rng(42)
            n_stars = max((w * h) // 500, 10)
            star_coords = rng.integers(0, w, size=n_stars)
            star_rows = rng.integers(0, h // 2, size=n_stars)
            brightness = rng.integers(180, 255, size=n_stars)
            sizes = rng.choice([1, 1, 1, 2], size=n_stars)

            for x, y, b, s in zip(star_coords, star_rows, brightness, sizes):
                cv2.circle(sky, (int(x), int(y)), int(s), (int(b), int(b), int(b)), -1)

        return sky

    def _color_transfer(self, source: np.ndarray, target: np.ndarray,
                        mask: np.ndarray) -> np.ndarray:
        """颜色迁移 - LAB 空间向量化均值方差匹配"""
        inv_mask = cv2.bitwise_not(mask)
        if np.count_nonzero(inv_mask) == 0:
            return target

        source_lab = cv2.cvtColor(source, cv2.COLOR_BGR2LAB).astype(np.float32)
        target_lab = cv2.cvtColor(target, cv2.COLOR_BGR2LAB).astype(np.float32)

        # 向量化计算源图像统计量（仅非天空区域）
        mask_bool = inv_mask > 0
        if np.count_nonzero(mask_bool) < 100:
            return target

        for i in range(3):
            src_channel = source_lab[:, :, i]
            tgt_channel = target_lab[:, :, i]

            src_mean = np.mean(src_channel[mask_bool])
            src_std = np.std(src_channel[mask_bool])
            tgt_mean = np.mean(tgt_channel)
            tgt_std = np.std(tgt_channel)

            if tgt_std > 1:
                # 温和的颜色迁移，避免剧烈变化
                ratio = np.clip(src_std / tgt_std * 0.3 + 0.7, 0.5, 2.0)
                target_lab[:, :, i] = (
                    (tgt_channel - tgt_mean) * ratio +
                    (tgt_mean * 0.5 + src_mean * 0.5)
                )

        result = cv2.cvtColor(
            np.clip(target_lab, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR
        )
        return result

    def _blend(
        self,
        image: np.ndarray,
        sky: np.ndarray,
        mask: np.ndarray,
        strength: float,
    ) -> np.ndarray:
        """羽化融合"""
        mask_norm = mask.astype(np.float32) / 255.0 * strength
        mask_3ch = np.stack([mask_norm] * 3, axis=-1)

        result = (image.astype(np.float32) * (1 - mask_3ch) +
                  sky.astype(np.float32) * mask_3ch)
        return np.clip(result, 0, 255).astype(np.uint8)

    def _add_atmosphere(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """添加大气透视效果（远景雾化 + 颜色过渡）"""
        h, w = image.shape[:2]
        mask_blur = mask.astype(np.float32) / 255.0

        # 创建与图像匹配的雾色（基于天空区域平均色）
        sky_region = mask_blur > 0.5
        if np.count_nonzero(sky_region) > 0:
            # 使用天空区域的平均色作为雾色
            fog_color = np.mean(image[sky_region], axis=0).astype(np.float32)
            # 限制雾色不要太极端
            fog_color = np.clip(fog_color, 100, 255)
        else:
            fog_color = np.array([220, 220, 220], dtype=np.float32)

        # 垂直渐变雾（上方雾更浓，下方更淡）
        y_coords = np.arange(h, dtype=np.float32).reshape(-1, 1)
        vertical_grad = np.clip(y_coords / max(h, 1), 0, 1)
        vertical_grad = np.broadcast_to(vertical_grad, (h, w))

        # 只在天空边界附近添加雾化（使用蒙版边缘渐变）
        fog_weight = mask_blur * vertical_grad * 0.05  # 轻微雾化

        fog_3ch = np.stack([fog_weight] * 3, axis=-1)
        result = image.astype(np.float32) * (1 - fog_3ch) + fog_color * fog_3ch
        return np.clip(result, 0, 255).astype(np.uint8)