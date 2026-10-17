#!/usr/bin/env bash
# OmniPulse AI developer helper (macOS / Linux / Git Bash).
# Usage: scripts/dev.sh <install|setup|api|worker|web|test|lint|reset|build|e2e>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -x "$ROOT/backend/.venv/bin/python" ]]; then PY="$ROOT/backend/.venv/bin/python"; else PY="$ROOT/backend/.venv/Scripts/python"; fi

case "${1:-}" in
  install) (cd "$ROOT/backend" && python3 -m venv .venv && "$PY" -m pip install -e ".[dev,redis,pgvector]") && (cd "$ROOT/frontend" && npm ci) ;;
  setup)   (cd "$ROOT/backend" && "$PY" -m app.cli migrate && "$PY" -m app.cli seed) ;;
  api)     (cd "$ROOT/backend" && "$PY" -m uvicorn app.main:app --reload --port 8000) ;;
  worker)  (cd "$ROOT/backend" && "$PY" -m app.tasks.worker) ;;
  web)     (cd "$ROOT/frontend" && npm run dev) ;;
  test)    (cd "$ROOT/backend" && "$PY" -m pytest) && (cd "$ROOT/frontend" && npm test) ;;
  lint)    (cd "$ROOT/backend" && "$PY" -m ruff check app tests) && (cd "$ROOT/frontend" && npm run lint && npm run typecheck) ;;
  reset)   (cd "$ROOT/backend" && "$PY" -m app.cli reset --yes) ;;
  build)   (cd "$ROOT/frontend" && npm run build) ;;
  e2e)     (cd "$ROOT/frontend" && npx playwright test) ;;
  *) echo "usage: scripts/dev.sh <install|setup|api|worker|web|test|lint|reset|build|e2e>"; exit 1 ;;
esac
