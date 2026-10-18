# Contributing to OmniPulse AI

## Workflow
1. Create a branch from `main`.
2. Keep changes focused; update tests and documentation in the same change.
3. Before pushing, run:
   ```bash
   # backend
   cd backend && ruff check app tests && pytest
   # frontend
   cd frontend && npm run lint && npm run typecheck && npm test && npm run build
   ```
4. Open a pull request describing the change, how it was tested, and any migration or env-var changes.
   CI runs lint, the backend suite on SQLite **and** PostgreSQL/pgvector, migrations + seed, and the
   frontend lint/typecheck/tests/build.

## Conventions
- **Backend**: routers are thin (validation, auth, response mapping); business logic and
  transactions live in `app/services`; pure algorithms in `app/analytics` and
  `services/pricing_policy.py`. Raise `AppError` subclasses, never bare `HTTPException` for business
  errors. Every merchant query must be tenant-scoped (`MerchantContext`). Record audit events for
  state changes. Money is `Decimal`; datetimes are timezone-aware UTC.
- **Migrations**: never edit an applied migration; add a new revision with `alembic revision
  --autogenerate` and review it. The test-suite checks model/migration parity.
- **AI**: models never write to the database or invent facts. Validate structured outputs and keep a
  deterministic fallback. Label outputs by method (rule, heuristic, statistical, ML, LLM, simulated).
- **Frontend**: one folder per feature under `src/features`; use the UI kit in `src/components/ui`,
  TanStack Query for server state, RHF + Zod for forms, and always implement loading/empty/error
  states. Don't call external AI APIs from the browser.
- **Docs**: run `python -m app.docs_gen` after API or model changes; update `TECHNICAL_README.md`
  (structure, env vars, endpoints, entities, commands) whenever they change. Never document
  unimplemented features as complete.
- **Real-time**: publish list changes through `websocket.hub.publish` (it also mirrors to Firestore)
  and merchant feed events through `integrations.firebase.firebase.merchant_feed`; never write
  business data from the browser to Firestore, and update `firestore.rules` when adding collections.
- **Connectors**: route every new sales channel through `channel_service.ingest_order` so stock,
  idempotency, alerts and the live feed behave the same for all channels.
- **Secrets**: only via environment variables (Secret Manager on Cloud Run); never commit `.env` or
  API keys.
- **Deploying**: `bash ./scripts/deploy-gcp.sh <project-id>` from Cloud Shell; see
  `docs/deployment/GCP.md`. Run `npm run e2e -- e2e/judge.spec.ts` against a running stack before
  changing the demo journeys.

## Commit messages
Imperative mood, short subject (≤72 chars), body explaining *why* when not obvious.
