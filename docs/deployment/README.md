# Deployment notes

## Topology
```
            ┌──────────── HTTPS (TLS at LB/ingress) ────────────┐
 Browser ──►│ web (nginx: SPA + /api,/media,/health proxy)       │
            └───────────────┬────────────────────────────────────┘
                            ▼
                 backend (N replicas, uvicorn)  ◄──► Redis (WebSocket fan-out, rate limits)
                            │
                 worker (M replicas, python -m app.tasks.worker)
                            │
                       PostgreSQL 15+ (pgvector optional)
```

## Release procedure
1. Build images: `docker build -t omnipulse-backend backend/` and `docker build -t omnipulse-web frontend/`.
2. Run migrations once: `docker run --rm --env-file prod.env omnipulse-backend python -m app.cli migrate`.
3. Roll out `backend` (API) and `worker` deployments, then `web`.
4. Verify `/health/ready` and a smoke login.

Do **not** run `python -m app.cli seed`/`reset` against production databases (reset refuses when
`APP_ENV=production`).

## Required production settings
`APP_ENV=production`, `JWT_SECRET` (≥32 random chars), `COOKIE_SECURE=true`, `CORS_ORIGINS`,
`DATABASE_URL`, `REDIS_URL` (when >1 API replica), `RUN_WORKER_IN_PROCESS=false`, `LOG_JSON=true`,
`FRONTEND_BASE_URL` (invitation links), `MEDIA_DIR` on persistent storage.

## Operations
- Probes: liveness `/health/live`, readiness `/health/ready`.
- Logs: JSON lines with `request_id`; correlate with the `X-Request-Id` response header.
- Jobs: `GET /api/v1/merchant/jobs` (status, attempts, errors). Failed jobs can be re-triggered.
- Backups: PostgreSQL PITR + `MEDIA_DIR`. Restore drills quarterly.
- Scaling: API is stateless (sessions in PostgreSQL); add replicas behind the LB. Workers scale
  horizontally (claiming is atomic). Use pgBouncer for many replicas.
