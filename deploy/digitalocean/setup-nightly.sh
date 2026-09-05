#!/usr/bin/env bash
# =============================================================================================
# Rocky Surf — set up the nightly real-cloud run on DigitalOcean. One command, run once.
#
# WHAT THIS IS FOR. The nightly workflow creates and destroys a real dev box on DigitalOcean every
# morning, over the same HTTP API `@rockysurf/provider-digitalocean` uses in production — and it
# installs that provider from a packed tarball first, the way a self-hoster does, so what it tests
# is the artifact rather than a workspace build. If a change breaks that path, the nightly turns
# red the next morning instead of a stranger's first launch failing. Until this script has run,
# the DigitalOcean leg skips with a notice.
#
# WHAT YOU PROVIDE: two things, and only the first is work.
#
#   1. A DIGITALOCEAN TEAM THAT EXISTS ONLY FOR THIS NIGHTLY. Not a project inside your usual
#      team — a team. This is the one demand this leg makes that AWS, Azure and GCP do not, and
#      it is not tidiness: a DigitalOcean personal access token is scoped to a TEAM, and custom
#      scopes narrow what a token may DO, never what it may do it TO. There is no project-level
#      token, no OIDC federation, and no API for minting a token at all. So a token that can
#      create a droplet in your team can also destroy the droplets already in it, and the only
#      isolation available is to point it at a team with nothing in it.
#   2. A read/write personal access token from that team. Created in the control panel, by hand,
#      because DigitalOcean publishes no API that creates one.
#
# THIS SCRIPT REFUSES TO FINISH IF THE TEAM IS NOT EMPTY. That check is the whole of demand 1,
# enforced rather than requested, and it runs BEFORE the secret is written — a setup that cannot
# prove what it claimed leaves the leg skipping, which is a clean and visible state, rather than
# turning a workflow red at 07:00 with a reason nobody can see (docs/memories/
# 2026-08-31-setup-scripts-verify-what-they-claimed.md, and gh issue #270 for why).
#
# It never prints the token, never accepts it as a command-line argument (anything typed as an
# argument can leak into another user's process list on a shared machine), and only ever pipes it
# straight into `gh secret set`.
#
# RUN IT AS OFTEN AS YOU LIKE. Every step checks before it creates. If the secret is already set,
# this script offers to keep it rather than making you type a new one.
#
#   ./deploy/digitalocean/setup-nightly.sh --dry-run     # show what it would do, change nothing
#   ./deploy/digitalocean/setup-nightly.sh
#
# To undo it: ./deploy/digitalocean/teardown-nightly.sh
# =============================================================================================
set -euo pipefail

SECRET_NAME='DIGITALOCEAN_TOKEN'
PROJECT_NAME='rockysurf-nightly'
# The size and region the nightly actually asks for. Written here so this script can CHECK them
# against the live catalogue rather than assert them — scripts/e2e/lifecycle.mjs (RUNS) and
# scripts/e2e/digitalocean-ci-firewall.mjs are where they are decided.
CI_SIZE='s-2vcpu-2gb'
CI_REGION='nyc3'
API='https://api.digitalocean.com/v2'

REPO=''
DRY_RUN=0
ASSUME_YES=0
SKIP_VERIFY=0

