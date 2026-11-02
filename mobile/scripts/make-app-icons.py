"""Regenerate app icon / adaptive icon / splash / favicon from the designed
brand mark at assets/brand/vendora-logo.png.

Usage (from mobile/):  python scripts/make-app-icons.py
"""
import numpy as np
from PIL import Image, ImageFilter

src = np.asarray(Image.open('assets/brand/vendora-logo.png').convert('RGB')).astype(float)
# Un-composite the mark from its white ground (color-to-alpha).
a = (255 - src).max(axis=2) / 255.0
a[a < 0.04] = 0
rgb = np.where(a[..., None] > 0, (src - (1 - a[..., None]) * 255) / np.maximum(a[..., None], 1e-3), 0).clip(0, 255)
rgb = (rgb * 1.25 + 18).clip(0, 255)  # lift so the mark reads on a dark ground
mark = Image.fromarray(np.dstack([rgb, a * 255]).astype('uint8'), 'RGBA')
mark = mark.crop(mark.getbbox())


def bg(size, c0=(34, 22, 82), c1=(10, 10, 26)):
    """Radial violet-to-#0A0A1A ground (matches splash/adaptive background)."""
    y, x = np.mgrid[0:size, 0:size] / size
    t = (np.sqrt((x - .5) ** 2 + (y - .42) ** 2) / 0.75).clip(0, 1)[..., None]
    return Image.fromarray((np.array(c0) * (1 - t) + np.array(c1) * t).astype('uint8'), 'RGB').convert('RGBA')


def place(canvas, frac):
    S = canvas.size[0]
    w = int(S * frac)
    m = mark.resize((w, int(mark.size[1] * w / mark.size[0])), Image.LANCZOS)
    pos = ((S - m.size[0]) // 2, (S - m.size[1]) // 2 + int(S * .02))
    g = Image.new('RGBA', m.size, (142, 107, 255, 0))
    g.putalpha(m.getchannel('A').point(lambda v: int(v * .55)))
    glow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    glow.paste(g, pos, g)
    glow = glow.filter(ImageFilter.GaussianBlur(S * .05))
    canvas = Image.alpha_composite(canvas, glow)
    canvas.alpha_composite(m, pos)
    return canvas


clear = lambda: Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
place(bg(1024), .60).convert('RGB').save('assets/icon.png')  # iOS: opaque, square corners
place(clear(), .42).save('assets/adaptive-icon.png')  # inside Android 66% safe zone
place(clear(), .50).save('assets/splash-icon.png')
place(bg(1024), .70).convert('RGB').resize((48, 48), Image.LANCZOS).save('assets/favicon.png')
print('ok', Image.open('assets/icon.png').size, Image.open('assets/icon.png').mode)
