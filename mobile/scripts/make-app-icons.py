"""Regenerate app icon / adaptive icon / splash / favicon / login logo from the
Resqlo source art at assets/brand/resqlo-source.png.

Crops to the rounded tile (dropping the black margin and glowing rim), fills
the tile's rounded corners by extending its own background colour so the
square is opaque edge-to-edge (Apple applies its own mask), then scales with
LANCZOS. No artwork is drawn; only crop/scale/fill.

Usage (from mobile/):  python scripts/make-app-icons.py
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

im = Image.open("assets/brand/resqlo-source.png").convert("RGB")
a = np.asarray(im).astype(float)
lum = a.max(axis=2)
mid = a.shape[0] // 2
ys = np.where(lum[:, mid] > 60)[0]
xs = np.where(lum[mid, :] > 60)[0]
top, bot, left, right = ys.min(), ys.max(), xs.min(), xs.max()
INSET = 22  # drop the glowing rim
L, T, R, B = left + INSET, top + INSET, right - INSET, bot - INSET
side = min(R - L, B - T)
cx, cy = (L + R) // 2, (T + B) // 2
x0, y0 = cx - side // 2, cy - side // 2
crop = im.crop((x0, y0, x0 + side, y0 + side))
S = crop.size[0]

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.24), fill=255)
mask = mask.filter(ImageFilter.MinFilter(25))
m = np.asarray(mask).astype(float)[..., None] / 255
c = np.asarray(crop).astype(float)
num = np.asarray(Image.fromarray((c * m).astype("uint8")).filter(ImageFilter.GaussianBlur(40))).astype(float)
den = np.asarray(mask.filter(ImageFilter.GaussianBlur(40))).astype(float)[..., None] / 255
est = num / np.maximum(den, 1e-3)
soft = np.asarray(mask.filter(ImageFilter.GaussianBlur(4))).astype(float)[..., None] / 255
out = (c * soft + est * (1 - soft)).clip(0, 255).astype("uint8")

icon = Image.fromarray(out, "RGB").resize((1024, 1024), Image.LANCZOS)
for name in ("icon.png", "adaptive-icon.png", "splash-icon.png", "brand/resqlo-logo.png"):
    icon.save(f"assets/{name}")
icon.resize((48, 48), Image.LANCZOS).save("assets/favicon.png")
print("tile", left, top, right, bot, "->", icon.mode, icon.size)
