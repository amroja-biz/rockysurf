#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — set up the nightly real-cloud run on Azure. One command, run once.
#
# WHAT THIS IS FOR. The nightly workflow creates and destroys a real dev box on Azure every
# morning, under the exact permissions deploy/azure/role.bicep publishes to self-hosters. If a
# change to packages/provider-azure starts making a call that role does not cover, the nightly
# turns red the next morning instead of a stranger's first launch failing. Until this script has
# run, the Azure leg skips with a notice.
#
# WHAT YOU PROVIDE: nothing but two logins you probably already have — `az login` and
# `gh auth login`. Everything else is derived or defaulted, and every default can be overridden
# with a flag.
#
# THERE ARE NO SECRETS ANYWHERE IN THIS FLOW, and that is deliberate. GitHub mints a short-lived
# token for each run and Azure is told to trust it (a "federated credential"), so nothing
# long-lived is stored in the repository, nothing needs rotating, and there is nothing to leak.
#
# RUN IT AS OFTEN AS YOU LIKE. Every step checks before it creates, so a second run reports
# "already done" instead of failing.
#
# NOTHING THIS SCRIPT CREATES COSTS MONEY. Identities, roles and an empty resource group are all
# free; only the nightly's own machines bill, at roughly two cents a night.
#
#   ./deploy/azure/setup-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/azure/setup-nightly.sh
#
# To undo it all: ./deploy/azure/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

GROUP='rocky-surf-ci'
LOCATION='westus3'
PROVIDER_APP='rockysurf-nightly-provider'
SWEEP_APP='rockysurf-nightly-sweep'
CREDENTIAL_NAME='rockysurf-nightly'
BRANCH='main'
REPO=''
SUBSCRIPTION=''
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Set up the nightly Azure run. You only need to be signed in to Azure and GitHub.

  ./deploy/azure/setup-nightly.sh [options]

Options:
  --subscription <id>   Which Azure subscription to use. Asks you if you have more than one.
  --group <name>        The resource group to make. Default: rocky-surf-ci
  --location <region>   The Azure region to use. Default: westus3
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --branch <name>       The branch the nightly runs on. Default: main
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask anything. Use the first subscription and start the run.
  -h, --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --subscription) SUBSCRIPTION=${2:?--subscription needs a value}; shift 2 ;;
    --group) GROUP=${2:?--group needs a value}; shift 2 ;;
    --location) LOCATION=${2:?--location needs a value}; shift 2 ;;
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --branch) BRANCH=${2:?--branch needs a value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=11
say() { printf '%s\n' "$*"; }
step() { printf '\n[%d/%d] %s\n' "$1" "$TOTAL" "$2"; }
made() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would make: %s\n' "$*"; else printf '  made it: %s\n' "$*"; fi
}
ready() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would be ready: %s\n' "$*"; else printf '  ready: %s\n' "$*"; fi
}
have() { printf '  already there: %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
ask() {
  # One yes/no question. Answers "no" on its own when nobody is at the keyboard.
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}
# Every write goes through this, so --dry-run is one rule rather than one per step.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; return 0; fi
  "$@"
}

say 'Setting up the nightly Azure run.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be created.'; fi

# ---------------------------------------------------------------------------------------------
step 1 'Checking you are signed in.'

command -v az >/dev/null 2>&1 ||
  fail 'The Azure CLI is not installed. Install it from https://aka.ms/azure-cli and run this again.'
az account show >/dev/null 2>&1 ||
  fail 'You are not signed in to Azure. Run: az login'
command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'
note 'Signed in to Azure and GitHub.'

# Bicep is how the roles are written. The Azure CLI installs it on its own, but doing it here
# means the wait happens now rather than in the middle of a deployment.
if az bicep version >/dev/null 2>&1; then
  note 'Bicep is installed.'
else
  note 'Installing Bicep, which the Azure CLI needs to read the role files.'
  run az bicep install
fi

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] ||
    fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

# ---------------------------------------------------------------------------------------------
step 2 'Choosing the Azure subscription.'

if [ -n "$SUBSCRIPTION" ]; then
  run az account set --subscription "$SUBSCRIPTION"
else
  # Only ask when there is a real choice to make.
  count=$(az account list --query "length([?state=='Enabled'])" -o tsv)
  if [ "${count:-1}" -gt 1 ] && [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
    say '  You have more than one subscription. Which one should the nightly use?'
    i=0
    ids=''
    while IFS=$'\t' read -r id name; do
      [ -n "$id" ] || continue
      i=$((i + 1))
      printf '    %d) %s\n' "$i" "$name"
      ids="$ids$id "
    done <<EOF
$(az account list --query "[?state=='Enabled'].[id,name]" -o tsv)
EOF
    printf '  Type a number, or press enter to keep the one you are using now: '
    read -r choice
    if [ -n "$choice" ]; then
      case "$choice" in
        ''|*[!0-9]*) fail 'That was not one of the numbers on the list.' ;;
      esac
      picked=$(printf '%s' "$ids" | cut -d' ' -f"$choice")
      [ -n "$picked" ] || fail 'That was not one of the numbers on the list.'
      run az account set --subscription "$picked"
    fi
  fi
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
note "Using: $SUBSCRIPTION_NAME"
note 'Use a subscription that holds nothing else. The nightly cleans up after itself in it.'

