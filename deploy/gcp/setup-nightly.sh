#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — set up the nightly real-cloud run on Google Cloud. One command, run once.
#
# WHAT THIS IS FOR. The nightly workflow creates and destroys a real dev box on Google Cloud
# every morning, under the exact permissions deploy/gcp/rockysurf-role.yaml publishes to
# self-hosters. If a change to packages/provider-gcp starts making a call that role does not
# cover, the nightly turns red the next morning instead of a stranger's first launch failing.
# Until this script has run, the GCP leg skips with a notice.
#
# WHAT YOU PROVIDE: nothing but two logins you probably already have — `gcloud auth login` and
# `gh auth login`. Everything else is derived or defaulted, and every default can be overridden
# with a flag.
#
# THERE ARE NO SECRETS ANYWHERE IN THIS FLOW, and that is deliberate. GitHub mints a short-lived
# token for each run and Google is told to trust it (a "workload identity pool"), so nothing
# long-lived is stored in the repository, nothing needs rotating, and there is nothing to leak.
# No service-account key is created anywhere on this path, and there is no flag to create one.
#
# USE A PROJECT THAT HOLDS NOTHING ELSE. This is the one rule that matters. The nightly builds
# and destroys machines in it every morning and sweeps up what it finds. On 2026-08-12 the
# Hetzner leg destroyed the owner's own live server because it shared a project with CI, and
# reported it as a leak it had helpfully cleaned up. A separate project makes that impossible
# rather than merely unlikely.
#
# RUN IT AS OFTEN AS YOU LIKE. Every step checks before it creates, so a second run reports
# "already there" and writes nothing at all.
#
# NOTHING THIS SCRIPT CREATES COSTS MONEY. Roles, service accounts and an identity pool are all
# free; only the nightly's own machines bill, at roughly two cents a night.
#
#   ./deploy/gcp/setup-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/gcp/setup-nightly.sh
#
# To undo it all: ./deploy/gcp/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

PROJECT=''
REPO=''
BRANCH_WORKFLOW='.github/workflows/nightly-real-cloud.yml'
POOL_ID='github'
PROVIDER_ID='rockysurf-nightly'
PROVIDER_SA_NAME='rockysurf'
SWEEP_SA_NAME='rockysurf-nightly-ci'
PUBLISHED_ROLE_ID='rockySurfDevBoxManager'
SWEEP_ROLE_ID='rockySurfNightlySweep'
ZONE='us-central1-a'
ZONE_GIVEN=0
DRY_RUN=0
ASSUME_YES=0

PUBLISHED_ROLE_FILE="${SCRIPT_DIR}/rockysurf-role.yaml"
SWEEP_ROLE_FILE="${SCRIPT_DIR}/nightly-sweep-role.yaml"
PUBLISHED_SETUP="${SCRIPT_DIR}/setup.sh"

usage() {
  cat <<'EOF'
Set up the nightly Google Cloud run. You only need to be signed in to Google and GitHub.

  ./deploy/gcp/setup-nightly.sh [options]

Options:
  --project <id>        The CI-only Google Cloud project. Asks you if it cannot tell.
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --workflow <path>     The workflow file allowed to sign in.
                        Default: .github/workflows/nightly-real-cloud.yml
  --zone <zone>         The zone the nightly runs in. Default: us-central1-a
  --pool <id>           The workload identity pool. Default: github
  --provider <id>       The sign-in provider inside that pool. Default: rockysurf-nightly
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask anything. Use what is saved and start the run.
  -h, --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=${2:?--project needs a value}; shift 2 ;;
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --workflow) BRANCH_WORKFLOW=${2:?--workflow needs a value}; shift 2 ;;
    --zone) ZONE=${2:?--zone needs a value}; ZONE_GIVEN=1; shift 2 ;;
    --pool) POOL_ID=${2:?--pool needs a value}; shift 2 ;;
    --provider) PROVIDER_ID=${2:?--provider needs a value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=10
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

say 'Setting up the nightly Google Cloud run.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be created.'; fi

# ---------------------------------------------------------------------------------------------
step 1 'Checking you are signed in.'

command -v gcloud >/dev/null 2>&1 ||
  fail 'The Google Cloud CLI is not installed. Install it from https://cloud.google.com/sdk/docs/install and run this again.'
active_account=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)
[ -n "$active_account" ] ||
  fail 'You are not signed in to Google Cloud. Run: gcloud auth login'
