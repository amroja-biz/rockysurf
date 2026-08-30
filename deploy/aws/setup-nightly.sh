#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — set up the nightly real-cloud run on AWS. One command, run once.
#
# WHAT THIS IS FOR. The nightly workflow creates and destroys two real dev boxes on AWS every
# morning, under the exact permissions deploy/aws/iam-role.yaml publishes to self-hosters. If a
# change to packages/provider-aws starts making a call that policy does not cover, the nightly
# turns red the next morning instead of a stranger's first launch failing. Until this script has
# run, the AWS leg skips with a notice.
#
# WHAT YOU PROVIDE: nothing but two logins you probably already have — an `aws` sign-in and
# `gh auth login`. Everything else is derived or defaulted, and every default can be overridden
# with a flag.
#
# THERE IS NO ACCESS KEY ANYWHERE IN THIS FLOW, and that is deliberate. GitHub mints a
# short-lived token for each run and AWS is told to trust it, so nothing long-lived is stored in
# the repository, nothing needs rotating, and there is nothing to leak.
#
# RUN IT AS OFTEN AS YOU LIKE. Every step checks before it creates, so a second run reports
# "already there" instead of failing or changing anything.
#
# NOTHING THIS SCRIPT CREATES COSTS MONEY. IAM roles and a sign-in provider are free; only the
# nightly's own machines bill, at under half a cent a night.
#
#   ./deploy/aws/setup-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/aws/setup-nightly.sh
#
# To undo it all: ./deploy/aws/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

CI_STACK='rocky-surf-nightly-ci'
PROVIDER_STACK='rocky-surf-nightly-provider'
CI_ROLE='rocky-surf-nightly-ci'
PROVIDER_ROLE='rocky-surf-provider'
REGION='us-east-1'
STACK_REGION=''
BRANCH='*'
REPO=''
DRY_RUN=0
ASSUME_YES=0
REPLACE_SECRET=0

usage() {
  cat <<'EOF'
Set up the nightly AWS run. You only need to be signed in to AWS and GitHub.

  ./deploy/aws/setup-nightly.sh [options]

Options:
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --branch <name>       The branch the nightly may run on. Default: any branch.
  --region <name>       Where the nightly runs its machines, and what the policy is pinned to.
                        Default: us-east-1, the region the workflow itself uses. Changing it
                        here means changing AWS_REGION in the workflow too.
  --stack-region <name> Where to keep the two CloudFormation stacks. Default: the region above.
                        IAM itself is global, so this only decides where the record lives.
  --role-name <name>    The name of the role under test. Default: rocky-surf-provider
  --replace-secret      Overwrite the CI role name saved in GitHub. Only needed if it is wrong:
                        a secret cannot be read back, so an existing one is left alone.
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask anything. Start the run at the end.
  -h, --help            Show this text.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --branch) BRANCH=${2:?--branch needs a value}; shift 2 ;;
    --region) REGION=${2:?--region needs a value}; shift 2 ;;
    --stack-region) STACK_REGION=${2:?--stack-region needs a value}; shift 2 ;;
    --role-name) PROVIDER_ROLE=${2:?--role-name needs a value}; shift 2 ;;
    --replace-secret) REPLACE_SECRET=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$STACK_REGION" ] || STACK_REGION=$REGION

TOTAL=9
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

stack_exists() {
  # A stack in ROLLBACK_COMPLETE exists but cannot be updated, so it is not "there" for our
  # purposes and the caller says so rather than failing inside CloudFormation.
  aws cloudformation describe-stacks --stack-name "$1" --region "$STACK_REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$STACK_REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null
}

# Deploys one stack and reports which of the three things happened, because "already there" is
# the answer this script exists to be able to give on an account that is already set up.
#
# A deployment with nothing to change touches no resource: CloudFormation works out a change set,
# finds it empty, and deletes it again. --no-fail-on-empty-changeset is what makes that a success
# rather than exit 255, and the line it prints is what tells "nothing to do" from "did something".
#
# Parameters NOT passed here keep the value the stack already has (the CLI's own documented rule),
# which is why nothing has to read the old ones back before writing them again — and why
# CreateOidcProvider is passed only on a first deployment, since flipping it on a later run would
# delete an account-global sign-in provider other workflows may depend on.
deploy_stack() {
  stack=$1
  template=$2
  label=$3
  shift 3
  status=$(stack_exists "$stack" || true)
  case "$status" in
    ROLLBACK_COMPLETE|REVIEW_IN_PROGRESS)
      fail "the stack $stack is stuck in $status from a failed first attempt. Delete it — aws cloudformation delete-stack --stack-name $stack --region $STACK_REGION — and run this again."
      ;;
  esac
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would run: aws cloudformation deploy --stack-name %s --template-file %s --region %s --capabilities CAPABILITY_NAMED_IAM --parameter-overrides %s\n' \
      "$stack" "$template" "$STACK_REGION" "$*"
    return 0
  fi
  if out=$(aws cloudformation deploy \
      --stack-name "$stack" \
      --template-file "$template" \
      --region "$STACK_REGION" \
      --capabilities CAPABILITY_NAMED_IAM \
      --no-fail-on-empty-changeset \
      --parameter-overrides "$@" 2>&1); then
    case "$out" in
      *'No changes to deploy'*) have "$label" ;;
      *) if [ -n "$status" ]; then ready "$label (brought up to date)"; else made "$label"; fi ;;
    esac
  else
    printf '%s\n' "$out" >&2
    fail "CloudFormation refused to deploy $stack. The error above is its own."
  fi
}

