#!/usr/bin/env bash
#
# Rocky Surf — create the least-privilege service account for the GCP provider.
#
# Creates (or updates, if they already exist) three things in YOUR project:
#
#   1. a custom IAM role carrying exactly deploy/gcp/rockysurf-role.yaml
#   2. a service account for Rocky Surf to run as
#   3. the binding between them
#
# It grants no predefined role, no owner, and no editor. It does NOT create a key file unless
# you ask for one with --create-key, because a key on disk is a credential to rotate and lose,
# and most installations do not need one — see the note at the bottom.
#
# Everything here is idempotent: run it again after editing the role file and it updates in
# place. gcloud is the only prerequisite.
#
#   ./deploy/gcp/setup.sh --project=my-project-123456
#   ./deploy/gcp/setup.sh --project=my-project-123456 --create-key=./rockysurf-sa.json
#
set -euo pipefail

PROJECT=""
ROLE_ID="rockySurfDevBoxManager"
SA_NAME="rockysurf"
CREATE_KEY=""
DRY_RUN=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLE_FILE="${SCRIPT_DIR}/rockysurf-role.yaml"

usage() {
  cat <<'USAGE'
Usage: deploy/gcp/setup.sh --project=PROJECT_ID [options]

  --project=ID        REQUIRED. The Google Cloud project to create everything in.
  --role-id=ID        Custom role id (default: rockySurfDevBoxManager). IAM role ids are
                      per-project, so a second Rocky Surf against the same project needs a
                      second id.
  --sa-name=NAME      Service account name (default: rockysurf).
  --create-key=PATH   Also create a service-account key at PATH. Off by default.
  --dry-run           Print what would run and change nothing.
  -h, --help          This.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --project=*) PROJECT="${arg#*=}" ;;
    --role-id=*) ROLE_ID="${arg#*=}" ;;
    --sa-name=*) SA_NAME="${arg#*=}" ;;
    --create-key=*) CREATE_KEY="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# No default project, and gcloud's ambient one is deliberately NOT consulted. This script
# creates an IAM role and a service account; inheriting which project that happens to in from
# the state of somebody's shell is not a thing to be relaxed about.
if [[ -z "$PROJECT" ]]; then
  echo "error: --project is required (there is no default, on purpose)" >&2
  usage >&2
  exit 2
fi

command -v gcloud >/dev/null 2>&1 || {
  echo "error: gcloud is not installed. It is the only prerequisite: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
}
[[ -f "$ROLE_FILE" ]] || {
  echo "error: role definition not found at $ROLE_FILE" >&2
  exit 1
}

SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

run() {
  if [[ -n "$DRY_RUN" ]]; then
    printf '  would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

echo "Rocky Surf GCP setup"
echo "  project:         $PROJECT"
echo "  custom role:     $ROLE_ID"
echo "  service account: $SA_EMAIL"
echo

echo "==> Enabling the Compute Engine API (no-op if already on)"
run gcloud services enable compute.googleapis.com --project="$PROJECT"

# `gcloud iam roles create` FAILS if the role exists and there is no upsert flag, so the
# create-or-update dance is the documented pattern rather than a workaround. Note that a
# recently DELETED role id is not immediately reusable — it needs `gcloud iam roles undelete`.
echo "==> Creating or updating the custom role"
if gcloud iam roles describe "$ROLE_ID" --project="$PROJECT" >/dev/null 2>&1; then
  echo "    role exists; updating it from $ROLE_FILE"
  run gcloud iam roles update "$ROLE_ID" --project="$PROJECT" --file="$ROLE_FILE"
else
  echo "    creating it from $ROLE_FILE"
  run gcloud iam roles create "$ROLE_ID" --project="$PROJECT" --file="$ROLE_FILE"
fi

echo "==> Creating the service account"
if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  echo "    already exists; leaving it alone"
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT" \
    --display-name="Rocky Surf" \
    --description="Creates and manages Rocky Surf dev boxes. Least-privilege; see deploy/gcp/rockysurf-role.yaml."
fi

echo "==> Binding the role to the service account"
run gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="projects/${PROJECT}/roles/${ROLE_ID}" \
  --condition=None

if [[ -n "$CREATE_KEY" ]]; then
  echo "==> Creating a service-account key at $CREATE_KEY"
  echo "    A key is a long-lived credential in a file. Rotate it, keep it out of version"
  echo "    control, and prefer the keyless paths below where you can."
  run gcloud iam service-accounts keys create "$CREATE_KEY" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT"
fi

cat <<EOF

Done.

Point Rocky Surf at it in rockysurf.config.yaml:

  providers:
    gcp:
      enabled: true
      projectId: $PROJECT
      zone: us-central1-a
      sshAllowedCidr: "YOUR.IP.ADDR.HERE/32"

and give it credentials for ${SA_EMAIL} in ONE of these ways, best first:

  1. Running on Google Cloud already? Attach the service account to the VM, Cloud Run service
     or GKE workload. Nothing to configure and no key exists to leak.

  2. Running elsewhere, in CI? Use workload identity federation, which exchanges your CI
     provider's own OIDC token for Google credentials. Still no key.

  3. Running it yourself, interactively?

       gcloud auth application-default login --impersonate-service-account=$SA_EMAIL

  4. A key file, if none of the above fit:

       export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

     or set providers.gcp.keyFile to that PATH. Never paste the key itself into the config
     file — there is deliberately nowhere in the schema to put it.

EOF
