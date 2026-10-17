# OmniPulse AI backend (API + worker share this image)
FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY app ./app
RUN pip install --upgrade pip && pip install ".[redis,pgvector]"
COPY alembic.ini ./
COPY alembic ./alembic
COPY tests ./tests
RUN useradd --create-home --uid 10001 omnipulse && mkdir -p /app/media && chown -R omnipulse /app
USER omnipulse
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD curl -fsS http://localhost:8000/health/live || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
