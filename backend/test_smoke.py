#!/usr/bin/env python3
"""Backend smoke test for CI/CD pipeline."""
import sys
import numpy as np
sys.path.insert(0, '.')
from services.inpainting import InpaintingService
from services.segmentation import SegmentationService
from services.sky import SkyService
from services.enhance import EnhanceService

print('All backend imports successful')

enh = EnhanceService()
seg = SegmentationService()
sky = SkyService()
inp = InpaintingService()

img = np.random.randint(100, 200, (200, 200, 3), dtype=np.uint8)

# Test enhance
assert enh.adjust(img).shape == img.shape
assert enh.apply_filter(img, 'morandi').shape == img.shape
assert enh.color_match(img, img).shape == img.shape
assert enh.skin_smooth(img).shape == img.shape
assert enh.face_slim(img).shape == img.shape
assert enh.hair_smooth(img).shape == img.shape
assert enh.apply_makeup(img, lipstick=0.3).shape == img.shape
assert enh.relight(img).shape == img.shape
assert enh.local_adjust(img, np.ones((200,200), dtype=np.uint8)*128).shape == img.shape

# Test segmentation
masks = seg.auto_detect_people(img)
assert isinstance(masks, list)
sky_masks = seg.auto_detect_sky(img)
assert isinstance(sky_masks, list)

# Test sky
assert sky.replace(img, sky_type='sunset').shape == img.shape

# Test inpainting
mask = np.zeros((200,200), dtype=np.uint8)
mask[50:100, 50:100] = 255
assert inp.inpaint(img, mask, prompt='test').shape == img.shape

print('All backend tests passed!')