usage() {
  cat <<'EOF'
Set up the nightly DigitalOcean run. You need to be signed in to GitHub, and to have (or be ready
to create) a DigitalOcean personal access token belonging to a team used ONLY by this nightly.

  ./deploy/digitalocean/setup-nightly.sh [options]

Options:
  --repo <owner/name>   The GitHub repository. Default: the one this folder came from.
  --skip-verify         Do not check the token against the DigitalOcean API before storing it.
                        This also skips the empty-team check, so use it only when you have
                        already satisfied yourself that the team is CI-only.
  --dry-run             Show what would happen and change nothing.
  --yes                 Do not ask anything. Replace an existing token without confirming.
  -h, --help            Show this text.

The token itself is never a flag. Set it in the DIGITALOCEAN_TOKEN environment variable before
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

TOTAL=7
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

# --- the two API helpers, so no other line in this file handles the token -----------------------
#
# THE TOKEN NEVER REACHES AN ARGUMENT LIST. `curl --config -` reads its options from stdin, and
# `printf` is a shell builtin, so the header is written by a process that has no argv and read by
# one whose argv does not contain it. `curl -H "Authorization: Bearer $TOKEN"` would put a live
# credential in `ps` output for the length of every call, on a machine that may not be yours alone.
auth_config() { printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"; }

# Body to stdout.
api_body() {
  local method=$1 path=$2 data=${3:-}
  if [ -n "$data" ]; then
    auth_config | curl -sS --config - -X "$method" -H 'Content-Type: application/json' -d "$data" "$API$path"
  else
    auth_config | curl -sS --config - -X "$method" "$API$path"
  fi
}
# HTTP status only, for the scope probes.
api_code() {
  auth_config | curl -sS --config - -o /dev/null -w '%{http_code}' "$API$1" || printf '000'
}

say 'Setting up the nightly DigitalOcean run.'
if [ "$DRY_RUN" = 1 ]; then say 'This is a dry run. Nothing will be created.'; fi

# ---------------------------------------------------------------------------------------------
step 1 'Checking you are signed in, and that the tools are here.'

command -v gh >/dev/null 2>&1 ||
  fail 'The GitHub CLI is not installed. Install it from https://cli.github.com and run this again.'
gh auth status >/dev/null 2>&1 ||
  fail 'You are not signed in to GitHub. Run: gh auth login'
command -v curl >/dev/null 2>&1 ||
  fail 'curl is not installed, and this script needs it to talk to DigitalOcean. Install curl and run this again.'
command -v jq >/dev/null 2>&1 ||
  fail 'jq is not installed, and this script needs it to read what DigitalOcean answers. Install jq and run this again.'
note 'Signed in to GitHub.'

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
  [ -n "$REPO" ] ||
    fail 'I could not tell which GitHub repository this is. Pass it with --repo owner/name.'
fi
note "GitHub repository: $REPO"

# ---------------------------------------------------------------------------------------------
step 2 'Getting your DigitalOcean token.'

say ''
say '  BEFORE YOU PASTE ANYTHING, the part no script can do for you:'
say ''
say '   1. If you have no DigitalOcean account, make one at https://cloud.digitalocean.com.'
say '   2. Make a TEAM that will hold nothing but this nightly. In the control panel: your'
say '      avatar, then "Teams", then "New Team". A DigitalOcean token is scoped to a team and'
say '      cannot be scoped to a project, so the team is the only isolation there is.'
say '   3. Switch into that team, then Account -> API -> "Generate New Token".'
say '      Give it Custom Scopes and tick exactly these:'
say ''
say '        droplet:read  droplet:create  droplet:update  droplet:delete'
say '        ssh_key:read  ssh_key:create  ssh_key:delete'
say '        firewall:read firewall:create firewall:update'
say '        tag:read      tag:create'
say '        image:read    sizes:read      regions:read     account:read'
say '        project:read  project:create  project:update'
say ''
say '      Full Access also works and is what to fall back to if a run is refused with a 403.'
say '      Set an expiry you are willing to diary: the token is the ONE long-lived credential in'
say '      this whole workflow, because DigitalOcean has no OIDC federation to replace it with.'
say ''

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
  if [ -n "${DIGITALOCEAN_TOKEN:-}" ]; then
    TOKEN=$DIGITALOCEAN_TOKEN
    note 'Using the token already in your DIGITALOCEAN_TOKEN environment variable.'
  elif [ "$DRY_RUN" = 1 ]; then
    note 'Dry run: would prompt for the token here. Skipping the prompt so this stays non-interactive.'
  else
    [ -t 0 ] ||
      fail 'Nobody is here to type the token. Set DIGITALOCEAN_TOKEN in your environment and run this again.'
    printf '  Paste the DigitalOcean token (input is hidden): '
    read -rs TOKEN
    printf '\n'
    [ -n "$TOKEN" ] || fail 'No token was entered.'
  fi
fi

# Everything from here to the `gh secret set` needs a token in hand. When there is none — the
# keep-the-existing path, or a dry run with nothing exported — the checks say so and are skipped
# rather than quietly passing.
CAN_CHECK=0
if [ -n "$TOKEN" ] && [ "$SKIP_VERIFY" = 0 ]; then CAN_CHECK=1; fi

# ---------------------------------------------------------------------------------------------
step 3 'Checking the token works, and that it can see what the provider needs.'

if [ "$CAN_CHECK" = 0 ]; then
  if [ "$SKIP_VERIFY" = 1 ]; then note 'Skipped: --skip-verify was given.'
  elif [ "$NEED_TOKEN" = 0 ]; then note 'Skipped: keeping the existing token, so there is nothing new to check.'
  else note 'Skipped in this dry run: no token was entered.'
  fi
else
  # Every READ the provider makes, probed. These create nothing, so they are safe to make for
  # real even during a dry run — and a missing read scope is exactly the failure that would
  # otherwise arrive at 07:00 as a 403 from a provider call nobody can place.
  probe() {
    local path=$1 scope=$2
    local code; code=$(api_code "$path")
    case "$code" in
      200) note "reads $path — $scope" ;;
      401) fail "DigitalOcean rejected that token (401 on $path). Check you copied it whole, from the CI-only team." ;;
      403) fail "The token is missing the $scope scope (403 on $path). Regenerate it with the scopes listed above, or with Full Access." ;;
      *)   fail "DigitalOcean answered HTTP $code for $path. It has to answer 200 before this leg is worth turning on; try again in a minute." ;;
    esac
  }
  probe '/account' 'account:read'
  probe '/droplets?per_page=1' 'droplet:read'
  probe '/account/keys?per_page=1' 'ssh_key:read'
  probe '/firewalls?per_page=1' 'firewall:read'
  probe "/sizes?per_page=200" 'sizes:read'
  probe '/projects' 'project:read'

  # THE WRITE SCOPES CANNOT ALL BE PROVEN FOR FREE, and saying so is better than implying they
  # were. A tag round-trip is free and reversible, so `tag:create` is proven here; `droplet:create`
  # and `firewall:create` are not, because proving them means paying for a droplet. The first
  # nightly run is what proves those, and it fails loudly with the endpoint in the message.
  tag_body=$(api_body POST '/tags' '{"name":"rockysurf-nightly-setup-probe"}' || true)
  if echo "$tag_body" | jq -e '.tag.name == "rockysurf-nightly-setup-probe"' >/dev/null 2>&1; then
    api_body DELETE '/tags/rockysurf-nightly-setup-probe' >/dev/null || true
    note 'writes a tag and deletes it again — tag:create, tag:read'
  else
    fail "The token could not create a tag, which the provider does when it launches: $(echo "$tag_body" | jq -r '.message // "no message"'). Add the tag:create scope, or use Full Access."
  fi
  note 'droplet:create and firewall:create cannot be proven without paying for a droplet — the first nightly run proves those, and names the endpoint if it is refused.'
