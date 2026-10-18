# OmniPulse AI — Technical README

This document describes **what is actually implemented**: modules, data model, APIs, algorithms,
configuration, operations and limitations. The product introduction is in [README.md](README.md);
architectural reasoning is in [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/decisions](docs/decisions/).

Contents: [A. Overview](#a-project-overview) · [B. Stack](#b-technology-stack) ·
[C. Repository](#c-repository-structure) · [D. Architecture](#d-architecture) ·
[E. Database](#e-database) · [F. API](#f-api) · [G. AI & analytics](#g-ai-and-analytics) ·
[H. Feature map](#h-feature-implementation-map) · [I. Environment](#i-environment-variables) ·
[J. Local development](#j-local-development-guide) · [K. Testing & troubleshooting](#k-testing-and-troubleshooting) ·
[L. Deployment](#l-deployment) · [M. Limitations & roadmap](#m-known-limitations-and-roadmap) ·
[N. Developer change guide](#n-developer-change-guide)

---

## A. Project overview

OmniPulse AI is a retail platform with two applications on one backend and one database:

* **Shopper app** (`/shop`): catalog search, conversational assistant, photo search, smart
  shopping lists parsed from free text, aisle grouping, optimised in-store routes on an interactive
  map, real-time shared lists (Firestore on Google Cloud, WebSocket locally), click & collect
  ordering, offers/coupons and consent-based proximity offers.
* **Merchant app** (`/merchant`): operational overview, catalog, inventory with batch ledger and
  CSV/XLSX import, expiry management with markdown recommendations, demand forecasting with
  stockout risk, pricing workflow (approve → publish) and promotions, weather opportunities,
  planogram editor, merchandising recommendations, cross-selling analytics, fraud review queue,
  shopping insights, integrations, settings, audit log and background jobs, plus a Gemini-written
  **AI morning brief** and a **Channels & orders** page with a live omnichannel order feed.
* **Plug and play** (`/onboarding`, `/merchant/setup`, `/merchant/channels`): store-owner self
  sign-up, a 5-step setup wizard (store → generated floor plan → catalog import → sales-history
  backfill → connectors), API keys for POS / e-commerce systems, a Shopify order webhook, a catalog
  feed for online storefronts and a POS simulator.

**Live deployment**: <https://aibuilder-5681b.web.app> (Cloud Run API, Firebase Hosting, Firestore +
Firebase Auth, Gemini). One-click demo personas on the sign-in page; see §L.1 and
[docs/deployment/GCP.md](docs/deployment/GCP.md).

**User roles**

| Role | Account type | Scope | Typical permissions |
|---|---|---|---|
| Shopper | `customer` | own lists, memberships, preferences | shopping APIs only |
| Merchant admin | `merchant` (role `merchant_admin`) | all stores of the merchant | everything |
| Store manager | `merchant` (role `store_manager`, `all_stores=false`) | assigned stores only | everything except `settings.manage`, `integrations.manage` |
| Analyst | `merchant` (role `analyst`) | all stores | all `*.read` + `forecast.run`, `affinity.run` |

Permission codes are defined in `backend/app/core/permissions.py` and seeded into `permissions`.

**Main workflows**: CSV import → inventory/batches → expiry evaluation → markdown recommendation →
approval → publication (simulated shelf labels) → shopper sees the markdown; shopper list → product
matching → route → collect; sales history → forecast → stockout risk → reorder suggestion;
baskets → association rules → merchandising test → planogram draft → publish → outcome tracking;
transactions → fraud rules + anomaly score → review queue → investigation outcome → evaluation;
POS bill / Shopify order / click & collect → Orders API → FEFO stock consumption → low-stock alert →
live feed (Firestore); new store → floor plan → catalog + history import → connectors → first analytics.

**Implemented vs planned**: see [H](#h-feature-implementation-map) (status column) and
[M](#m-known-limitations-and-roadmap).

---

## B. Technology stack

| Technology | Used for | Where | Required? | Demo mode |
|---|---|---|---|---|
| Python 3.12+ (developed on 3.14) | Backend runtime | `backend/` | Yes | Yes |
| FastAPI 0.143 / Starlette 1.8 | REST + WebSocket API, OpenAPI | `app/main.py`, `app/api` | Yes | Yes |
| Pydantic 2.14 / pydantic-settings | Request/response schemas, config | `app/schemas`, `app/core/config.py` | Yes | Yes |
| SQLAlchemy 2.1 | ORM, portable types | `app/db` | Yes | Yes |
| Alembic 1.20 | Migrations | `backend/alembic` | Yes | Yes |
| PostgreSQL 17 (+ pgvector optional) | Primary database | docker-compose `db` | Recommended (SQLite fallback) | Yes |
| SQLite | Zero-setup dev DB and test DB | default `DATABASE_URL` | Optional | Yes |
| psycopg 3 | PostgreSQL driver | — | With PostgreSQL | Yes |
| Redis 7 (optional) | Cross-instance WebSocket fan-out, shared rate limits | `app/websocket/hub.py`, `app/core/rate_limit.py` | No | No (in-process fallback) |
| argon2-cffi, PyJWT | Password hashing, session tokens | `app/core/security.py` | Yes | Yes |
| NumPy, pandas | Vector maths, daily aggregation | `ai/embeddings`, `services/sales_stats.py` | Yes | Yes |
| scikit-learn 1.9 | Ridge forecasting, IsolationForest | `analytics/forecasting`, `analytics/anomaly_detection` | Yes | Yes |
| Pillow | Image validation, visual descriptors, synthetic packshots | `ai/visual_search`, `seed/images.py` | Yes | Yes |
| openpyxl | XLSX import | `services/inventory_service.py` | Yes | Yes |
| segno | QR codes for invitations | `services/collaboration_service.py` | Yes | Yes |
| httpx | OpenAI / Gemini / OpenWeatherMap adapters | `ai/providers`, `integrations/weather` | Only with keys | No |
| React 19 + TypeScript 5.9 | SPA | `frontend/src` | Yes | Yes |
| Vite 8 | Dev server (proxy) and build | `frontend/vite.config.ts` | Yes | Yes |
| Tailwind CSS 4 | Styling with design tokens (`@theme`) | `src/styles/globals.css` | Yes | Yes |
| Radix UI primitives (shadcn-style components) | Accessible dialogs, tabs, menus, switches, tooltips | `src/components/ui` | Yes | Yes |
| TanStack Query 5 | Server state, caching, polling | everywhere | Yes | Yes |
| React Router 7 | Routing, guards | `src/routes/router.tsx` | Yes | Yes |
| React Hook Form + Zod 4 | Forms and validation | feature forms | Yes | Yes |
| Recharts 3 | Charts | merchant analytics pages | Yes | Yes |
| lucide-react, sonner | Icons, toasts | — | Yes | Yes |
| Vitest + Testing Library + jsdom | Frontend tests | `src/**/*.test.tsx` | Dev | — |
| pytest | Backend tests | `backend/tests` | Dev | — |
| Playwright | End-to-end test of the demo journeys | `frontend/e2e` | Dev (optional) | — |
| Docker / Compose, nginx | Containers, SPA serving + reverse proxy | `docker-compose.yml`, `*/Dockerfile`, `frontend/nginx.conf` | Optional | Yes |
| GitHub Actions | CI (lint, tests on SQLite + PostgreSQL/pgvector, migrations, build) | `.github/workflows/ci.yml` | Optional | — |
| Google Cloud Run | Hosts the backend container (built from `backend/Dockerfile` by Cloud Build) | `scripts/deploy-gcp.sh` | For the cloud deployment | — |
| Firebase Hosting | Serves the SPA; rewrites `/api`, `/media`, `/health` to Cloud Run | `firebase.json` | For the cloud deployment | — |
| Firestore + Firebase Auth (firebase-admin 7.7, firebase JS 12.19) | Real-time shared lists, presence and merchant live feed; custom tokens + security rules | `app/integrations/firebase`, `src/lib/firebase.ts`, `firestore.rules` | No (`FIREBASE_ENABLED`) | No (WebSocket / polling fallback) |
| Gemini API | Intent, replies, list parsing, embeddings, vision captions, AI brief | `ai/providers/gemini_provider.py` | No (`AI_PROVIDER=gemini`) | No (deterministic fallback) |
| Secret Manager, Cloud Scheduler | JWT secret + Gemini key; free keep-warm ping | `scripts/deploy-gcp.sh` | For the cloud deployment | — |

Why these: FastAPI/Pydantic give typed contracts and OpenAPI for free; SQLAlchemy 2 typed models
run on PostgreSQL and SQLite; scikit-learn covers forecasting and anomaly detection without heavy
dependencies (Prophet had no wheels for the target Python and was not needed — see ARCHITECTURE §9);
the frontend stack is the brief's stack with hand-written shadcn-style components.

---

## C. Repository structure

```
.
├── README.md · TECHNICAL_README.md · ARCHITECTURE.md · CONTRIBUTING.md
├── .env.example · .gitignore · docker-compose.yml · Makefile
├── firebase.json · firestore.rules · firestore.indexes.json   Firebase Hosting + Firestore config
├── backend/                     FastAPI application (Python package `app`)
├── frontend/                    React SPA
├── data/sample/                 Generated sample import CSV and demo "customer photos" (by the seed)
├── docs/                        api/ (generated OpenAPI + endpoint table), architecture/ (generated ER diagram),
│                                decisions/ (ADRs), development/, deployment/
├── scripts/                     dev.ps1 / dev.sh task runners, deploy-gcp.sh (Cloud Run + Firebase)
└── .github/workflows/ci.yml     CI pipeline
```

### Backend (`backend/app`)

| Module | Responsibility | Entry points / public interface | Depends on |
|---|---|---|---|
| `main.py` | App factory: CORS, request-ID + security-header middleware, exception handlers, routers, `/media` static files, `/health/live`, `/health/ready`, in-process worker lifecycle, optional migrate + seed on startup (`SEED_ON_STARTUP`) | `create_app()`, `app` | api, core, db |
| `cli.py` | `migrate`, `seed`, `reset --yes`, `run-jobs`, `check` | `python -m app.cli …` | db, seed, tasks |
| `docs_gen.py` | Regenerates `docs/api/*` and `docs/architecture/er-diagram.md` | `python -m app.docs_gen` | main, db |
| `core/config.py` | All settings from env (see §I); production validation | `get_settings()` | — |
| `core/security.py` | Argon2 hashing, JWT create/decode, opaque tokens, token hashing | functions | config |
| `core/exceptions.py` | `AppError` hierarchy (404/401/403/409/422/429/502) and the JSON error envelope | `register_exception_handlers` | logging |
| `core/permissions.py` | Permission codes and built-in roles | `PERMISSIONS`, `ROLES` | — |
| `core/rate_limit.py` | Fixed-window limiter (Redis or in-process) | `rate_limiter.hit(key, limit)` | config |
| `core/logging.py` | Text/JSON logging with request IDs | `configure_logging`, `request_id_var` | — |
| `db/base.py` | Declarative base, `UTCDateTime`, money type, naming convention, mixins | `Base`, `UUIDPk`, `Timestamps` | — |
| `db/session.py` | Engine/session factory (SQLite pragmas, Postgres pool) | `get_db`, `SessionLocal`, `configure_engine` | config |
| `db/models/*` | 63 tables in 9 modules: identity, store, catalog, inventory, shopping, sales, pricing, analytics, fraud, ops | ORM classes | base |
| `api/dependencies.py` | Authentication (cookie or Bearer), `MerchantContext` (tenant, role, permissions, store scope), `require_permission`, `get_store_scoped`, pagination | FastAPI dependencies | db, security |
| `api/v1/*.py` | 19 routers (one per domain, incl. `onboarding`, `channels`, `realtime`) — HTTP only, no business rules | `api/router.py` | services, schemas |
| `schemas/*` | Shared Pydantic schemas (auth, catalog, shopping, common) | models | — |
| `services/*` | Business logic and transactions (one module per domain, listed in §H) | functions | db, ai, analytics, integrations |
| `services/channel_service.py` | Connectors: API keys (SHA-256 hashed), idempotent order ingestion from any channel with FEFO stock consumption and low-stock alerts, Shopify payload mapping, catalog feed, sales-history CSV import, starter sales generator, POS-simulator baskets | `ingest_order`, `catalog_feed`, `import_sales_history` | inventory, catalog, firebase |
| `services/onboarding_service.py` | Merchant sign-up (tenant, policies, category tree), store creation, layout preview/apply, starter catalog CSV, first analytics run, setup status | `register_merchant`, `create_store`, `apply_layout`, `status` | layout builder, inventory |
| `services/brief_service.py` | AI morning brief: gathers verified facts, asks the provider for prioritised actions, caches 5 min | `operations_brief` | dashboard, providers |
| `services/pricing_policy.py` | **Pure** pricing guardrails + markdown heuristic | `price_floor`, `compute_markdown`, `validate_price`, `promotion_price` | — |
| `ai/providers/*` | `AIProvider` interface, `DemoProvider`, `LLMProvider` base, OpenAI and Gemini adapters, factory | `get_ai_provider()` | config |
| `ai/lexicon.py` | Grocery lexicon: synonyms, occasions, units, tokenizer | functions | — |
| `ai/embeddings/service.py` | Embedding index (re-embed on model/content change), query embedding | `reindex_products`, `load_matrix`, `embed_query` | providers, db |
| `ai/recommendations/assistant.py` | Concierge orchestration + grounding validation | `chat()` | catalog, cross_selling, providers |
| `ai/visual_search/*` | Image validation, colour/layout descriptor, image search | `search_by_image`, `describe`, `reindex_images` | Pillow, catalog |
| `ai/prompts/templates.py` | LLM system prompts | constants | — |
| `analytics/forecasting/models.py` | Seasonal-naive, weather Ridge, backtesting, metrics (pure) | `forecast_product`, `metrics` | numpy, sklearn |
| `analytics/forecasting/calendar.py` | Holiday/weekend features | `is_holiday` | — |
| `analytics/basket_analysis/association.py` | Pair-wise Apriori rules (pure) | `mine_pair_rules` | — |
| `analytics/anomaly_detection/isolation.py` | IsolationForest percentile scores (pure) | `score` | sklearn |
| `integrations/weather/providers.py` | Simulated + OpenWeatherMap adapters | `SimulatedWeatherProvider`, `OpenWeatherMapProvider` | httpx |
| `integrations/pos/pricing_publisher.py` | Simulated ESL/POS price publisher | `SimulatedPricePublisher.publish` | — |
| `integrations/firebase/__init__.py` | Firebase Admin bridge: mirrors list events / member sets and the merchant feed to Firestore on one ordered background thread; mints custom tokens; no-op when disabled | `firebase.list_event`, `merchant_feed`, `custom_token`, `available` | firebase-admin |
| `integrations/notifications/adapters.py` | Log (simulated) / SMTP channel adapters | `get_adapter` | config |
| `tasks/queue.py` | Durable job queue (enqueue, claim, run, retry, eager mode) | `enqueue`, `run_job`, `run_pending`, `job_handler` | db |
| `tasks/handlers.py` | Job handlers (import commit, expiry, forecasts, affinity, analytics refresh, promotions, fraud scan, re-index) | registered by decorator | services |
| `tasks/worker.py` | Worker loop + scheduler (`SCHEDULE`) | `python -m app.tasks.worker`, `Worker` | queue |
| `websocket/hub.py` | Per-list subscriber registry, presence, Redis fan-out; every published list message is also mirrored to Firestore | `hub.publish`, `hub.join/leave` | config, firebase |
| `seed/*` | Parameterised floor-plan generator (`LayoutSpec`: aisles, sections, levels, walls, checkouts), catalog data, synthetic packshots, demo dataset | `seed_demo()`, `build_layout()` | services |

`backend/tests/`: `conftest.py` (seeds a compact dataset once into a template SQLite DB; each test
module gets its own copy; `TEST_DATABASE_URL` switches to PostgreSQL), `test_auth_and_tenancy.py`,
`test_unit_algorithms.py`, `test_shopping_flows.py`, `test_merchant_flows.py`, `test_analytics_ops.py`,
`test_onboarding_channels.py` (demo sign-in, end-to-end store onboarding, connectors, Shopify webhook,
FEFO simulator, click & collect, AI brief grounding, placement rule book, LLM timeout cooldown).

### Frontend (`frontend/src`)

| Path | Contents |
|---|---|
| `main.tsx`, `app/providers.tsx` | Root render; QueryClient (no retries on 4xx), Tooltip provider, Auth provider, toasts |
| `routes/router.tsx` | Route tree, lazy pages, guards (`RequireAuth kind=customer|merchant permission=…`) |
| `lib/api.ts` | Fetch client (cookies, error envelope → `ApiError`, `errorMessage`, `wsUrl`) |
| `lib/list-socket.ts` | Reconnecting WebSocket client for shared lists (resync via `last_seq`, idempotent ops) |
| `lib/firebase.ts`, `lib/list-firestore.ts` | Firestore session (runtime config from `/__/firebase/init.json`, custom-token sign-in) and the Firestore shared-list channel (same contract as `ListSocket`; writes go through REST) |
| `lib/utils.ts`, `lib/chart.ts` | Formatting (₹, dates), class merging, chart styling |
| `types/api.ts` | TypeScript mirrors of backend response schemas |
| `hooks/use-stores.tsx`, `hooks/use-job.ts` | Shopper store selection / merchant store filter; job polling |
| `components/ui/*` | Design-system components (Button, Card, Field/Input/Select, Badge/StatusBadge, Table, Dialog/side sheet, Tabs, Menu/Switch/Tooltip, feedback states, PageHeader/StatCard/Provenance/Pagination) |
| `components/layout/*` | `CustomerLayout` (top nav + mobile tab bar + store picker), `MerchantLayout` (sidebar by permission + store filter), `NotificationBell` |
| `components/maps/StoreMap.tsx` | SVG floor plan: fixtures, walkways, shelf sections, route, stops, highlights, keyboard-accessible sections, HTML5 drop targets, draggable movable fixtures |
| `features/auth` | Login page (one-click demo personas), auth context (`demoLogin`, `adopt`), route guard |
| `features/onboarding`, `features/channels` | Store-owner sign-up and setup wizard (incl. floor-plan builder); Channels & orders (connectors, API keys, POS simulator, live feed, developer quick start) |
| `features/<feature>` | One folder per feature with its page(s), components and tests (see §H) |
| `tests/` | Vitest setup and helpers (`mockApi`, `renderWithProviders`) |
| `e2e/` | Playwright specs: `customer.spec.ts`, `merchant.spec.ts` and `judge.spec.ts` (one-click owner, click & collect landing on the owner feed, new-store onboarding) |

---

## D. Architecture

### D.1 System architecture

```mermaid
flowchart TB
  subgraph Client
    SPA["React SPA (Vite dev server / nginx)"]
  end
  subgraph Backend["FastAPI modular monolith"]
    MW["Middleware: request ID, CORS, security headers, error envelope"]
    API["api/v1 routers (16)"]
    DEP["dependencies: auth, MerchantContext, permissions, store scope"]
    SVC["services: catalog · shopping · collaboration · navigation · inventory · expiry · pricing · forecasting · cross_selling · merchandising · layout · fraud · geofence · dashboard · notification · audit"]
    AIL["ai: providers · assistant · embeddings · visual_search"]
    ANA["analytics: forecasting · basket_analysis · anomaly_detection (pure)"]
    INT["integrations: weather · pos/pricing_publisher · notifications"]
    HUB["websocket hub + Firestore mirror"]
    Q["tasks: queue · handlers · worker/scheduler"]
  end
  DB[("PostgreSQL / SQLite")]
  REDIS[("Redis (optional)")]
  EXT[("OpenAI / Gemini / OpenWeatherMap / SMTP (optional)")]
  FS[("Firestore + Firebase Auth (optional)")]
  POS["POS / Shopify / storefront"]
  SPA -->|"/api/v1 JSON, httpOnly cookie"| MW --> API --> DEP
  SPA <-->|"/api/v1/ws/shopping-lists/{id}"| HUB
  API --> SVC --> DB
  SVC --> AIL --> ANA
  SVC --> ANA
  SVC --> INT
  HUB <--> SVC
  HUB -.-> REDIS
  Q --> SVC
  Q --> DB
  AIL -.-> EXT
  INT -.-> EXT
  HUB -.->|"Admin SDK writes"| FS
  FS -.->|"onSnapshot (custom token)"| SPA
  POS -->|"Orders API, X-Api-Key"| API
```

On Google Cloud the SPA is served by Firebase Hosting, which rewrites `/api/**`, `/media/**` and
`/health/**` to the Cloud Run service, so the browser talks to one origin.

### D.2 Frontend ↔ backend communication
* REST under `/api/v1`; the SPA calls relative URLs and Vite (dev) or nginx (container) proxies
  `/api`, `/media` and `/health` to the API, so the session cookie is same-origin.
* Session: `POST /auth/login` (or `POST /auth/demo-login`) sets the session cookie (`op_session`
  by default; `__session` on Firebase Hosting, the only cookie Hosting forwards), httpOnly,
  SameSite=Lax, Secure when `COOKIE_SECURE`.
  The JWT (`sub`, `sid`, `exp`) is validated **and** its `auth_sessions` row must be unrevoked.
  API clients may send `Authorization: Bearer <access_token>` instead.
* Errors: every non-2xx response is `{"error": {"code", "message", "details", "request_id"}}`.
* Server state is cached with TanStack Query; long jobs return `job_id`s polled via
  `GET /merchant/jobs/{id}`.

### D.3 Database access patterns
* One SQLAlchemy session per request (`get_db`); services own transactions and commit explicitly.
  Audit events are added in the same transaction as the change they describe.
* Bulk seed uses Core `insert()`; reads use typed `select()`; hot paths have composite indexes
  (`ix_sales_store_time`, `ix_batches_store_expiry`, `ix_list_events_list_seq`, …).
* Row locks (`FOR UPDATE`) serialise coupon redemption on PostgreSQL.

### D.4 AI provider abstraction — see [G](#g-ai-and-analytics) and ADR-0004.

### D.5 Background jobs
`enqueue()` → `job_runs` → worker claims → handler → `succeeded` / retry with backoff / `failed`.
Scheduled jobs (`tasks/worker.py: SCHEDULE`): `expiry_reevaluation` (hourly), `promotion_lifecycle`
(15 min), `stockout_risk_refresh` (6 h), `fraud_scan` (6 h), `forecast_refresh`, `analytics_refresh`,
`embedding_reindex` (daily). On-demand jobs: `inventory_import_commit`, `forecast_run`, `affinity_run`.

### D.6 WebSocket architecture
`/api/v1/ws/shopping-lists/{list_id}?last_seq=N[&token=…]`. On connect the server authenticates
(cookie or token), checks list membership (close code 4401/4404 otherwise), then sends either
`events` since `last_seq` (≤200) or a full `snapshot`. Client ops are applied through the same
service function as REST, acknowledged to the sender and broadcast to members. See §F.6.

**Firestore transport (cloud deployment).** Firebase Hosting cannot proxy WebSockets, so when
`FIREBASE_ENABLED=true` the hub also mirrors every list message to Firestore
(`shoppingLists/{id}` with `members`, `shoppingLists/{id}/events/{seq}`), and order / low-stock events
go to `merchants/{merchantId}/feed`. The browser asks `GET /realtime/config`, signs in to Firebase
with `POST /realtime/token` (custom token, uid = user id, `merchant_id` claim for staff), calls
`POST /realtime/lists/{id}/subscribe` and then listens with `onSnapshot`; operations are sent over
REST with `client_event_id`. `firestore.rules` only lets list members read their list and staff read
their own merchant's feed; browsers never write business data (only their own presence document).
Without Firebase the client falls back to the WebSocket (lists) or 5-second polling (feed).

### D.7 External integration boundaries
| Boundary | Interface | Implementations | Default |
|---|---|---|---|
| LLM / embeddings / vision | `AIProvider` | `DemoProvider`, `OpenAIProvider`, `GeminiProvider` | Demo (deterministic) |
| Weather | `forecast()/day()` | `SimulatedWeatherProvider`, `OpenWeatherMapProvider` | Simulated |
| Price publication (ESL/POS) | `PricePublisher.publish()` | `SimulatedPricePublisher` | Simulated |
| Notifications | `ChannelAdapter.send()` | `LogAdapter` (email/sms/push), `SmtpEmailAdapter` | Log (simulated) |
| POS / e-commerce orders | `POST /ingest/orders`, `POST /ingest/shopify/orders` (API key), `channel_service.ingest_order` | Generic JSON, Shopify `orders/create`, POS simulator, click & collect | Live API (no vendor-specific adapters yet) |
| Online storefront catalog | `GET /ingest/catalog` (API key) | Selling price incl. markdowns/promotions, stock, shelf | Live API |
| Real-time delivery | `FirebaseBridge` | Firestore (Admin SDK) | Off (WebSocket / polling) |
| Payments / self-checkout scale | order payload `payment_method`; `POST /merchant/fraud/transactions` harness | simulated only | Simulated |
| Geolocation | `POST /me/location` (foreground reports, consent-gated) | browser geolocation or demo simulator | Simulator |

### D.8 Authentication & authorization boundaries
Router dependencies: `get_current_user` (any signed-in user), `require_customer` (shopper APIs),
`require_permission("<code>")` (merchant APIs, resolves `MerchantContext`), plus
`get_store_scoped()` / `resolve_store_ids()` for store-level isolation. The frontend guards mirror
these but are not relied on for security.

### D.9 Customer shopping workflow

```mermaid
sequenceDiagram
  actor S as Shopper
  participant UI as SPA
  participant API as FastAPI
  participant SH as shopping_service
  participant CAT as catalog_service
  participant NAV as navigation_service
  S->>UI: "Milk, eggs, bread, chocolate, diapers, detergent, and coffee."
  UI->>API: POST /shopping-lists/parse
  API->>SH: parse_and_match
  SH->>SH: provider.parse_shopping_list (demo grammar or LLM, validated)
  SH->>CAT: hybrid search per item (store's carried products, popularity tie-break)
  API-->>UI: items + candidates + unresolved + merged duplicates
  S->>UI: confirm / change matches
  UI->>API: POST /shopping-lists
  UI->>API: POST /shopping-lists/{id}/route
  API->>NAV: Dijkstra distance matrix + Held-Karp (≤11 stop nodes) or NN+2-opt
  API-->>UI: ordered stops, path, turn-by-turn steps, unrouted items
  S->>UI: tick items (WebSocket op "collect")
```

### D.10 Inventory & expiry workflow

```mermaid
flowchart LR
  CSV["CSV/XLSX upload"] --> STAGE["stage_import: parse + validate rows<br/>(errors/warnings per field)"]
  STAGE --> PREVIEW["Preview: valid / errors / warnings"]
  PREVIEW -->|commit| JOB["job inventory_import_commit"]
  JOB --> APPLY["products, categories, batches,<br/>placements, stock ledger, audit"]
  APPLY --> EVAL["expiry_service.evaluate_merchant"]
  SCHED["hourly expiry_reevaluation"] --> EVAL
  EVAL --> ALERT["expiry_alerts (warning/critical/expired)"]
  EVAL --> MD["compute_markdown (heuristic)"]
  MD -->|markdown| PC["price_change RECOMMENDED"]
  MD -->|blocked by floor/caps| TASK["store_task move_to_clearance"]
  EVAL -->|past sell-by| WO["write-off + remove_expired task"]
```

### D.11 Pricing approval workflow

```mermaid
stateDiagram-v2
  [*] --> RECOMMENDED: create (guardrails checked)
  RECOMMENDED --> PENDING_APPROVAL: submit
  RECOMMENDED --> REJECTED
  RECOMMENDED --> CANCELLED
  PENDING_APPROVAL --> APPROVED: approve (guardrails re-checked)
  PENDING_APPROVAL --> REJECTED
  PENDING_APPROVAL --> CANCELLED
  APPROVED --> PUBLISHED: publish via PricePublisher (guardrails re-checked)
  APPROVED --> FAILED: publisher error / guardrail failure
  FAILED --> APPROVED: retry
  PUBLISHED --> EXPIRED: batch sold out or expired
  RECOMMENDED --> EXPIRED
  PENDING_APPROVAL --> EXPIRED
  APPROVED --> CANCELLED
  note right of APPROVED
    Auto-publication only if merchant enabled
    auto_publish_markdowns and discount ≤ auto_publish_max_pct
  end note
```

### D.12 Shared-shopping synchronisation

```mermaid
sequenceDiagram
  participant A as Member A (WebSocket)
  participant B as Member B (WebSocket)
  participant API as API instance
  participant DB as PostgreSQL
  participant R as Redis (optional)
  A->>API: {"type":"op","op":"collect","item_id":…,"client_event_id":"c1"}
  API->>DB: check role · apply (idempotent) · list.version += 1 · insert event(seq) · commit
  API-->>A: {"type":"ack","client_event_id":"c1","seq":42}
  API-->>B: {"type":"event","event":{seq:42,type:"item_collected",…}}
  API-->>R: publish list:<id> (other API instances deliver to their sockets)
  Note over B: B disconnects, A adds an item (seq 43)
  B->>API: reconnect ?last_seq=42
  API-->>B: {"type":"events","events":[{seq:43,…}]}
```

### D.13 Demand forecasting pipeline

```mermaid
flowchart LR
  TX["transaction_items (sales)"] --> AGG["daily_sales_frame<br/>zero-filled per product/day"]
  WX["weather_records<br/>(observed + forecast, source-labelled)"] --> FEAT
  CAL["calendar: weekday, holidays"] --> FEAT["features"]
  AGG --> BT["backtest last 14 days:<br/>seasonal_naive vs weather_ridge"]
  FEAT --> BT
  BT --> SEL["pick lower MAE"]
  SEL --> FIT["refit on full history,<br/>forecast horizon + 80% interval"]
  FIT --> RISK["stockout date vs sellable stock,<br/>days of cover, overstock, reorder qty"]
  RISK --> OUT["forecast_results + forecast_product_summaries<br/>+ explanation + stockout notification"]
```

---

## E. Database

### E.1 Entities (63 tables)

| Domain | Tables | Notes |
|---|---|---|
| Identity & tenancy | `users`, `roles`, `permissions`, `role_permissions`, `merchants`, `merchant_settings`, `merchant_memberships`, `store_memberships`, `auth_sessions` | `merchant_memberships.all_stores=false` + `store_memberships` restrict staff to stores. `merchant_settings` holds pricing/expiry/fraud/notification policy. |
| Stores & layouts | `stores`, `store_layouts` (versioned; `active`/`draft`/`archived`), `layout_fixtures`, `shelf_locations`, `nav_nodes`, `nav_edges`, `product_placements` | The walkable graph and placements are per layout version, so drafts never affect shoppers until published. |
| Catalog | `product_categories`, `products`, `product_images`, `product_embeddings`, `product_relations` | `product_embeddings` stores provider/model/dimensions/content hash. `product_relations` = curated compatibility. |
| Inventory | `inventory_items`, `inventory_batches`, `stock_adjustments`, `import_jobs`, `import_job_rows`, `expiry_alerts`, `store_tasks` | All stock lives in batches; on-hand = Σ batches; every change = ledger row. |
| Shopping | `shopping_lists`, `shopping_list_items`, `list_memberships`, `list_invitations`, `shopping_list_events` | `shopping_lists.version` is the event sequence; invitation tokens stored as SHA-256 hashes. |
| Sales & context | `sales_transactions`, `transaction_items`, `account_security_events`, `weather_records` | Returns reference `original_transaction_id`; `detected_quantity` = bagging-scale count (self-checkout). |
| Pricing | `pricing_rules`, `price_changes`, `price_change_events`, `promotions`, `promotion_products`, `coupons`, `coupon_redemptions` | `price_change_events` is the full workflow history. |
| Analytics | `forecast_runs`, `forecast_results`, `forecast_product_summaries`, `affinity_runs`, `affinity_rules`, `category_affinities`, `merchandising_recommendations` | Runs record parameters, metrics and status. |
| Fraud | `fraud_rules`, `fraud_alerts`, `fraud_investigations`, `investigation_notes`, `fraud_labels` | `fraud_labels` (synthetic ground truth) is used only for evaluation, never as a model feature. |
| Operations | `notifications`, `notification_preferences` (incl. consent), `geofence_events`, `audit_events`, `integration_configs`, `job_runs`, `api_keys` | Notifications de-duplicated by unique `idempotency_key`. `api_keys` store only a SHA-256 hash + prefix, optional store binding, usage and revocation. |

The complete generated ER diagram (every column, PK, FK) is in
[docs/architecture/er-diagram.md](docs/architecture/er-diagram.md). Core relationships:

```mermaid
erDiagram
  merchants ||--o{ stores : owns
  merchants ||--o{ products : sells
  merchants ||--o{ merchant_memberships : has
  users ||--o{ merchant_memberships : "member of"
  roles ||--o{ merchant_memberships : grants
  stores ||--o{ store_layouts : "versions"
  store_layouts ||--o{ layout_fixtures : contains
  store_layouts ||--o{ nav_nodes : graph
  store_layouts ||--o{ shelf_locations : shelves
  shelf_locations ||--o{ product_placements : holds
  products ||--o{ product_placements : "placed at"
  stores ||--o{ inventory_items : stocks
  products ||--o{ inventory_items : "stocked as"
  inventory_items ||--o{ inventory_batches : "made of"
  inventory_batches ||--o{ stock_adjustments : ledger
  inventory_batches ||--o{ expiry_alerts : raises
  inventory_batches ||--o{ price_changes : "marked down by"
  price_changes ||--o{ price_change_events : history
  promotions ||--o{ promotion_products : targets
  promotions ||--o{ coupons : issues
  stores ||--o{ sales_transactions : records
  sales_transactions ||--o{ transaction_items : lines
  sales_transactions ||--o{ fraud_alerts : flagged
  fraud_alerts ||--o| fraud_investigations : "reviewed in"
  users ||--o{ shopping_lists : owns
  shopping_lists ||--o{ shopping_list_items : items
  shopping_lists ||--o{ list_memberships : members
  shopping_lists ||--o{ list_invitations : invites
  shopping_lists ||--o{ shopping_list_events : "event log"
  forecast_runs ||--o{ forecast_product_summaries : summarises
  affinity_runs ||--o{ affinity_rules : mines
```

### E.2 Keys, indexes and constraints
* UUID primary keys everywhere (`Uuid` type; native `uuid` on PostgreSQL).
* Foreign keys with `ON DELETE CASCADE` for ownership and `SET NULL` for references (actors, optional links).
* Unique constraints enforce business identity: `(merchant_id, sku)`, `(store_id, product_id)`
  inventory, `(store_id, product_id, batch_code)`, `(list_id, seq)`, `(merchant_id, idempotency_key)`
  for imports, `dedupe_key` on alerts/tasks/price changes, `idempotency_key` on notifications,
  `(promotion_id, customer_id)` coupons.
* Indexes on tenant/time access paths (sales by store/merchant + time, batches by store + expiry,
  audit by merchant + time, notifications by user + time, jobs by status + schedule).

### E.3 Tenant isolation
Merchant APIs resolve a `MerchantContext` from the session and filter every query by
`merchant_id` and permitted `store_ids`; objects of other tenants return **404**. Tests
(`test_auth_and_tenancy.py::test_tenant_isolation_between_merchants`, `…store_manager_is_scoped…`)
verify this with a second demo merchant (UrbanBasket).

### E.4 Migrations
* `alembic/versions/0001_initial_schema.py` — full schema (autogenerated from the models, reviewed).
* `alembic/versions/0002_optional_pgvector.py` — adds `product_embeddings.embedding vector(256)` + HNSW
  index when the `vector` extension exists; no-op otherwise.
* `alembic/versions/0003_connector_api_keys.py` — `api_keys` table for connectors.
* `test_alembic_migrations_match_models` upgrades a fresh DB to head, asserts **no diff** between
  migrations and models, then downgrades to base.

```powershell
cd backend
.venv\Scripts\python -m app.cli migrate                     # upgrade head (uses DATABASE_URL)
.venv\Scripts\alembic revision --autogenerate -m "describe change"   # after editing models
```

### E.5 Seed data (`app/seed/demo.py`, all synthetic and flagged demo)
* Merchants **FreshMart** (stores AND01 Andheri West, BAN01 Bandra — Mumbai) and **UrbanBasket**
  (KOR01 Koramangala — Bengaluru, used for isolation tests).
* Sample 40 m × 30 m floor plan per store: 6 aisles × 2 faces × 4 sections × 5 levels, dairy chiller
  wall, produce/bakery wall, frozen wall, 5 endcaps, clearance bin, checkouts; walkable graph of ~75
  nodes.
* 77 FreshMart products / 25 UrbanBasket products (milk, eggs, bread, chocolate, diapers, detergent,
  coffee, tea, umbrellas, cameras, memory cards, smart watches, …) with synthetic packshot images.
* 120 days of simulated weather and ~44k basket-level transactions generated from "shopping
  missions" (breakfast, tea time, baby, rainy day, electronics with accessories, …), so co-purchase
  and rain associations exist in the data by construction (documented as synthetic).
* Batches with expiry dates, including **40 cartons of full-cream milk (MLK-002-B1) expiring within
  ~48 h at AND01**, a paneer batch blocked by its price floor (clearance), and an already-expired curd
  batch (withdrawn on evaluation).
* Legitimate returns plus labelled synthetic fraud scenarios (serial returner, duplicate receipt,
  receipt/product mismatch, self-checkout discrepancies, transaction velocity, account takeover
  return, repeated manual write-offs).
* Promotions (active, geofenced, ended), pricing rules, curated relations, shopping lists (one shared).
* Initial analytics runs: embeddings, affinity rules, forecasts per store, expiry evaluation,
  merchandising recommendations, fraud scan.
* Writes `data/sample/inventory_import_sample.csv` (relative dates; valid rows + deliberate errors)
  and `data/sample/query_images/*.jpg` (perturbed packshots standing in for customer photos).

Inventory quantities equal the sum of batch quantities; the ledger contains an opening "receive"
row per batch; dashboard aggregates are computed live from these tables, so they agree by
construction.

### E.6 Inspecting / resetting
```powershell
cd backend
.venv\Scripts\python -m app.cli check                 # configuration summary
.venv\Scripts\python -m app.cli reset --yes           # drop everything, migrate, reseed (refuses in production)
psql "postgresql://omnipulse:omnipulse@localhost:5432/omnipulse" -c "select code, name from stores;"
```

---

## F. API

* **Base URL**: `/api/v1` (development: `http://localhost:8000/api/v1`, or through the Vite proxy at
  `http://localhost:5173/api/v1`).
* **Interactive docs**: `http://localhost:8000/docs` (Swagger UI), `/redoc`, `/openapi.json`.
  A generated endpoint table (156 operations) is in [docs/api/endpoints.md](docs/api/endpoints.md);
  regenerate with `python -m app.docs_gen`.
* **Health**: `GET /health/live`, `GET /health/ready` (database, Redis, AI provider).

### F.1 Authentication
```http
POST /api/v1/auth/login
{"email": "admin@freshmart.demo", "password": "Demo@12345"}

200 → Set-Cookie: op_session=<jwt>; HttpOnly; SameSite=Lax
{"user": {...}, "merchant": {"merchant_id": "...", "role": "merchant_admin", "permissions": [...], "all_stores": true, "store_ids": []},
 "access_token": "<jwt>", "token_type": "bearer", "expires_at": "..."}
```
`POST /auth/logout` revokes the server-side session. `GET/PATCH /auth/me`. `POST /auth/register`
creates shopper accounts; `POST /onboarding/merchant` creates a store-owner account and tenant.
`GET /auth/demo-personas` and `POST /auth/demo-login {"persona": "customer"|"owner"|…}` give
password-less demo sign-in when `DEMO_LOGIN_ENABLED`. Merchant users may select a tenant with
`X-Merchant-Id`.

### F.2 Endpoint groups

| Group | Prefix / examples |
|---|---|
| Catalog (shopper) | `GET /stores`, `/stores/{id}`, `/stores/{id}/floorplan`, `/stores/{id}/categories`, `/stores/{id}/products?q=&category_id=&in_stock=&max_price=`, `/stores/{id}/products/{pid}`, `/stores/{id}/featured`, `/stores/{id}/weather` |
| Assistant & visual | `POST /assistant/chat`, `POST /visual-search` (multipart) |
| Shopping lists | `POST /shopping-lists/parse`, `GET/POST /shopping-lists`, `GET/PATCH/DELETE /shopping-lists/{id}`, `POST/PATCH/DELETE …/items[/{item_id}]`, `GET …/events?since=`, `POST …/route` |
| Shared shopping | `POST/GET …/invitations`, `DELETE …/invitations/{id}`, `GET /invitations/{token}`, `POST /invitations/{token}/accept`, `DELETE …/members/{user_id}`, `WS /ws/shopping-lists/{id}` |
| Navigation | `POST /stores/{id}/route` |
| Offers & preferences | `GET /offers?store_id=`, `POST /offers/{promo_id}/claim`, `GET/PATCH /me/preferences`, `POST /me/location`, `GET /notifications`, `POST /notifications/{id}/read`, `POST /notifications/read-all` |
| Merchant catalog | `GET/POST /merchant/products`, `GET/PATCH /merchant/products/{id}`, `GET /merchant/categories`, `POST /merchant/products/reindex` |
| Inventory | `GET /merchant/inventory`, `GET/PATCH /merchant/inventory/items/{id}`, `POST …/items/{id}/adjust`, `GET …/adjustments/recent`, imports: `GET …/imports/template`, `GET …/imports/sample`, `POST …/imports` (+`Idempotency-Key`), `GET …/imports[/{id}]`, `GET …/imports/{id}/rows?only=`, `POST …/imports/{id}/commit`, `POST …/imports/{id}/cancel` |
| Expiry | `GET /merchant/expiry/batches`, `POST /merchant/expiry/evaluate`, `GET/PATCH /merchant/expiry/alerts`, `GET /merchant/expiry/tasks`, `POST …/tasks/{id}/complete` |
| Forecasting | `POST/GET /merchant/forecasts`, `GET /merchant/forecasts/{id}`, `GET …/{id}/products/{pid}` |
| Pricing | `GET/POST /merchant/pricing/changes`, `GET …/changes/{id}`, `POST …/changes/{id}/{submit|approve|publish|reject|cancel}`, `GET/PATCH /merchant/pricing/policy`, `GET/POST/PUT /merchant/pricing/rules`, `GET /merchant/pricing/weather-opportunities` |
| Promotions | `GET/POST /merchant/promotions`, `POST …/simulate`, `GET …/{id}` (+performance), `POST …/{id}/actions`, `POST /merchant/coupons/redeem` |
| Layouts & merchandising | `GET /merchant/stores/{id}/layouts`, `POST …/layouts/draft`, `GET/DELETE /merchant/layouts/{id}`, `POST …/placements`, `DELETE …/placements/{pid}`, `PATCH …/fixtures/{fid}`, `POST …/publish`, `GET …/diff`; `GET /merchant/merchandising/recommendations`, `POST …/generate`, `GET …/{id}`, `POST …/{id}/review`, `POST …/{id}/apply-to-draft` |
| Cross-selling | `POST/GET /merchant/affinity/runs`, `GET …/runs/{id}`, `…/heatmap`, `…/graph` |
| Fraud | `GET /merchant/fraud/alerts`, `GET …/alerts/{id}`, `POST …/{id}/{investigation|notes|escalate|close}`, `POST /merchant/fraud/scan`, `GET /merchant/fraud/evaluation`, `GET/PATCH /merchant/fraud/rules`, `POST /merchant/fraud/transactions` |
| Admin | `GET /merchant/stores`, `/merchant/overview`, `/merchant/insights`, `/merchant/ai-brief?refresh=`, `/merchant/audit-events`, `GET/POST /merchant/jobs`, `GET /merchant/jobs/{id}`, `GET/PUT /merchant/integrations[/{kind}]`, `GET /merchant/layouts/{id}/rules` |
| Onboarding | `POST /onboarding/merchant`, `GET /merchant/onboarding/status`, `POST /merchant/stores`, `POST /merchant/stores/{id}/layout-preview`, `POST …/layout-generate`, `GET …/starter-catalog.csv`, `GET …/starter-sales.csv`, `POST /merchant/onboarding/finish` |
| Channels (merchant) | `GET /merchant/channels`, `POST/DELETE /merchant/channels/keys[/{id}]`, `GET /merchant/channels/orders`, `POST /merchant/channels/simulate`, `POST /merchant/channels/sales-history` (CSV) |
| Ingestion (API key) | `POST /ingest/orders`, `POST /ingest/shopify/orders?store_code=`, `GET /ingest/catalog?store_code=` — header `X-Api-Key` |
| Click & collect, realtime | `POST /shopping-lists/{id}/order`; `GET /realtime/config`, `POST /realtime/token`, `POST /realtime/lists/{id}/subscribe` |

### F.3 Examples
```http
POST /api/v1/shopping-lists/parse
{"store_id": "<AND01>", "text": "Milk, eggs, bread, chocolate, diapers, detergent, and coffee."}
200 {"items": [{"raw_text": "Milk", "quantity": 1, "unit": null, "product_id": "...",
      "display_name": "Amul Taaza Toned Milk 1 L", "confidence": 1.0, "status": "pending",
      "needs_review": true, "candidates": [{"product_id": "...", "name": "...", "price": 68.0, "in_stock": true, "score": 1.25, "location": "D-2-2"}, ...]}, ...],
     "duplicates_merged": [], "unresolved": [], "parser": {"provider": "demo", "kind": "deterministic", "fell_back": false}}

POST /api/v1/merchant/pricing/changes/{id}/approve
{"note": "ok", "publish": true}
200 {"status": "PUBLISHED", "publish_reference": "SIM-ESL-…", "events": [{"from": null, "to": "RECOMMENDED"}, …, {"to": "PUBLISHED"}], ...}

422 {"error": {"code": "business_rule_violation", "message": "Price change violates pricing guardrails",
               "details": {"violations": ["₹100 is below the price floor of ₹250.00."]}, "request_id": "a1b2…"}}
```

### F.4 Error format
| Status | `code` | When |
|---|---|---|
| 401 | `not_authenticated`, `invalid_credentials` | missing/expired/revoked session, wrong password |
| 403 | `forbidden` | missing permission, wrong account type, store out of scope, viewer editing |
| 404 | `not_found` | unknown or other tenant's resource |
| 409 | `conflict` | stale `expected_version`, duplicate SKU/email, coupon already redeemed |
| 422 | `validation_failed` | schema validation (details = field errors) |
| 422 | `business_rule_violation`, `invitation_expired/revoked/exhausted` | guardrails, invalid state transitions, constraints |
| 429 | `rate_limited` | login/registration/assistant/visual/location limits |
| 500 | `internal_error` | unexpected (logged with request ID; no internals leaked) |

### F.5 Pagination
List endpoints that can grow accept `page` (≥1) and `page_size` (≤200) and return
`{"items": [...], "total", "page", "page_size"}` (products, inventory, import rows, price changes,
fraud alerts, audit events).

### F.6 WebSocket events (`/api/v1/ws/shopping-lists/{list_id}`)
| Direction | Message |
|---|---|
| server→client | `{"type":"snapshot","list":ListView}` · `{"type":"events","events":[Event],"list_version":n}` · `{"type":"event","event":Event}` · `{"type":"ack","client_event_id","seq","item"}` · `{"type":"error","client_event_id","code","message","details"}` · `{"type":"presence","members_online":[{user_id,name}]}` · `{"type":"pong"}` · `{"type":"list_deleted"}` |
| client→server | `{"type":"op","op":"add_item|update_item|remove_item|collect|uncollect","client_event_id", ...fields}` · `{"type":"ping"}` |

`Event = {seq, type: list_created|item_added|item_updated|item_removed|item_collected|item_uncollected|member_joined|member_left|list_updated, item_id, actor_id, actor_name, payload, client_event_id, created_at}`. Close codes: 4401 unauthenticated, 4404 not a member.

---

## G. AI and analytics

Every analytics output is labelled in the UI by method: **Business rule**, **Heuristic**,
**Statistical model**, **ML model**, **LLM**, **Deterministic AI fallback**, **Simulated data**.

| Feature | Kind | Input | Processing / algorithm | Output | Fallback | Limitations | Configuration | Evaluation |
|---|---|---|---|---|---|---|---|---|
| Intent extraction | LLM (OpenAI/Gemini JSON schema) **or** deterministic rules | message, optional context product | `extract_intent` → `ShoppingIntent` (validated) | intent, queries, budget, people, occasion, reference | Demo rules on missing key/any failure | Rules cover common grocery phrasings only | `AI_PROVIDER`, model vars | `test_shopping_flows.py` assistant tests |
| Assistant answers | Tool use by backend + LLM/template phrasing | intent + verified facts | catalog search, stock, prices, locations, curated relations, mined rules; budget basket greedy fill (essentials first, cheapest viable match) | message + product cards + basket + directions | Template from same facts; replies with unverified ₹ amounts or unknown product IDs are replaced (amounts the shopper stated and greeting examples are allowed) | Template phrasing is basic in demo mode | — | `test_grounding_rejects_unverified_amounts`, `test_grounding_allows_shopper_amounts_and_greeting_examples` |
| AI morning brief | LLM over verified facts **or** template | KPIs + numbered facts (expiry alerts, low stock, stockout risk, pending prices, fraud, merchandising, channel mix) | provider writes headline + ≤5 actions citing fact ids; rejected if it cites unknown facts or writes numbers not in the facts | prioritised actions with links and evidence | Template ordered by priority | Facts are a fixed set of queries | `AI_PROVIDER` | `test_ai_brief_is_grounded`, `test_llm_brief_rejects_ungrounded_numbers` |
| Shopping-list parsing | Deterministic grammar (default) or LLM | free text | split on commas/newlines/"and"/sentences; quantity & unit grammar (dozen → 12 pc) | items | Demo grammar | Complex sentences may need edits in the review step | — | parse tests |
| Product matching / search | Lexical + **semantic retrieval** | query | field-weighted token/prefix matching (name 3, brand/category/tags 2, description 0.8) + synonym expansion, combined 70/30 with embedding cosine; popularity tie-break; threshold 0.30 | ranked products, candidates, confidence | Lexical-only if embeddings unavailable | Demo embeddings are hashed lexical features (spelling/synonyms, not meaning) | `EMBEDDING_DIMENSIONS` | search tests |
| Embeddings | Demo hashed n-grams or provider embeddings | product text | stored per model with content hash; re-embed when stale | 256-d vectors | — | NumPy scoring per tenant (see M) | provider vars | — |
| Visual search | **Image matching** (deterministic descriptor) + optional vision caption | uploaded JPEG/PNG/WebP ≤ 5 MB | HSV foreground histogram (108 bins) + 4×4 colour layout, cosine ≥ 0.55; with a vision provider: caption → catalog search, 50/50 blend in which products the caption does not match score 0 on text | matches with similarity | — | Not object recognition; matches colour/packaging similarity to catalog images | vision-capable provider | `test_visual_search_matches_query_photo` |
| Routing | Deterministic graph algorithms | list items, start point, accessible flag | Dijkstra distance matrix; Held-Karp exact open-path TSP (≤ 11 stop nodes) else nearest-neighbour + 2-opt; turn detection from heading changes | ordered stops, path, steps, distance saved vs list order | — | No indoor positioning; start point is manual | — | brute-force equivalence tests |
| Markdown recommendations | **Heuristic** with explicit assumptions | batch qty, hours to sell-by, 14-day velocity (FEFO-allocated across batches), price, cost, floor, policy | expected = v·days; needed discount = (qty/expected − 1)/elasticity, rounded up to 5 %, capped by time tier & max markdown & floor; leftover → clearance | price change + clearance task | — | Elasticity is an assumption (default 2.0, configurable), not learned | `pricing_rules` (`expiry_markdown`), `merchant_settings` | unit tests in `test_unit_algorithms.py` |
| Demand forecasting | **Statistical baseline + ML** | daily units, weather, calendar | seasonal naive (mean of last 4 same weekdays) vs Ridge(weekday, trend, precip, rain flag, temp, holiday); 14-day backtest picks lower MAE; ±1.28σ interval | per-day forecast + interval, stockout risk, reorder qty, explanation | seasonal naive for sparse series | Weather associations are not causal; backtests use observed weather | horizon/history per run | MAE/RMSE/WAPE per product and per model in `forecast_runs.metrics` |
| Weather opportunities | Deterministic rule + historical evidence | forecast, rain-day vs dry-day sales, stock, floors | qualifies if rain ≥ 5 mm forecast, ≥5 rainy & dry days observed with ratio ≥ 1.3, stock ≥ 1.2× expected, eligible, above floor | promotion draft suggestion | Simulated weather | Association only | `pricing_rules` (`weather_promotion`) | — |
| Product affinity | **Association rules** | sale baskets in window | pair-wise Apriori: support, confidence, lift with min support / confidence / pair count and ≥ 200 baskets; category-level lift matrix | rules, heatmap, network graph | run fails with "insufficient data" | Pairs only (no 3-item sets); correlation ≠ causation | run parameters | exact-value unit test |
| Merchandising | Deterministic, evidence-based | rules, placements, walking distance, velocity, margin, weights | adjacency tests (lift ≥ 1.5, conf ≥ 0.2, ≥ 20 pairs, ≥ 12 m apart; cheaper complement placed near anchor); eye-level tests; safety relocations | recommendation + evidence quality + A/B plan (sample size rule of thumb) | — | Outcome tracking is observational before/after | constants in `merchandising_service.py` | — |
| Merchandising guardrails | **Business rules** | product, shelf, fixture | `layout_service.PLACEMENT_RULES`: chilled goods in chillers, ≥5 kg not above 100 cm, no kids' treats (children's products, confectionery, crisps) at checkouts, warning ≤90 cm (kids' eye level), capacity, chiller space, walkway clearance; AI generators never propose violating placements | block / warn + rule book with live compliance | — | Tag-based detection of confectionery | constants in `layout_service.py` | `test_placement_rule_book_and_kid_height_warning` |
| Fraud | **Business rules** + **anomaly detection** | transactions, returns, receipts, security events, adjustments | 8 weighted, configurable rules (severity-scaled); IsolationForest percentile over behavioural features; risk = 0.75·rules + 0.25·anomaly | review-queue alerts with explanations | — | Synthetic labels; no automatic actions | `fraud_rules`, `fraud_alert_threshold` | precision/recall vs labels + reviewer outcomes (`/merchant/fraud/evaluation`) |

LLM calls are bounded: each request times out after `AI_REQUEST_TIMEOUT_SECONDS` (12 s on Cloud Run),
and after a timeout or a 402/429/5xx error the provider is skipped for 60 s (deterministic fallback
answers immediately) so users never wait on a failing model. Gemini 3 models are asked for a low
thinking level; models that reject that setting are retried without it.

---

## H. Feature implementation map

| Feature | Frontend | Backend | Database entities | APIs | Background jobs | External integrations | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| Auth & roles | `features/auth` | `api/v1/auth.py`, `services/auth_service.py`, `api/dependencies.py` | users, roles, permissions, memberships, auth_sessions | `/auth/*` | — | — | `test_auth_and_tenancy.py`, `auth.test.tsx` | Implemented |
| Shopping home & catalog | `features/shopping-assistant` (Home, Product) | `products.py`, `catalog_service.py` | products, categories, inventory, placements, promotions | `/stores/*` | `embedding_reindex` | — | `test_shopping_flows.py` | Implemented |
| Conversational concierge | `features/shopping-assistant/AssistantPage` | `ai/recommendations/assistant.py`, `ai/providers/*` | (reads catalog) | `/assistant/chat` | — | OpenAI/Gemini optional | assistant tests | Implemented (demo provider; LLM adapters untested without keys) |
| Visual discovery | `features/visual-discovery` | `ai/visual_search/*` | product_images | `/visual-search` | `embedding_reindex` (images) | vision provider optional | visual tests | Implemented (colour/layout matching) |
| Smart lists & routing | `features/shopping-lists`, `features/store-navigation` | `shopping_service.py`, `navigation_service.py` | shopping_lists/items/events, nav_nodes/edges, shelf_locations | `/shopping-lists/*`, `/stores/{id}/route` | — | — | shopping + routing tests | Implemented |
| Shared shopping | `features/shared-shopping`, list detail | `collaboration_service.py`, `shared_shopping.py`, `websocket/hub.py` | list_memberships, list_invitations, events | invitations + WS | — | Redis optional | WS sync, permissions, invitations tests | Implemented |
| Proximity offers & reminders | `features/promotions/OffersPage` | `geofence_service.py`, `notification_service.py` | geofence_events, notifications, preferences, coupons | `/me/location`, `/me/preferences`, `/offers` | `promotion_lifecycle` | Native push not implemented | geofence test | Implemented (foreground + simulator) |
| Merchant overview | `features/merchant-dashboard/OverviewPage` | `dashboard_service.py` | all | `/merchant/overview` | — | — | dashboard consistency test | Implemented |
| Catalog management | `features/inventory/CatalogPage` | `products.py` | products, categories | `/merchant/products` | `embedding_reindex` | — | tenancy tests | Implemented |
| Inventory & import | `features/inventory` | `inventory_service.py`, `inventory.py` | inventory_items, batches, stock_adjustments, import_jobs/rows | `/merchant/inventory/*` | `inventory_import_commit` | — | import + ledger tests | Implemented (CSV + XLSX) |
| Expiry management | `features/expiry-management` | `expiry_service.py`, `pricing_policy.py` | expiry_alerts, store_tasks, price_changes | `/merchant/expiry/*` | `expiry_reevaluation` | — | markdown + workflow tests | Implemented |
| Pricing workflow | `features/dynamic-pricing` | `pricing_service.py`, `pricing.py` | price_changes, events, pricing_rules, merchant_settings | `/merchant/pricing/*` | — | Simulated ESL/POS publisher | approval, failure/retry, auto-publish tests | Implemented (simulated publisher) |
| Promotions & coupons | `features/dynamic-pricing` | `pricing_service.py`, `promotions.py` | promotions, promotion_products, coupons, redemptions | `/merchant/promotions/*`, `/offers` | `promotion_lifecycle` | Simulated POS redemption | promotion lifecycle test | Implemented |
| Weather opportunities | `features/dynamic-pricing` | `pricing.py` (`weather-opportunities`), `weather_service.py` | weather_records | `/merchant/pricing/weather-opportunities` | — | OpenWeatherMap optional | weather test | Implemented (simulated weather) |
| Demand forecasting | `features/demand-forecasting` | `forecasting_service.py`, `analytics/forecasting` | forecast_runs/results/summaries | `/merchant/forecasts/*` | `forecast_run`, `forecast_refresh`, `stockout_risk_refresh` | weather | model unit tests + API test | Implemented |
| Store layout / planogram | `features/merchandising/LayoutPage` | `layout_service.py`, `merchandising.py` | store_layouts, fixtures, shelf_locations, placements | `/merchant/layouts/*` | — | — | planogram constraint tests | Implemented (simplified editor) |
| Merchandising recommendations | `features/merchandising/MerchandisingPage` | `merchandising_service.py` | merchandising_recommendations | `/merchant/merchandising/*` | `analytics_refresh` | — | recommendation tests | Implemented |
| Cross-selling analytics | `features/cross-selling` | `cross_selling_service.py`, `analytics/basket_analysis` | affinity_runs/rules, category_affinities | `/merchant/affinity/*` | `affinity_run`, `analytics_refresh` | — | association tests | Implemented |
| Fraud shield | `features/fraud-monitoring` | `fraud_service.py`, `analytics/anomaly_detection` | fraud_rules/alerts/investigations/notes/labels | `/merchant/fraud/*` | `fraud_scan` | Simulated POS/self-checkout | fraud tests | Implemented (synthetic data) |
| Shopping insights | `features/merchant-dashboard/InsightsPage` | `dashboard_service.customer_insights` | sales, lists | `/merchant/insights` | — | — | dashboard test | Implemented |
| Integrations, settings, audit, jobs | `features/merchant-dashboard` | `analytics.py`, `audit_service.py`, `tasks/*` | integration_configs, audit_events, job_runs | `/merchant/integrations`, `/merchant/audit-events`, `/merchant/jobs` | all | — | job/scheduler tests | Implemented |
| One-click demo sign-in | `features/auth/LoginPage` | `auth.py`, `auth_service.demo_login` | auth_sessions | `/auth/demo-personas`, `/auth/demo-login` | — | — | `test_one_click_demo_login`, `auth.test.tsx` | Implemented (disable with `DEMO_LOGIN_ENABLED=false`) |
| Store-owner onboarding | `features/onboarding` | `onboarding.py`, `onboarding_service.py`, `seed/layout_builder.py` | merchants, stores, layouts, products, sales | `/onboarding/merchant`, `/merchant/stores…`, `/merchant/onboarding/*` | import commit, analytics jobs | — | `test_new_store_owner_end_to_end`, `onboarding.test.tsx`, `judge.spec.ts` | Implemented |
| Channels & connectors | `features/channels` | `channels.py`, `channel_service.py` | api_keys, sales_transactions, batches, stock_adjustments | `/merchant/channels/*`, `/ingest/*` | — | Shopify webhook format; Firestore feed | `test_shopify_webhook_and_stock_rules`, `test_pos_simulator_consumes_fefo`, `channels.test.tsx` | Implemented (generic + Shopify; vendor POS adapters on roadmap) |
| Click & collect | `shopping-lists/components/PickupOrderCard` | `shopping_lists.py` (`/order`), `channel_service` | sales_transactions, list events | `/shopping-lists/{id}/order` | — | Firestore feed | `test_click_and_collect_from_shared_list` | Implemented (payment simulated) |
| AI morning brief | `merchant-dashboard/components/AiBriefCard` | `brief_service.py`, `llm_base.operations_brief` | (reads operational tables) | `/merchant/ai-brief` | — | Gemini | brief tests | Implemented |
| Real-time over Firestore | `lib/firebase.ts`, `lib/list-firestore.ts`, `channels/LiveOrdersFeed` | `integrations/firebase`, `realtime.py` | (mirrors list events / feed) | `/realtime/*` | — | Firestore, Firebase Auth | `test_realtime_negotiation_without_firebase` | Implemented (cloud deployment) |
| Notifications | `features/notifications`, `NotificationBell` | `notification_service.py`, `notifications.py` | notifications, preferences | `/notifications/*` | various | Log/SMTP adapters | geofence test | Implemented (in-app; email via SMTP optional) |

---

## I. Environment variables

All are optional in demo mode; see [.env.example](.env.example). Empty values (`KEY=`) mean "use
the default". Secrets are marked ●.

| Variable | Purpose | Example / format | Required | Default | Secret |
|---|---|---|---|---|---|
| `APP_ENV` | development / test / production (production enforces strong JWT secret + secure cookies) | `production` | No | `development` | |
| `LOG_LEVEL`, `LOG_JSON` | Logging level, JSON log lines | `INFO`, `true` | No | `INFO`, `false` | |
| `DEMO_MODE` | Informational flag for demo deployments | `true` | No | `true` | |
| `DATABASE_URL` | SQLAlchemy URL | `postgresql+psycopg://user:pass@host:5432/db` | No | SQLite file `backend/omnipulse.db` | ● (if it contains a password) |
| `DATABASE_ECHO` | Log SQL | `false` | No | `false` | |
| `REDIS_URL` | WebSocket fan-out + shared rate limits | `redis://localhost:6379/0` | No | none (in-process) | |
| `JWT_SECRET` | Signs session JWTs | 32+ random chars | **Yes in production** | dev-only value | ● |
| `JWT_ALGORITHM` | JWT algorithm | `HS256` | No | `HS256` | |
| `ACCESS_TOKEN_MINUTES` | Session lifetime | `720` | No | `720` | |
| `SESSION_COOKIE_NAME` | Cookie name (`__session` behind Firebase Hosting) | `__session` | No | `op_session` | |
| `COOKIE_SECURE` | Secure cookie flag (HTTPS) | `true` | **Yes (true) in production** | `false` | |
| `COOKIE_SAMESITE` | `lax` / `strict` / `none` | `lax` | No | `lax` | |
| `CORS_ORIGINS` | Allowed origins (comma-separated) | `https://app.example.com` | No | `http://localhost:5173,http://127.0.0.1:5173` | |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | Per IP and per email | `10` | No | `10` | |
| `INVITATION_TTL_HOURS` | Default shared-list invitation lifetime | `72` | No | `72` | |
| `FRONTEND_BASE_URL` | Used in invitation links | `https://app.example.com` | No | `http://localhost:5173` | |
| `AI_PROVIDER` | `demo` / `openai` / `gemini` | `openai` | No | `demo` | |
| `OPENAI_API_KEY` | OpenAI key | `sk-…` | With `openai` | none | ● |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL | `https://api.openai.com/v1` | No | as shown | |
| `OPENAI_CHAT_MODEL`, `OPENAI_EMBEDDING_MODEL` | Models | `gpt-4.1-mini`, `text-embedding-3-small` | No | as shown | |
| `GEMINI_API_KEY` | Gemini key (sent as `x-goog-api-key` header) | — | With `gemini` | none | ● |
| `GEMINI_BASE_URL`, `GEMINI_CHAT_MODEL`, `GEMINI_EMBEDDING_MODEL` | Gemini endpoints/models | `gemini-3.5-flash-lite` (the GCP deploy script picks the newest Flash model the key can use), `gemini-embedding-001` | No | as shown | |
| `EMBEDDING_DIMENSIONS` | Vector size for all providers | `256` | No | `256` | |
| `AI_REQUEST_TIMEOUT_SECONDS` | Provider HTTP timeout (per call) | `12` on Cloud Run | No | `30` | |
| `WEATHER_PROVIDER` | `simulated` / `openweathermap` | `openweathermap` | No | `simulated` | |
| `OPENWEATHER_API_KEY` | OpenWeatherMap One Call 3.0 key | — | With `openweathermap` | none | ● |
| `PRICING_PUBLISHER` | Price publication adapter | `simulated` | No | `simulated` | |
| `EMAIL_PROVIDER` | `log` (simulated) / `smtp` | `smtp` | No | `log` | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_FROM` | SMTP settings | `smtp.example.com`, `587` | With `smtp` | none / `587` / — / `no-reply@omnipulse.local` | |
| `SMTP_PASSWORD` | SMTP password | — | With `smtp` | none | ● |
| `SMS_PROVIDER`, `PUSH_PROVIDER` | Only `log` (simulated) is implemented | `log` | No | `log` | |
| `MEDIA_DIR` | Product images / uploads directory served at `/media` | `/app/media` | No | `backend/media` | |
| `SAMPLE_DATA_DIR` | Where the seed writes sample CSV and query photos | `/app/media/sample` | No | `data/sample` | |
| `MAX_UPLOAD_MB`, `MAX_CSV_ROWS` | Upload limits | `5`, `5000` | No | `5`, `5000` | |
| `RUN_WORKER_IN_PROCESS` | Run the worker thread inside the API | `false` in production | No | `true` | |
| `WORKER_POLL_SECONDS`, `ENABLE_SCHEDULER` | Worker polling / periodic jobs | `2`, `true` | No | `2`, `true` | |
| `JOBS_EAGER` | Run jobs synchronously at enqueue (tests) | `false` | No | `false` | |
| `TEST_DATABASE_URL` | Run the backend test-suite on PostgreSQL | postgres URL | No | SQLite | ● |
| `FIREBASE_ENABLED` | Mirror lists/feed to Firestore and mint Firebase custom tokens (needs Application Default Credentials) | `true` | No | `false` | |
| `FIREBASE_PROJECT_ID` | Firebase / Google Cloud project | `aibuilder-5681b` | With Firebase | from credentials | |
| `DEMO_LOGIN_ENABLED` | One-click demo personas on the sign-in page | `false` for real tenants | No | `true` | |
| `SEED_ON_STARTUP` | Migrate and seed the demo dataset on boot when the DB is empty (Cloud Run + SQLite) | `true` | No | `false` | |
| `VITE_FIREBASE_CONFIG` | Frontend: Firebase web config JSON for local testing (Hosting serves it automatically) | `{"apiKey":…,"projectId":…}` | No | none | |
| `VITE_API_BASE_URL` | Frontend: API origin when not proxied | `https://api.example.com` | No | same origin | |
| `VITE_BACKEND_URL` | Vite dev proxy target | `http://127.0.0.1:8000` | No | as shown | |

---

## J. Local development guide

### Prerequisites
* Python **3.12+** (3.14 used during development), Node.js **24+** (npm 11), Git.
* Optional: PostgreSQL 15+ (pgvector optional), Redis 7, Docker Desktop.

### J.1 Without Docker — Windows PowerShell
```powershell
git clone <repo> omnipulse-ai; cd omnipulse-ai
Copy-Item .env.example .env            # optional: edit DATABASE_URL etc.

# Backend
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev,redis,pgvector]"
.venv\Scripts\python -m app.cli migrate      # creates tables (SQLite by default)
.venv\Scripts\python -m app.cli seed         # ~20-40 s; prints the demo password
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
# API docs: http://localhost:8000/docs

# Frontend (second terminal)
cd frontend
npm ci
npm run dev                                  # http://localhost:5173
```
Or use the helper: `./scripts/dev.ps1 install`, `./scripts/dev.ps1 setup`, `./scripts/dev.ps1 api`,
`./scripts/dev.ps1 web`.

To use PostgreSQL set, before `migrate`:
```powershell
$env:DATABASE_URL = "postgresql+psycopg://omnipulse:omnipulse@localhost:5432/omnipulse"
```

### J.2 Without Docker — macOS / Linux
```bash
cp .env.example .env
cd backend && python3 -m venv .venv && .venv/bin/pip install -e ".[dev,redis,pgvector]"
.venv/bin/python -m app.cli migrate && .venv/bin/python -m app.cli seed
.venv/bin/python -m uvicorn app.main:app --reload --port 8000
cd ../frontend && npm ci && npm run dev
```
(`make install`, `make migrate seed`, `make dev-api`, `make dev-web` do the same.)

### J.3 With Docker Compose
```bash
docker compose up --build
# web:  http://localhost:8080   api: http://localhost:8000/docs
docker compose run --rm backend python -m app.cli reset --yes     # reset demo data
```
Compose runs PostgreSQL with pgvector, Redis, a one-shot `migrate` service (migrate + seed if
empty), the API (worker disabled) and a separate `worker` process, and nginx serving the SPA.

### J.4 Demo access (local only — not for production)
Password for every demo account: **`Demo@12345`**

| Account | Role |
|---|---|
| `priya@demo.omnipulse.ai` | Shopper (owns a shared list) |
| `rohan@demo.omnipulse.ai` | Shopper (member of Priya's list) |
| `admin@freshmart.demo` | FreshMart merchant admin |
| `manager.andheri@freshmart.demo` | Store manager (Andheri only) |
| `analyst@freshmart.demo` | Analyst (read-only + run analyses) |
| `admin@urbanbasket.demo` | Second tenant admin (isolation) |

### J.5 Running the worker separately
Set `RUN_WORKER_IN_PROCESS=false` for the API and run `python -m app.tasks.worker` (several
instances are safe on PostgreSQL). `python -m app.cli run-jobs` drains the queue once.

---

## K. Testing and troubleshooting

### K.1 Test suites
```powershell
cd backend;  .venv\Scripts\python -m pytest                    # SQLite (fast, isolated copies per module)
$env:TEST_DATABASE_URL="postgresql+psycopg://omnipulse:omnipulse@localhost:5432/omnipulse_test"; .venv\Scripts\python -m pytest
.venv\Scripts\ruff check app tests
cd ..\frontend; npm test; npm run lint; npm run typecheck; npm run build
npx playwright install chromium; npm run e2e                   # needs API on :8000 and dev server (auto-started)
```
Backend tests cover authentication, sessions, rate limits, role permissions, tenant isolation,
catalog search, list parsing, routing optimality (vs brute force), shared-list permissions,
invitations and WebSocket sync/resync/idempotency, CSV/XLSX import validation and commit, inventory
ledger invariants, markdown guardrails, the full price-change state machine (incl. publisher failure
and auto-publish policy), promotions/coupons, weather opportunities, forecasting models and runs,
association metrics, merchandising/planogram constraints, fraud detection/investigation/evaluation,
geofence consent and cooldowns, dashboard aggregates vs DB, job queue/scheduler, health checks and
migration/model parity.

Last verified run (this repository state): backend **88 passed** (SQLite; `test_scheduler_is_idempotent`
can fail on Windows because of coarse clock resolution), ruff clean. Frontend **90 passed** (22 files),
ESLint and `tsc -b` clean, production build OK. Playwright `judge.spec.ts`: **3/3 passed** (one-click
owner → AI brief → POS simulator; click & collect → order on the owner's feed; new store owner →
setup wizard → live). The Gemini adapter, Firestore mirroring and Firebase custom tokens were verified
on the live Cloud Run deployment (chat 1.5–2.1 s, all 8 sample photos matched first in photo search);
OpenAI, OpenWeatherMap and SMTP adapters were **not** exercised (no credentials).

### K.2 Common problems
| Symptom | Cause / fix |
|---|---|
| `Cannot reach the OmniPulse API` in the UI | Start the API on port 8000 (or set `VITE_BACKEND_URL`). |
| `connection refused` / `password authentication failed` | Check `DATABASE_URL`; for Docker the host is `db`, locally `localhost`. |
| `relation "…" does not exist` | Run `python -m app.cli migrate`. |
| Alembic "Target database is not up to date" / multiple heads | `alembic heads`, `alembic upgrade head`; never edit applied migrations — add a new one. |
| `Database already contains data` on seed | Use `python -m app.cli reset --yes` (development only). |
| WebSocket closes with 4401 | Session cookie missing/expired (sign in again) or wrong origin; with a separate API origin pass `?token=`. |
| WebSocket closes with 4404 | User is not a member of the list. |
| Real-time updates not crossing API replicas | Set `REDIS_URL` on every API instance. |
| `AI_PROVIDER=openai but no API key` warning | Set `OPENAI_API_KEY`, or keep `demo`. Check `GET /health/ready` (`ai_provider`). |
| Assistant response `provider.fell_back=true` | The LLM call failed or returned invalid JSON; the deterministic fallback answered. See API logs (`gcloud run services logs read omnipulse-api`). A `402 prepayment credits are depleted` means the Gemini key's project has no credit: use a key from a project without billing (free tier). |
| Live feed shows "Auto-refresh" instead of "Live · Firestore" | Firebase Authentication not initialised (Firebase console → Authentication → Get started) or `FIREBASE_ENABLED` is off; polling keeps working. |
| 502 from Firebase Hosting on `/api` | The Cloud Run request exceeded Hosting's 60 s limit or the instance was restarting (seeding takes ~30 s). |
| `ZoneInfoNotFoundError` on Windows | `tzdata` must be installed (it is a dependency). |
| 429 on login during scripted tests | Raise `LOGIN_RATE_LIMIT_PER_MINUTE`. |
| Images missing in the catalog | Seed writes to `MEDIA_DIR`; make sure the API serves the same directory. |

---

## L. Deployment

* **Images**: `backend/Dockerfile` (python:3.13-slim, non-root user, healthcheck; runs uvicorn —
  override the command with `python -m app.tasks.worker` for workers) and `frontend/Dockerfile`
  (Node build → nginx; proxies `/api` incl. WebSockets, `/media`, `/health`).
* **Configuration**: `APP_ENV=production`, strong `JWT_SECRET`, `COOKIE_SECURE=true`, exact
  `CORS_ORIGINS`, PostgreSQL `DATABASE_URL`, `REDIS_URL` when running >1 API replica,
  `RUN_WORKER_IN_PROCESS=false` with dedicated worker processes, `LOG_JSON=true`. The API refuses to
  start in production with a weak JWT secret or insecure cookies.
* **Migrations**: run `python -m app.cli migrate` (Alembic `upgrade head`) as a one-off release step
  before rolling out API pods; migrations are forward-only in production.
* **HTTPS**: terminate TLS at the load balancer/ingress; keep `--proxy-headers`; set HSTS there.
* **Observability**: JSON logs carry `request_id` (also returned as `X-Request-Id`); slow requests
  (>1.5 s) are logged; `/health/live` (liveness) and `/health/ready` (DB/Redis/AI) for probes; job
  outcomes are queryable in `job_runs`. Add metrics/tracing (e.g. OpenTelemetry) before production.
* **Backups**: PostgreSQL PITR (WAL archiving) or managed backups; back up `MEDIA_DIR` (product
  images). The audit log and stock ledger are append-only and must be retained per policy.
* **Scaling**: stateless API replicas (+Redis for WebSocket fan-out and rate limits), N workers,
  PostgreSQL connection pooling (pgBouncer), pgvector kNN for very large catalogs.
* **Security hardening** before production: CSRF token (in addition to SameSite) if cross-site
  embedding is possible, account lockout/MFA for merchant users, secret manager for env vars,
  malware scanning for uploads, WAF/rate limiting at the edge, data-retention policy for location
  events, legal review of pricing/promotions and consumer-protection compliance, privacy review.
* **External integrations**: set `AI_PROVIDER` + key, `WEATHER_PROVIDER=openweathermap` + key,
  `EMAIL_PROVIDER=smtp` + SMTP vars. ESL/POS publication, payments, SMS and push require writing an
  adapter implementing the existing interfaces (`PricePublisher`, `ChannelAdapter`).

See also [docs/deployment/README.md](docs/deployment/README.md).

### L.1 Google Cloud deployment (live demo)
`GEMINI_API_KEY='…' bash ./scripts/deploy-gcp.sh <project-id> [region]` (best run from Cloud Shell)
enables the APIs, adds Firebase and a web app, creates Firestore, a service account (Firestore user +
token creator on itself), Secret Manager secrets (JWT secret, Gemini key), picks the newest Gemini
Flash-Lite model the key can use, deploys `backend/` to **Cloud Run** (max one instance, SQLite demo
database seeded on start, scale to zero plus a free Cloud Scheduler keep-warm ping, or `ALWAYS_ON=1`),
builds the SPA and deploys **Firebase Hosting** and `firestore.rules`. One manual step: Firebase
console → Authentication → Get started. Reset to clean demo data with
`gcloud run services update omnipulse-api --region us-central1 --update-env-vars DEMO_RESET=$(date +%s)`.
Details, costs and troubleshooting: [docs/deployment/GCP.md](docs/deployment/GCP.md).

---

## M. Known limitations and roadmap

**Simulated (clearly labelled in the UI and data)**
* Weather (deterministic simulator; demo weekend-rain scenario via integration settings).
* Price publication to shelf labels/POS (`SimulatedPricePublisher`), payments (order payload only),
  the POS simulator and seeded `is_simulated` transactions, coupon redemption at POS, SMS/push
  (logged only), email (logged unless SMTP configured), location (demo simulator or foreground
  browser geolocation).
* All demo data (sales, fraud labels, weather history) is synthetic; correlations exist by
  construction.

**Requires external credentials or hardware**
* OpenAI/Gemini — not tested in CI without keys (Gemini verified on the live deployment).
  OpenWeatherMap. SMTP. Vendor-specific POS adapters (Tally, Gofrugal, Petpooja) beyond the generic
  Orders API and Shopify webhook; real ESL/payment/receipt-scanner/self-checkout hardware. Mobile background geofencing + push (native app). Indoor positioning (BLE/UWB).

**Incomplete / simplified**
* Planogram editor: product placement and movable fixtures (endcaps, clearance bin) only; aisle
  geometry comes from the floor-plan generator (aisles, sections, levels, walls, checkouts) rather
  than free drawing.
* The cloud demo uses an in-container SQLite database on one Cloud Run instance: data resets when the
  instance restarts. Production would use Cloud SQL (PostgreSQL) and more instances.
* Association rules are pair-wise only. Markdown elasticity is a configurable assumption.
* Vector search scores in NumPy per tenant; the pgvector column/index exist (migration 0002) but
  SQL kNN is not implemented.
* No CSRF token (SameSite=Lax cookie + JSON content type + CORS are relied on), no MFA, no
  password reset flow, no merchant user administration UI (provision via seed/DB).
* Notifications are in-app; no per-type notification settings UI beyond channels and consent.
* Merchandising recommendations reference shelf locations of the layout version active when they
  were generated; after a new layout is published they still match by shelf code but not by id.
* When an owner removes a member from a shared list, other connected WebSocket members see it only
  on their next refetch (`member_removed` is not yet applied by `ListSocket`); with Firestore the
  member set is updated and the removed member loses read access immediately.
* Single currency (INR) and timezone per store.

**Roadmap**: pgvector kNN, causal uplift via randomised store-level experiments, learned price
elasticity, 3-item association sets, multi-lingual list parsing, native app for geofencing/push,
vendor POS adapters, UPI/Razorpay payments, real ESL integration, OpenTelemetry metrics/tracing,
admin UI for users/roles.

---

## N. Developer change guide

**Add an API endpoint**
1. Put business logic in a service (`app/services/<domain>_service.py`); keep routers thin.
2. Add the route to the domain router in `app/api/v1/<domain>.py` with request/response Pydantic
   models, `Depends(require_permission("<code>"))` (or `require_customer`), and tenant scoping
   (`get_store_scoped`, `merchant_id` filters). New permission codes go in `core/permissions.py`
   (and need a migration/seed update for existing databases).
3. Raise `NotFoundError`, `BusinessRuleError`, `ConflictError`… — never return raw 500s.
4. Record `record_audit(...)` for state changes. Add a test in `backend/tests`.
5. Regenerate docs: `python -m app.docs_gen`.

**Add a database model**: create the class in `app/db/models/<module>.py` (use `UUIDPk`,
`Timestamps`, `UTCDateTime`, `Money`), export it in `app/db/models/__init__.py`, then
`alembic revision --autogenerate -m "..."`, review the script (types, server defaults, data
migrations), `python -m app.cli migrate`, run `pytest` (the parity test fails if model and
migration differ).

**Add an AI provider**: subclass `LLMProvider` (implement `_complete_json` and `embed`) or
`AIProvider` directly; register it in `app/ai/providers/__init__.py:get_ai_provider` and add
settings to `core/config.py` + `.env.example` + §I. Keep `EMBEDDING_DIMENSIONS` consistent; changing
the embedding model triggers re-embedding (`POST /merchant/products/reindex`).

**Add an analytics algorithm**: implement it as a pure function in `app/analytics/<area>/` (no DB
access) with unit tests; call it from a service that loads data and persists results; if it is
slow, add a job handler in `tasks/handlers.py` (and optionally a `SCHEDULE` entry); label its output
method in the API/UI (`Provenance`).

**Add a frontend feature**: create `src/features/<feature>/` with a default-exported page, add the
route in `src/routes/router.tsx` (with `guard(kind, page, permission)`) and a nav entry in the
layout; use `api` + TanStack Query (keys starting with `"merchant"` or `"store"`), UI kit components,
loading/empty/error states and toasts; add `*.test.tsx` with `mockApi`/`renderWithProviders`.

**Add an external integration**: define/extend an adapter interface in `app/integrations/<area>/`,
implement a deterministic simulated adapter first, read secrets only from settings/env, handle
failures by falling back and labelling the source, expose non-secret settings via
`integration_configs`, and document variables in `.env.example` and §I.

**Add tests for a new module**: backend tests get a seeded, isolated database through the `client`,
`db`, `ids` and role fixtures in `tests/conftest.py`; prefer API-level tests for workflows and pure
unit tests for algorithms. Frontend tests use Vitest + Testing Library with `mockApi`.
