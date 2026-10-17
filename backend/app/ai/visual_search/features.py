"""Deterministic visual descriptor used for demo-mode image matching.

Descriptor = [HSV colour histogram of foreground pixels (12 hue x 3 sat x 3 val bins) * 0.6,
              4x4 grid of mean RGB colours * 0.4], L2-normalised.

This captures colour and coarse layout - it can match a photo of a package to the catalog image of
the same package, or to similarly coloured packaging. It does NOT recognise objects or read text,
and the API labels results as "colour/layout similarity". With a vision-capable AI provider the
image is additionally captioned and the caption is used for semantic catalog search.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageOps

FEATURE_VERSION = "color-layout-v1"
MAX_PIXELS = 4096 * 4096
ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


class InvalidImage(ValueError):
    pass


def load_image(data: bytes) -> Image.Image:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = probe.format
        probe.verify()
    except Exception as exc:
        raise InvalidImage("File is not a valid image") from exc
    if fmt not in ALLOWED_FORMATS:
        raise InvalidImage("Only JPEG, PNG and WebP images are supported")
    img = Image.open(io.BytesIO(data))
    if img.width * img.height > MAX_PIXELS:
        raise InvalidImage("Image is too large")
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def describe(img: Image.Image) -> list[float]:
    small = ImageOps.pad(img, (96, 96), color=(255, 255, 255))
    rgb = np.asarray(small, dtype=np.float32) / 255.0
    hsv = np.asarray(small.convert("HSV"), dtype=np.float32) / 255.0
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    fg = ~((s < 0.12) & (v > 0.9))  # ignore near-white background
    if fg.sum() < 50:
        fg = np.ones_like(fg)
    hb = np.minimum((h[fg] * 12).astype(int), 11)
    sb = np.minimum((s[fg] * 3).astype(int), 2)
    vb = np.minimum((v[fg] * 3).astype(int), 2)
    hist = np.bincount(hb * 9 + sb * 3 + vb, minlength=108).astype(np.float32)
    hist /= np.linalg.norm(hist) or 1.0
    grid = rgb.reshape(4, 24, 4, 24, 3).mean(axis=(1, 3)).reshape(-1)
    grid = grid - grid.mean()
    grid /= np.linalg.norm(grid) or 1.0
    vec = np.concatenate([hist * 0.6, grid * 0.4])
    vec /= np.linalg.norm(vec) or 1.0
    return [round(float(x), 5) for x in vec]
