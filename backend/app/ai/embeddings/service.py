"""Product text-embedding index.

Vectors are stored in ``product_embeddings`` with provider/model/dimensions and a content hash, so a
change of embedding model (or of product text) is detected and the product is re-embedded. Cosine
similarity is computed in NumPy over the merchant's catalog. When the database is PostgreSQL with the
pgvector extension, the same vectors can be indexed server-side (see docs/decisions/0003-vector-search.md).
"""

from __future__ import annotations

import hashlib
import uuid

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.providers import AIProvider, get_ai_provider
from app.core.logging import get_logger
from app.db.models import Product, ProductEmbedding

log = get_logger(__name__)


def product_document(p: Product) -> str:
    cat = p.category.name if p.category else ""
    tags = " ".join(p.tags or [])
    return f"{p.name}. {p.brand or ''} {cat}. {tags}. {p.description or ''}".strip()


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def reindex_products(db: Session, merchant_id: uuid.UUID, provider: AIProvider | None = None,
                     force: bool = False, batch_size: int = 64) -> dict:
    """Create or refresh embeddings for products whose text or embedding model changed."""
    provider = provider or get_ai_provider()
    products = db.scalars(select(Product).where(Product.merchant_id == merchant_id)).all()
    existing = {
        e.product_id: e
        for e in db.scalars(
            select(ProductEmbedding).where(
                ProductEmbedding.model == provider.embedding_model,
                ProductEmbedding.product_id.in_([p.id for p in products]),
            )
        )
    }
    todo: list[tuple[Product, str, str]] = []
    for p in products:
        doc = product_document(p)
        h = _hash(doc)
        e = existing.get(p.id)
        if force or e is None or e.content_hash != h or e.dimensions != provider.embedding_dimensions:
            todo.append((p, doc, h))
    for i in range(0, len(todo), batch_size):
        chunk = todo[i : i + batch_size]
        vectors = provider.embed([doc for _, doc, _ in chunk])
        for (p, _, h), vec in zip(chunk, vectors, strict=True):
            e = existing.get(p.id)
            if e is None:
                e = ProductEmbedding(product_id=p.id, provider=provider.name, model=provider.embedding_model,
                                     dimensions=len(vec), content_hash=h, vector=[round(float(v), 6) for v in vec])
                db.add(e)
            else:
                e.vector, e.content_hash, e.dimensions = [round(float(v), 6) for v in vec], h, len(vec)
    db.commit()
    return {"model": provider.embedding_model, "indexed": len(todo), "total": len(products)}


def load_matrix(db: Session, product_ids: list[uuid.UUID], model: str) -> tuple[list[uuid.UUID], np.ndarray | None]:
    rows = db.execute(
        select(ProductEmbedding.product_id, ProductEmbedding.vector).where(
            ProductEmbedding.model == model, ProductEmbedding.product_id.in_(product_ids)
        )
    ).all()
    if not rows:
        return [], None
    ids = [r[0] for r in rows]
    mat = np.asarray([r[1] for r in rows], dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return ids, mat / norms


def embed_query(text: str, provider: AIProvider | None = None) -> np.ndarray | None:
    provider = provider or get_ai_provider()
    try:
        vec = np.asarray(provider.embed([text])[0], dtype=np.float32)
    except Exception as exc:  # provider outage: search degrades to lexical-only
        log.warning("Query embedding failed (%s); falling back to lexical search", exc)
        return None
    n = np.linalg.norm(vec)
    return vec / n if n else vec