# The role names are global to the account but the STACKS are regional. A role that exists with
# no stack in the region we are looking at means the stack was deployed somewhere else, and
# deploying again here would fail on a name clash rather than change anything. Say so instead.
check_not_orphaned() {
  role=$1
  stack=$2
  aws iam get-role --role-name "$role" >/dev/null 2>&1 || return 0
  [ -z "$(stack_exists "$stack" || true)" ] || return 0
  fail "the role $role already exists, but there is no $stack stack in $STACK_REGION. It was probably deployed in another region. Run this again with --stack-region <that region>, or delete the role if it is not ours."
}

say 'Setting up the nightly AWS run.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be created.'; fi

# ---------------------------------------------------------------------------------------------
step 1 'Checking you are signed in.'

command -v aws >/dev/null 2>&1 ||
  fail 'The AWS CLI is not installed. Install it from https://aws.amazon.com/cli/ and run this again.'
aws sts get-caller-identity >/dev/null 2>&1 ||
  fail 'You are not signed in to AWS. Run: aws sso login --profile <yours>, or set AWS_PROFILE.'
command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'
note 'Signed in to AWS and GitHub.'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] ||
    fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

# ---------------------------------------------------------------------------------------------
step 2 'Checking which AWS account this is.'

CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
# aws, aws-us-gov or aws-cn. Every ARN this script writes is built for the same one.
PARTITION=$(printf '%s' "$CALLER_ARN" | cut -d: -f2)
ACCOUNT_ALIAS=$(aws iam list-account-aliases --query 'AccountAliases[0]' --output text 2>/dev/null || true)
case "$ACCOUNT_ALIAS" in ''|None) ACCOUNT_ALIAS='' ;; esac

if [ -n "$ACCOUNT_ALIAS" ]; then
  note "Account: $ACCOUNT_ID ($ACCOUNT_ALIAS)"
else
  note "Account: $ACCOUNT_ID"
fi
note 'Use an account that holds nothing else. The nightly cleans up after itself in it.'
note "The nightly will run its machines in $REGION."
if [ "$STACK_REGION" != "$REGION" ]; then
  note "The two CloudFormation stacks will be kept in $STACK_REGION."
fi

# ---------------------------------------------------------------------------------------------
step 3 'Checking whether AWS already knows how to accept a GitHub sign-in.'
note 'There can be only one of these per account, and every workflow that signs in this way shares it.'

OIDC_HOST='token.actions.githubusercontent.com'
CREATE_OIDC='yes'
if aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text 2>/dev/null |
    tr '\t' '\n' | grep -q "$OIDC_HOST"; then
  CREATE_OIDC='no'
  have "the GitHub sign-in provider ($OIDC_HOST)"
  note 'This script will use it and will never delete it.'
else
  note 'There is none yet. The next step makes it.'
fi

# ---------------------------------------------------------------------------------------------
step 4 'Making the role GitHub signs in as.'
note "AWS will accept a token GitHub makes for $REPO, and nothing else."

# GitHub is moving from `repo:owner/name:...` to an immutable-id form, `repo:owner@1234/name@5678:...`,
# and a token may carry either. Both are trusted, which is what the first real run of this leg
# needed after being refused for matching only the classic form.
CLASSIC_SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"
IMMUTABLE_PREFIX=$(gh api "repos/${REPO}/actions/oidc/customization/sub" --jq '.sub_claim_prefix' 2>/dev/null || true)
case "$IMMUTABLE_PREFIX" in
  repo:*) SUBJECT="${CLASSIC_SUBJECT},${IMMUTABLE_PREFIX}:ref:refs/heads/${BRANCH}" ;;
  *)
    SUBJECT="$CLASSIC_SUBJECT"
    note 'GitHub did not tell me this repository ids, so only the classic sign-in name is trusted.'
    ;;