# ---------------------------------------------------------------------------------------------
step 3 'Turning on the two Azure services the nightly needs.'

for namespace in Microsoft.Compute Microsoft.Network; do
  state=$(az provider show --namespace "$namespace" --query registrationState -o tsv 2>/dev/null || true)
  if [ "$state" = 'Registered' ]; then
    have "$namespace"
  else
    run az provider register --namespace "$namespace"
    made "$namespace (it can take a minute to finish on its own)"
  fi
done

# ---------------------------------------------------------------------------------------------
step 4 'Making the resource group the nightly works in.'

if az group show --name "$GROUP" >/dev/null 2>&1; then
  have "resource group $GROUP"
else
  run az group create --name "$GROUP" --location "$LOCATION" --output none
  made "resource group $GROUP in $LOCATION"
fi

# ---------------------------------------------------------------------------------------------
step 5 'Making the two identities the nightly runs as.'
note 'One is the identity being tested. The other only cleans up after it.'

# Prints the application id, making the app registration and its service principal if either is
# missing. Split in two because an app can exist without its service principal if an earlier run
# stopped in between.
ensure_app() {
  app_display=$1
  app_id=$(az ad app list --display-name "$app_display" --query "[0].appId" -o tsv 2>/dev/null || true)
  if [ -n "$app_id" ]; then
    have "identity $app_display" >&2
  else
    if [ "$DRY_RUN" = 1 ]; then
      printf '  would run: az ad app create --display-name %s\n' "$app_display" >&2
      app_id="would-be-created"
    else
      app_id=$(az ad app create --display-name "$app_display" --query appId -o tsv)
      made "identity $app_display" >&2
    fi
  fi
  printf '%s' "$app_id"
}

ensure_sp() {
  sp_app_id=$1
  sp_label=$2
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run: az ad sp create --id %s\n' "$sp_app_id" >&2
    printf '%s' 'would-be-created'
    return 0
  fi
  sp_object_id=$(az ad sp show --id "$sp_app_id" --query id -o tsv 2>/dev/null || true)
  if [ -z "$sp_object_id" ]; then
    sp_object_id=$(az ad sp create --id "$sp_app_id" --query id -o tsv)
    made "sign-in account for $sp_label" >&2
  fi
  printf '%s' "$sp_object_id"
}

PROVIDER_APP_ID=$(ensure_app "$PROVIDER_APP")
PROVIDER_OBJECT_ID=$(ensure_sp "$PROVIDER_APP_ID" "$PROVIDER_APP")
SWEEP_APP_ID=$(ensure_app "$SWEEP_APP")
SWEEP_OBJECT_ID=$(ensure_sp "$SWEEP_APP_ID" "$SWEEP_APP")

# ---------------------------------------------------------------------------------------------
step 6 'Letting GitHub sign in as those identities, without a password.'
note "Azure will accept a token GitHub makes for $REPO on the $BRANCH branch, and nothing else."

SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"

ensure_federated_credential() {
  fed_app_id=$1
  fed_label=$2
  existing=$(az ad app federated-credential list --id "$fed_app_id" \
    --query "[?name=='${CREDENTIAL_NAME}'].subject" -o tsv 2>/dev/null || true)
  if [ "$existing" = "$SUBJECT" ]; then
    have "GitHub sign-in for $fed_label"
    return 0
  fi
  if [ -n "$existing" ]; then
    # The repository or branch changed since the last run. Replace it rather than adding a second.
    note "Updating the GitHub sign-in for $fed_label, which pointed somewhere else."
    run az ad app federated-credential delete --id "$fed_app_id" --federated-credential-id "$CREDENTIAL_NAME" --yes
  fi
  run az ad app federated-credential create --id "$fed_app_id" --parameters "$(printf '{
    "name": "%s",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "%s",
    "description": "Rocky Surf nightly real-cloud run",
    "audiences": ["api://AzureADTokenExchange"]
  }' "$CREDENTIAL_NAME" "$SUBJECT")" --output none
  made "GitHub sign-in for $fed_label"
}

ensure_federated_credential "$PROVIDER_APP_ID" "$PROVIDER_APP"
ensure_federated_credential "$SWEEP_APP_ID" "$SWEEP_APP"

# ---------------------------------------------------------------------------------------------
step 7 'Giving the tested identity exactly the permissions we publish.'
note 'These are the same two roles a self-hoster deploys, from the same file, unchanged.'
note 'This one takes a minute.'

