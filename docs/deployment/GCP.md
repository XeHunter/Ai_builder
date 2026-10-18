# Deploying to Google Cloud (Cloud Run + Firebase Hosting + Firestore + Gemini)

This is the setup used for the public demo. One script does everything; this page explains what it does
and the few clicks it cannot do for you.

```
Browser ──HTTPS──► Firebase Hosting (React SPA, /__/firebase/init.json)
   │                    │  rewrites /api/**, /media/**, /health/**
   │                    ▼
   │               Cloud Run: omnipulse-api (FastAPI, SQLite demo DB seeded on boot)
   │                    │  Admin SDK writes ──► Firestore (shoppingLists/*, merchants/*/feed)
   │                    │  Gemini API (assistant, list parsing, embeddings, photo captions, AI brief)
   └──Firestore listeners (Firebase Auth custom token minted by the API) ◄──┘
```

| Google service | Used for |
|---|---|
| **Cloud Run** | Runs the FastAPI backend container (`backend/Dockerfile`), built from source by Cloud Build. |
| **Firebase Hosting** | Serves the SPA and proxies `/api` to Cloud Run on the same origin (so the session cookie, `__session`, works). |
| **Firestore** | Real-time delivery: shared shopping-list events + presence, and each merchant's live order/low-stock feed. Hosting cannot proxy WebSockets, so browsers subscribe to Firestore instead. |
| **Firebase Auth** | The API mints a custom token per signed-in user (uid = user id, `merchant_id` claim for staff); `firestore.rules` use it so people only read their own lists / their own store's feed. |
| **Gemini** | `AI_PROVIDER=gemini`: shopper concierge (intent + grounded replies), free-text list parsing, product embeddings for semantic search, photo-search captions, and the store owner's AI morning brief. Every output is schema-validated and grounded; failures fall back to the deterministic provider. |
| Secret Manager | `JWT_SECRET` and `GEMINI_API_KEY`. |

## Prerequisites (once)

1. A Google Cloud project with **billing enabled** (Cloud Run and Firebase Hosting rewrites need the Blaze plan; a demo stays within or near the free tier, see costs below).
2. A Gemini API key from <https://aistudio.google.com/apikey> (create it in the same project).
3. Your code on GitHub (the judges need the repo link anyway).

## Deploy (Cloud Shell, nothing to install)

Open <https://shell.cloud.google.com>, then:

```bash
git clone https://github.com/<you>/<repo>.git && cd <repo>
firebase login --no-localhost          # once; Cloud Shell already has gcloud credentials
GEMINI_API_KEY=<your key> ./scripts/deploy-gcp.sh <project-id>          # optional 2nd arg: region (default us-central1)
```

The first run takes ~8–10 minutes (container build). It prints the app URL, `https://<project-id>.web.app`.

**One manual click the first time:** Firebase console → *Build → Authentication → Get started*. Without it
custom-token sign-in fails and the app silently falls back to polling (everything still works, just not
via Firestore).

From Windows without Cloud Shell: install the Google Cloud SDK and `npm i -g firebase-tools`, then run
the same script from Git Bash.

## What the script does

1. Enables Cloud Run, Cloud Build, Artifact Registry, Firestore, Secret Manager, IAM Credentials,
   Identity Toolkit (Firebase Auth), Firebase Hosting and the Generative Language (Gemini) APIs.
2. Adds Firebase to the project and registers a web app (`/__/firebase/init.json` then serves its config).
3. Creates the Firestore database (native mode) in the region.
4. Creates the `omnipulse-api` service account with `datastore.user` and token-creator on itself (needed to
   sign Firebase custom tokens).
5. Stores `JWT_SECRET` (random) and `GEMINI_API_KEY` in Secret Manager.
6. `gcloud run deploy omnipulse-api --source backend` with at most one instance (scales to zero, kept warm by a
   free Cloud Scheduler ping; `ALWAYS_ON=1` pins one instance instead). The demo database is
   SQLite inside the container and is migrated + seeded on start (`SEED_ON_STARTUP=true`, ~30 s), so every
   restart is a clean demo. One instance keeps all users on the same data.
7. Builds the SPA and runs `firebase deploy --only hosting,firestore:rules`.

## Configuration (Cloud Run env)

`APP_ENV=production`, `COOKIE_SECURE=true`, `SESSION_COOKIE_NAME=__session` (Hosting forwards only this
cookie), `CORS_ORIGINS=https://<project>.web.app,https://<project>.firebaseapp.com`, `AI_PROVIDER=gemini`,
`FIREBASE_ENABLED=true`, `FIREBASE_PROJECT_ID`, `DEMO_LOGIN_ENABLED=true` (one-click judge sign-in),
`JOBS_EAGER=true` (background jobs run inline, no worker process needed on a single instance).

## Keeping it up during evaluation

* The keep-warm ping (or `ALWAYS_ON=1`) avoids cold starts, so data judges create survives between their visits.
  A redeploy or instance restart resets to the clean demo dataset.
* Check health: `curl https://<project>.web.app/health/ready` → `{"database":"ok","ai_provider":"gemini (llm)"}`.
* Logs: `gcloud run services logs read omnipulse-api --region us-central1 --limit 100`.
* **Nightly reset:** a Cloud Scheduler job (`omnipulse-nightly-reset`) rebuilds the demo data every
  night at 03:00 India time through `POST /api/v1/demo/reset` (protected by the `omnipulse-reset-token`
  secret), so expiring batches, the rain forecast and recent sales always match today's date.
  Run it now: `gcloud scheduler jobs run omnipulse-nightly-reset --location us-central1`.
* Reset to a clean demo at any time (new revision = fresh container = fresh seed):
  `gcloud run services update omnipulse-api --region us-central1 --update-env-vars DEMO_RESET=$(date +%s)`.
  Do this right before the evaluation window opens.
* If Gemini quota is exhausted the app keeps working on the deterministic provider (responses say so).

## Costs

**Default: free tier.** Cloud Run scales to zero and is billed only while handling requests, which a demo
keeps inside the monthly free allowance (180k vCPU-seconds, 2M requests). A Cloud Scheduler job (3 free
per billing account) pings `/health/live` every 5 minutes so the instance stays warm for judges.
Hosting, Firestore, Secret Manager and Cloud Build stay inside their free tiers. A billing account is
still required (Blaze plan); new Google Cloud accounts get US$300 of trial credit.

Trade-off: if Google recycles the instance anyway, the next visitor waits ~30–40 s while it re-seeds,
and data created by judges resets. For a fully stable demo deploy with `ALWAYS_ON=1` (one permanent
instance, roughly US$15–25/month).

**Gemini:** create the API key in a project *without* billing to stay on the free tier (rate-limited).
A key from a billed project is charged per token. If the free quota runs out, the app falls back to its
deterministic AI and keeps working.

Clean up after evaluation: `gcloud run services delete omnipulse-api --region <region>` and
`gcloud scheduler jobs delete omnipulse-keep-warm --location <region>`.

## Production notes

For a real tenant you would point `DATABASE_URL` at Cloud SQL for PostgreSQL (pgvector), set
`SEED_ON_STARTUP=false` and `DEMO_LOGIN_ENABLED=false`, allow more than one instance (Firestore already
fans out real-time events across instances), and run `python -m app.tasks.worker` as a Cloud Run job or
second service with `JOBS_EAGER=false`.
