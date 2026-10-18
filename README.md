# OmniPulse AI

**AI-powered omnichannel retail intelligence.** OmniPulse AI connects the shopper's journey with the
store's operational intelligence: shoppers find products, plan lists and walk optimised in-store
routes, while store teams make evidence-backed inventory, merchandising and pricing decisions — on one
backend and one data model.

## Live demo

| | |
|---|---|
| **Live app** | **<https://aibuilder-5681b.web.app>** |
| **Demo video** | [Watch the walkthrough](https://drive.google.com/file/d/17AuKCLtaDLV_kZKliSOzzMLYUu-P2LQS/view?usp=sharing) |

No sign-up needed: on the sign-in page choose **Enter as Customer** (Priya, a shopper at FreshMart
Andheri) or **Enter as Store Owner** (FreshMart admin). To try photo search, use the sample photos in
[`data/sample/query_images/`](data/sample/query_images/) (see [Try photo search](#try-photo-search)).
The live deployment runs on Google Cloud: Cloud Run (API), Firebase Hosting (web app), Firestore with
Firebase Auth (real-time updates) and Gemini (AI). The demo data resets when the service restarts.

> Locally it also runs fully offline in **demo mode** (deterministic AI fallback, simulated weather and
> store hardware, synthetic data). Real AI providers and integrations plug in via environment variables.

## Key features

**For shoppers** (`/shop`)
- Catalog search (hybrid lexical + embedding), product pages with stock, price, promotions,
  short-dated markdowns and shelf location.
- Conversational concierge ("breakfast for two under ₹500", "where is the milk?", "which memory card
  fits this camera?") grounded in live catalog data.
- Photo search: Gemini Vision describes the photo and the description is searched in the store's
  catalog, blended with colour/layout matching against product images (see [Try photo search](#try-photo-search)).
- Smart lists from free text with product matching, disambiguation, duplicate merging and aisle
  grouping; optimised multi-stop routes on an interactive store map with turn-by-turn directions.
- Real-time shared lists (Firestore on Google Cloud, WebSocket locally) with QR/link invitations,
  roles, presence and offline resync.
- Click & collect: order a list for pickup; it lands on the store's live orders feed.
- Offers and coupons; consent-based proximity offers and list reminders (with a location simulator).

**For store teams** (`/merchant`)
- Operational overview, catalog, batch-level inventory with an audit ledger, CSV/XLSX import with
  preview and row-level validation.
- Expiry management with markdown recommendations that respect price floors and policy caps,
  clearance instructions and write-offs.
- Price-change approval workflow (recommend → approve → publish), promotions, coupons, weather-driven
  opportunities with historical evidence.
- Demand forecasting (baseline vs weather-aware model chosen by backtest) with stockout risk and
  reorder suggestions.
- Planogram editor, merchandising recommendations framed as A/B tests, cross-selling heatmap and
  product network.
- Fraud review queue (explainable rules + anomaly scores, human investigation), insights,
  integrations, audit log and background jobs.
- Gemini **AI morning brief** with prioritised actions built only from verified store data, and a
  **Channels & orders** page with a live feed of every POS, online and click & collect order.
- Placement rule book with live compliance: chilled goods, heavy items, and no sweets at checkouts
  or kids' eye level.

**Plug and play** (`/onboarding`, `/merchant/setup`, `/merchant/channels`)
- Store-owner self sign-up and a 5-step setup wizard: store → generated floor plan (aisles, shelves,
  chillers, checkouts) → catalog import → sales-history backfill → connect channels.
- Connectors: any POS/billing software via the Orders API (API keys, idempotent), Shopify order
  webhooks, a catalog feed for online storefronts, click & collect from the shopper app, and a POS
  simulator. Every channel consumes the same batch stock (FEFO) and appears on a live orders feed.
- One-click demo sign-in for judges (**Enter as Customer** / **Enter as Store Owner**).

**On Google Cloud**: FastAPI on **Cloud Run**, SPA on **Firebase Hosting**, real-time lists and live
feed via **Firestore** (authorised with **Firebase Auth** custom tokens), **Gemini** for the concierge,
list parsing, embeddings, photo captions and the owner's AI brief. Deploy with
`GEMINI_API_KEY=... ./scripts/deploy-gcp.sh <project-id>` — see [docs/deployment/GCP.md](docs/deployment/GCP.md).

## Prerequisites
Python 3.12+, Node.js 24+, Git. Optional: PostgreSQL 15+ (pgvector), Redis 7, Docker.

## Quick start (Windows PowerShell)
```powershell
cd backend
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev,redis,pgvector]"
.venv\Scripts\python -m app.cli migrate
.venv\Scripts\python -m app.cli seed
.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000

# new terminal
cd frontend
npm ci
npm run dev
```
Open **http://localhost:5173** (app) and **http://localhost:8000/docs** (API).
macOS/Linux: `make install migrate seed`, then `make dev-api` and `make dev-web`.
Docker: `docker compose up --build` → http://localhost:8080.

## Demo access (local demo data only)
Password for all demo accounts: `Demo@12345`

| Account | Use it for |
|---|---|
| `priya@demo.omnipulse.ai` | Shopper journey (owns a shared list) |
| `rohan@demo.omnipulse.ai` | Second shopper (shared-list sync) |
| `admin@freshmart.demo` | Merchant admin journey |
| `manager.andheri@freshmart.demo` | Store manager (one store) |
| `analyst@freshmart.demo` | Read-only analyst |

Sample files: `data/sample/inventory_import_sample.csv` (import with deliberate errors) and
`data/sample/query_images/*.jpg` (photos for photo search) are generated by the seed.

## Try photo search
Sign in as a shopper (**Enter as Customer**), open **Photo search** and upload one of these photos
from [`data/sample/query_images/`](data/sample/query_images/). Each is a shopper-style shot (angled,
cropped, different lighting) of a product sold at FreshMart Andheri, and that product should come back
as the top match.

| Photo | Expected top match |
|---|---|
| [`photo_sea-001.jpg`](data/sample/query_images/photo_sea-001.jpg) | Folding Umbrella (3-fold) |
| [`photo_mlk-001.jpg`](data/sample/query_images/photo_mlk-001.jpg) | Amul Taaza Toned Milk 1 L |
| [`photo_cof-001.jpg`](data/sample/query_images/photo_cof-001.jpg) | Nescafe Classic Instant Coffee 100 g |
| [`photo_tea-001.jpg`](data/sample/query_images/photo_tea-001.jpg) | Tata Tea Premium 500 g |
| [`photo_cho-001.jpg`](data/sample/query_images/photo_cho-001.jpg) | Cadbury Dairy Milk Silk Chocolate 60 g |
| [`photo_hhd-001.jpg`](data/sample/query_images/photo_hhd-001.jpg) | Surf Excel Matic Detergent Powder 2 kg |
| [`photo_bab-001.jpg`](data/sample/query_images/photo_bab-001.jpg) | Pampers Active Baby Diapers Medium (56 pc) |
| [`photo_ele-001.jpg`](data/sample/query_images/photo_ele-001.jpg) | Canon EOS 1500D DSLR Camera Kit |

How it works: with Gemini configured, the photo is captioned by Gemini Vision ("A red Nescafe coffee
jar…") and the caption is run through the hybrid catalog search; that ranking is blended 50/50 with a
colour-and-layout descriptor compared against every catalog image. Without an AI key the colour/layout
match alone still finds the right product for these photos. Real phone photos work too, as long as the
product is in the store's catalog; anything else returns the closest-looking items.

## Documentation
- **[TECHNICAL_README.md](TECHNICAL_README.md)** — implementation reference: modules, database, API,
  AI/analytics methods, environment variables, testing, deployment, limitations, change guide.
- [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/decisions](docs/decisions/) — architecture and ADRs.
- [docs/api/endpoints.md](docs/api/endpoints.md) — generated endpoint list; live docs at `/docs`.
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow and conventions.