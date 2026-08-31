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
# "already done" instead of failing. It also ENDS BY CHECKING that Azure accepts the sign-in
# GitHub will actually present, so running it again is the way to diagnose a nightly refused with
# "AADSTS700213: No matching federated identity record found" (gh issue #270).
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

TOTAL=12
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

GITHUB_ISSUER='https://token.actions.githubusercontent.com'
GITHUB_AUDIENCE='api://AzureADTokenExchange'

SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"
# GitHub is moving from `repo:owner/name:...` to an immutable-id form,
# `repo:owner@1234/name@5678:...`, and a token may carry either — the first real run was refused
# with AADSTS700213 because only the classic form was trusted. Entra matches a federated
# credential's subject EXACTLY (no wildcards), so each app registration gets one credential per
# form: "${CREDENTIAL_NAME}" for the classic name and "${CREDENTIAL_NAME}-id" for the id form.
#
# THE TWO IDS ARE NOT OPTIONAL (gh issue #270). This step used to fall back to a one-line note
# when it could not read them, which made the id form easy to skip without noticing: the script
# still said it was done, and the only symptom was a run refused hours later in a workflow log
# nobody was watching. A setup that cannot produce the id form is a setup that does not work, so
# it stops here instead.
fed_ids=$(gh api "repos/${REPO}" --jq '"\(.owner.id)\t\(.id)"' 2>/dev/null || true)
fed_owner_id=$(printf '%s' "$fed_ids" | cut -f1)
fed_repo_id=$(printf '%s' "$fed_ids" | cut -f2)
# Digits, both of them: an unreadable field comes back as the string "null", which would build a
# subject Entra accepts and GitHub never presents — a worse outcome than not building one at all.
is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
if ! is_number "$fed_owner_id" || ! is_number "$fed_repo_id"; then
  fail "I could not read the two numbers GitHub uses to name $REPO in the token it makes for the
nightly — the owner id and the repository id. Azure has to be told to trust a sign-in carrying
those numbers, and they cannot be guessed, so I stopped rather than finish a setup whose only
symptom would be a failed run tomorrow morning.

This is nearly always an expired GitHub sign-in. Run 'gh auth login', then run this script again.
Everything it made before this point is fine to leave exactly where it is."
fi
IMMUTABLE_SUBJECT="repo:${REPO%%/*}@${fed_owner_id}/${REPO##*/}@${fed_repo_id}:ref:refs/heads/${BRANCH}"

ensure_federated_credential() {
  fed_app_id=$1
  fed_label=$2
  fed_name=$3
  fed_subject=$4
  # Both fields in one read: the delete below needs the credential's own id, because the name is
  # ours and the id is Entra's, and only the id is certain to identify it.
  existing=$(az ad app federated-credential list --id "$fed_app_id" \
    --query "[?name=='${fed_name}'].[id,subject]" -o tsv 2>/dev/null || true)
  existing_id=$(printf '%s' "$existing" | cut -f1)
  existing_subject=$(printf '%s' "$existing" | cut -f2)
  if [ -n "$existing_id" ] && [ "$existing_subject" = "$fed_subject" ]; then
    have "GitHub sign-in ($fed_name) for $fed_label"
    return 0
  fi
  if [ -n "$existing_id" ]; then
    # The repository or branch changed since the last run. Replace it rather than adding a second.
    note "Updating the GitHub sign-in ($fed_name) for $fed_label, which pointed somewhere else."
    run az ad app federated-credential delete --id "$fed_app_id" --federated-credential-id "$existing_id" --yes
  fi
  run az ad app federated-credential create --id "$fed_app_id" --parameters "$(printf '{
    "name": "%s",
    "issuer": "%s",
    "subject": "%s",
    "description": "Rocky Surf nightly real-cloud run",
    "audiences": ["%s"]
  }' "$fed_name" "$GITHUB_ISSUER" "$fed_subject" "$GITHUB_AUDIENCE")" --output none
  made "GitHub sign-in ($fed_name) for $fed_label"
}

ensure_federated_credential "$PROVIDER_APP_ID" "$PROVIDER_APP" "$CREDENTIAL_NAME" "$SUBJECT"
ensure_federated_credential "$SWEEP_APP_ID" "$SWEEP_APP" "$CREDENTIAL_NAME" "$SUBJECT"
ensure_federated_credential "$PROVIDER_APP_ID" "$PROVIDER_APP" "${CREDENTIAL_NAME}-id" "$IMMUTABLE_SUBJECT"
ensure_federated_credential "$SWEEP_APP_ID" "$SWEEP_APP" "${CREDENTIAL_NAME}-id" "$IMMUTABLE_SUBJECT"

