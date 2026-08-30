#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — undo everything deploy/gcp/setup-nightly.sh made.
#
# It removes any machine the nightly left behind, the sign-in pool GitHub used, the two service
# accounts, the two roles they carried, and the settings saved in GitHub. After this the GCP leg
# of the nightly goes back to skipping with a notice, and the rest of the nightly carries on as
# before.
#
# IT DOES NOT DELETE THE PROJECT. That is yours, and deleting one is not something a script
# should do on your behalf. Everything it does delete lives inside it.
#
# IT ASKS BEFORE IT DELETES ANYTHING, and it names the project in the question. Read that name.
#
# Like the setup script, it is safe to run twice: anything already gone is reported as gone.
#
#   ./deploy/gcp/teardown-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/gcp/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

PROJECT=''
REPO=''
POOL_ID='github'
PROVIDER_ID='rockysurf-nightly'
PROVIDER_SA_NAME='rockysurf'
SWEEP_SA_NAME='rockysurf-nightly-ci'
PUBLISHED_ROLE_ID='rockySurfDevBoxManager'
SWEEP_ROLE_ID='rockySurfNightlySweep'
ZONE=''
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Undo the nightly Google Cloud setup. You only need to be signed in to Google and GitHub.

  ./deploy/gcp/teardown-nightly.sh [options]

Options:
  --project <id>        The CI-only project to clean out. Default: the one saved in GitHub.
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --zone <zone>         Where to look for leftover machines. Default: the saved GCP_CI_ZONE,
                        or us-central1-a.
  --pool <id>           The workload identity pool to delete. Default: github
  --provider <id>       The sign-in provider inside it. Default: rockysurf-nightly
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask. Delete it all.
  -h, --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=${2:?--project needs a value}; shift 2 ;;
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --zone) ZONE=${2:?--zone needs a value}; shift 2 ;;
    --pool) POOL_ID=${2:?--pool needs a value}; shift 2 ;;
    --provider) PROVIDER_ID=${2:?--provider needs a value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=6
say() { printf '%s\n' "$*"; }
step() { printf '\n[%d/%d] %s\n' "$1" "$TOTAL" "$2"; }
gone() { printf '  deleted: %s\n' "$*"; }
absent() { printf '  already gone: %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; return 0; fi
  "$@"
}

say 'Undoing the nightly Google Cloud setup.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be deleted.'; fi

command -v gcloud >/dev/null 2>&1 ||
  fail 'The Google Cloud CLI is not installed. Install it from https://cloud.google.com/sdk/docs/install and run this again.'
gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q . ||
  fail 'You are not signed in to Google Cloud. Run: gcloud auth login'
command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] || fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi

variable_value() { gh variable get "$1" --repo "$REPO" 2>/dev/null || true; }

if [ -z "$PROJECT" ]; then
  PROJECT=$(variable_value GCP_CI_PROJECT)
  [ -n "$PROJECT" ] ||
    fail 'I could not tell which project to clean out. Pass it with --project <id>.'
fi
if [ -z "$ZONE" ]; then
  ZONE=$(variable_value GCP_CI_ZONE)
  [ -n "$ZONE" ] || ZONE='us-central1-a'
fi

PROVIDER_SA_EMAIL="${PROVIDER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SWEEP_SA_EMAIL="${SWEEP_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

say ''
say "This will delete, inside the project $PROJECT:"
say "  any machine in $ZONE labelled managed-by=rockysurf"
say "  the sign-in pool $POOL_ID and its provider $PROVIDER_ID"
say "  the identities $PROVIDER_SA_EMAIL and $SWEEP_SA_EMAIL"
say "  the roles $PUBLISHED_ROLE_ID and $SWEEP_ROLE_ID"
say 'The project itself is left alone, and so is anything in it without that label.'
say "GitHub repository: $REPO"

if [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  [ -t 0 ] || fail 'Nobody is here to confirm this. Run it again with --yes if you are sure.'
  printf 'Type the project id to confirm: '
  read -r typed
  [ "$typed" = "$PROJECT" ] || fail 'That did not match. Nothing was deleted.'
fi

# ---------------------------------------------------------------------------------------------
step 1 'Deleting machines the nightly left behind.'
note 'Only ones labelled managed-by=rockysurf. Anything else in the project is left alone.'

leftovers=$(gcloud compute instances list --project="$PROJECT" --zones="$ZONE" \
  --filter='labels.managed-by=rockysurf' --format='value(name)' 2>/dev/null || true)
if [ -n "$leftovers" ]; then
  while IFS= read -r machine; do
    [ -n "$machine" ] || continue
    run gcloud compute instances delete "$machine" --project="$PROJECT" --zone="$ZONE" --quiet
    gone "machine $machine"
  done <<EOF
$leftovers
EOF
else
  absent "machines in $ZONE"
fi

# ---------------------------------------------------------------------------------------------
step 2 'Deleting the sign-in pool GitHub used.'

if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
  --format='value(state)' 2>/dev/null | grep -qx 'ACTIVE'; then
  run gcloud iam workload-identity-pools providers delete "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" --quiet
  gone "sign-in provider $PROVIDER_ID"
else
  absent "sign-in provider $PROVIDER_ID"
fi

if gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT" --location=global --format='value(state)' 2>/dev/null | grep -qx 'ACTIVE'; then
  run gcloud iam workload-identity-pools delete "$POOL_ID" \
    --project="$PROJECT" --location=global --quiet
  gone "sign-in pool $POOL_ID"
else
  absent "sign-in pool $POOL_ID"
fi

# ---------------------------------------------------------------------------------------------
step 3 'Deleting the two identities.'

for sa in "$PROVIDER_SA_EMAIL" "$SWEEP_SA_EMAIL"; do
  if gcloud iam service-accounts describe "$sa" --project="$PROJECT" >/dev/null 2>&1; then
    run gcloud iam service-accounts delete "$sa" --project="$PROJECT" --quiet
    gone "identity $sa"
  else
    absent "identity $sa"
  fi
done

# ---------------------------------------------------------------------------------------------
step 4 'Deleting the two roles.'

for role in "$PUBLISHED_ROLE_ID" "$SWEEP_ROLE_ID"; do
  state=$(gcloud iam roles describe "$role" --project="$PROJECT" --format='value(deleted)' 2>/dev/null || true)
  if [ "$state" = 'True' ]; then
    absent "role $role"
  elif gcloud iam roles describe "$role" --project="$PROJECT" >/dev/null 2>&1; then
    run gcloud iam roles delete "$role" --project="$PROJECT" --quiet
    gone "role $role"
  else
    absent "role $role"
  fi
done

# ---------------------------------------------------------------------------------------------
step 5 'Removing the settings from GitHub.'

for name in GCP_CI_PROJECT GCP_WORKLOAD_IDENTITY_PROVIDER GCP_PROVIDER_SERVICE_ACCOUNT \
            GCP_NIGHTLY_SERVICE_ACCOUNT GCP_CI_ZONE; do
  if gh variable list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$name"; then
    run gh variable delete "$name" --repo "$REPO"
    gone "$name"
  else
    absent "$name"
  fi
done

# ---------------------------------------------------------------------------------------------
step 6 'Done.'

say ''
say 'The GCP leg of the nightly will now skip, and say so in the run summary.'
say 'The Hetzner, AWS and Azure legs are untouched.'
say 'To set it all up again: ./deploy/gcp/setup-nightly.sh'
say 'Google keeps deleted roles and pools for a while before purging them; the setup script'
say 'brings them back rather than failing on a name that is still taken.'
if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was deleted.'
fi
