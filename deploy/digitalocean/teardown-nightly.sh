#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — undo everything deploy/digitalocean/setup-nightly.sh made.
#
# It removes the repository secret it saved in GitHub, and — if you give it a token — the
# `rockysurf-nightly` project it made. After this the DigitalOcean leg of the nightly goes back to
# skipping with a notice, and the rest of the nightly carries on as before.
#
# WHAT THIS SCRIPT CANNOT DO, AND THE FIRST ONE IS THE ONE THAT MATTERS:
#
#   * Revoke the token. GitHub only ever held a copy of it. The token still exists in your
#     DigitalOcean team, still has write access to it, and DigitalOcean publishes no API for
#     revoking one — you do it at Account -> API, by hand. This script says so again at the end.
#   * Delete the team. Same reason: no API, and deleting a team is not something a script should
#     do on your behalf in any case.
#   * Delete a project that still holds resources. DigitalOcean refuses that, and so does this:
#     a non-empty project means the nightly left something behind, which is a thing to look at
#     rather than a thing to sweep away.
#
# It asks before it deletes anything. Like the setup script, it is safe to run twice: a secret
# that is already gone is reported as gone.
#
#   ./deploy/digitalocean/teardown-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/digitalocean/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SECRET_NAME='DIGITALOCEAN_TOKEN'
PROJECT_NAME='rockysurf-nightly'
API='https://api.digitalocean.com/v2'

REPO=''
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Undo the nightly DigitalOcean setup. You need to be signed in to GitHub.

  ./deploy/digitalocean/teardown-nightly.sh [options]

Options:
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask. Delete it.
  -h, --help            Show this text.

To have the rockysurf-nightly PROJECT removed as well, export DIGITALOCEAN_TOKEN first. Without
it this script removes the GitHub secret and tells you what is left.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=3
say() { printf '%s\n' "$*"; }
step() { printf '\n[%d/%d] %s\n' "$1" "$TOTAL" "$2"; }
gone() { printf '  deleted: %s\n' "$*"; }
absent() { printf '  already gone: %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }
ask() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would run: %s\n' "$*"; return 0; fi
  "$@"
}

# The token never reaches an argument list — see the same helper in setup-nightly.sh for why.
TOKEN=${DIGITALOCEAN_TOKEN:-}
auth_config() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }
api_body() {
  local method=$1 path=$2
  auth_config | curl -sS --config - -X "$method" "$API$path"
}

say 'Undoing the nightly DigitalOcean setup.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be deleted.'; fi

# ---------------------------------------------------------------------------------------------
step 1 'Checking you are signed in.'

command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] ||
    fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

# ---------------------------------------------------------------------------------------------
step 2 'Removing the repository secret.'

if gh secret list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$SECRET_NAME"; then
  if ask "Delete the repository secret $SECRET_NAME from $REPO?"; then
    run gh secret delete "$SECRET_NAME" --repo "$REPO"
    [ "$DRY_RUN" = 1 ] || gone "repository secret $SECRET_NAME"
  else
    note 'Left alone. The DigitalOcean leg will keep running every morning.'
  fi
else
  absent "repository secret $SECRET_NAME"
fi

# ---------------------------------------------------------------------------------------------
step 3 "Removing the $PROJECT_NAME project."

if [ -z "$TOKEN" ]; then
  note "Skipped: no DIGITALOCEAN_TOKEN in the environment, so I cannot reach DigitalOcean."
  note "Export one and run this again, or delete the project in the control panel."
elif ! command -v jq >/dev/null 2>&1; then
  note 'Skipped: jq is not installed, and this step needs it to read what DigitalOcean answers.'
else
  PROJECT_ID=$(api_body GET '/projects' | jq -r --arg name "$PROJECT_NAME" '.projects[]? | select(.name == $name) | .id' | head -n1)
  if [ -z "$PROJECT_ID" ]; then
    absent "project $PROJECT_NAME"
  else
    # A project with resources in it is a project the nightly did not finish cleaning. Say that
    # rather than deleting around it — DigitalOcean would refuse anyway, and the refusal is the
    # more useful answer.
    resources=$(api_body GET "/projects/$PROJECT_ID/resources" | jq '(.resources // []) | length')
    if [ "$resources" != '0' ]; then
      note "project $PROJECT_NAME still holds $resources resource(s) — left alone."
      note "That is worth a look before you delete it: the nightly is supposed to leave nothing."
      note "  curl -sS -H 'Authorization: Bearer \$DIGITALOCEAN_TOKEN' $API/projects/$PROJECT_ID/resources"
    elif ask "Delete the empty project $PROJECT_NAME ($PROJECT_ID)?"; then
      if [ "$DRY_RUN" = 1 ]; then
        printf '  would run: DELETE %s/projects/%s\n' "$API" "$PROJECT_ID"
      else
        api_body DELETE "/projects/$PROJECT_ID" >/dev/null
        gone "project $PROJECT_NAME ($PROJECT_ID)"
      fi
    else
      note 'Left alone.'
    fi
  fi
fi
TOKEN=''

say ''
say 'Teardown is done as far as a script can take it.'
say ''
say 'WHAT IS STILL YOURS TO DO, BY HAND — and the first one is not optional:'
say ''
say '  * REVOKE THE TOKEN at https://cloud.digitalocean.com/account/api/tokens. GitHub held a'
say '    copy of it; DigitalOcean still has the original, and it still has write access to the'
say '    team. Nothing here can revoke it — DigitalOcean has no API for that.'
say '  * DELETE THE TEAM you made for this nightly, once the token is gone.'
say ''
say 'To set it all up again: ./deploy/digitalocean/setup-nightly.sh'
