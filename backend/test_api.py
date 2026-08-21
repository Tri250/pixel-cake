#!/usr/bin/env python3
"""API contract test for CI/CD pipeline."""
import requests
import time
import io
import numpy as np
from PIL import Image

time.sleep(1)
BASE = 'http://localhost:8765/api'

# Health check
r = requests.get(f'{BASE}/health')
assert r.status_code == 200, f'Health check failed: {r.status_code}'

# Upload test
img = np.random.randint(100, 200, (200, 200, 3), dtype=np.uint8)
pil_img = Image.fromarray(img[..., ::-1])
buf = io.BytesIO()
pil_img.save(buf, format='JPEG')
buf.seek(0)
r = requests.post(f'{BASE}/upload', files={'file': ('test.jpg', buf, 'image/jpeg')})
assert r.status_code == 200, f'Upload failed: {r.status_code}'
image_id = r.json()['image_id']

# Upload a second image for color-match reference
img2 = np.random.randint(150, 255, (150, 150, 3), dtype=np.uint8)
pil_img2 = Image.fromarray(img2[..., ::-1])
buf2 = io.BytesIO()
pil_img2.save(buf2, format='JPEG')
buf2.seek(0)
r2 = requests.post(f'{BASE}/upload', files={'file': ('ref.jpg', buf2, 'image/jpeg')})
assert r2.status_code == 200, f'Reference upload failed: {r2.status_code}'
ref_image_id = r2.json()['image_id']

# Test form-data endpoints (use data=)
for endpoint, data in [
    ('auto-segment', {'image_id': image_id, 'mode': 'person'}),
    ('face-slim', {'image_id': image_id, 'strength': '0.3'}),
    ('hair-smooth', {'image_id': image_id, 'strength': '0.5'}),
    ('sky/replace', {'image_id': image_id, 'sky_type': 'sunset'}),
    ('relight', {'image_id': image_id, 'mode': 'natural'}),
]:
    r = requests.post(f'{BASE}/{endpoint}', data=data)
    assert r.status_code == 200, f'{endpoint} failed: {r.status_code}'

# Test JSON endpoints (use json=)
for endpoint, data in [
    ('enhance', {'image_id': image_id, 'brightness': 0.1}),
    ('makeup', {'image_id': image_id, 'lipstick': 0.3}),
]:
    r = requests.post(f'{BASE}/{endpoint}', json=data)
    assert r.status_code == 200, f'{endpoint} failed: {r.status_code}'

# Test color-match with reference image file upload
ref_buf = io.BytesIO()
pil_img2.save(ref_buf, format='JPEG')
ref_buf.seek(0)
r = requests.post(
    f'{BASE}/color-match',
    data={'image_id': image_id},
    files={'reference': ('ref.jpg', ref_buf, 'image/jpeg')}
)
assert r.status_code == 200, f'color-match failed: {r.status_code}'

# Test inpaint with valid mask_id
sr = requests.post(f'{BASE}/auto-segment', data={'image_id': image_id, 'mode': 'person'})
mask_id = sr.headers.get('X-Mask-Id', '')
if mask_id:
    r = requests.post(f'{BASE}/inpaint', json={'image_id': image_id, 'mask_id': mask_id})
    assert r.status_code == 200, f'inpaint failed: {r.status_code}'
    r = requests.post(f'{BASE}/local-adjust', json={'image_id': image_id, 'mask_id': mask_id, 'brightness': 0.2})
    assert r.status_code == 200, f'local-adjust failed: {r.status_code}'
    result_id = r.headers.get('X-Result-Id', '')
    if result_id:
        r = requests.get(f'{BASE}/download/{result_id}')
        assert r.status_code == 200, f'download failed: {r.status_code}'

print('All API contract tests passed!')
