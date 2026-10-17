# OmniPulse AI — Submission

**Live prototype:** `https://<project-id>.web.app` · **API docs:** `https://<cloud-run-url>/docs` · **Repo:** `https://github.com/XeHunter/Ai_builder`

## Brief description

OmniPulse AI is a plug-and-play retail intelligence platform for a mart that sells **in-store and online
at the same time**. One backend and one stock ledger connect the shopper's journey to the store's
operations:

* **Shoppers** search the catalog in plain language, ask a Gemini-powered concierge ("breakfast for two
  under ₹500", "where is the milk?"), search by photo, turn a typed list into matched products with an
  optimised walking route on the store map, share the list live with family, and **order it for pickup**
  (click & collect).
* **Store owners** get a Gemini-written **morning brief** with prioritised actions, a **live feed of
  orders from every channel**, expiry markdowns with an approval workflow, demand forecasts with
  stockout risk, merchandising experiments, cross-selling analytics and an explainable fraud queue.
* **Plug and play:** a new owner signs up, generates a floor plan, imports products and sales history
  from any billing export, and connects their POS or online store (generic Orders API, Shopify webhook,
  catalog feed) with an API key — in about five minutes. Every POS bill, Shopify order or app order
  reduces the same batch-level stock first-expiry-first-out, so online and in-store never oversell each other.

### How we use Google's stack

| Technology | How OmniPulse uses it |
|---|---|
| **Cloud Run** | Hosts the FastAPI backend container (built from source with Cloud Build). It owns all business logic: auth and tenancy, the stock ledger, order ingestion from POS/online channels, pricing guardrails, forecasting (scikit-learn), routing (Dijkstra + Held-Karp) and fraud scoring. Secrets come from Secret Manager. |
| **Firebase Hosting** | Serves the React SPA and rewrites `/api/**` to the Cloud Run service, so the app and API share one origin and session cookie. |
| **Firestore** | The real-time layer. The API mirrors every shared-list event (plus presence heartbeats) to `shoppingLists/{id}/events` and every order / low-stock signal to `merchants/{id}/feed`; browsers subscribe with `onSnapshot`. When a shopper ticks off milk, their partner sees it instantly; when a POS bill, Shopify order or click-and-collect order arrives, the owner's dashboard updates within a second. |
| **Firebase Authentication** | The API mints a **custom token** per signed-in user (uid = user id, `merchant_id` claim for store staff). Firestore security rules use it so shoppers only read lists they belong to and staff only read their own store's feed. Browsers never write business data. |
| **Gemini** | (1) Shopper concierge: intent extraction and replies grounded in verified catalog facts. (2) Free-text shopping-list parsing. (3) `gemini-embedding-001` embeddings for semantic product search. (4) Photo captions for visual search. (5) The owner's **AI morning brief**: computed facts in, prioritised actions out. Every Gemini output is JSON-schema validated and checked against the facts; a reply that invents a price or product id is rejected and replaced with a deterministic answer, so the app never shows hallucinated numbers. |

## For judges — no setup needed

Open the live link and use the **one-click buttons** on the sign-in page:

* **Enter as Customer** (Priya, shopper) → ask the AI concierge, try photo search, open the shared
  list *Weekend breakfast*, see the route, then **Order for pickup**. (If another judge already
  ordered it, add an item such as "2 milk" first, or create a new list from free text.)
* **Enter as Store Owner** (FreshMart admin) → read the AI brief, watch the live orders feed, open
  *Channels* and **ring up a POS bill** or copy the `curl` example to push an order with an API key, then
  approve an expiry markdown in *Expiry management*.

Best demo: open the two personas in two browser windows (one normal, one private). Place the pickup
order as Priya and watch it land on the owner's live feed.

To try onboarding: *Own a store? Set it up in 5 minutes* on the sign-in page → sign up → follow the
wizard (store → floor plan → starter catalog → sample sales history → API key → first analytics run).

All data is synthetic. Payment, shelf-label and weather integrations are simulated and labelled as such.

## Video script (3:30)

| Time | Show | Say |
|---|---|---|
| 0:00–0:20 | Sign-in page | "A neighbourhood mart sells in the store and online, but stock, prices and customers live in separate systems. OmniPulse is one brain for both, and it's plug and play." |
| 0:20–0:35 | Architecture slide | "React on Firebase Hosting, FastAPI on Cloud Run, Firestore for real-time, Firebase Auth custom tokens, Gemini for language." |
| 0:35–1:25 | Customer: concierge → photo search → list → route → **Order for pickup** | "Gemini understands 'breakfast for two under ₹500', but every price comes from our database; replies that invent numbers are rejected." Show the route, then place the pickup order. |
| 1:25–2:20 | Owner (second window): AI brief, live feed shows Priya's order instantly, stock dropped, low-stock alert; Channels → ring up a POS bill → feed; show the Shopify / curl endpoint | "That order arrived through Firestore in under a second, and it consumed the earliest-expiring batch. A POS bill or a Shopify order goes through exactly the same path." |
| 2:20–2:50 | Expiry: approve a markdown → published; Forecasting: stockout risk | "Markdowns respect price floors and need approval; forecasts pick the better model by backtest." |
| 2:50–3:20 | Onboarding wizard (sped up): floor-plan builder preview, starter catalog import, API key | "A new owner is live in five minutes: generate the floor plan, import any billing export, connect channels with an API key." |
| 3:20–3:30 | Close | "OmniPulse: one stock ledger, every channel, AI that is grounded in your real data." |
