# OmniPulse AI developer commands (GNU make). On Windows PowerShell use scripts/dev.ps1 instead.
PY ?= backend/.venv/bin/python
ifeq ($(OS),Windows_NT)
PY = backend/.venv/Scripts/python
endif

.PHONY: install backend-install frontend-install migrate seed reset dev-api worker dev-web test test-backend test-frontend lint build e2e up down

install: backend-install frontend-install

backend-install:
	python -m venv backend/.venv
	$(PY) -m pip install -e "backend[dev,redis,pgvector]"

frontend-install:
	cd frontend && npm ci

migrate:
	cd backend && ../$(PY) -m app.cli migrate

seed:
	cd backend && ../$(PY) -m app.cli seed

reset:
	cd backend && ../$(PY) -m app.cli reset --yes

dev-api:
	cd backend && ../$(PY) -m uvicorn app.main:app --reload --port 8000

worker:
	cd backend && ../$(PY) -m app.tasks.worker

dev-web:
	cd frontend && npm run dev

test: test-backend test-frontend

test-backend:
	cd backend && ../$(PY) -m pytest

test-frontend:
	cd frontend && npm test

lint:
	cd backend && ../$(PY) -m ruff check app tests
	cd frontend && npm run lint && npm run typecheck

build:
	cd frontend && npm run build

e2e:
	cd frontend && npx playwright test

up:
	docker compose up --build

down:
	docker compose down