run az deployment sub create \
  --location "$LOCATION" \
  --name "rockysurf-nightly-roles-${GROUP}" \
  --template-file "${SCRIPT_DIR}/role.bicep" \
  --parameters "resourceGroupName=${GROUP}" "principalId=${PROVIDER_OBJECT_ID}" \
  --output none
ready "the published roles are granted to $PROVIDER_APP"

# ---------------------------------------------------------------------------------------------
step 8 'Giving the cleanup identity permission to delete leftovers, and nothing else.'
note 'It cannot create anything, and it cannot touch the shared network.'

run az deployment sub create \
  --location "$LOCATION" \
  --name "rockysurf-nightly-sweep-${GROUP}" \
  --template-file "${SCRIPT_DIR}/nightly-sweep-role.bicep" \
  --parameters "resourceGroupName=${GROUP}" "principalId=${SWEEP_OBJECT_ID}" \
  --output none
ready "the cleanup role is granted to $SWEEP_APP"

# ---------------------------------------------------------------------------------------------
step 9 'Checking Azure will let you run the two machine sizes.'
note 'A new subscription is often allowed zero of them until you ask.'

# Azure gates a create twice: whether it sells the size here, and whether you have vCPU quota for
# its family. The second is invisible until a create fails, so it is worth reading now.
quota_short=''
usage_rows=$(az vm list-usage --location "$LOCATION" --query "[].[name.value,currentValue,limit]" -o tsv 2>/dev/null || true)
if [ -z "$usage_rows" ]; then
  note 'I could not read your quota. Skipping this check; the nightly will tell you if it is short.'
else
  for family in StandardDlsv6Family StandardDplsv6Family; do
    limit=$(printf '%s\n' "$usage_rows" | awk -v f="$family" 'tolower($1) == tolower(f) { print $3 }' | head -n 1)
    case "$limit" in
      ''|*[!0-9]*) limit='' ;;
    esac
    if [ -z "$limit" ]; then
      note "I could not read the quota for $family in $LOCATION. The nightly will say so if it matters."
    elif [ "$limit" -lt 2 ]; then
      quota_short="$quota_short $family"
      note "Not enough: $family is allowed $limit vCPUs in $LOCATION, and 2 are needed."
    else
      note "Fine: $family is allowed $limit vCPUs in $LOCATION."
    fi
  done
fi

# ---------------------------------------------------------------------------------------------
step 10 'Saving the settings in GitHub.'
note 'None of these is a secret. They are names and ids, and they are safe to read.'

set_variable() {
  var_name=$1
  var_value=$2
  run gh variable set "$var_name" --repo "$REPO" --body "$var_value"
  note "$var_name"
}

set_variable AZURE_CI_SUBSCRIPTION "$SUBSCRIPTION_ID"
set_variable AZURE_CI_RESOURCE_GROUP "$GROUP"
set_variable AZURE_CI_LOCATION "$LOCATION"
set_variable AZURE_TENANT "$(az account show --query tenantId -o tsv)"
set_variable AZURE_PROVIDER_CLIENT_ID "$PROVIDER_APP_ID"
set_variable AZURE_NIGHTLY_CLIENT_ID "$SWEEP_APP_ID"

# ---------------------------------------------------------------------------------------------
step 11 'Starting the nightly, if you want to see it work now.'

say ''
say 'Setup is done.'
say "The nightly will build and destroy one Azure box each morning, in $GROUP."
say 'It costs about two cents a night. Nothing this script made costs anything on its own.'
say 'No password or key was created, stored or printed. There is nothing here to rotate.'
say 'Run this script again any time. It will say what is already done and change nothing else.'
say 'To undo all of it: ./deploy/azure/teardown-nightly.sh'

if [ -n "$quota_short" ]; then
  say ''
  say 'One thing is not ready, and only you can fix it.'
  say "Azure has not given you enough vCPUs for:$quota_short"
  say 'Here is what to do, and it usually takes a few minutes to be approved:'
  say '  1. Open https://portal.azure.com and search for "Quotas".'
  say '  2. Choose "Compute".'
  say "  3. Set the region filter to $LOCATION."
  say '  4. Find each family named above in the list.'
  say '  5. Tick it, choose "New Quota Request", ask for 2 or more vCPUs, and submit.'
  say 'The nightly will fail with a clear message until that is approved.'
fi

if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was created. Run it again without --dry-run to do it for real.'
  exit 0
fi

say ''
if [ -n "$quota_short" ]; then
  say 'Not starting a run yet, because it would fail on the quota above.'
  say "Once the quota is approved, run: gh workflow run nightly-real-cloud.yml --repo $REPO"
  exit 0
fi

if ask 'Start a run now to check it works?'; then
  run gh workflow run nightly-real-cloud.yml --repo "$REPO"
  say 'Started. Watch it with: gh run watch'
else
  say 'Not started. It will run on its own at 07:00 UTC.'
  say "To start one yourself: gh workflow run nightly-real-cloud.yml --repo $REPO"
fi