command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'
note 'Signed in to Google Cloud and GitHub.'

[ -f "$PUBLISHED_ROLE_FILE" ] || fail "The published role file is missing: $PUBLISHED_ROLE_FILE"
[ -f "$SWEEP_ROLE_FILE" ] || fail "The sweep role file is missing: $SWEEP_ROLE_FILE"
[ -x "$PUBLISHED_SETUP" ] || fail "The shipped setup script is missing or not executable: $PUBLISHED_SETUP"

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] ||
    fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

# Reads one repository variable. Nothing here is a secret; these are names and ids.
variable_value() { gh variable get "$1" --repo "$REPO" 2>/dev/null || true; }

# ---------------------------------------------------------------------------------------------
step 2 'Choosing the Google Cloud project the nightly owns.'

# Three sources, in this order: the flag, what is already saved in GitHub, and a question. The
# project gcloud happens to be pointed at is deliberately NOT one of them — this script grants a
# GitHub repository the right to build and destroy machines in whatever project it is handed, and
# inheriting that from the state of somebody's shell is not a thing to be relaxed about.
project_was_confirmed=0
saved_project=$(variable_value GCP_CI_PROJECT)
if [ -n "$PROJECT" ]; then
  note "Using the project you passed: $PROJECT"
  # Naming the project that is already wired up is a re-run, not a new decision, so it does not
  # ask again — which is what lets a re-run finish with nobody at the keyboard.
  [ "$PROJECT" = "$saved_project" ] && project_was_confirmed=1
elif [ -n "$saved_project" ]; then
  PROJECT=$saved_project
  note "Using the project already saved in GitHub: $PROJECT"
  project_was_confirmed=1
fi

if [ -z "$PROJECT" ]; then
  [ -t 0 ] || fail 'I do not know which project to use. Pass it with --project <id>.'
  say '  Which project should the nightly use? It must hold nothing else.'
  i=0
  ids=''
  while IFS=$'\t' read -r id name; do
    [ -n "$id" ] || continue
    i=$((i + 1))
    printf '    %d) %s (%s)\n' "$i" "$id" "$name"
    ids="$ids$id "
  done <<EOF
$(gcloud projects list --format='value(projectId,name)' 2>/dev/null)
EOF
  [ "$i" -gt 0 ] || fail 'I could not see any Google Cloud projects. Pass one with --project <id>.'
  printf '  Type a number, or the id of a project to create: '
  read -r choice
  [ -n "$choice" ] || fail 'Nothing chosen. Nothing was changed.'
  case "$choice" in
    ''|*[!0-9]*) PROJECT=$choice ;;
    *) PROJECT=$(printf '%s' "$ids" | cut -d' ' -f"$choice")
       [ -n "$PROJECT" ] || fail 'That was not one of the numbers on the list.' ;;
  esac
fi

if [ "$project_was_confirmed" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  say ''
  say "  Real machines will be built and destroyed in $PROJECT every morning, and a sweep will"
  say '  delete what the run leaves behind. It must be a project that holds nothing else — not'
  say '  the one in docs/providers/gcp.md, and not one anybody runs their own Rocky Surf against.'
  ask "  Does $PROJECT hold nothing else?" ||
    fail 'Not confirmed. Nothing was changed. Make a project for CI alone and pass it with --project.'
fi

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)
if [ -z "$PROJECT_NUMBER" ]; then
  if ask "  I cannot see a project called $PROJECT. Make it?"; then
    run gcloud projects create "$PROJECT"
    made "project $PROJECT"
    PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)
  fi
fi
if [ -z "$PROJECT_NUMBER" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    # Only reachable in a dry run, or when the project genuinely is not there — in which case
    # nothing below would have worked either. The placeholder keeps the printed commands readable
    # instead of quietly emitting a resource name with an empty piece in the middle of it.
    PROJECT_NUMBER='<PROJECT_NUMBER>'
    note 'I could not read the project number. The lines below show it as <PROJECT_NUMBER>.'
  else
    fail "I could not read the project $PROJECT. Check the id, or make it in the console first."
  fi
fi
note "Project number: $PROJECT_NUMBER"

# Compute Engine refuses to do anything in a project with no billing account attached, and the
# failure arrives much later as a puzzling API error. Read it now and say so in plain words.
billing=$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)
case "$billing" in
  True|true) note 'Billing is on for this project.' ;;
  False|false)
    note 'Billing is OFF for this project, and Compute Engine will refuse to build anything.'
    note "Turn it on here: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT" ;;
  *) note 'I could not read the billing status. The nightly will say so if it matters.' ;;