esac
if [ "$BRANCH" = '*' ]; then
  note 'Any branch of that repository may run it. The schedule always uses the default branch,'
  note 'and pinning the name would break the morning anybody renames it.'
else
  note "Only the $BRANCH branch may run it."
fi

check_not_orphaned "$CI_ROLE" "$CI_STACK"

CI_PARAMS=(
  "GitHubSubjectClaim=$SUBJECT"
  "ProviderRoleName=$PROVIDER_ROLE"
  "ProviderRegion=$REGION"
  "RoleName=$CI_ROLE"
)
# Only on a first deployment. On a later run the stack keeps whatever it already decided, so a
# re-run can never delete an account-global sign-in provider other workflows are using.
if [ -z "$(stack_exists "$CI_STACK" || true)" ]; then
  CI_PARAMS+=("CreateOidcProvider=$CREATE_OIDC")
fi

deploy_stack "$CI_STACK" "${SCRIPT_DIR}/nightly-ci.yaml" "the CI role $CI_ROLE" "${CI_PARAMS[@]}"

CI_ROLE_ARN=$(stack_output "$CI_STACK" NightlyRoleArn || true)
case "$CI_ROLE_ARN" in
  arn:*) ;;
  *) CI_ROLE_ARN="arn:${PARTITION}:iam::${ACCOUNT_ID}:role/${CI_ROLE}" ;;
esac
note 'It can do almost nothing on its own: become the role below, and look for leftovers.'

# ---------------------------------------------------------------------------------------------
step 5 'Making the role under test, from the file we publish.'
note 'deploy/aws/iam-role.yaml is used unchanged. That is the whole point of this leg:'
note 'what the nightly proves is the policy self-hosters are actually given.'

check_not_orphaned "$PROVIDER_ROLE" "$PROVIDER_STACK"

deploy_stack "$PROVIDER_STACK" "${SCRIPT_DIR}/iam-role.yaml" "the role under test $PROVIDER_ROLE" \
  "TrustedPrincipalArn=$CI_ROLE_ARN" \
  "ProviderRegion=$REGION" \
  "RoleName=$PROVIDER_ROLE"

PROVIDER_ROLE_ARN=$(stack_output "$PROVIDER_STACK" RoleArn || true)
case "$PROVIDER_ROLE_ARN" in
  arn:*) ;;
  *) PROVIDER_ROLE_ARN="arn:${PARTITION}:iam::${ACCOUNT_ID}:role/${PROVIDER_ROLE}" ;;
esac

# ---------------------------------------------------------------------------------------------
step 6 'Checking the two roles fit together.'
note 'The run signs in as the first role and then becomes the second. Both halves have to agree.'

if [ "$DRY_RUN" = 1 ]; then
  ready "$CI_ROLE may become $PROVIDER_ROLE"
else
  # IAM hands the trust policy back url-encoded in some paths and decoded in others, so the
  # colons are normalised before looking for the name.
  trust=$(aws iam get-role --role-name "$PROVIDER_ROLE" --query 'Role.AssumeRolePolicyDocument' \
    --output json 2>/dev/null | sed 's/%3[Aa]/:/g' || true)
  case "$trust" in
    *"$CI_ROLE_ARN"*) ready "$CI_ROLE may become $PROVIDER_ROLE" ;;
    *)
      note "I could not see $CI_ROLE named in $PROVIDER_ROLE's trust policy."
      note 'The nightly will fail on its second sign-in if that is really so. Run this again.'
      ;;
  esac
fi

# ---------------------------------------------------------------------------------------------
step 7 'Checking AWS will let you run the two machine sizes.'
note 'Rocky Surf never creates networking, and a new account is sometimes allowed few machines.'

blocked=''

vpc=$(aws ec2 describe-vpcs --region "$REGION" --filters 'Name=is-default,Values=true' \
  --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)
case "$vpc" in
  vpc-*) note "Fine: $REGION has a default VPC ($vpc)." ;;
  '')   note "I could not read the VPCs in $REGION. Skipping this check." ;;
  *)
    blocked="${blocked}vpc "
    note "Not ready: $REGION has no default VPC, and Rocky Surf does not create one."
    ;;
esac

# One quota covers both sizes: t3 and t4g are both in the on-demand Standard family, which is
# counted in vCPUs. Two at a time is what the nightly needs, and it runs them one after another.
quota=$(aws service-quotas get-service-quota --region "$REGION" \
  --service-code ec2 --quota-code L-1216C47A --query 'Quota.Value' --output text 2>/dev/null || true)
