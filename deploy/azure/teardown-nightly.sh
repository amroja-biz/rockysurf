#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — undo everything deploy/azure/setup-nightly.sh made.
#
# It removes the CI resource group and everything in it, the two identities, the two roles they
# were granted, and the settings saved in GitHub. After this the Azure leg of the nightly goes
# back to skipping with a notice, and the rest of the nightly carries on as before.
#
# IT ASKS BEFORE IT DELETES ANYTHING, and it names the resource group in the question. Read that
# name. Deleting a resource group deletes everything inside it.
#
# Like the setup script, it is safe to run twice: anything already gone is reported as gone.
#
#   ./deploy/azure/teardown-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/azure/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

GROUP='rocky-surf-ci'
PROVIDER_APP='rockysurf-nightly-provider'
SWEEP_APP='rockysurf-nightly-sweep'
REPO=''
SUBSCRIPTION=''
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Undo the nightly Azure setup. You only need to be signed in to Azure and GitHub.

  ./deploy/azure/teardown-nightly.sh [options]

Options:
  --subscription <id>   Which Azure subscription to use. Default: the one you are using now.
  --group <name>        The resource group to delete. Default: rocky-surf-ci
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask. Delete it all.
  -h, --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --subscription) SUBSCRIPTION=${2:?--subscription needs a value}; shift 2 ;;
    --group) GROUP=${2:?--group needs a value}; shift 2 ;;
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=5
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

say 'Undoing the nightly Azure setup.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be deleted.'; fi

command -v az >/dev/null 2>&1 ||
  fail 'The Azure CLI is not installed. Install it from https://aka.ms/azure-cli and run this again.'
az account show >/dev/null 2>&1 ||
  fail 'You are not signed in to Azure. Run: az login'
command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'

if [ -n "$SUBSCRIPTION" ]; then run az account set --subscription "$SUBSCRIPTION"; fi
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] || fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi

SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
say ''
say "This will delete the resource group $GROUP and everything inside it."
say "Subscription: $SUBSCRIPTION_NAME"
say "GitHub repository: $REPO"

if [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  [ -t 0 ] || fail 'Nobody is here to confirm this. Run it again with --yes if you are sure.'
  printf 'Type the group name to confirm: '
  read -r typed
  [ "$typed" = "$GROUP" ] || fail 'That did not match. Nothing was deleted.'
fi

# ---------------------------------------------------------------------------------------------
step 1 'Deleting the resource group and its contents.'

if az group show --name "$GROUP" >/dev/null 2>&1; then
  # Not --no-wait: the role definitions below cannot be removed while something still uses them,
  # and waiting here is what makes a single run finish the job.
  run az group delete --name "$GROUP" --yes --output none
  gone "resource group $GROUP"
else
  absent "resource group $GROUP"
fi

# ---------------------------------------------------------------------------------------------
step 2 'Deleting the two roles the nightly used.'

for role in "Rocky Surf Provider ($GROUP)" "Rocky Surf Catalogue Reader ($GROUP)" "Rocky Surf Nightly Sweep ($GROUP)"; do
  found=$(az role definition list --name "$role" --query "[0].name" -o tsv 2>/dev/null || true)
  if [ -n "$found" ]; then
    run az role definition delete --name "$role"
    gone "role $role"
  else
    absent "role $role"
  fi
done

# ---------------------------------------------------------------------------------------------
step 3 'Deleting the two identities.'

for app in "$PROVIDER_APP" "$SWEEP_APP"; do
  app_id=$(az ad app list --display-name "$app" --query "[0].appId" -o tsv 2>/dev/null || true)
  if [ -n "$app_id" ]; then
    run az ad app delete --id "$app_id"
    gone "identity $app"
  else
    absent "identity $app"
  fi
done

# ---------------------------------------------------------------------------------------------
step 4 'Removing the settings from GitHub.'

for name in AZURE_CI_SUBSCRIPTION AZURE_CI_RESOURCE_GROUP AZURE_CI_LOCATION AZURE_TENANT \
            AZURE_PROVIDER_CLIENT_ID AZURE_NIGHTLY_CLIENT_ID; do
  if gh variable list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$name"; then
    run gh variable delete "$name" --repo "$REPO"
    gone "$name"
  else
    absent "$name"
  fi
done

# ---------------------------------------------------------------------------------------------
step 5 'Done.'

say ''
say 'The Azure leg of the nightly will now skip, and say so in the run summary.'
say 'The Hetzner, AWS and GCP legs are untouched.'
say 'To set it all up again: ./deploy/azure/setup-nightly.sh'
if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was deleted.'
fi