esac

PROVIDER_SA_EMAIL="${PROVIDER_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SWEEP_SA_EMAIL="${SWEEP_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

# ---------------------------------------------------------------------------------------------
step 3 'Turning on the four Google services the nightly needs.'
note 'Compute is the thing under test. The other three are the sign-in exchange itself.'

enabled_services=$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)' 2>/dev/null || true)
missing_services=''
for api in compute.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com; do
  if printf '%s\n' "$enabled_services" | grep -qx "$api"; then
    have "$api"
  else
    missing_services="$missing_services $api"
  fi
done
if [ -n "$missing_services" ]; then
  # shellcheck disable=SC2086 # the list is built from a fixed set of names, and is meant to split
  run gcloud services enable $missing_services --project="$PROJECT"
  made "these services:$missing_services"
fi

# ---------------------------------------------------------------------------------------------
step 4 'Making the identity under test carry exactly the permissions we publish.'
note 'This is the same role a self-hoster deploys, from the same file, unchanged.'

# The permission names in a role file, one per line, sorted — so a role already in the project can
# be compared with the file that defines it and left alone when the two agree.
permissions_in_file() {
  awk '
    /^includedPermissions:/ { inlist = 1; next }
    inlist && /^[^[:space:]]/ { inlist = 0 }
    inlist && /^[[:space:]]*-[[:space:]]/ {
      sub(/^[[:space:]]*-[[:space:]]*/, "")
      sub(/[[:space:]]+$/, "")
      if (length($0)) print
    }
  ' "$1" | sort
}

# A role deleted by the teardown script is only soft-deleted: the id stays taken for seven days
# and `roles create` fails with "already exists" until it is either purged or brought back. Bring
# it back, which is what somebody re-running this script means.
role_is_soft_deleted() {
  deleted=$(gcloud iam roles describe "$1" --project="$PROJECT" \
    --format='value(deleted)' 2>/dev/null || true)
  [ "$deleted" = 'True' ]
}

undelete_role_if_needed() {
  role_id=$1
  if role_is_soft_deleted "$role_id"; then
    note "The role $role_id was deleted recently. Bringing it back rather than making a second one."
    run gcloud iam roles undelete "$role_id" --project="$PROJECT"
  fi
}

# True when the role already in the project carries exactly the permissions the file defines.
role_matches_file() {
  live=$(gcloud iam roles describe "$1" --project="$PROJECT" \
    --format='value[delimiter=";"](includedPermissions)' 2>/dev/null | tr ';' '\n' | sort || true)
  [ -n "$live" ] && [ "$live" = "$(permissions_in_file "$2")" ]
}

# Creates or updates one custom role from its file, and does nothing at all when the role in the
# project already carries exactly those permissions.
ensure_role() {
  role_id=$1
  role_file=$2
  role_label=$3
  undelete_role_if_needed "$role_id"
  if gcloud iam roles describe "$role_id" --project="$PROJECT" >/dev/null 2>&1; then
    if role_matches_file "$role_id" "$role_file"; then
      have "$role_label"
      return 1
    fi
    note "$role_label has drifted from $(basename "$role_file"). Putting the file back."
    run gcloud iam roles update "$role_id" --project="$PROJECT" --file="$role_file"
    made "$role_label"
    return 0
  fi
  run gcloud iam roles create "$role_id" --project="$PROJECT" --file="$role_file"
  made "$role_label"
  return 0
}

# The published half is deployed by the SHIPPED script, unmodified — what runs in CI has to be
# what self-hosters deploy, or the nightly proves nothing about the thing we publish. It is only
# called when there is something to do, so a re-run on a live project writes nothing.
published_role_ok=0
if ! role_is_soft_deleted "$PUBLISHED_ROLE_ID" &&
  role_matches_file "$PUBLISHED_ROLE_ID" "$PUBLISHED_ROLE_FILE"; then
  published_role_ok=1
fi

published_sa_ok=0
if gcloud iam service-accounts describe "$PROVIDER_SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  published_sa_ok=1
fi