case "$quota" in
  ''|None)
    note 'I could not read your instance quota. Skipping this check; the nightly will say if it is short.'
    ;;
  *)
    # Service Quotas answers with a float, and the shell only compares integers.
    quota_int=${quota%%.*}
    case "$quota_int" in
      ''|*[!0-9]*) note "I could not make sense of the quota value AWS returned. Skipping this check." ;;
      *)
        if [ "$quota_int" -lt 2 ]; then
          blocked="${blocked}quota "
          note "Not enough: standard on-demand instances are capped at $quota_int vCPUs in $REGION, and 2 are needed."
        else
          note "Fine: standard on-demand instances are allowed $quota_int vCPUs in $REGION."
        fi
        ;;
    esac
    ;;
esac

# ---------------------------------------------------------------------------------------------
step 8 'Saving the settings in GitHub.'
note 'Neither of these is a credential. They are names of roles, and they grant nothing by themselves.'

# The workflow reads the CI role's name from a repository SECRET rather than a variable, so that
# is where it is written. A secret cannot be read back to compare, so an existing one is left
# exactly as it is unless --replace-secret says otherwise.
if gh secret list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx AWS_NIGHTLY_ROLE_ARN &&
   [ "$REPLACE_SECRET" = 0 ]; then
  have 'AWS_NIGHTLY_ROLE_ARN'
  note "I cannot read a secret back, so I left it alone. It should be: $CI_ROLE_ARN"
  note 'If it is not, run this again with --replace-secret.'
else
  run gh secret set AWS_NIGHTLY_ROLE_ARN --repo "$REPO" --body "$CI_ROLE_ARN"
  made 'AWS_NIGHTLY_ROLE_ARN'
fi

set_variable() {
  var_name=$1
  var_value=$2
  current=$(gh api "repos/${REPO}/actions/variables/${var_name}" --jq '.value' 2>/dev/null || true)
  if [ "$current" = "$var_value" ]; then
    have "$var_name"
  else
    run gh variable set "$var_name" --repo "$REPO" --body "$var_value"
    made "$var_name"
  fi
}

set_variable AWS_PROVIDER_ROLE_ARN "$PROVIDER_ROLE_ARN"

# Only worth writing when it is not the name the workflow already assumes. Writing the default
# would be a change to the repository that buys nothing.
if [ "$PROVIDER_ROLE" = 'rocky-surf-provider' ] &&
   [ -z "$(gh api "repos/${REPO}/actions/variables/AWS_PROVIDER_ROLE_NAME" --jq '.value' 2>/dev/null || true)" ]; then
  note 'AWS_PROVIDER_ROLE_NAME is not needed: the workflow already expects rocky-surf-provider.'
else
  set_variable AWS_PROVIDER_ROLE_NAME "$PROVIDER_ROLE"
fi

# ---------------------------------------------------------------------------------------------
step 9 'Starting the nightly, if you want to see it work now.'

say ''
say 'Setup is done.'
say "The nightly will build and destroy two AWS boxes each morning, in $REGION."
say 'It costs under half a cent a night. Nothing this script made costs anything on its own.'
say 'No access key was created, stored or printed. There is nothing here to rotate.'
say 'Run this script again any time. It will say what is already done and change nothing else.'
say 'To undo all of it: ./deploy/aws/teardown-nightly.sh'

if [ -n "$blocked" ]; then
  say ''
  say 'Something is not ready, and only you can fix it.'
  case "$blocked" in
    *vpc*)
      say "$REGION has no default VPC. Rocky Surf finds a VPC and a subnet; it never makes them."
      say '  To make one back: aws ec2 create-default-vpc --region '"$REGION"
      say '  Or pass --region <somewhere that has one> and run this again.'
      ;;
  esac
  case "$blocked" in
    *quota*)
      say "AWS has not given you enough on-demand vCPUs in $REGION."
      say 'Here is what to do, and it is usually approved in minutes:'
      say '  1. Open https://console.aws.amazon.com/servicequotas/ and choose "Amazon EC2".'
      say "  2. Set the region to $REGION."
      say '  3. Find "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances".'
      say '  4. Request an increase to 2 vCPUs or more, and submit.'
      ;;
  esac
  say 'The nightly will fail with a clear message until that is done.'
fi

if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was created. Run it again without --dry-run to do it for real.'
  exit 0
fi

say ''
if [ -n "$blocked" ]; then
  say 'Not starting a run yet, because it would fail on what is listed above.'
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
