#!/usr/bin/env bash
#
# Rocky Surf — wire the nightly real-cloud GCP leg into a CI-ONLY Google Cloud project.
#
# ---------------------------------------------------------------------------------------------
# THIS IS CI INFRASTRUCTURE, NOT A SHIPPED ARTIFACT.
#
# `deploy/gcp/setup.sh` is what a self-hoster runs: it creates the least-privilege role that
# `docs/providers/gcp.md` publishes, a service account, and the binding between them. This script
# CALLS that one unmodified and then adds the parts that exist only so
# `.github/workflows/nightly-real-cloud.yml` can authenticate without a key:
#
#   1. a Workload Identity Federation pool and an OIDC provider trusting GitHub's issuer,
#      constrained to ONE repository and ONE workflow file;
#   2. a CI-only sweep service account carrying deploy/gcp/nightly-sweep-role.yaml;
#   3. `roles/iam.workloadIdentityUser` on both service accounts for that repository's identity.
#
# NO KEY IS CREATED ANYWHERE ON THIS PATH, and there is no flag to create one. The whole point of
# federation is that the credential is GitHub's own short-lived OIDC token, exchanged at run time;
# a key file would be a long-lived credential to rotate, leak and forget.
#
# ─── USE A DEDICATED, CI-ONLY PROJECT. THIS IS THE ONE RULE THAT MATTERS ─────────────────────
#
# Never point this at the project from docs/providers/gcp.md, at the project anybody runs their
# own Rocky Surf against, or at a project holding anything else at all. The nightly creates and
# destroys real machines every morning, and its sweep lists everything in the zone carrying the
# `managed-by=rockysurf` label. That sweep is deliberately narrow — it deletes only the
# `server-id` values the run itself recorded and merely reports the rest — but the narrowness is
# a second line of defence, not the first. The first is that a machine somebody cares about is
# not in this project at all.
#
# The reason this warning is phrased so bluntly is that the mistake has already been made once, on
# Hetzner: on 2026-08-12 the owner launched a server from their own Rocky Surf against the same
# project the nightly used, and the sweep destroyed it 37 seconds later while reporting it as a
# leak it had helpfully cleaned up. A separate project is what makes that class of accident
# impossible rather than merely unlikely.
#
# ─── USAGE ───────────────────────────────────────────────────────────────────────────────────
#
#   ./deploy/gcp/nightly-ci.sh --project=rockysurf-nightly-ci --dry-run    # read it first
#   ./deploy/gcp/nightly-ci.sh --project=rockysurf-nightly-ci
#
# Everything is idempotent: run it again after editing a role file and it updates in place.
# gcloud is the only prerequisite (`gh` is not needed — the commands to set the repository
# variables are printed for you to run).
# ---------------------------------------------------------------------------------------------
set -euo pipefail

PROJECT=""
REPO="amroja-biz/rockysurf"
WORKFLOW=".github/workflows/nightly-real-cloud.yml"
POOL_ID="github"
PROVIDER_ID="rockysurf-nightly"
SWEEP_ROLE_ID="rockySurfNightlySweep"
SWEEP_SA_NAME="rockysurf-nightly-ci"
PROVIDER_SA_NAME="rockysurf"
ZONE="us-central1-a"
DRY_RUN=""
ASSUME_YES=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWEEP_ROLE_FILE="${SCRIPT_DIR}/nightly-sweep-role.yaml"
PROVIDER_SETUP="${SCRIPT_DIR}/setup.sh"

usage() {
  cat <<'USAGE'
Usage: deploy/gcp/nightly-ci.sh --project=PROJECT_ID [options]

  --project=ID          REQUIRED. A CI-ONLY Google Cloud project. Never the one from the role
                        docs, and never one anybody runs their own Rocky Surf against.
  --repo=OWNER/NAME     The GitHub repository allowed to federate (default: amroja-biz/rockysurf).
  --workflow=PATH       The workflow file allowed to federate, repo-relative
                        (default: .github/workflows/nightly-real-cloud.yml).
  --pool-id=ID          Workload identity pool id (default: github).
  --provider-id=ID      OIDC provider id within the pool (default: rockysurf-nightly).
  --sa-name=NAME        CI-only sweep service account (default: rockysurf-nightly-ci).
  --provider-sa-name=N  The service account carrying the PUBLISHED role. Must match whatever
                        deploy/gcp/setup.sh created (default: rockysurf).
  --sweep-role-id=ID    Custom role id for the sweep (default: rockySurfNightlySweep).
  --zone=ZONE           The zone the nightly runs in; only printed, for GCP_CI_ZONE
                        (default: us-central1-a, one of the eight with T2A/arm64 stock).
  --dry-run             Print every command it would run and change nothing.
  --yes                 Skip the "is this really a CI-only project?" confirmation.
  -h, --help            This.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --project=*) PROJECT="${arg#*=}" ;;
    --repo=*) REPO="${arg#*=}" ;;
    --workflow=*) WORKFLOW="${arg#*=}" ;;
    --pool-id=*) POOL_ID="${arg#*=}" ;;
    --provider-id=*) PROVIDER_ID="${arg#*=}" ;;
    --sa-name=*) SWEEP_SA_NAME="${arg#*=}" ;;
    --provider-sa-name=*) PROVIDER_SA_NAME="${arg#*=}" ;;
    --sweep-role-id=*) SWEEP_ROLE_ID="${arg#*=}" ;;
    --zone=*) ZONE="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
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

