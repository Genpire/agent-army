#!/usr/bin/env bash
# Deploy Agent Army (Pointer and its team) to Google Cloud Run. Safe to re-run:
# it updates in place.
#
#   PROJECT=my-project REGION=us-central1 NAME=agent-army ./deploy/gcp.sh
#
# Creates: a private bucket (encrypted config, memory + task records), two
# secrets, two least-privilege service accounts, the web service and the
# worker job.
#
# Optional:
#   IMAGE=ghcr.io/<owner>/agent-army:latest
#                     deploy this image instead of building one with Cloud
#                     Build (a public image, or one in Artifact Registry).
#   PUBLIC_URL=https://army.example.com
#                     the address Slack and GitHub use (a custom domain).
#                     Default: the service's own run.app URL, set after the
#                     first deploy.
#   MIN_INSTANCES=1   web instances kept running. Keep the default 1: Pointer
#                     answers after Slack has had its HTTP 200, and the
#                     routines' clock ticks every minute. 0 scales to zero.
#   SERVICE_CPU / SERVICE_MEMORY, JOB_CPU / JOB_MEMORY, JOB_TIMEOUT_MIN: below.
#
# Cost (us-central1, CPU always allocated): the web service at the default
# 2 vCPU / 4 GiB, always on, is about $110/month (1 vCPU / 2 GiB: about $53).
# Repo tasks run in the worker job, billed only while they run: about $0.58
# per task-hour at 8 vCPU / 8 GiB. Claude usage is billed separately.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
NAME="${NAME:-agent-army}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
# Sizes (Cloud Run allows up to 8 vCPU / 32 GiB; 8 vCPU needs at least 4 GiB).
# The web service runs Pointer's chat (the Agent SDK is a subprocess); repo
# tasks run in the job, each in its own container.
SERVICE_CPU="${SERVICE_CPU:-2}"
SERVICE_MEMORY="${SERVICE_MEMORY:-4Gi}"
JOB_CPU="${JOB_CPU:-8}"
JOB_MEMORY="${JOB_MEMORY:-8Gi}"
# Hard deadline of one task's worker. The team's own run stops at
# TASK_TIMEOUT_MIN (50); waiting for the pull request's checks, fix rounds and
# publishing happen after it, so the job gets more time. Cloud Run Jobs allow
# up to 168 h (7 days).
JOB_TIMEOUT_MIN="${JOB_TIMEOUT_MIN:-180}"
IMAGE="${IMAGE:-}"
PUBLIC_URL="${PUBLIC_URL:-}"
[ -n "$PROJECT" ] || { echo "Set PROJECT=<gcp-project-id>"; exit 1; }

BUCKET="${PROJECT}-${NAME}-data"
SERVER_SA="${NAME}-server@${PROJECT}.iam.gserviceaccount.com"
WORKER_SA="${NAME}-worker@${PROJECT}.iam.gserviceaccount.com"
JOB="${NAME}-worker"
G="gcloud --project ${PROJECT} --quiet"

echo "==> Enabling APIs"
APIS="run.googleapis.com secretmanager.googleapis.com storage.googleapis.com"
[ -n "$IMAGE" ] || APIS="${APIS} cloudbuild.googleapis.com artifactregistry.googleapis.com"
# shellcheck disable=SC2086 # one API per word
$G services enable $APIS

echo "==> Storage bucket"
$G storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 || \
  $G storage buckets create "gs://${BUCKET}" --location "${REGION}" \
     --uniform-bucket-level-access --public-access-prevention

echo "==> Secrets"
ensure_secret() { # name
  if ! $G secrets describe "$1" >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n' | $G secrets create "$1" --replication-policy automatic --data-file=-
  fi
}
ensure_secret "${NAME}-master-key"
ensure_secret "${NAME}-setup-token"

echo "==> Service accounts"
for sa in server worker; do
  $G iam service-accounts describe "${NAME}-${sa}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    $G iam service-accounts create "${NAME}-${sa}" --display-name "Agent Army ${sa}"
done
for sa in "$SERVER_SA" "$WORKER_SA"; do
  $G storage buckets add-iam-policy-binding "gs://${BUCKET}" \
     --member "serviceAccount:${sa}" --role roles/storage.objectUser >/dev/null
  $G secrets add-iam-policy-binding "${NAME}-master-key" \
     --member "serviceAccount:${sa}" --role roles/secretmanager.secretAccessor >/dev/null
done
$G secrets add-iam-policy-binding "${NAME}-setup-token" \
   --member "serviceAccount:${SERVER_SA}" --role roles/secretmanager.secretAccessor >/dev/null

if [ -n "$IMAGE" ]; then
  echo "==> Image: ${IMAGE} (not building)"
