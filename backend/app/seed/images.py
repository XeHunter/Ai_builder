"""Synthetic product "packshots" for the demo visual-search dataset.

Each product gets a deterministic illustration (package silhouette by category, brand-derived
colours and a label band). These are clearly synthetic (``product_images.is_synthetic = True``).
``make_query_variants`` produces perturbed copies (rotation, crop, lighting, JPEG noise) that
stand in for customer photos when demonstrating image search.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

CATEGORY_SHAPE = {
    "dairy": "carton", "eggs": "tray", "bakery": "loaf", "produce": "crate", "breakfast": "box",
    "tea-coffee": "jar", "snacks": "pouch", "beverages": "bottle", "staples": "sack", "personal-care": "tube",
    "household": "bottle", "baby": "box", "electronics": "device", "seasonal": "umbrella", "frozen": "tub",
    "gift-cards": "card",
}


def _palette(key: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    h = hashlib.sha256(key.encode()).digest()
    base = (60 + h[0] % 180, 40 + h[1] % 190, 40 + h[2] % 190)
    accent = (255 - base[0] // 2, 230 - base[1] // 3, 120 + h[3] % 120)
    return base, accent


def _font(size: int) -> ImageFont.ImageFont:
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_packshot(sku: str, name: str, brand: str | None, category_slug: str, size: int = 320) -> Image.Image:
    img = Image.new("RGB", (size, size), (255, 255, 255))
    d = ImageDraw.Draw(img)
    base, accent = _palette(f"{brand or name}:{sku}")
    shape = CATEGORY_SHAPE.get(category_slug, "box")
    s = size
    if shape == "carton":
        d.polygon([(s*.3, s*.25), (s*.5, s*.12), (s*.7, s*.25), (s*.7, s*.88), (s*.3, s*.88)], fill=base)
    elif shape == "bottle":
        d.rectangle([s*.42, s*.1, s*.58, s*.25], fill=accent)
        d.rounded_rectangle([s*.32, s*.22, s*.68, s*.9], radius=int(s*.06), fill=base)
    elif shape == "jar":
        d.rectangle([s*.3, s*.18, s*.7, s*.28], fill=accent)
        d.rounded_rectangle([s*.27, s*.27, s*.73, s*.88], radius=int(s*.05), fill=base)
    elif shape == "pouch":
        d.polygon([(s*.25, s*.15), (s*.75, s*.15), (s*.8, s*.88), (s*.2, s*.88)], fill=base)
    elif shape == "loaf":
        d.rounded_rectangle([s*.15, s*.3, s*.85, s*.8], radius=int(s*.18), fill=base)
    elif shape == "tray":
        for i in range(3):
            for j in range(2):
                d.ellipse([s*(.2+i*.22), s*(.35+j*.2), s*(.36+i*.22), s*(.55+j*.2)], fill=(245, 235, 215), outline=base, width=4)
        d.rectangle([s*.15, s*.75, s*.85, s*.85], fill=base)
    elif shape == "crate":
        d.rectangle([s*.15, s*.55, s*.85, s*.85], fill=(170, 120, 70))
        for i in range(4):
            d.ellipse([s*(.17+i*.17), s*.3, s*(.33+i*.17), s*.58], fill=base)
    elif shape == "sack":
        d.polygon([(s*.25, s*.18), (s*.75, s*.18), (s*.82, s*.9), (s*.18, s*.9)], fill=base)
        d.rectangle([s*.25, s*.15, s*.75, s*.22], fill=accent)
    elif shape == "tube":
        d.polygon([(s*.2, s*.3), (s*.8, s*.25), (s*.82, s*.6), (s*.18, s*.65)], fill=base)
        d.rectangle([s*.82, s*.38, s*.9, s*.5], fill=accent)
    elif shape == "device":
        d.rounded_rectangle([s*.15, s*.3, s*.85, s*.78], radius=int(s*.05), fill=(40, 40, 45))
        d.ellipse([s*.38, s*.38, s*.62, s*.66], fill=base, outline=accent, width=6)
        d.rectangle([s*.22, s*.24, s*.38, s*.31], fill=(40, 40, 45))
    elif shape == "umbrella":
        d.pieslice([s*.1, s*.15, s*.9, s*.85], 180, 360, fill=base)
        d.line([s*.5, s*.5, s*.5, s*.88], fill=(60, 60, 60), width=6)
        d.arc([s*.42, s*.8, s*.58, s*.95], 0, 180, fill=(60, 60, 60), width=6)
    elif shape == "tub":
        d.polygon([(s*.22, s*.3), (s*.78, s*.3), (s*.7, s*.85), (s*.3, s*.85)], fill=base)
        d.rectangle([s*.2, s*.24, s*.8, s*.32], fill=accent)
    elif shape == "card":
        d.rounded_rectangle([s*.12, s*.3, s*.88, s*.72], radius=int(s*.04), fill=base)
    else:
        d.rectangle([s*.25, s*.15, s*.75, s*.88], fill=base)
    if shape not in ("tray", "crate", "umbrella", "device"):
        d.rectangle([s*.25, s*.48, s*.75, s*.62], fill=accent)
        label = (brand or name.split()[0])[:10].upper()
        d.text((s*.5, s*.55), label, fill=(20, 20, 20), anchor="mm", font=_font(int(s*.055)))
    d.text((s*.5, s*.95), sku, fill=(140, 140, 140), anchor="mm", font=_font(int(s*.04)))
    return img


def make_query_variants(img: Image.Image, seed: int) -> Image.Image:
    w, h = img.size
    out = img.rotate(4 + seed % 5, resample=Image.Resampling.BICUBIC, fillcolor=(236, 236, 232))
    m = int(w * 0.06)
    out = out.crop((m, m, w - m, h - m)).resize((480, 480))
    out = ImageEnhance.Brightness(out).enhance(0.92 + (seed % 3) * 0.05)
    return out.filter(ImageFilter.GaussianBlur(0.6))


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)