# No default project, and gcloud's ambient one is deliberately NOT consulted — the same rule
# deploy/gcp/setup.sh follows, and it matters more here: this script grants a GitHub repository
# the right to act in whatever project it is pointed at.
if [[ -z "$PROJECT" ]]; then
  echo "error: --project is required (there is no default, on purpose)" >&2
  usage >&2
  exit 2
fi

command -v gcloud >/dev/null 2>&1 || {
  echo "error: gcloud is not installed. It is the only prerequisite: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
}
[[ -f "$SWEEP_ROLE_FILE" ]] || {
  echo "error: sweep role definition not found at $SWEEP_ROLE_FILE" >&2
  exit 1
}
[[ -x "$PROVIDER_SETUP" ]] || {
  echo "error: the shipped provider setup script is missing or not executable: $PROVIDER_SETUP" >&2
  exit 1
}

SWEEP_SA_EMAIL="${SWEEP_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
PROVIDER_SA_EMAIL="${PROVIDER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

run() {
  if [[ -n "$DRY_RUN" ]]; then
    printf '  would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

cat <<EOF
Rocky Surf nightly CI setup (GCP)
  project:            $PROJECT
  repository:         $REPO
  workflow:           $WORKFLOW
  pool / provider:    $POOL_ID / $PROVIDER_ID
  identity under test: $PROVIDER_SA_EMAIL   (the PUBLISHED least-privilege role)
  sweep identity:     $SWEEP_SA_EMAIL   (CI-only)

EOF

if [[ -z "$ASSUME_YES" && -z "$DRY_RUN" ]]; then
  echo "This project will have real machines created and destroyed in it every morning, and a"
  echo "sweep will list everything in it labelled managed-by=rockysurf. It must be a project that"
  echo "holds NOTHING ELSE — not the one in docs/providers/gcp.md, and not one anybody runs their"
  echo "own Rocky Surf against."
  echo
  read -r -p "Is '$PROJECT' a dedicated CI-only project? [y/N] " reply
  case "$reply" in
    [yY] | [yY][eE][sS]) ;;
    *)
      echo "aborted; nothing was changed." >&2
      exit 1
      ;;
  esac
  echo
fi

echo "==> Enabling the APIs federation needs (no-op if already on)"
# compute: the thing under test. iam + iamcredentials + sts: the exchange itself — a pool with no
# `sts.googleapis.com` fails at run time with an opaque 403 rather than at creation.
run gcloud services enable \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project="$PROJECT"

echo
echo "==> Creating the PUBLISHED role and its service account, via the SHIPPED script"
echo "    ($PROVIDER_SETUP, unmodified — what runs in CI must be what self-hosters deploy)"
if [[ -n "$DRY_RUN" ]]; then
  "$PROVIDER_SETUP" --project="$PROJECT" --sa-name="$PROVIDER_SA_NAME" --dry-run
else
  "$PROVIDER_SETUP" --project="$PROJECT" --sa-name="$PROVIDER_SA_NAME"
fi

echo
echo "==> Creating or updating the CI-only sweep role"
if gcloud iam roles describe "$SWEEP_ROLE_ID" --project="$PROJECT" >/dev/null 2>&1; then
  echo "    role exists; updating it from $SWEEP_ROLE_FILE"
  run gcloud iam roles update "$SWEEP_ROLE_ID" --project="$PROJECT" --file="$SWEEP_ROLE_FILE"
else
  echo "    creating it from $SWEEP_ROLE_FILE"
  run gcloud iam roles create "$SWEEP_ROLE_ID" --project="$PROJECT" --file="$SWEEP_ROLE_FILE"
fi

echo "==> Creating the sweep service account"
if gcloud iam service-accounts describe "$SWEEP_SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  echo "    already exists; leaving it alone"
else
  run gcloud iam service-accounts create "$SWEEP_SA_NAME" \
    --project="$PROJECT" \
    --display-name="Rocky Surf nightly sweep" \
    --description="CI only. Cleans up after .github/workflows/nightly-real-cloud.yml; see deploy/gcp/nightly-sweep-role.yaml."
fi

echo "==> Binding the sweep role to the sweep service account"
run gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SWEEP_SA_EMAIL}" \
  --role="projects/${PROJECT}/roles/${SWEEP_ROLE_ID}" \
  --condition=None

