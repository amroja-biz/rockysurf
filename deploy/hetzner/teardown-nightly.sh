#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — undo everything deploy/hetzner/setup-nightly.sh made.
#
# It removes the repository secret it saved in GitHub. After this the Hetzner leg of the nightly
# goes back to skipping with a notice, and the rest of the nightly carries on as before.
#
# WHAT THIS SCRIPT CANNOT DO: revoke the token itself. GitHub only ever held a copy of it; the
# token still exists in your Hetzner project until you delete it there by hand. This script
# tells you that again at the end, with the address to go to.
#
# It asks before it deletes anything. Like the setup script, it is safe to run twice: a secret
# that is already gone is reported as gone.
#
#   ./deploy/hetzner/teardown-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/hetzner/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SECRET_NAME='HETZNER_TOKEN'
REPO=''
DRY_RUN=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Undo the nightly Hetzner setup. You only need to be signed in to GitHub.

  ./deploy/hetzner/teardown-nightly.sh [options]

Options:
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask. Delete it.
  -h, --help            Show this text.
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

TOTAL=2
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

say 'Undoing the nightly Hetzner setup.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be deleted.'; fi

command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] || fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

EXISTS=0
if gh secret list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$SECRET_NAME"; then
  EXISTS=1
fi

if [ "$EXISTS" = 1 ]; then
  say ''
  say "This will delete the repository secret $SECRET_NAME from $REPO."
  say 'It will not touch the token in your Hetzner project — see the note at the end for that.'
  if [ "$ASSUME_YES" = 0 ] && [ "$DRY_RUN" = 0 ]; then
    [ -t 0 ] || fail 'Nobody is here to confirm this. Run it again with --yes if you are sure.'
    ask "Delete $SECRET_NAME?" || { say 'Not deleted. Nothing changed.'; exit 0; }
  fi
fi

# ---------------------------------------------------------------------------------------------
step 1 "Deleting the repository secret $SECRET_NAME."

if [ "$EXISTS" = 1 ]; then
  run gh secret delete "$SECRET_NAME" --repo "$REPO"
  gone "repository secret $SECRET_NAME"
else
  absent "repository secret $SECRET_NAME"
fi

# ---------------------------------------------------------------------------------------------
step 2 'Done.'

say ''
say 'The Hetzner leg of the nightly will now skip, and say so in the run summary.'
say 'The AWS, Azure and GCP legs are untouched.'
say ''
say 'ONE THING THIS SCRIPT COULD NOT DO: revoke the token itself.'
say 'GitHub only ever held a copy of it. Go to https://console.hetzner.com, open the CI'
say 'project, find the token under Security, and delete it there by hand.'
say ''
say 'To set it all up again: ./deploy/hetzner/setup-nightly.sh'
if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was deleted.'
fi
