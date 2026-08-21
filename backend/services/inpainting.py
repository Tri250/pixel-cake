"""
Inpainting Service - AI图像修复
基于 LaMa / Stable Diffusion Inpainting / OpenCV Telea (兜底)
支持：去路人、祛纹身、去胡渣、消除穿帮
特性：支持 prompt 文本引导修复，GPU/CPU 自适应
"""

import numpy as np
import cv2
import gc

# 安全导入可选依赖
HAS_TORCH = False
HAS_PIL = False
torch = None
Image = None

try:
    import torch as _torch
    torch = _torch
    HAS_TORCH = True
except ImportError:
    pass

try:
    from PIL import Image as _Image
    Image = _Image
    HAS_PIL = True
except ImportError:
    pass


def _torch_dtype(is_cuda: bool):
    """安全获取 torch dtype"""
    if not HAS_TORCH:
        return None
    return torch.float16 if is_cuda else torch.float32


class InpaintingService:
    """图像修复服务，支持多种后端模型，带逐级回退"""

    def __init__(self, model_type: str = "lama"):
        """
        Args:
            model_type: 模型类型
                - "lama": LaMa (轻量快速，适合大面积修复)
                - "sd": Stable Diffusion Inpainting (高质量，适合细节)
                - "opencv": OpenCV Telea (兜底，无需GPU)
        """
        self.model_type = model_type
        self.device = "cuda" if (HAS_TORCH and torch.cuda.is_available()) else "cpu"
        self._model = None
        self._loaded = False
        self._load_model()

    def _load_model(self):
        """延迟加载模型，逐级回退"""
        if self.model_type == "opencv":
            self._loaded = True
            return

        if self.model_type == "lama":
            ok = self._load_lama()
            if not ok:
                print("[Inpainting] LaMa failed, falling back to OpenCV Telea")
                self.model_type = "opencv"
                self._loaded = True
                return

        elif self.model_type == "sd":
            ok = self._load_sd()
            if not ok:
                print("[Inpainting] SD failed, falling back to OpenCV Telea")
                self.model_type = "opencv"
                self._loaded = True
                return

        self._loaded = True

    def _load_lama(self) -> bool:
        """加载 LaMa 模型（逐级回退）"""
        if not HAS_TORCH:
            print("[Inpainting] LaMa requires torch, not installed")
            return False

        # 路径1: simple-lama-inpainting 包
        try:
            from simple_lama_inpainting import SimpleLama
            self._model = SimpleLama()
            print("[Inpainting] LaMa (simple-lama) loaded successfully")
            return True
        except ImportError:
            pass
        except Exception as e:
            print(f"[Inpainting] simple-lama-inpainting error: {e}")

        # 路径2: HuggingFace big-lama via diffusers
        try:
            from diffusers import AutoPipelineForInpainting
            dtype = _torch_dtype(self.device == "cuda")
            self._model = AutoPipelineForInpainting.from_pretrained(
                "smartywu/big-lama",
                torch_dtype=dtype,
            ).to(self.device)
            if self.device == "cuda":
                self._model.enable_model_cpu_offload()
            print("[Inpainting] LaMa (HuggingFace) loaded successfully")
            return True
        except ImportError:
            print("[Inpainting] diffusers package not installed")
            return False
        except Exception as e:
            print(f"[Inpainting] LaMa (HuggingFace) load failed: {e}")
            return False

    def _load_sd(self) -> bool:
        """加载 Stable Diffusion Inpainting"""
        if not HAS_TORCH:
            print("[Inpainting] SD requires torch, not installed")
            return False
        try:
            from diffusers import AutoPipelineForInpainting
            dtype = _torch_dtype(self.device == "cuda")
            self._model = AutoPipelineForInpainting.from_pretrained(
                "runwayml/stable-diffusion-inpainting",
                torch_dtype=dtype,
            ).to(self.device)
            if self.device == "cuda":
                self._model.enable_model_cpu_offload()
            print("[Inpainting] SD Inpainting loaded successfully")
            return True
        except ImportError:
            print("[Inpainting] diffusers package not installed")
            return False
        except Exception as e:
            print(f"[Inpainting] SD Inpainting load failed: {e}")
            return False

    def inpaint(
        self,
        image: np.ndarray,
        mask: np.ndarray,
        prompt: str = "",
        negative_prompt: str = "blurry, artifacts, low quality",
        strength: float = 0.8,
        guidance_scale: float = 7.5,
        num_steps: int = 30,
    ) -> np.ndarray:
        """
        执行图像修复

        Args:
            image: 输入图像 (H, W, 3) BGR
            mask: 修复掩码 (H, W) 0-255
            prompt: 文本提示 (SD模式)
            negative_prompt: 负面提示
            strength: 修复强度 0-1
            guidance_scale: CFG引导强度
            num_steps: 推理步数

        Returns:
            修复后的图像 (BGR uint8)
        """
        # 安全检查
        if image is None or mask is None:
            if image is not None:
                return image
            return np.zeros((256, 256, 3), dtype=np.uint8)

        # 确保掩码是单通道
        if len(mask.shape) == 3:
            mask = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)

        # 确保图像是 3 通道 BGR
        if len(image.shape) == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)

        # 确保掩码尺寸与图像匹配
        if mask.shape[:2] != image.shape[:2]:
            mask = cv2.resize(mask, (image.shape[1], image.shape[0]),
                              interpolation=cv2.INTER_NEAREST)

        # 检查掩码是否为空
        if np.count_nonzero(mask) == 0:
            return image.copy()

        # 路由到对应模型
        if self.model_type == "lama" and self._model is not None:
            try:
                result = self._inpaint_lama(image, mask)
                self._cleanup_gpu()
                return result
            except Exception as e:
                print(f"[Inpainting] LaMa inference failed: {e}, falling back to OpenCV")
                self._cleanup_gpu()
                return self._inpaint_opencv(image, mask)

        elif self.model_type == "sd" and self._model is not None:
            try:
                result = self._inpaint_sd(
                    image, mask, prompt, negative_prompt,
                    strength, guidance_scale, num_steps
                )
                self._cleanup_gpu()
                return result
            except Exception as e:
                print(f"[Inpainting] SD inference failed: {e}, falling back to OpenCV")
                self._cleanup_gpu()
                return self._inpaint_opencv(image, mask)

        else:
            return self._inpaint_opencv(image, mask)

    def _inpaint_lama(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """LaMa 修复"""
        if not HAS_PIL:
            return self._inpaint_opencv(image, mask)

        img_pil = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        mask_pil = Image.fromarray(mask)
        result = self._model(img_pil, mask_pil)
        result_np = np.array(result)
        return cv2.cvtColor(result_np, cv2.COLOR_RGB2BGR)

    def _inpaint_sd(
        self,
        image: np.ndarray,
        mask: np.ndarray,
        prompt: str,
        negative_prompt: str,
        strength: float,
        guidance_scale: float,
        num_steps: int,
    ) -> np.ndarray:
        """Stable Diffusion 修复"""
        if not HAS_PIL:
            return self._inpaint_opencv(image, mask)

        # SD inpainting 需要图像尺寸为 8 的倍数
        h, w = image.shape[:2]
        new_h = (h // 8) * 8
        new_w = (w // 8) * 8
        if new_h != h or new_w != w:
            image = cv2.resize(image, (new_w, new_h))
            mask = cv2.resize(mask, (new_w, new_h), interpolation=cv2.INTER_NEAREST)

        img_pil = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
        mask_pil = Image.fromarray(mask)

        if not prompt:
            prompt = "high quality, detailed, seamless background, natural texture"

        # 限制推理步数避免超时
        actual_steps = min(num_steps, 25)

        with torch.no_grad():
            result = self._model(
                prompt=prompt,
                negative_prompt=negative_prompt,
                image=img_pil,
                mask_image=mask_pil,
                strength=strength,
                guidance_scale=guidance_scale,
                num_inference_steps=actual_steps,
            ).images[0]

        result_np = np.array(result)
        result_bgr = cv2.cvtColor(result_np, cv2.COLOR_RGB2BGR)

        # 如果之前调整了尺寸，调整回去
        if new_h != h or new_w != w:
            result_bgr = cv2.resize(result_bgr, (w, h))

        return result_bgr

    def _inpaint_opencv(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """OpenCV 兜底修复 (Telea 算法 + NS 算法双保险)"""
        h, w = image.shape[:2]

        # 膨胀掩码边缘，使过渡更自然
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask_dilated = cv2.dilate(mask, kernel, iterations=2)

        # Telea 修复
        try:
            result = cv2.inpaint(image, mask_dilated, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
        except Exception:
            # 回退到 NS 算法
            try:
                result = cv2.inpaint(image, mask_dilated, inpaintRadius=5, flags=cv2.INPAINT_NS)
            except Exception:
                result = image.copy()

        # 仅在修复区域周围做轻微模糊以柔化边缘
        blurred = cv2.GaussianBlur(result, (3, 3), 0)
        mask_norm = (mask_dilated.astype(np.float32) / 255.0) * 0.3
        mask_3ch = np.stack([mask_norm] * 3, axis=-1)
        result = result.astype(np.float32) * (1 - mask_3ch) + blurred.astype(np.float32) * mask_3ch

        return result.clip(0, 255).astype(np.uint8)

    def batch_inpaint(
        self,
        images: list[np.ndarray],
        masks: list[np.ndarray],
        **kwargs,
    ) -> list[np.ndarray]:
        """批量修复"""
        results = []
        for img, mask in zip(images, masks):
            result = self.inpaint(img, mask, **kwargs)
            results.append(result)
        return results

    def _cleanup_gpu(self):
        """清理 GPU 内存"""
        if HAS_TORCH and self.device == "cuda":
            gc.collect()
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass

    def unload(self):
        """卸载模型释放资源"""
        self._model = None
        self._loaded = False
        self._cleanup_gpu()
        print("[Inpainting] model unloaded")