echo
echo "==> Creating the workload identity pool"
if gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT" --location=global >/dev/null 2>&1; then
  echo "    already exists; leaving it alone"
else
  run gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT" \
    --location=global \
    --display-name="GitHub Actions" \
    --description="Federated identities for GitHub Actions workflows in $REPO."
fi

# WHAT THE PROVIDER WILL AND WILL NOT ACCEPT, in one condition.
#
# Google REQUIRES an attribute condition on a provider whose issuer is a shared public one like
# GitHub's: without it, ANY GitHub Actions workflow on the entire internet holds a token this pool
# would accept. The condition below is the boundary, and it is two clauses:
#
#   - the repository, exactly. Not the owner, not a prefix.
#   - the workflow FILE, by `job_workflow_ref` prefix. So a token minted for some other workflow
#     in this same repository — one a pull request from a fork could reach — is refused.
#
# The ref is deliberately NOT pinned. `job_workflow_ref` ends `@refs/heads/<branch>`, and the
# schedule trigger always runs on the default branch, which this project has already changed once
# and expects to change again; a pinned ref would fail with an opaque STS error on the morning
# after a rename. Leaving the ref open also lets the wiring be proven from a branch with
# workflow_dispatch before it merges, which is exactly how it should first be run. What stays
# excluded is every other repository, every other workflow, and — because pull_request runs of
# this file cannot exist, the workflow having no `pull_request` trigger — every fork.
ATTRIBUTE_CONDITION="assertion.repository == '${REPO}' && assertion.job_workflow_ref.startsWith('${REPO}/${WORKFLOW}@')"
ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.workflow_ref=assertion.job_workflow_ref"

echo "==> Creating or updating the OIDC provider"
echo "    condition: $ATTRIBUTE_CONDITION"
if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  echo "    provider exists; updating it in place"
  run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --attribute-mapping="$ATTRIBUTE_MAPPING" \
    --attribute-condition="$ATTRIBUTE_CONDITION" \
    --issuer-uri="https://token.actions.githubusercontent.com"
else
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --display-name="Rocky Surf nightly" \
    --attribute-mapping="$ATTRIBUTE_MAPPING" \
    --attribute-condition="$ATTRIBUTE_CONDITION" \
    --issuer-uri="https://token.actions.githubusercontent.com"
fi

# The pool's resource name uses the project NUMBER, not the project id, in both the IAM member
# below and the `workload_identity_provider` input the action takes. Using the id there is the
# single most common way this wiring fails, and it fails at run time with a "not found".
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)
if [[ -z "$PROJECT_NUMBER" ]]; then
  # Only reachable under --dry-run, or when the caller cannot read the project — in which case
  # nothing above this line succeeded either. The placeholder keeps the printed commands
  # readable instead of silently emitting a resource name with an empty segment in it.
  [[ -n "$DRY_RUN" ]] || {
    echo "error: could not read the project number for $PROJECT. Is the project id right, and are you logged in?" >&2
    exit 1
  }
  PROJECT_NUMBER='<PROJECT_NUMBER>'
fi
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
MEMBER="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${REPO}"

echo
echo "==> Letting $REPO impersonate both service accounts"
# Two grants, and they are not interchangeable. The nightly authenticates twice: as the sweep
# account (captured, never exported) and as the published one (the identity under test). Grant
# only the second and the sweep cannot clean up after a failed run; grant only the first and the
# lifecycle runs under an identity that proves nothing about the published role.
for sa in "$SWEEP_SA_EMAIL" "$PROVIDER_SA_EMAIL"; do
  run gcloud iam service-accounts add-iam-policy-binding "$sa" \
    --project="$PROJECT" \
    --role="roles/iam.workloadIdentityUser" \
    --member="$MEMBER"
done

cat <<EOF

Done.

Set these four repository variables — none of them is a credential, which is the point:

  gh variable set GCP_CI_PROJECT --repo $REPO --body "$PROJECT"
  gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo $REPO --body "$PROVIDER_NAME"
  gh variable set GCP_PROVIDER_SERVICE_ACCOUNT --repo $REPO --body "$PROVIDER_SA_EMAIL"
  gh variable set GCP_NIGHTLY_SERVICE_ACCOUNT --repo $REPO --body "$SWEEP_SA_EMAIL"

Optionally, if the nightly should not run in us-central1-a:

  gh variable set GCP_CI_ZONE --repo $REPO --body "$ZONE"

  (arm64 needs a zone with T2A stock: us-central1-a, us-central1-b, us-central1-f,
   europe-west4-a/b/c, asia-southeast1-b/c. Anywhere else and the arm64 leg fails the
   availability check before it creates anything.)

Then prove it once, without waiting for 07:00 UTC:

  gh workflow run nightly-real-cloud.yml --repo $REPO

The GCP job should stop skipping and take roughly twenty minutes for both architectures. If the
token exchange is refused, the condition on the provider is where to look first — it names one
repository and one workflow file, on purpose.
EOF
