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
#   MIN_INSTANCES=1   keep one web instance warm (no cold start on the first
#                     Slack message after an idle period). Default 0 scales to
#                     zero. The service has 2 GiB and CPU always allocated, so
#                     1 costs roughly $55/month.
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
NAME="${NAME:-agent-army}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"
# Sizes (Cloud Run allows up to 8 vCPU / 32 GiB; 8 vCPU needs at least 4 GiB).
SERVICE_CPU="${SERVICE_CPU:-8}"
SERVICE_MEMORY="${SERVICE_MEMORY:-8Gi}"
JOB_CPU="${JOB_CPU:-8}"
JOB_MEMORY="${JOB_MEMORY:-8Gi}"
[ -n "$PROJECT" ] || { echo "Set PROJECT=<gcp-project-id>"; exit 1; }

BUCKET="${PROJECT}-${NAME}-data"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${NAME}/${NAME}:$(date +%Y%m%d-%H%M%S)"
SERVER_SA="${NAME}-server@${PROJECT}.iam.gserviceaccount.com"
WORKER_SA="${NAME}-worker@${PROJECT}.iam.gserviceaccount.com"
JOB="${NAME}-worker"
G="gcloud --project ${PROJECT} --quiet"

echo "==> Enabling APIs"
$G services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com

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

echo "==> Building image"
$G artifacts repositories describe "${NAME}" --location "${REGION}" >/dev/null 2>&1 || \
  $G artifacts repositories create "${NAME}" --repository-format docker --location "${REGION}"
$G builds submit --tag "${IMAGE}" .

COMMON_ENV="STORAGE=gcs,GCS_BUCKET=${BUCKET},REQUIRE_MASTER_KEY=1"

echo "==> Worker job (one isolated container per task)"
$G run jobs deploy "${JOB}" --region "${REGION}" --image "${IMAGE}" \
  --service-account "${WORKER_SA}" \
  --command node --args dist/worker.js \
  --set-env-vars "${COMMON_ENV}" \
  --set-secrets "MASTER_KEY=${NAME}-master-key:latest" \
  --cpu "${JOB_CPU}" --memory "${JOB_MEMORY}" --task-timeout 3600 --max-retries 0

# The server may start worker executions (with the task id as an override) and nothing else.
$G run jobs add-iam-policy-binding "${JOB}" --region "${REGION}" \
  --member "serviceAccount:${SERVER_SA}" --role roles/run.jobsExecutorWithOverrides >/dev/null

echo "==> Web service (admin page, Slack events, Pointer's chat)"
# Pointer answers after Slack has had its 200, so the CPU must stay allocated
# outside requests; the Agent SDK runs as a subprocess, hence 2 GiB. One instance
# only: per-thread queues and event dedupe live in memory.
$G run deploy "${NAME}" --region "${REGION}" --image "${IMAGE}" \
  --service-account "${SERVER_SA}" \
  --allow-unauthenticated \
  --set-env-vars "${COMMON_ENV},RUNNER=cloudrun,WORKER_JOB=projects/${PROJECT}/locations/${REGION}/jobs/${JOB}" \
  --set-secrets "MASTER_KEY=${NAME}-master-key:latest,SETUP_TOKEN=${NAME}-setup-token:latest" \
  --cpu "${SERVICE_CPU}" --memory "${SERVICE_MEMORY}" --no-cpu-throttling --min-instances "${MIN_INSTANCES}" --max-instances 1 \
  --concurrency 40 --timeout 300

URL="$($G run services describe "${NAME}" --region "${REGION}" --format 'value(status.url)')"
TOKEN="$($G secrets versions access latest --secret "${NAME}-setup-token")"
cat <<DONE

Agent Army is deployed: Pointer and its team.

  Open:         ${URL}
  Setup token:  ${TOKEN}

New install: open the URL, create the admin account with the setup token, then
connect Claude, Slack and GitHub in the page. Nothing else needs to be configured.

Already have a Slack app from an earlier version? Update it so Pointer receives
DMs and channel messages: on the page, Slack > "Already created the app? Update
it", copy the manifest into https://api.slack.com/apps > your app > App Manifest,
Save, then Install App > Reinstall.

Smoke test (runs Pointer once inside the worker job, no Slack needed):
  gcloud run jobs execute ${JOB} --project ${PROJECT} --region ${REGION} \\
    --args=dist/smoke.js,"Introduce yourself and the team" --wait
DONE