published_binding_ok=0
if gcloud projects get-iam-policy "$PROJECT" \
  --flatten='bindings[].members' \
  --format='value(bindings.role)' \
  --filter="bindings.members:serviceAccount:${PROVIDER_SA_EMAIL}" 2>/dev/null |
  grep -qx "projects/${PROJECT}/roles/${PUBLISHED_ROLE_ID}"; then
  published_binding_ok=1
fi

if [ "$published_role_ok" = 1 ] && [ "$published_sa_ok" = 1 ] && [ "$published_binding_ok" = 1 ]; then
  have "the published role $PUBLISHED_ROLE_ID"
  have "identity $PROVIDER_SA_EMAIL"
  have 'the published role is granted to it'
else
  note "Handing over to $PUBLISHED_SETUP, which is the script we ship to self-hosters."
  undelete_role_if_needed "$PUBLISHED_ROLE_ID"
  # Its own closing notes are addressed to a self-hoster wiring up rockysurf.config.yaml, which is
  # not what is happening here, so the hand-over stops at the line where those start.
  if [ "$DRY_RUN" = 1 ]; then
    "$PUBLISHED_SETUP" --project="$PROJECT" --sa-name="$PROVIDER_SA_NAME" --role-id="$PUBLISHED_ROLE_ID" --dry-run |
      awk '/^Done\.$/ { hush = 1 } !hush { print "  | " $0 }'
  else
    "$PUBLISHED_SETUP" --project="$PROJECT" --sa-name="$PROVIDER_SA_NAME" --role-id="$PUBLISHED_ROLE_ID" |
      awk '/^Done\.$/ { hush = 1 } !hush { print "  | " $0 }'
  fi
  ready "the published role is granted to $PROVIDER_SA_EMAIL"
fi

# ---------------------------------------------------------------------------------------------
step 5 'Making the cleanup identity, which can delete leftovers and nothing else.'
note 'It cannot create anything, and it cannot touch the shared SSH rule every box depends on.'

ensure_role "$SWEEP_ROLE_ID" "$SWEEP_ROLE_FILE" "the cleanup role $SWEEP_ROLE_ID" || true

if gcloud iam service-accounts describe "$SWEEP_SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
  have "identity $SWEEP_SA_EMAIL"
else
  run gcloud iam service-accounts create "$SWEEP_SA_NAME" \
    --project="$PROJECT" \
    --display-name='Rocky Surf nightly sweep' \
    --description='CI only. Cleans up after .github/workflows/nightly-real-cloud.yml; see deploy/gcp/nightly-sweep-role.yaml.'
  made "identity $SWEEP_SA_EMAIL"
fi

if gcloud projects get-iam-policy "$PROJECT" \
  --flatten='bindings[].members' \
  --format='value(bindings.role)' \
  --filter="bindings.members:serviceAccount:${SWEEP_SA_EMAIL}" 2>/dev/null |
  grep -qx "projects/${PROJECT}/roles/${SWEEP_ROLE_ID}"; then
  have 'the cleanup role is granted to it'
else
  run gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:${SWEEP_SA_EMAIL}" \
    --role="projects/${PROJECT}/roles/${SWEEP_ROLE_ID}" \
    --condition=None
  ready "the cleanup role is granted to $SWEEP_SA_EMAIL"
fi

# ---------------------------------------------------------------------------------------------
step 6 'Letting GitHub sign in as those identities, without a password.'
note "Google will accept a token GitHub makes for $REPO, for one workflow file, and nothing else."

# WHAT GOOGLE WILL AND WILL NOT ACCEPT, in one condition. Google requires it on a provider whose
# issuer is a shared public one like GitHub's: without it, any GitHub Actions workflow on the
# internet holds a token this pool would accept. Two clauses — this repository exactly, and this
# one workflow file. The branch is deliberately not pinned: the schedule runs on the default
# branch, which this project has renamed once already, and a pinned ref would fail on the morning
# after the next rename with an error that says nothing useful.
ATTRIBUTE_CONDITION="assertion.repository == '${REPO}' && assertion.job_workflow_ref.startsWith('${REPO}/${BRANCH_WORKFLOW}@')"
ATTRIBUTE_MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner,attribute.workflow_ref=assertion.job_workflow_ref"
ISSUER='https://token.actions.githubusercontent.com'