else
  echo "==> Building image"
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${NAME}/${NAME}:$(date +%Y%m%d-%H%M%S)"
  $G artifacts repositories describe "${NAME}" --location "${REGION}" >/dev/null 2>&1 || \
    $G artifacts repositories create "${NAME}" --repository-format docker --location "${REGION}"
  $G builds submit --tag "${IMAGE}" .
fi

# The public address: PUBLIC_URL, else the service's own URL once it exists
# (a re-run). A first deploy sets it right after the service is created.
PUBLIC_URL_GIVEN="${PUBLIC_URL}"
[ -n "$PUBLIC_URL" ] || \
  PUBLIC_URL="$($G run services describe "${NAME}" --region "${REGION}" --format 'value(status.url)' 2>/dev/null || true)"

COMMON_ENV="STORAGE=gcs,GCS_BUCKET=${BUCKET},REQUIRE_MASTER_KEY=1${PUBLIC_URL:+,PUBLIC_URL=${PUBLIC_URL}}"

echo "==> Worker job (one isolated container per task)"
$G run jobs deploy "${JOB}" --region "${REGION}" --image "${IMAGE}" \
  --service-account "${WORKER_SA}" \
  --command node --args dist/worker.js \
  --set-env-vars "${COMMON_ENV},JOB_TIMEOUT_MIN=${JOB_TIMEOUT_MIN}" \
  --set-secrets "MASTER_KEY=${NAME}-master-key:latest" \
  --cpu "${JOB_CPU}" --memory "${JOB_MEMORY}" --task-timeout "$((JOB_TIMEOUT_MIN * 60))" --max-retries 0

# The server may start worker executions (with the task id as an override) and nothing else.
$G run jobs add-iam-policy-binding "${JOB}" --region "${REGION}" \
  --member "serviceAccount:${SERVER_SA}" --role roles/run.jobsExecutorWithOverrides >/dev/null

echo "==> Web service (admin page, Slack events, Pointer's chat)"
# Pointer answers after Slack has had its 200, so the CPU must stay allocated
# outside requests and an instance must stay up (MIN_INSTANCES=1); the Agent
# SDK runs as a subprocess. One instance only: per-thread queues and event
# dedupe live in memory. On SIGTERM the server lets requests in flight finish
# within 8 s, inside the 10 s Cloud Run gives before SIGKILL.
$G run deploy "${NAME}" --region "${REGION}" --image "${IMAGE}" \
  --service-account "${SERVER_SA}" \
  --allow-unauthenticated \
  --set-env-vars "${COMMON_ENV},RUNNER=cloudrun,WORKER_JOB=projects/${PROJECT}/locations/${REGION}/jobs/${JOB}" \
  --set-secrets "MASTER_KEY=${NAME}-master-key:latest,SETUP_TOKEN=${NAME}-setup-token:latest" \
  --cpu "${SERVICE_CPU}" --memory "${SERVICE_MEMORY}" --no-cpu-throttling --min-instances "${MIN_INSTANCES}" --max-instances 1 \
  --concurrency 40 --timeout 300

URL="$($G run services describe "${NAME}" --region "${REGION}" --format 'value(status.url)')"
# First deploy without PUBLIC_URL: the service's URL becomes it, on the service
# (webhook addresses) and the job (links in ticket updates).
if [ -z "$PUBLIC_URL_GIVEN" ] && [ "$PUBLIC_URL" != "$URL" ]; then
  echo "==> PUBLIC_URL=${URL}"
  $G run services update "${NAME}" --region "${REGION}" --update-env-vars "PUBLIC_URL=${URL}" >/dev/null
  $G run jobs update "${JOB}" --region "${REGION}" --update-env-vars "PUBLIC_URL=${URL}" >/dev/null
fi
TOKEN="$($G secrets versions access latest --secret "${NAME}-setup-token")"
cat <<DONE

Agent Army is deployed: Pointer and its team.

  Open:         ${URL}
  Setup token:  ${TOKEN}

New install: open the URL, create the admin account with the setup token, then
connect Claude, Slack and GitHub in the page. Nothing else needs to be configured.

Already have a Slack app from an earlier version? Update it so Pointer receives
DMs and channel messages and can post screenshots (files:write): on the page,
Slack > "Already created the app? Update it", copy the manifest into
https://api.slack.com/apps > your app > App Manifest, Save, then Install App >
Reinstall.

Pull request reviews: to let reviews on the team's pull requests start
follow-up tasks, add a GitHub webhook to ${URL}/github/webhook (see the
GitHub card on the page).

Smoke test (runs Pointer once inside the worker job, no Slack needed):
  gcloud run jobs execute ${JOB} --project ${PROJECT} --region ${REGION} \\
    --args=dist/smoke.js,"Introduce yourself and the team" --wait
DONE
