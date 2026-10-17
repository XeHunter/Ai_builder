# ADR-0002: Database-backed job queue instead of Celery

* Status: accepted
* Date: 2026-10-16

## Context
We need background processing for forecast runs, affinity analysis, import commits, expiry
re-evaluation, promotion lifecycle, fraud scans and re-indexing, with retries, status tracking and
de-duplication. Celery would require a broker (Redis/RabbitMQ) even for local development.

## Decision
`app/tasks/queue.py` stores jobs in `job_runs`. `enqueue()` supports `dedupe_key`; workers claim
jobs with a conditional `UPDATE ... WHERE status='queued'` (atomic on PostgreSQL, so several workers
are safe); failures retry with exponential backoff up to `max_attempts`. `app/tasks/worker.py` runs the
loop and a scheduler that enqueues periodic jobs with time-bucketed dedupe keys. The worker runs
in-process for local demos (`RUN_WORKER_IN_PROCESS=true`) or standalone (`python -m app.tasks.worker`).
`JOBS_EAGER=true` executes jobs synchronously (tests).

## Consequences
* No extra infrastructure; job state is queryable (`GET /api/v1/merchant/jobs`).
* Throughput is bounded by database polling (adequate for minutes-scale analytics jobs). If job
  volume grows, `enqueue()` can be re-implemented on Celery/RQ without touching callers.