pool_state=$(gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT" --location=global --format='value(state)' 2>/dev/null || true)
case "$pool_state" in
  ACTIVE)
    have "sign-in pool $POOL_ID" ;;
  DELETED)
    # Same seven-to-thirty-day soft delete as the roles above: the id is taken until it is
    # brought back, so a teardown followed by a setup has to undo the delete rather than fail.
    note "The pool $POOL_ID was deleted recently. Bringing it back."
    run gcloud iam workload-identity-pools undelete "$POOL_ID" --project="$PROJECT" --location=global
    made "sign-in pool $POOL_ID" ;;
  *)
    run gcloud iam workload-identity-pools create "$POOL_ID" \
      --project="$PROJECT" \
      --location=global \
      --display-name='GitHub Actions' \
      --description="Federated identities for GitHub Actions workflows in $REPO."
    made "sign-in pool $POOL_ID" ;;
esac

provider_describe() {
  gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
    --format="$1" 2>/dev/null || true
}

provider_state=$(provider_describe 'value(state)')
if [ "$provider_state" = 'DELETED' ]; then
  note "The sign-in provider $PROVIDER_ID was deleted recently. Bringing it back."
  run gcloud iam workload-identity-pools providers undelete "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID"
  provider_state=$(provider_describe 'value(state)')
fi

if [ -n "$provider_state" ]; then
  live_condition=$(provider_describe 'value(attributeCondition)')
  live_issuer=$(provider_describe 'value(oidc.issuerUri)')
  live_repo_attribute=$(provider_describe "value(attributeMapping['attribute.repository'])")
  if [ "$live_condition" = "$ATTRIBUTE_CONDITION" ] &&
    [ "$live_issuer" = "$ISSUER" ] &&
    [ "$live_repo_attribute" = 'assertion.repository' ]; then
    have "sign-in provider $PROVIDER_ID, trusting $REPO and nothing else"
  else
    note "The sign-in provider trusted something else. Pointing it at $REPO."
    run gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
      --project="$PROJECT" \
      --location=global \
      --workload-identity-pool="$POOL_ID" \
      --attribute-mapping="$ATTRIBUTE_MAPPING" \
      --attribute-condition="$ATTRIBUTE_CONDITION" \
      --issuer-uri="$ISSUER"
    made "sign-in provider $PROVIDER_ID"
  fi
else
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT" \
    --location=global \
    --workload-identity-pool="$POOL_ID" \
    --display-name='Rocky Surf nightly' \
    --attribute-mapping="$ATTRIBUTE_MAPPING" \
    --attribute-condition="$ATTRIBUTE_CONDITION" \
    --issuer-uri="$ISSUER"
  made "sign-in provider $PROVIDER_ID"
fi

# The pool's name uses the project NUMBER rather than its id, in the member below and in the
# variable the workflow reads. Using the id there is the most common way this wiring fails, and it
# fails at run time with a flat "not found".
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}"
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER_ID}"
MEMBER="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${REPO}"

# ---------------------------------------------------------------------------------------------
step 7 'Letting the repository act as both identities.'
note 'Two grants, and they are not the same one twice.'

# The nightly signs in twice: as the cleanup account (held, never exported) and as the published
# one (the identity under test). Grant only the second and a failed run cannot be cleaned up;
# grant only the first and the lifecycle runs as something that proves nothing about what we ship.
for sa in "$PROVIDER_SA_EMAIL" "$SWEEP_SA_EMAIL"; do
  if gcloud iam service-accounts get-iam-policy "$sa" --project="$PROJECT" \
    --flatten='bindings[].members' \
    --format='value(bindings.members)' \
    --filter='bindings.role:roles/iam.workloadIdentityUser' 2>/dev/null |
    grep -qxF "$MEMBER"; then
    have "$REPO may sign in as $sa"
  else
    run gcloud iam service-accounts add-iam-policy-binding "$sa" \
      --project="$PROJECT" \
      --role='roles/iam.workloadIdentityUser' \
      --member="$MEMBER"
    ready "$REPO may sign in as $sa"
  fi
done

# ---------------------------------------------------------------------------------------------
step 8 'Checking the zone sells the two machines the nightly builds.'
note 'Only eight zones stock the arm64 one, and the wrong zone fails every morning.'