fi

# ---------------------------------------------------------------------------------------------
step 4 'Checking the team is used by nothing else.'

if [ "$CAN_CHECK" = 0 ]; then
  note 'Skipped: no token to check with. The team must still be one that holds nothing but this nightly.'
else
  droplet_count=$(api_body GET '/droplets?per_page=200' | jq '(.droplets // []) | length')
  case "$droplet_count" in
    ''|*[!0-9]*) fail 'I could not read the droplet list back from DigitalOcean, so I cannot tell whether this team is CI-only. Nothing was written.' ;;
  esac
  if [ "$droplet_count" != '0' ]; then
    say ''
    api_body GET '/droplets?per_page=200' | jq -r '.droplets[]? | "    \(.name) (\(.id)) in \(.region.slug)"'
    say ''
    fail "this token's team already holds $droplet_count droplet(s), listed above, so it is not a CI-only team.

The nightly sweeps this team every morning. It only ever DELETES droplets whose \`server-id:\`
tag it wrote itself, and it reports everything else — but a token that can create a droplet here
can destroy those too, and a DigitalOcean token cannot be narrowed to a project. Make a separate
team for the nightly, generate a token in that team, and run this again.

If those droplets are leftovers from an earlier nightly, destroy them first:
  curl -sS -H \"Authorization: Bearer \$DIGITALOCEAN_TOKEN\" \\
    -X DELETE $API/droplets/<id>"
  fi
  note "the team holds no droplets — nothing here for the nightly to be confused by"

  # The other thing worth knowing before spending anything: that the size this leg asks for is
  # real, and orderable in the region it asks for it in. Free, and it is the one claim in
  # scripts/e2e/lifecycle.mjs that was written from documentation rather than from the catalogue.
  size_ok=$(api_body GET '/sizes?per_page=200' |
    jq -r --arg slug "$CI_SIZE" --arg region "$CI_REGION" \
      '[.sizes[]? | select(.slug == $slug)] | if length == 0 then "missing"
       elif (.[0].regions // []) | index($region) then "yes" else "wrong-region" end')
  case "$size_ok" in
    yes) note "$CI_SIZE is sold in $CI_REGION" ;;
    wrong-region) fail "$CI_SIZE exists but is not sold in $CI_REGION. Change CI_REGION in scripts/e2e/digitalocean-ci-firewall.mjs to a region that sells it, or pick another size in RUNS in scripts/e2e/lifecycle.mjs." ;;
    missing) fail "DigitalOcean's catalogue has no size called $CI_SIZE. Pick one it does sell and change RUNS in scripts/e2e/lifecycle.mjs; a nightly asking for a size that does not exist fails every morning at the catalogue check." ;;
    *) fail 'I could not read the size catalogue back, so I cannot tell whether the nightly can order a droplet. Nothing was written.' ;;
  esac
fi

# ---------------------------------------------------------------------------------------------
step 5 "Making the $PROJECT_NAME project, and reading it back."

say ''
note "A DigitalOcean PROJECT groups resources; it does not restrict a token. The isolation is"
note "the team, checked above. This project is here so the nightly's droplets are somewhere"
note "obvious in the control panel rather than mixed into the team's default project."
say ''

PROJECT_ID=''
if [ "$CAN_CHECK" = 0 ]; then
  note 'Skipped: no token to create it with.'
elif [ "$DRY_RUN" = 1 ]; then
  printf '  would run: POST %s/projects {"name":"%s","purpose":"Operational / Developer tooling","environment":"Development"}\n' "$API" "$PROJECT_NAME"
else
  PROJECT_ID=$(api_body GET '/projects' | jq -r --arg name "$PROJECT_NAME" '.projects[]? | select(.name == $name) | .id' | head -n1)
  if [ -n "$PROJECT_ID" ]; then
    have "project $PROJECT_NAME ($PROJECT_ID)"
  else
    created=$(api_body POST '/projects' \
      "{\"name\":\"$PROJECT_NAME\",\"description\":\"Rocky Surf nightly real-cloud run. Created and destroyed every morning.\",\"purpose\":\"Operational / Developer tooling\",\"environment\":\"Development\"}")
    PROJECT_ID=$(echo "$created" | jq -r '.project.id // empty')
    [ -n "$PROJECT_ID" ] ||
      fail "DigitalOcean would not create the project: $(echo "$created" | jq -r '.message // "no message"'). Add the project:create scope, or use Full Access."
    made "project $PROJECT_NAME ($PROJECT_ID)"
  fi

  # READ IT BACK AND COMPARE, rather than trusting the create's own answer. The rule, and the
  # reason for it, are in docs/memories/2026-08-31-setup-scripts-verify-what-they-claimed.md: a
  # create that reports success and changes nothing is a real failure mode, and it costs one
  # call to rule out.
  readback=$(api_body GET "/projects/$PROJECT_ID" | jq -r '.project.name // empty')
  [ "$readback" = "$PROJECT_NAME" ] ||
    fail "I asked DigitalOcean for a project called $PROJECT_NAME and reading it back gave '${readback:-nothing}'. Nothing else has been written; check the control panel before running this again."
  note "read back: $PROJECT_NAME ($PROJECT_ID)"

  # Making it the DEFAULT is what actually puts the nightly's droplets in it, because the
  # provider never names a project when it creates one. This one is allowed to fall short and
  # say so: a droplet in the wrong project still runs, still gets swept, and breaks nothing —
  # unlike the checks above, whose absence would break the wiring.
  defaulted=$(api_body PATCH "/projects/$PROJECT_ID" '{"is_default":true}' | jq -r '.project.is_default // false')
  if [ "$defaulted" = 'true' ]; then
    note "and it is now this team's default project, so the nightly's droplets land in it"
  else
    note "could not make it the default project (needs project:update). Harmless: the nightly's droplets will appear in the team's existing default project instead."
  fi
fi

# ---------------------------------------------------------------------------------------------
step 6 'Saving the token in GitHub.'

if [ "$NEED_TOKEN" = 0 ]; then
  note 'Left as it was.'
elif [ "$DRY_RUN" = 1 ]; then
  printf '  would run: gh secret set %s --repo %s (value piped in; never shown or logged)\n' "$SECRET_NAME" "$REPO"
elif [ -z "$TOKEN" ]; then
  fail 'There is no token to save. Set DIGITALOCEAN_TOKEN and run this again.'
else
  printf '%s' "$TOKEN" | gh secret set "$SECRET_NAME" --repo "$REPO"
  made "repository secret $SECRET_NAME"
fi
TOKEN=''

note 'This is the only setting the DigitalOcean leg needs. Like Hetzner and unlike AWS, Azure and GCP, there are no repository variables.'

# ---------------------------------------------------------------------------------------------
step 7 'Reading GitHub back, and saying what is left for you.'

if [ "$DRY_RUN" = 0 ]; then
  gh secret list --repo "$REPO" --json name -q '.[].name' 2>/dev/null | grep -qx "$SECRET_NAME" ||
    fail "I set $SECRET_NAME and GitHub does not list it. The leg will keep skipping until it does; check \`gh auth status\` has permission to write secrets on $REPO."
  note "GitHub lists $SECRET_NAME on $REPO"
fi

say ''
say 'Setup is done.'
say "The nightly will build and destroy one DigitalOcean $CI_SIZE droplet in $CI_REGION each morning."
say 'No token was printed or logged anywhere by this script.'
say ''
say 'WHAT IS STILL YOURS TO DO, BY HAND:'
say ''
say '  * ROTATE THE TOKEN on whatever schedule you set its expiry to. DigitalOcean has no way to'
say '    rotate one in place: generate a new token in the same team, run this script again, and'
say '    then revoke the old one at Account -> API. The leg keeps working across that swap,'
say '    because the new token is written before the old one is revoked.'
say '  * KEEP THE TEAM EMPTY. This script checked once. Nothing checks again, and the guarantee'
say '    that the nightly cannot touch anything of yours is exactly the guarantee that there is'
say '    nothing of yours in that team.'
say '  * REVOKE THE TOKEN if you ever delete this repository, and destroy the team with it.'
say ''
say 'Run this script again any time. Every step checks before it creates.'
say 'To undo it: ./deploy/digitalocean/teardown-nightly.sh'

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
