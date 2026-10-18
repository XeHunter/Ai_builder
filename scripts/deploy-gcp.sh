#!/usr/bin/env bash
# Deploy OmniPulse AI to Google Cloud: API on Cloud Run, SPA on Firebase Hosting, Firestore rules.
#
#   GEMINI_API_KEY=... ./scripts/deploy-gcp.sh <project-id> [region]
#
# Default is the free-tier setup: Cloud Run scales to zero (billed only while serving requests) and a
# free Cloud Scheduler job pings it every 5 minutes so judges don't hit a cold start. Set ALWAYS_ON=1
# to keep one instance permanently running instead (~US$15-25/month, never restarts).
#
# Easiest place to run it: Google Cloud Shell (gcloud, firebase, node and openssl are preinstalled):
#   git clone <your repo> && cd <repo> && GEMINI_API_KEY=... ./scripts/deploy-gcp.sh my-project
# Re-running is safe; every step is idempotent. See docs/deployment/GCP.md for what each step does.
set -euo pipefail

PROJECT="${1:?usage: GEMINI_API_KEY=... $0 <project-id> [region]}"
REGION="${2:-us-central1}"
SERVICE="omnipulse-api"
SA_NAME="omnipulse-api"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_ORIGINS="https://${PROJECT}.web.app,https://${PROJECT}.firebaseapp.com"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Project ${PROJECT} (${REGION})"
gcloud config set project "$PROJECT" >/dev/null

step "Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com \
  identitytoolkit.googleapis.com firebase.googleapis.com firebasehosting.googleapis.com \
  generativelanguage.googleapis.com cloudscheduler.googleapis.com

step "Firebase project + web app"
firebase projects:addfirebase "$PROJECT" >/dev/null 2>&1 || true
if ! firebase apps:list WEB --project "$PROJECT" 2>/dev/null | grep -q "omnipulse-web"; then
  firebase apps:create WEB omnipulse-web --project "$PROJECT"
fi

step "Firestore (native mode)"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --type=firestore-native
fi

step "Service account ${SA}"
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --display-name "OmniPulse API (Cloud Run)"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:${SA}" \
  --role roles/datastore.user --condition=None --quiet >/dev/null
# Minting Firebase Auth custom tokens signs with the service account's own key via IAM.
gcloud iam service-accounts add-iam-policy-binding "$SA" --member "serviceAccount:${SA}" \
  --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null

ensure_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
  elif [ "${3:-}" = "update" ]; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$name" --member "serviceAccount:${SA}" \
    --role roles/secretmanager.secretAccessor --quiet >/dev/null
}

step "Secrets"
ensure_secret omnipulse-jwt-secret "$(openssl rand -hex 32)"
ensure_secret omnipulse-reset-token "$(openssl rand -hex 24)"
SECRETS="JWT_SECRET=omnipulse-jwt-secret:latest,DEMO_RESET_TOKEN=omnipulse-reset-token:latest"
AI_PROVIDER="demo"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  ensure_secret omnipulse-gemini-key "$GEMINI_API_KEY" update
  SECRETS="${SECRETS},GEMINI_API_KEY=omnipulse-gemini-key:latest"
  AI_PROVIDER="gemini"
elif gcloud secrets describe omnipulse-gemini-key >/dev/null 2>&1; then
  SECRETS="${SECRETS},GEMINI_API_KEY=omnipulse-gemini-key:latest"
  AI_PROVIDER="gemini"
else
  echo "GEMINI_API_KEY not set: deploying with the deterministic demo AI provider."
fi

GEMINI_ENV=""
if [ -n "${GEMINI_API_KEY:-}" ]; then
  step "Picking the newest Gemini model this key can use"
  MODELS="$(curl -fsS -H "x-goog-api-key: ${GEMINI_API_KEY}"     "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200" || true)"
  CHAT_MODEL="${GEMINI_CHAT_MODEL:-}"
  if [ -z "$CHAT_MODEL" ]; then
    # Flash-Lite first: fastest responses and the most generous free-tier limits for short JSON tasks.
    for m in gemini-3.5-flash-lite gemini-3.1-flash-lite gemini-3.8-flash gemini-3.5-flash gemini-2.5-flash-lite gemini-2.5-flash; do
      if grep -q "\"models/${m}\"" <<<"$MODELS"; then CHAT_MODEL="$m"; break; fi
    done
  fi
  EMBED_MODEL="${GEMINI_EMBEDDING_MODEL:-gemini-embedding-001}"
  if [ -z "$CHAT_MODEL" ]; then
    echo "Could not list Gemini models with this key (check the key / API enablement)." >&2
    CHAT_MODEL="gemini-3.5-flash-lite"
  fi
  echo "Chat model: ${CHAT_MODEL}   Embedding model: ${EMBED_MODEL}"
  GEMINI_ENV="@GEMINI_CHAT_MODEL=${CHAT_MODEL}@GEMINI_EMBEDDING_MODEL=${EMBED_MODEL}"
