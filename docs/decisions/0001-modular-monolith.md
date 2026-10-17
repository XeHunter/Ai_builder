# ADR-0001: Modular monolith with PostgreSQL as the source of truth

* Status: accepted
* Date: 2026-10-16

## Context
OmniPulse spans shopper features (search, lists, routing, collaboration) and store operations
(inventory, expiry, pricing, forecasting, merchandising, fraud). These domains share one data model
and many workflows cross them (an import changes stock, which changes expiry exposure, which creates
price recommendations, which on publication change what shoppers see).

## Decision
Build a single FastAPI application with strict internal modules (`api`, `services`, `ai`,
`analytics`, `integrations`, `tasks`, `db`). Pure algorithms live in `analytics/` and
`services/pricing_policy.py` with no database access so they are unit-testable. PostgreSQL holds all
durable state; SQLite is supported for zero-setup development and fast tests.

## Consequences
* Cross-domain workflows are simple database transactions.
* Horizontal scaling is by running more API replicas and worker processes from the same image.
* A future split is possible along module lines (services do not import routers; analytics does not
  import services).
