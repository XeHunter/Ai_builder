# ADR-0003: Portable embeddings with optional pgvector

* Status: accepted
* Date: 2026-10-16

## Context
Semantic product search needs vector similarity. pgvector is ideal on PostgreSQL but is not
available on SQLite, nor on every PostgreSQL install (e.g. the portable PostgreSQL used to develop
this project).

## Decision
`product_embeddings` stores provider, model, dimensions (256 by default — OpenAI `text-embedding-3-*`
and Gemini embedding models both support reduced dimensions), a content hash and the vector as JSON.
Similarity is computed in NumPy over the merchant's catalog (a few hundred to a few thousand
products per tenant). Migration `0002` adds `embedding vector(256)` plus an HNSW cosine index when the
`vector` extension is available (docker-compose uses the `pgvector/pgvector` image).

## Consequences
* Identical behaviour across environments; tests run on SQLite.
* For catalogs of 100k+ products per tenant, move kNN into SQL using the pgvector column (the column
  and index already exist on pgvector installs; the query path is not yet implemented — see
  TECHNICAL_README "Known limitations").
* Changing the embedding model is detected by model name/dimensions/content hash and triggers
  re-embedding (`POST /api/v1/merchant/products/reindex`, scheduled `embedding_reindex`).
