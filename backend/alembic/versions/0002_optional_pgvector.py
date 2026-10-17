"""optional pgvector column for product embeddings

On PostgreSQL with the ``vector`` extension available (e.g. the pgvector/pgvector Docker image used
by docker-compose), add ``product_embeddings.embedding vector(256)`` plus an HNSW cosine index.
On SQLite, or PostgreSQL without the extension, this migration is a no-op; embeddings remain in the
portable JSON column and similarity is computed in NumPy.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-16
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DIMS = 256


def _pgvector_available(bind) -> bool:
    if bind.dialect.name != "postgresql":
        return False
    return bool(bind.execute(sa.text("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).scalar())


def upgrade() -> None:
    bind = op.get_bind()
    if not _pgvector_available(bind):
        return
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute(f"ALTER TABLE product_embeddings ADD COLUMN IF NOT EXISTS embedding vector({DIMS})")
    op.execute("CREATE INDEX IF NOT EXISTS ix_product_embeddings_hnsw ON product_embeddings "
               "USING hnsw (embedding vector_cosine_ops)")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute("DROP INDEX IF EXISTS ix_product_embeddings_hnsw")
    op.execute("ALTER TABLE product_embeddings DROP COLUMN IF EXISTS embedding")