# ---------------------------------------------------------------------------------------------
step 7 'Giving the tested identity exactly the permissions we publish.'
note 'These are the same two roles a self-hoster deploys, from the same file, unchanged.'
note 'This one takes a minute.'

# The deployment NAME carries the location because Azure pins a subscription-scope deployment
# name to the region its metadata was first created in — re-running with --location <elsewhere>
# under the old name fails with InvalidDeploymentLocation. A per-location name deploys fresh;
# stale metadata from an earlier region is inert and costs nothing.
run az deployment sub create \
  --location "$LOCATION" \
  --name "rockysurf-nightly-roles-${GROUP}-${LOCATION}" \
  --template-file "${SCRIPT_DIR}/role.bicep" \
  --parameters "resourceGroupName=${GROUP}" "principalId=${PROVIDER_OBJECT_ID}" \
  --output none
ready "the published roles are granted to $PROVIDER_APP"

# ---------------------------------------------------------------------------------------------
step 8 'Giving the cleanup identity permission to delete leftovers, and nothing else.'
note 'It cannot create anything, and it cannot touch the shared network.'

run az deployment sub create \
  --location "$LOCATION" \
  --name "rockysurf-nightly-sweep-${GROUP}-${LOCATION}" \
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
step 10 'Checking Azure will accept the sign-in GitHub will actually present.'
note 'Reading it back from Azure, rather than trusting that step 6 did what it said.'

# WHY THIS STEP EXISTS (gh issue #270). Entra matches a federated credential's subject exactly,
# and a missing one is invisible from here: nothing goes red until a run is refused with
# AADSTS700213, which is hours later, in a workflow log. Every way of ending up without one — a
# step that quietly skipped, a credential deleted by hand, a repository renamed — looks identical
# to a healthy setup unless something reads the state back and compares it. This is that read.
#
# It runs late on purpose: after the role deployments, so Entra has had a minute to catch up with
# the writes in step 6, and before the repository variables in step 11, so a setup that cannot
# sign in never turns the Azure leg on.
verify_app_trust() {
  vt_app_id=$1
  vt_label=$2
  vt_rows=$(az ad app federated-credential list --id "$vt_app_id" \
    --query "[].[subject,issuer,join(',', audiences)]" -o tsv 2>/dev/null || true)
  note "$vt_label accepts:"
  if [ -z "$vt_rows" ]; then
    note '    nothing at all'
  else
    printf '%s\n' "$vt_rows" | while IFS=$'\t' read -r vt_subject vt_issuer vt_audience; do
      printf '    %s\n      from %s, for %s\n' "$vt_subject" "$vt_issuer" "$vt_audience"
    done
  fi
  for vt_wanted in "$SUBJECT" "$IMMUTABLE_SUBJECT"; do
    if printf '%s\n' "$vt_rows" | awk -F'\t' -v s="$vt_wanted" -v i="$GITHUB_ISSUER" \
      -v a="$GITHUB_AUDIENCE" '$1 == s && $2 == i && index($3, a) { found = 1 }
                               END { exit found ? 0 : 1 }'; then
      continue
    fi
    MISSING_TRUST="${MISSING_TRUST}
  $vt_label does not accept: $vt_wanted"
  done
}

note 'GitHub will present one of these two, and Azure has to accept both:'
note "    $SUBJECT"
note "    $IMMUTABLE_SUBJECT"

MISSING_TRUST=''
if [ "$DRY_RUN" = 1 ]; then
  note 'Nothing was created in a dry run, so there is nothing to read back.'
else
  verify_app_trust "$PROVIDER_APP_ID" "$PROVIDER_APP"
  verify_app_trust "$SWEEP_APP_ID" "$SWEEP_APP"
fi

if [ -n "$MISSING_TRUST" ]; then
  fail "Azure will refuse the nightly, because it does not accept every sign-in GitHub can present:
${MISSING_TRUST}

That is the state behind 'AADSTS700213: No matching federated identity record found'. Run this
script again — it creates whatever is missing. If it says this a second time, the account you are
signed in to Azure with is probably not allowed to add sign-ins to these two identities, and
somebody who administers the Entra tenant has to run it instead."
fi
ready 'Azure accepts both sign-ins, on both identities'

# ---------------------------------------------------------------------------------------------
step 11 'Saving the settings in GitHub.'
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
step 12 'Starting the nightly, if you want to see it work now.'

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