fi

step "Cloud Run: ${SERVICE} (build from backend/Dockerfile)"
# At most one instance: the demo database is SQLite inside the container, seeded fresh on every start.
MIN_INSTANCES=0
if [ "${ALWAYS_ON:-0}" = "1" ]; then MIN_INSTANCES=1; fi
gcloud run deploy "$SERVICE" --source "$ROOT/backend" --region "$REGION" --service-account "$SA" \
  --allow-unauthenticated --min-instances "$MIN_INSTANCES" --max-instances 1 --cpu 2 --memory 2Gi --cpu-boost \
  --timeout 900 --concurrency 80 \
  --set-secrets "$SECRETS" \
  --set-env-vars "^@^APP_ENV=production@DEMO_MODE=true@DEMO_LOGIN_ENABLED=true@SEED_ON_STARTUP=true@LOG_JSON=true@COOKIE_SECURE=true@SESSION_COOKIE_NAME=__session@CORS_ORIGINS=${WEB_ORIGINS}@FRONTEND_BASE_URL=https://${PROJECT}.web.app@AI_PROVIDER=${AI_PROVIDER}@FIREBASE_ENABLED=true@FIREBASE_PROJECT_ID=${PROJECT}@MEDIA_DIR=/app/media@SAMPLE_DATA_DIR=/app/media/sample@JOBS_EAGER=true@RUN_WORKER_IN_PROCESS=false@ENABLE_SCHEDULER=false@AI_REQUEST_TIMEOUT_SECONDS=12${GEMINI_ENV}"

RUN_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
if [ "$MIN_INSTANCES" = "0" ]; then
  step "Keep-warm ping every 5 minutes (Cloud Scheduler free tier: 3 jobs per billing account)"
  if gcloud scheduler jobs describe omnipulse-keep-warm --location "$REGION" >/dev/null 2>&1; then
    ACTION=update
  else
    ACTION=create
  fi
  gcloud scheduler jobs "$ACTION" http omnipulse-keep-warm --location "$REGION" --schedule "*/5 * * * *" \
    --uri "${RUN_URL}/health/live" --http-method GET >/dev/null
fi

step "Nightly demo reset at 03:00 India time (keeps the date-relative demo data current)"
RESET_TOKEN="$(gcloud secrets versions access latest --secret=omnipulse-reset-token)"
if gcloud scheduler jobs describe omnipulse-nightly-reset --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http omnipulse-nightly-reset --location "$REGION" --schedule "0 3 * * *" \
    --time-zone "Asia/Kolkata" --uri "${RUN_URL}/api/v1/demo/reset" --http-method POST \
    --update-headers "X-Reset-Token=${RESET_TOKEN}" --attempt-deadline 900s \
    --max-retry-attempts 2 --min-backoff 120s >/dev/null
else
  gcloud scheduler jobs create http omnipulse-nightly-reset --location "$REGION" --schedule "0 3 * * *" \
    --time-zone "Asia/Kolkata" --uri "${RUN_URL}/api/v1/demo/reset" --http-method POST \
    --headers "X-Reset-Token=${RESET_TOKEN}" --attempt-deadline 900s \
    --max-retry-attempts 2 --min-backoff 120s >/dev/null
fi

step "Frontend build"
(cd "$ROOT/frontend" && npm ci --no-audit --no-fund && npm run build)

step "Firebase Hosting + Firestore rules"
TMP_CFG="$(mktemp)"
sed "s/\"region\": \"us-central1\"/\"region\": \"${REGION}\"/g" "$ROOT/firebase.json" > "$TMP_CFG"
cp "$TMP_CFG" "$ROOT/firebase.deploy.json"
# Low upload concurrency: Cloud Shell's network drops many parallel Hosting uploads.
(cd "$ROOT" && FIREBASE_HOSTING_UPLOAD_CONCURRENCY=4 firebase deploy --config firebase.deploy.json --only hosting,firestore:rules --project "$PROJECT" --non-interactive)
rm -f "$ROOT/firebase.deploy.json" "$TMP_CFG"

URL="https://${PROJECT}.web.app"
step "Done"
echo "App:        ${URL}"
echo "API docs:   ${RUN_URL}/docs"
echo "Health:     ${URL}/health/ready"
echo
echo "One manual step the first time: Firebase console -> Authentication -> Get started"
echo "(enables Firebase Auth so browsers can sign in with the API's custom tokens)."
