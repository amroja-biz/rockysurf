#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — set up the nightly real-cloud run on Hetzner. One command, run once.
#
# WHAT THIS IS FOR. The nightly workflow creates and destroys a real dev box on Hetzner Cloud
# every morning, over the same HTTP API this project's provider uses in production. If a change
# to packages/provider-hetzner breaks that path, the nightly turns red the next morning instead
# of a stranger's first launch failing. Until this script has run, the Hetzner leg skips with a
# notice.
#
# WHAT YOU PROVIDE: one thing — a Hetzner API token, Read & Write, from a project that holds
# nothing but this nightly's own boxes.
#
# UNLIKE AWS, AZURE AND GCP, THIS LEG HOLDS A SECRET. Hetzner's Cloud API has no equivalent of
# the short-lived, keyless sign-in the other three clouds use (see "There is no least-privilege
# token" in docs/providers/hetzner.md), so a long-lived token is the only way in, and GitHub has
# to hold a copy of it. This script never prints the token, never accepts it as a command-line
# argument (anything typed as an argument can leak into another user's process list on a shared
# machine), and only ever pipes it straight into `gh secret set`. Nothing else on this machine —
# not your shell history, not a log file — ever sees it.
#
# RUN IT AS OFTEN AS YOU LIKE. If the secret is already set, this script offers to keep it
# rather than making you type a new one.
#
#   ./deploy/hetzner/setup-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/hetzner/setup-nightly.sh
#
# To undo it: ./deploy/hetzner/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SECRET_NAME='HETZNER_TOKEN'
REPO=''
DRY_RUN=0
ASSUME_YES=0
SKIP_VERIFY=0

usage() {
  cat <<'EOF'
Set up the nightly Hetzner run. You only need to be signed in to GitHub, and to have (or be
ready to create) a Hetzner API token.

  ./deploy/hetzner/setup-nightly.sh [options]

Options:
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --skip-verify         Do not check the token against the Hetzner API before storing it.
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask anything. Replace an existing token without confirming.
  -h, --help            Show this text.

The token itself is never a flag. Set it in the HETZNER_TOKEN environment variable before
running this script, or leave it unset and this script will prompt you (input is hidden).
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:?--repo needs a value}; shift 2 ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Stopped: I do not know the option %s.\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

TOTAL=5
say() { printf '%s\n' "$*"; }
step() { printf '\n[%d/%d] %s\n' "$1" "$TOTAL" "$2"; }
made() {
  if [ "$DRY_RUN" = 1 ]; then printf '  would make: %s\n' "$*"; else printf '  made it: %s\n' "$*"; fi
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

say 'Setting up the nightly Hetzner run.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be created.'; fi

# ---------------------------------------------------------------------------------------------
step 1 'Checking you are signed in.'

command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'
command -v curl >/dev/null 2>&1 ||
  fail 'curl is not installed, and this script needs it to check your token. Install curl and run this again.'
note 'Signed in to GitHub.'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] ||
    fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

# ---------------------------------------------------------------------------------------------
step 2 'Getting your Hetzner API token.'
note 'Create a project at https://console.hetzner.com dedicated to this nightly, then generate a Read & Write API token under that project'\''s Security section.'
note 'A read-only token is not enough: the provider creates servers and SSH keys, and both are writes.'

NEED_TOKEN=1
TOKEN=''

if gh secret list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$SECRET_NAME"; then
  have "repository secret $SECRET_NAME"
  if ask 'Replace it with a new token?'; then
    NEED_TOKEN=1
  else
    NEED_TOKEN=0
    note 'Keeping the existing token. Nothing to change here.'
  fi
fi

if [ "$NEED_TOKEN" = 1 ]; then
  if [ -n "${HETZNER_TOKEN:-}" ]; then
    TOKEN=$HETZNER_TOKEN
    note 'Using the token already in your HETZNER_TOKEN environment variable.'
  elif [ "$DRY_RUN" = 1 ]; then
    note 'Dry run: would prompt for the token here. Skipping the prompt so this stays non-interactive.'
  else
    [ -t 0 ] ||
      fail 'Nobody is here to type the token. Set HETZNER_TOKEN in your environment and run this again.'
    printf '  Paste the Hetzner API token (input is hidden): '
    read -rs TOKEN
    printf '\n'
    [ -n "$TOKEN" ] || fail 'No token was entered.'
  fi
fi

# ---------------------------------------------------------------------------------------------
step 3 'Checking the token works.'

if [ "$NEED_TOKEN" = 0 ]; then
  note 'Skipped: keeping the existing token, so there is nothing new to check.'
elif [ "$SKIP_VERIFY" = 1 ]; then
  note 'Skipped: --skip-verify was given.'
elif [ -z "$TOKEN" ]; then
  note 'Skipped in this dry run: no token was entered.'
else
  # A read-only call: it lists servers and creates nothing, so it is safe to make for real even
  # during a dry run.
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    'https://api.hetzner.cloud/v1/servers?per_page=1') || code='000'
  case "$code" in
    200) note 'Confirmed: the token can read servers.' ;;
    401|403)
      fail "Hetzner rejected that token (HTTP $code). Check you copied a Read & Write token from the right project and try again." ;;
    *)
      note "Could not confirm the token (Hetzner responded with HTTP $code). Continuing anyway — the nightly will fail clearly if it is wrong." ;;
  esac
fi

# ---------------------------------------------------------------------------------------------
step 4 'Saving it in GitHub.'

if [ "$NEED_TOKEN" = 0 ]; then
  note 'Left as it was.'
elif [ "$DRY_RUN" = 1 ]; then
  printf '  would run: gh secret set %s --repo %s (value piped in; never shown or logged)\n' "$SECRET_NAME" "$REPO"
else
  printf '%s' "$TOKEN" | gh secret set "$SECRET_NAME" --repo "$REPO"
  made "repository secret $SECRET_NAME"
fi
TOKEN=''

note 'This is the only setting the Hetzner leg needs. Unlike Azure and GCP, there are no repository variables to set.'

# ---------------------------------------------------------------------------------------------
step 5 'Starting the nightly, if you want to see it work now.'

say ''
say 'Setup is done.'
say 'The nightly will build and destroy one Hetzner cpx12 box each morning.'
say 'No token was printed or logged anywhere by this script.'
say 'Run this script again any time. It will offer to keep or replace the token, and change nothing else.'
say 'To undo it: ./deploy/hetzner/teardown-nightly.sh'

if [ "$DRY_RUN" = 1 ]; then
  say ''
  say 'That was a dry run. Nothing was created. Run it again without --dry-run to do it for real.'
  exit 0
fi

say ''
if ask 'Start a run now to check it works?'; then
  run gh workflow run nightly-real-cloud.yml --repo "$REPO"
  say 'Started. Watch it with: gh run watch'
else
  say 'Not started. It will run on its own at 07:00 UTC.'
  say "To start one yourself: gh workflow run nightly-real-cloud.yml --repo $REPO"
fi
