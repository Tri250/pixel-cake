#!/usr/bin/env python3
"""Create a simple Windows .ico file from Pillow."""
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("Pillow not installed, skipping icon creation")
    sys.exit(0)

os.makedirs("assets", exist_ok=True)

# Create a simple blue-to-red gradient icon
img = Image.new('RGBA', (256, 256), (66, 133, 244, 255))

# Add red accent in center
for i in range(50, 200):
    for j in range(50, 200):
        img.putpixel((i, j), (234, 67, 53, 255))

# White cross/plus
for i in range(110, 146):
    for j in range(70, 190):
        img.putpixel((i, j), (255, 255, 255, 255))
for i in range(70, 190):
    for j in range(110, 146):
        img.putpixel((i, j), (255, 255, 255, 255))

icon_path = "assets/icon.ico"
img.save(icon_path, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
size = os.path.getsize(icon_path)
print(f"Created {icon_path} ({size} bytes)")
