"""Visual product discovery: validate the upload, match it against catalog images, enrich with store facts.

Uploaded images are processed in memory and not stored.
"""

from __future__ import annotations

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.providers import get_ai_provider
from app.ai.visual_search.features import FEATURE_VERSION, InvalidImage, describe, load_image
from app.core.config import get_settings
from app.core.exceptions import ValidationFailedError
from app.db.models import Product, ProductImage, Store
from app.services import catalog_service

MIN_VISUAL_SIMILARITY = 0.55


def reindex_images(db: Session, merchant_id) -> int:
    s = get_settings()
    n = 0
    rows = db.scalars(select(ProductImage).join(Product, Product.id == ProductImage.product_id)
                      .where(Product.merchant_id == merchant_id)).all()
    for img in rows:
        if img.feature_version == FEATURE_VERSION and img.features:
            continue
        path = s.media_dir / img.file_path
        if not path.exists():
            continue
        img.features = describe(load_image(path.read_bytes()))
        img.feature_version = FEATURE_VERSION
        n += 1
    db.commit()
    return n


def search_by_image(db: Session, store: Store, data: bytes, content_type: str | None, limit: int = 6) -> dict:
    s = get_settings()
    if len(data) == 0:
        raise ValidationFailedError("Empty file")
    if len(data) > s.max_upload_bytes:
        raise ValidationFailedError(f"Image exceeds the {s.max_upload_mb} MB limit")
    if content_type and content_type not in ("image/jpeg", "image/png", "image/webp"):
        raise ValidationFailedError("Only JPEG, PNG and WebP images are supported")
    try:
        img = load_image(data)
    except InvalidImage as exc:
        raise ValidationFailedError(str(exc)) from exc
    query_vec = np.asarray(describe(img), dtype=np.float32)

    rows = db.execute(select(ProductImage.product_id, ProductImage.features, ProductImage.is_synthetic)
                      .join(Product, Product.id == ProductImage.product_id)
                      .where(Product.merchant_id == store.merchant_id, Product.status == "active",
                             ProductImage.feature_version == FEATURE_VERSION)).all()
    visual: dict = {}
    for pid, feats, _ in rows:
        if feats:
            sim = float(np.dot(query_vec, np.asarray(feats, dtype=np.float32)))
            visual[pid] = max(visual.get(pid, -1.0), sim)

    provider = get_ai_provider()
    caption = None
    text_scores: dict = {}
    if provider.supports_vision:
        desc = provider.describe_image(data, content_type or "image/jpeg")
        if desc:
            caption = desc.caption
            for h in catalog_service.search(db, store.merchant_id, f"{desc.caption} {' '.join(desc.keywords)}", limit=10):
                text_scores[h.product_id] = h.score

    # With a caption, every product is scored on both signals (a product the caption doesn't match
    # scores 0 on text) so a look-alike can't outrank the product the vision model actually named.
    combined = {}
    for pid in set(visual) | set(text_scores):
        v = visual.get(pid, 0.0)
        combined[pid] = 0.5 * v + 0.5 * text_scores.get(pid, 0.0) if text_scores else v
    ranked = sorted(combined.items(), key=lambda kv: (-kv[1], str(kv[0])))
    if not text_scores:
        ranked = [(pid, sc) for pid, sc in ranked if sc >= MIN_VISUAL_SIMILARITY]
    ranked = ranked[:limit]
    products = catalog_service.load_products(db, [pid for pid, _ in ranked])
    cards = catalog_service.product_cards(db, store, products, dict(ranked))
    for c in cards:
        c["visual_similarity"] = round(visual.get(next(p.id for p in products if str(p.id) == c["id"]), 0.0), 3)
    method = "colour_layout_similarity" + ("+vision_caption_search" if caption else "")
    return {
        "matches": cards,
        "method": method,
        "method_description": (
            "Matched by colour histogram and coarse layout against catalog images (deterministic, not object "
            "recognition)." + (f" A vision model described the photo as: '{caption}'." if caption else
                               " Configure a vision-capable AI provider for semantic image understanding.")
        ),
        "caption": caption,
        "image": {"width": img.width, "height": img.height},
    }
