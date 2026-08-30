#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — undo everything deploy/aws/setup-nightly.sh made.
#
# It removes the two IAM roles (each by deleting the CloudFormation stack that made it) and the
# settings saved in GitHub. After this the AWS leg of the nightly goes back to skipping with a
# notice, and the rest of the nightly carries on as before.
#
# IT ASKS BEFORE IT DELETES ANYTHING, and it names the account in the question. Read that number.
#
# ONE THING TO READ TWICE. If the setup script made the GitHub sign-in provider in this account,
# deleting the CI stack takes it away again — and it is ACCOUNT-GLOBAL, so any other workflow in
# any other repository that signs in to this account through GitHub stops working. This script
# checks, says so before it asks, and tells you the one command that puts it back.
#
# Like the setup script, it is safe to run twice: anything already gone is reported as gone.
#
#   ./deploy/aws/teardown-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/aws/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

CI_STACK='rocky-surf-nightly-ci'
PROVIDER_STACK='rocky-surf-nightly-provider'
REGION='us-east-1'
STACK_REGION=''
REPO=''
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Undo the nightly AWS setup. You only need to be signed in to AWS and GitHub.

  ./deploy/aws/teardown-nightly.sh [options]

Options:
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --stack-region <name> Where the two CloudFormation stacks were kept. Default: us-east-1
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask. Delete it all.
  -h, --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --stack-region) STACK_REGION=${2:?--stack-region needs a value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$STACK_REGION" ] || STACK_REGION=$REGION

TOTAL=4
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

stack_exists() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$STACK_REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null
}

delete_stack() {
  stack=$1
  label=$2
  if [ -z "$(stack_exists "$stack" || true)" ]; then
    absent "$label"
    return 0
  fi
  run aws cloudformation delete-stack --stack-name "$stack" --region "$STACK_REGION"
  # Waiting rather than returning early: the second stack names the first, and a half-deleted
  # pair is a worse place to be than a slow script.
  run aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$STACK_REGION"
  gone "$label"
}

say 'Undoing the nightly AWS setup.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be deleted.'; fi

command -v aws >/dev/null 2>&1 ||
  fail 'The AWS CLI is not installed. Install it from https://aws.amazon.com/cli/ and run this again.'
aws sts get-caller-identity >/dev/null 2>&1 ||
  fail 'You are not signed in to AWS. Run: aws sso login --profile <yours>, or set AWS_PROFILE.'
command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] || fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Does deleting the CI stack also take away the account-wide GitHub sign-in provider?
OWNS_SIGN_IN=$(aws cloudformation describe-stacks --stack-name "$CI_STACK" --region "$STACK_REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='CreateOidcProvider'].ParameterValue" \
  --output text 2>/dev/null || true)

say ''
say "This will delete the two Rocky Surf nightly roles in AWS account $ACCOUNT_ID."
say "Stacks: $PROVIDER_STACK and $CI_STACK, in $STACK_REGION."
say "GitHub repository: $REPO"
if [ "$OWNS_SIGN_IN" = 'yes' ]; then
  say ''
  say 'READ THIS ONE. The GitHub sign-in provider in this account was made by that CI stack, so'
  say 'deleting it takes the provider away too. It is account-global: any other workflow in any'
  say 'repository that signs in to this account through GitHub will stop working.'
  say 'To put it back afterwards, one command:'
  say '  aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com'
fi

if [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then
  [ -t 0 ] || fail 'Nobody is here to confirm this. Run it again with --yes if you are sure.'
  printf 'Type the account number to confirm: '
  read -r typed
  [ "$typed" = "$ACCOUNT_ID" ] || fail 'That did not match. Nothing was deleted.'
fi

# ---------------------------------------------------------------------------------------------
step 1 'Deleting the role under test.'
note 'This is the role carrying the published policy. Deleting it here does not change the file.'

delete_stack "$PROVIDER_STACK" "the role under test ($PROVIDER_STACK)"

# ---------------------------------------------------------------------------------------------
step 2 'Deleting the role GitHub signed in as.'

delete_stack "$CI_STACK" "the CI role ($CI_STACK)"

# ---------------------------------------------------------------------------------------------
step 3 'Removing the settings from GitHub.'

if gh secret list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx AWS_NIGHTLY_ROLE_ARN; then
  run gh secret delete AWS_NIGHTLY_ROLE_ARN --repo "$REPO"
  gone 'AWS_NIGHTLY_ROLE_ARN'
else
  absent 'AWS_NIGHTLY_ROLE_ARN'
fi

for name in AWS_PROVIDER_ROLE_ARN AWS_PROVIDER_ROLE_NAME; do
  if gh variable list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$name"; then
    run gh variable delete "$name" --repo "$REPO"
    gone "$name"
  else
    absent "$name"
  fi
done

# ---------------------------------------------------------------------------------------------
step 4 'Done.'

say ''
say 'The AWS leg of the nightly will now skip, and say so in the run summary.'
say 'The Hetzner, GCP and Azure legs are untouched.'
say 'To set it all up again: ./deploy/aws/setup-nightly.sh'
if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was deleted.'
fi