REGION=${ZONE%-*}
zone_short=''
for machine in t2a-standard-1 e2-small; do
  if [ "$DRY_RUN" = 1 ] && [ -n "$missing_services" ]; then
    note "Skipping the check for $machine: Compute is not on in this project yet."
    continue
  fi
  if gcloud compute machine-types describe "$machine" --zone="$ZONE" --project="$PROJECT" \
    --format='value(name)' >/dev/null 2>&1; then
    note "Fine: $ZONE sells $machine."
  else
    zone_short="$zone_short $machine"
    note "Not sold: $ZONE does not offer $machine."
  fi
done

# The second gate, and it is invisible until a create fails: a project with no CPU quota in the
# region cannot build either machine however available they are.
cpu_limit=$(gcloud compute regions describe "$REGION" --project="$PROJECT" \
  --flatten='quotas[]' --format='value(quotas.metric,quotas.limit)' 2>/dev/null |
  awk '$1 == "CPUS" { print $2 }' | head -n 1 || true)
case "$cpu_limit" in
  ''|*[!0-9.]*) cpu_limit='' ;;
esac
if [ -z "$cpu_limit" ]; then
  note "I could not read the CPU quota in $REGION. The nightly will say so if it matters."
elif [ "${cpu_limit%%.*}" -lt 2 ]; then
  zone_short="$zone_short cpu-quota"
  note "Not enough: $REGION allows ${cpu_limit} CPUs, and 2 are needed."
else
  note "Fine: $REGION allows ${cpu_limit} CPUs."
fi

# ---------------------------------------------------------------------------------------------
step 9 'Saving the settings in GitHub.'
note 'None of these is a secret. They are names and ids, and they are safe to read.'

set_variable() {
  var_name=$1
  var_value=$2
  if [ "$(variable_value "$var_name")" = "$var_value" ]; then
    have "$var_name"
    return 0
  fi
  run gh variable set "$var_name" --repo "$REPO" --body "$var_value"
  made "$var_name"
}

set_variable GCP_CI_PROJECT "$PROJECT"
set_variable GCP_WORKLOAD_IDENTITY_PROVIDER "$PROVIDER_NAME"
set_variable GCP_PROVIDER_SERVICE_ACCOUNT "$PROVIDER_SA_EMAIL"
set_variable GCP_NIGHTLY_SERVICE_ACCOUNT "$SWEEP_SA_EMAIL"

# The zone is only saved when it was asked for. The workflow already defaults to us-central1-a, so
# writing the default would add a setting nobody chose and one more thing to keep in step.
if [ "$ZONE_GIVEN" = 1 ]; then
  set_variable GCP_CI_ZONE "$ZONE"
else
  note "GCP_CI_ZONE: left alone. The nightly uses $ZONE unless you pass --zone."
fi

# ---------------------------------------------------------------------------------------------
step 10 'Starting the nightly, if you want to see it work now.'

say ''
say 'Setup is done.'
say "The nightly will build and destroy two Google Cloud machines each morning, in $PROJECT."
say 'It costs about two cents a night. Nothing this script made costs anything on its own.'
say 'No key was created, stored or printed. There is nothing here to rotate.'
say 'Run this script again any time. It will say what is already done and change nothing else.'
say 'To undo all of it: ./deploy/gcp/teardown-nightly.sh'

if [ -n "$zone_short" ]; then
  say ''
  say 'One thing is not ready, and only you can fix it.'
  say "This is short in $ZONE:$zone_short"
  say 'If a machine is not sold there, run this script again with a zone that has both:'
  say '  us-central1-a, us-central1-b, us-central1-f, europe-west4-a, europe-west4-b,'
  say '  europe-west4-c, asia-southeast1-b, asia-southeast1-c'
  say 'If it is the CPU quota, open https://console.cloud.google.com/iam-admin/quotas, filter on'
  say "\"CPUS\" in $REGION, tick it and ask for 2 or more. It is usually approved in minutes."
  say 'The nightly will fail with a clear message until that is sorted.'
fi

if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was created. Run it again without --dry-run to do it for real.'
  exit 0
fi

say ''
if [ -n "$zone_short" ]; then
  say 'Not starting a run yet, because it would fail on the thing above.'
  say "Once that is sorted, run: gh workflow run nightly-real-cloud.yml --repo $REPO"
  exit 0
fi

if ask 'Start a run now to check it works?'; then
  run gh workflow run nightly-real-cloud.yml --repo "$REPO"
  say 'Started. Watch it with: gh run watch'
else
  say 'Not started. It will run on its own at 07:00 UTC.'
  say "To start one yourself: gh workflow run nightly-real-cloud.yml --repo $REPO"
fi
