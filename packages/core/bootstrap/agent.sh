#!/usr/bin/env bash
#
# The Rocky Surf bootstrap agent.
#
# Core copies this file plus an InstallPlan onto a freshly booted box and launches it. The
# agent executes the plan's steps in order and journals every transition to state.json, which
# core polls (push mode) or the box POSTs (callback mode). Nothing here knows what cloud it is
# on, holds a cloud credential, or reads an instance metadata service.
#
# NORMATIVE SPEC: docs/bootstrap-contract.md. This file implements it; where the two disagree,
# the document wins. The rules that are easy to break by accident, with the reason each exists:
#
#   * ONE EXECUTOR, TWO MODES. The callback branch stays inert unless callback.env exists, so
#     push mode cannot drift into reporting something different from what it journals.
#   * RE-RUNNABLE BY CONSTRUCTION. On start the agent reads state.json and skips steps already
#     marked `done` — and ONLY `done`. A step left `running` by a SIGKILL, a reboot or a lost
#     connection re-runs from the top, because the journal entry is written when a step
#     FINISHES. That is why every step script must be idempotent (docs/writing-a-pack.md).
#   * THE JOURNAL IS WRITTEN ATOMICALLY. Core reads it from another SSH channel while this
#     process writes it; a torn read is otherwise indistinguishable from corruption.
#   * THE RUN ID IS STAMPED BEFORE ANY STEP RUNS. Without it a re-push reads the PREVIOUS
#     run's terminal status and reports success before the agent has started — and a retry of
#     a failed bootstrap reports the old failure as the new result.
#   * NOTHING IS ASSUMED ABOUT THE IMAGE. "Ubuntu 24.04" is not a contract about installed
#     packages: one cloud's image ships jq and another's does not, so the agent bootstraps its
#     own JSON parser before it can read its own instructions.
#
# Usage:  agent.sh [plan.json]        default: $STATE_DIR/plan.json
#         $ROCKYSURF_STATE_DIR (env)  default: /var/lib/rockysurf
# Exit:   0 = plan complete, 1 = a required step failed, 2 = could not start.

set -uo pipefail
# NOT `set -e`: a step failure is isolated and recorded, never allowed to kill the agent
# before it has journalled why it died.

STATE_DIR="${ROCKYSURF_STATE_DIR:-/var/lib/rockysurf}"
PLAN_FILE="${1:-$STATE_DIR/plan.json}"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/agent.log"
SECRETS_FILE="$STATE_DIR/secrets.env"
# Callback mode only. Absent in push mode, where core polls state.json over its own SSH
# connection and this file is never written.
CALLBACK_FILE="$STATE_DIR/callback.env"

# The only plan version this agent understands. A plan from a newer core must be refused
# rather than half-understood.
SUPPORTED_PLAN_VERSION=1

mkdir -p "$STATE_DIR/steps"
exec > >(tee -a "$LOG_FILE") 2>&1

export DEBIAN_FRONTEND=noninteractive

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --------------------------------------------------------------------------------------
# arch
# --------------------------------------------------------------------------------------
# Plan steps are written against amd64/arm64 (Debian's spelling), not x86_64/aarch64
# (uname's). Normalising here means no step script has to care which one it is reading.
detect_arch() {
  local a=''
  if command -v dpkg >/dev/null 2>&1; then a=$(dpkg --print-architecture); else a=$(uname -m); fi
  case "$a" in
    amd64 | x86_64) echo amd64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) echo "$a" ;;
  esac
}
ARCH=$(detect_arch)
export ARCH

# --------------------------------------------------------------------------------------
# the agent's own identity in the environment
# --------------------------------------------------------------------------------------
# docs/writing-a-pack.md promises every step `$HOME` — `/root` for a root step — and root steps
# get it by INHERITING this process's environment. Under the transient systemd unit core
# launches (docs/bootstrap-contract.md § The systemd unit contract) that environment has no
# HOME, USER or LOGNAME at all: systemd sets those only for units with `User=`, and this one
# runs as root without it. A Docker `exec` and a `nohup` shell both happen to carry HOME, which
# is why every harness stayed green while a real box killed the first root step that read it —
# an upstream installer piped to `bash` under `set -u` died with "HOME: unbound variable"
# (issue #158). Establish the contract here, once, from the passwd entry rather than from a
# guess: unprivileged steps already get theirs from `sudo -H`.
if [ -z "${HOME:-}" ]; then
  HOME=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)
  [ -n "$HOME" ] || HOME=/root
fi
export HOME
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$USER}"

# --------------------------------------------------------------------------------------
# secrets
# --------------------------------------------------------------------------------------
# Pushed separately from the plan at mode 0600 so the plan itself stays loggable. Values are
# never echoed; only the variable NAMES are, so unprivileged steps can be handed the same env.
SECRET_NAMES=()
load_secrets() {
  [ -f "$SECRETS_FILE" ] || return 0
  local name
  while IFS='=' read -r name _; do
    case "$name" in '' | '#'*) continue ;; esac
    SECRET_NAMES+=("$name")
  done <"$SECRETS_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
  log "loaded ${#SECRET_NAMES[@]} secret(s): ${SECRET_NAMES[*]}"
}

# --------------------------------------------------------------------------------------
# callback mode (additive — push mode leaves all of this inert)
# --------------------------------------------------------------------------------------
CALLBACK_URL=''
CALLBACK_TOKEN=''

# Kept OUT of load_secrets deliberately: secrets.env is forwarded into every unprivileged
# step's environment, and no install script has any business seeing core's control-plane
# token.
load_callback_config() {
  [ -f "$CALLBACK_FILE" ] || return 0
  # shellcheck disable=SC1090
  . "$CALLBACK_FILE"
  CALLBACK_URL="${ROCKYSURF_CALLBACK_URL:-}"
  CALLBACK_TOKEN="${ROCKYSURF_TOKEN:-}"
  unset ROCKYSURF_CALLBACK_URL ROCKYSURF_TOKEN
  [ -n "$CALLBACK_URL" ] && log "callback mode: reporting progress to core"
  return 0
}

report_progress() {
  [ -n "$CALLBACK_URL" ] || return 0 # push mode: core reads state.json itself
  command -v curl >/dev/null 2>&1 || return 0

  local step label status runid stepstatus tail_txt
  step=$(jq -r '.step // ""' <<<"$STATE")
  [ -n "$step" ] || return 0
  # Core's vocabulary on the wire (the plan's `reports`), the agent's own id alongside it.
  # The label is lossy by design — several steps can share one — so a core that receives only
  # labels cannot tell which step actually finished.
  label=$(jq -r --arg id "$step" 'first(.steps[] | select(.id == $id) | .reports) // $id' <<<"$STATE")
  status=$(jq -r '.status // ""' <<<"$STATE")
  runid=$(jq -r '.runId // ""' <<<"$STATE")
  # The step's OWN outcome and, when it failed, its log tail (ADR-0010): `status` above is the
  # plan's, which stays `running` past an optional step's failure, and core has no other way
  # to learn in callback mode that a repository did not clone.
  stepstatus=$(jq -r --arg id "$step" 'first(.steps[] | select(.id == $id) | .status) // ""' <<<"$STATE")
  tail_txt=$(jq -r --arg id "$step" 'first(.steps[] | select(.id == $id) | .logTail) // ""' <<<"$STATE")
  # The plan-level notice (see set_notice), so callback mode's timeline says the same thing
  # push mode's does while a step waits.
  local notice
  notice=$(jq -r '.notice // ""' <<<"$STATE")

  # On the TERMINAL failure report, the last lines of the agent's own log ride along too
  # (issue #168). agent.log carries the whole install's narrative — every step's output, the
  # retries, the step that broke and everything before it — and for a failed tool install core
  # is about to release the machine (ADR-0010), so in callback mode this POST is the only
  # chance to preserve it. Bounded in lines AND bytes: a report core's body cap refuses is a
  # failure core never records.
  local agent_tail=''
  if [ "$status" = failed ] && [ -f "$LOG_FILE" ]; then
    agent_tail=$(tail -n 200 "$LOG_FILE" | tail -c 65536)
  fi

  # Body on stdin, never in argv: a `-d` with the token in it is readable through `ps` by
  # every user on the box, including the unprivileged steps this agent is about to run.
  if ! jq -nc --arg s "$label" --arg sid "$step" --arg st "$status" --arg t "$CALLBACK_TOKEN" --arg r "$runid" \
    --arg ss "$stepstatus" --arg lt "$tail_txt" --arg n "$notice" --arg al "$agent_tail" \
    '{step:$s, stepId:$sid, status:$st, token:$t, runId:$r}
     + (if $ss != "" then {stepStatus:$ss} else {} end)
     + (if $lt != "" then {logTail:$lt} else {} end)
     + (if $n != "" then {notice:$n} else {} end)
     + (if $al != "" then {agentLog:$al} else {} end)' |
    curl -fsS --max-time 15 --retry 3 --retry-delay 2 --retry-connrefused \
      -H 'Content-Type: application/json' --data @- "$CALLBACK_URL" >/dev/null; then
    # Progress is telemetry, not control flow. A box that cannot reach core still finishes
    # installing, and state.json remains the complete record for whenever it can.
    log "WARNING: progress report failed for $step (continuing)"
  fi
}

# --------------------------------------------------------------------------------------
# the apt retry standard
# --------------------------------------------------------------------------------------
# EVERY TOOL STEP GETS TWO ATTEMPTS AT AN APT FETCH FAILURE, AND NO MORE (issue #188). That is
# the agent's promise to every pack, so no pack script has to write its own retry loop and none
# of them may (docs/writing-a-pack.md § Bounded retries). Between the two attempts the agent
# does what an operator would do by hand — swap a sick mirror if there is one to swap, wait for
# an out-of-sync archive if there is not, refresh the lists, try again. A step that fails a
# second time has failed for real: the plan stops, the box is released (ADR-0010) and the
# failure report names the URL that would not serve (`bootstrap/failure-report.ts`).
#
# WHY TWO ATTEMPTS AT THE STEP AND NOT `Acquire::Retries` IN AN apt.conf.d DROP-IN. A drop-in
# retries the TRANSFER, inside one apt invocation, against the index apt already has. Measured
# on 24.04's apt 2.8.3 (issue #117): the default is already three attempts with exponential
# backoff, it covers connection failures only, and neither a 503 nor a 404 is retried at any
# setting. Both failure modes we actually see need the thing a drop-in cannot do — a fresh
# `apt-get update`, and time — so the retry lives here, where the agent can spend both.
#
# THE FIRST FAILURE MODE: A SICK REGIONAL MIRROR. Every Ubuntu cloud image points apt at a
# PER-REGION Canonical mirror — us-east-1.ec2.ports.ubuntu.com, azure.archive.ubuntu.com,
# europe-west1.gce.archive.ubuntu.com — and when that one mirror's backend is sick its index
# files keep serving while every .deb in the pool answers 503. The first apt step of the plan —
# build-essential, in every pack — dies, and with it the whole bootstrap, before anything
# pack-specific has run. Seen in the wild four times in a week, on two mirror IPs at once and
# for hours at a stretch (issue #117). The remedy is to switch to the global mirror. That swap
# happens at most ONCE per bootstrap, because after it there is nothing left to swap; the
# regional mirror stays the default until it is proven sick, because it is fast and in-region.
#
# Rewriting the sources is safe under the idempotency contract: every step is written to
# converge, and `apt-get install` against a different mirror of the same archive converges on
# the same packages. A pack that hard-codes a regional mirror hostname in its own script is
# already broken on every other cloud (docs/writing-a-pack.md).
#
# THE SECOND FAILURE MODE HAS NOTHING TO SWAP. A box already on the global mirror (the stock
# `ubuntu:24.04` image the pack smoke runs in, or a box after the swap above) fails a fetch for
# a different reason: an archive's index and its pool are out of step, so a specific `.deb` the
# index names answers 404 for some minutes (`libheif 1.17.6-1ubuntu4.8` on arm64, issue #129;
# `perl-base 5.38.2-3.2ubuntu0.4` on arm64, issue #188 — packs red, the same packs green a few
# minutes later with no change). A retry within seconds of that fails the same way, so when
# there is no mirror to swap the agent WAITS before refreshing, for a bounded period an
# operator would consider reasonable. A sick global mirror gets the same wait, which is the
# most anyone can do for it.
#
# WHY THE BUDGET IS PER STEP AND NOT PER BOOTSTRAP. It used to be one retry for the whole
# bootstrap: the first apt step to fail spent it, and every later step got none. That is not a
# standard a pack author can rely on — whether tool number nine is retried depended on whether
# tool number two happened to hit a flake. Two attempts per step is bounded in the same way,
# because a required step that fails twice ends the plan there: at most one required step ever
# pays the wait, and optional steps are repository clones, which are git and never match an apt
# fetch signature.
APT_MIRROR_SWAPPED=0

# How long to wait before the retry when there is no regional mirror to swap. Overridable so a
# test does not sit through it; a box never sets it.
APT_RETRY_WAIT_S="${ROCKYSURF_APT_RETRY_WAIT_S:-120}"

# Anything with a subdomain in front of archive/ports — the regional and per-cloud mirrors —
# collapses to the bare global host. `archive.ubuntu.com`, `ports.ubuntu.com` and
# `security.ubuntu.com` do not match, so a box already on the global mirror is left alone.
REGIONAL_MIRROR_RE='[a-z0-9.-]+\.(archive|ports)\.ubuntu\.com'

# $1 = a log file, $2 = the line count it had before this attempt. Only this attempt's output
# is inspected: on a resume, an earlier attempt's fetch failure must not trigger a retry for a
# step that is now failing for some other reason.
apt_fetch_failed() {
  [ -f "$1" ] || return 1
  tail -n +"$(($2 + 1))" "$1" | grep -qE \
    'Failed to fetch|Unable to fetch some archives|Some index files failed to download|Mirror sync in progress|File has unexpected size|Hash Sum mismatch'
}

# Put the box in the best shape it can be in for one more attempt. $1 = what is being retried,
# for the log. Always returns 0: the caller has already decided the failure was a fetch, and
# the second attempt is owed whether or not there was a mirror to swap.
apt_recover() {
  log "!!! apt fetch failure in $1 — engaging the mirror fallback before this step's second and last attempt"

  local f rewritten=0
  if [ "$APT_MIRROR_SWAPPED" = 0 ]; then
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
      [ -f "$f" ] || continue
      grep -qE "$REGIONAL_MIRROR_RE" "$f" || continue
      if sed -i -E "s#$REGIONAL_MIRROR_RE#\\1.ubuntu.com#g" "$f"; then
        rewritten=1
        log "!!! $f: regional Ubuntu mirror rewritten to the global one"
      else
        log "!!! $f: could not rewrite (not root?)"
      fi
    done
    [ "$rewritten" = 1 ] && APT_MIRROR_SWAPPED=1
  fi

  if [ "$rewritten" = 0 ]; then
    log "!!! already on the global Ubuntu mirror — nothing to swap; waiting ${APT_RETRY_WAIT_S}s for the archive to settle (an index published ahead of its pool answers 404 until it catches up), then refreshing lists and retrying as-is"
    # Two minutes under "Installing tools" with nothing moving looks like a hang. The journal
    # already carries the step's retry notice (`retry_notice`, issue #205) for the whole of
    # this wait and the attempt after it — it names the wait, so nothing is posted here.
    sleep "$APT_RETRY_WAIT_S"
  fi

  # The step's own `apt-updated` stamp is stale by definition now, but the lists it guards are
  # refreshed here, so the stamp idiom keeps working without every pack knowing about this.
  if apt-get update -qq 2>&1 | tail -n 5; then
    log "!!! apt lists refreshed"
  else
    log "!!! apt-get update still failing — the retry below will tell"
  fi
  return 0
}

# True when `apt_recover` would still find a regional mirror to swap — the question the retry
# notice has to answer before apt_recover answers it for real.
apt_can_swap() {
  [ "$APT_MIRROR_SWAPPED" = 0 ] || return 1
  local f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] && grep -qE "$REGIONAL_MIRROR_RE" "$f" && return 0
  done
  return 1
}

# THE RETRY IS ANNOUNCED, WITH THE CHOICE IT LEAVES THE USER (issue #205, owner's ruling).
#
# $1 = step id, $2 = its log, $3 = the log's line count before the attempt that just failed,
# $4 = the step's timeoutSeconds. Prints one line for the journal's `notice`, posted before
# `apt_recover` and standing until the second attempt has ended, whichever way.
#
# What it says, in the user's terms and in this order: what could not be downloaded, from
# where and with what answer (the first `Failed to fetch <url>  <status>` of THIS attempt —
# the one fact a person can check for themselves, and the one the failure report will name
# again if the retry fails); what is being done about it (the mirror swap or the wait, then
# one more attempt — never a third); the bounded worst case, derived rather than guessed: the
# second attempt is capped by the step's own `timeout`, plus the wait when there is one; and
# the choice — wait, or terminate now (the button already on the server page) and launch the
# same server on another provider. `retried once … same answer … create again or another
# provider` is what the failure report says afterwards, so the two agree.
retry_notice() {
  local id="$1" step_log="$2" before="$3" timeout_s="$4"
  local name="${id#tool:}" line url='' status='' host what remedy budget_s bound
  line=$(tail -n +"$((before + 1))" "$step_log" 2>/dev/null | grep -oE 'Failed to fetch [^[:space:]]+([[:space:]]+[0-9]{3})?' | head -n 1)
  if [ -n "$line" ]; then
    url=$(awk '{print $4}' <<<"$line")
    status=$(awk '{print $5}' <<<"$line")
    host=${url#*://}
    host=${host%%/*}
    if [ -n "$status" ]; then
      what="$name could not be downloaded — $host answered HTTP $status for $url"
    else
      what="$name could not be downloaded — $host would not serve $url"
    fi
  else
    what="$name could not be downloaded — Ubuntu's package mirror was not serving what apt asked for"
  fi
  if apt_can_swap; then
    remedy="switching to Ubuntu's global mirror"
    budget_s=$timeout_s
  else
    remedy="waiting $(human_wait) for the archive to catch up"
    budget_s=$((timeout_s + APT_RETRY_WAIT_S))
  fi
  if [ "$timeout_s" -gt 0 ] 2>/dev/null; then
    bound="it gives up after $(((budget_s + 59) / 60)) more minutes at most"
  else
    bound="this step has no time limit"
  fi
  echo "$what. Rocky Surf is $remedy, then trying this step once more; $bound. You can wait, or terminate this server now (Terminate, on this page) and launch it on another provider."
}

# --------------------------------------------------------------------------------------
# json
# --------------------------------------------------------------------------------------
# The plan is JSON, so the agent cannot read its own instructions until jq exists — and
# installing jq is the sort of thing a plan step would do. This is the bootstrap-the-
# bootstrapper hop, and it is why the agent may assume nothing about the base image.
ensure_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  log "jq missing — bootstrapping it before the plan can be parsed"
  # An image without jq (Hetzner's) on a cloud with a sick mirror would otherwise die here,
  # before the plan — the same failure as a step's, so it gets the same fallback.
  local jq_log="$STATE_DIR/steps/jq-bootstrap.log"
  apt-get update -qq >>"$jq_log" 2>&1 || true
  apt-get install -y -qq jq >>"$jq_log" 2>&1 && return 0
  if apt_fetch_failed "$jq_log" 0; then
    apt_recover "the jq bootstrap"
    log "jq: retrying once on the fallback mirror"
    apt-get install -y -qq jq >>"$jq_log" 2>&1 && return 0
  fi
  log "FATAL: could not install jq"
  tail -n 10 "$jq_log"
  return 1
}

check_plan_version() {
  local version
  version=$(jq -r '.version // ""' "$PLAN_FILE")
  if [ "$version" != "$SUPPORTED_PLAN_VERSION" ]; then
    log "FATAL: plan version '$version' is not supported (this agent understands $SUPPORTED_PLAN_VERSION)"
    return 1
  fi
}

# --------------------------------------------------------------------------------------
# state journal
# --------------------------------------------------------------------------------------
STATE=''

# Atomic: core polls state.json from another SSH channel while this is being written, and a
# half-written file would parse as corrupt at exactly the moment it matters most.
flush_state() {
  printf '%s\n' "$STATE" >"$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
  # One choke point for both topologies: whatever gets journalled gets reported. In push mode
  # this is a no-op, so the two modes cannot drift into reporting different things.
  report_progress
}

init_state() {
  local server_id run_id
  server_id=$(jq -r '.serverId' "$PLAN_FILE")
  # Stamped on the journal before any step runs, so a re-push stops reading stale terminal
  # status from the previous attempt.
  run_id=$(jq -r '.runId // ""' "$PLAN_FILE")

  if [ -f "$STATE_FILE" ] && jq -e . "$STATE_FILE" >/dev/null 2>&1; then
    local prev
    prev=$(jq -r '.serverId // ""' "$STATE_FILE")
    if [ "$prev" = "$server_id" ]; then
      # Carry the step history forward (that is what makes resume possible) but adopt the new
      # run's id, and merge in any steps the new plan added.
      STATE=$(jq -c --slurpfile plan "$PLAN_FILE" --arg ts "$(now)" --arg rid "$run_id" '
        (.steps // []) as $old
        | .runId = $rid | .status = "running" | .updatedAt = $ts | del(.failedStep, .logTail)
        | .steps = [ $plan[0].steps[] | . as $p
            | (first($old[] | select(.id == $p.id)) // { id: $p.id, reports: $p.reports, status: "pending" }) ]
      ' "$STATE_FILE")
      log "resuming from existing state.json (runId=$run_id)"
      flush_state
      return 0
    fi
    log "state.json belongs to $prev, not $server_id — starting a fresh journal"
  fi

  STATE=$(jq -c --arg ts "$(now)" --arg rid "$run_id" '{
    planVersion: .version,
    serverId: .serverId,
    runId: $rid,
    step: "",
    status: "running",
    updatedAt: $ts,
    steps: [ .steps[] | { id, reports, status: "pending" } ]
  }' "$PLAN_FILE")
  flush_state
}

step_status() {
  jq -r --arg id "$1" 'first(.steps[] | select(.id == $id) | .status) // "pending"' <<<"$STATE"
}

# $3 (optional) = the step's log. On `failed` its last 60 lines ride in the step's journal
# entry, so callback mode — where core never has an SSH channel to read the log itself — still
# gets the evidence (ADR-0010). Push mode reads the whole file over SSH and ignores this. It is
# per-STEP, not just the plan-level `logTail`, because an optional step that fails does not stop
# the plan and its reason would otherwise be lost the moment the next step started.
set_step() {
  local id="$1" st="$2" step_log="${3:-}" ts tail_txt=''
  ts=$(now)
  [ "$st" = failed ] && [ -n "$step_log" ] && [ -f "$step_log" ] && tail_txt=$(tail -n 60 "$step_log")
  STATE=$(jq -c --arg id "$id" --arg st "$st" --arg ts "$ts" --arg t "$tail_txt" '
    .step = $id | .updatedAt = $ts |
    .steps = [ .steps[] | if .id == $id
        then .status = $st | (if $st == "running" then .startedAt = $ts else .finishedAt = $ts end)
             | (if $t != "" then .logTail = $t else . end)
        else . end ]
  ' <<<"$STATE")
  flush_state
}

set_plan_status() {
  local st="$1"
  STATE=$(jq -c --arg st "$st" --arg ts "$(now)" '.status = $st | .updatedAt = $ts' <<<"$STATE")
  flush_state
}

# A one-line, user-readable reason the CURRENT step is taking longer than it looks (#129). Core
# forwards it on the progress event and the timeline shows it under the active step; it is
# cleared the moment the reason stops applying, so a notice never outlives its cause. Bumping
# `updatedAt` is what makes core's poller notice a journal whose step and status are unchanged.
# Silently a no-op before the plan is loaded (no journal yet) or without jq (nothing to write
# it with): the jq bootstrap's own fallback wait has no channel, and that is fine — it is the
# agent's first seconds, not a two-minute hole in the middle of an install.
set_notice() {
  [ -n "${STATE:-}" ] && command -v jq >/dev/null 2>&1 || return 0
  STATE=$(jq -c --arg n "$1" --arg ts "$(now)" '.notice = $n | .updatedAt = $ts' <<<"$STATE")
  flush_state
}

clear_notice() {
  [ -n "${STATE:-}" ] && command -v jq >/dev/null 2>&1 || return 0
  STATE=$(jq -c --arg ts "$(now)" 'del(.notice) | .updatedAt = $ts' <<<"$STATE")
  flush_state
}

# The notice that STANDS for the current step — the retry notice, while a step is on its
# second attempt (#205) — as opposed to one the quiet watcher posts over it for a while. The
# watcher restores this rather than clearing outright, so a step's output resuming mid-retry
# does not wipe the line telling the user what the retry is and what they can do about it.
STEP_NOTICE=''

restore_notice() {
  if [ -n "$STEP_NOTICE" ]; then set_notice "$STEP_NOTICE"; else clear_notice; fi
}

# "2 min" for a real box, "1 s" under the smoke harness's override.
human_wait() {
  if [ "$APT_RETRY_WAIT_S" -ge 60 ]; then echo "$((APT_RETRY_WAIT_S / 60)) min"; else echo "${APT_RETRY_WAIT_S} s"; fi
}

mark_failed() {
  local id="$1" step_log="$2" tail_txt=''
  [ -f "$step_log" ] && tail_txt=$(tail -n 25 "$step_log")
  STATE=$(jq -c --arg id "$id" --arg t "$tail_txt" --arg ts "$(now)" '
    .status = "failed" | .failedStep = $id | .logTail = $t | .updatedAt = $ts
  ' <<<"$STATE")
  flush_state
}

# --------------------------------------------------------------------------------------
# step execution
# --------------------------------------------------------------------------------------
# A step names the user it must run as and the AGENT dispatches privilege, rather than every
# script remembering to sudo. That is what makes `runAs` a contract rather than a comment —
# and why a script that reaches for sudo itself fails in a container that has none.
install_tool() {
  local tool_id="$1" run_as="$2" script="$3" timeout_s="$4" step_log="$5"
  log "==> $tool_id (as $run_as, arch=$ARCH)"

  local -a cmd=(bash -c "$script")
  if [ "$run_as" != "root" ] && [ "$run_as" != "$(id -un)" ]; then
    local -a env_args=("ARCH=$ARCH" "DEBIAN_FRONTEND=noninteractive")
    local n
    for n in ${SECRET_NAMES[@]+"${SECRET_NAMES[@]}"}; do env_args+=("$n=${!n}"); done
    cmd=(sudo -u "$run_as" -H env "${env_args[@]}" bash -c "$script")
  fi
  if [ "$timeout_s" != "0" ] && [ "$timeout_s" != "null" ] && command -v timeout >/dev/null 2>&1; then
    cmd=(timeout "$timeout_s" "${cmd[@]}")
  fi

  # The step runs in the background so the agent can watch its log while it runs (issue #205).
  # Its exit status travels through a file because `$PIPESTATUS` is not available for a
  # backgrounded pipeline and `wait` would answer for `tee`, not for the script.
  local rc_file="$step_log.rc" pipe_pid rc waited
  rm -f "$rc_file"
  { "${cmd[@]}" 2>&1; echo "$?" >"$rc_file"; } | tee -a "$step_log" &
  pipe_pid=$!
  watch_quiet "$tool_id" "$step_log" "$pipe_pid"
  wait "$pipe_pid"
  waited=$?
  rc=$(cat "$rc_file" 2>/dev/null || true)
  rm -f "$rc_file"
  return "${rc:-$waited}"
}

# How long a step may run without writing a line before the journal says so on its behalf.
# Overridable so a test does not sit through a minute; a box never sets it. 0 turns it off.
STEP_QUIET_S="${ROCKYSURF_STEP_QUIET_S:-60}"

# "4 min" on a box, "3 s" under a test's override.
human_seconds() {
  if [ "$1" -ge 60 ]; then echo "$(($1 / 60)) min"; else echo "$1 s"; fi
}

# A STEP THAT SAYS NOTHING IS ANNOUNCED, ON THE JOURNAL, WHILE IT LASTS (issue #205).
#
# $1 = the step id, $2 = its log, $3 = the pid of the pipeline running it. Returns once that
# pid is gone.
#
# The #129 notice covers the wait the agent takes BETWEEN two attempts at an apt step; it did
# not cover the first attempt itself, which is where a box actually spends its time when a
# mirror is slow to answer. `apt-get update -qq` prints nothing until it has either succeeded
# or given up, and apt's own connect and read timeout is two minutes per try, so a step can sit
# for several minutes with its log not moving before the agent ever gets to engage the mirror
# fallback (ADR-0012). From the timeline that is indistinguishable from a hang: "Installing
# tools", a log that stopped, no reason — and the owner who filed #205 terminated a healthy box
# at five minutes, on the same day the same step had taken 4 min 21 s on their previous launch
# and finished. The retry standard cannot help until apt fails; this is what the user is told
# in the meantime.
#
# Silence is measured on the STEP'S LOG rather than on the journal, because the journal is what
# this writes to. Every STEP_QUIET_S of silence re-posts the notice with the elapsed time, so
# the line under the active step carries a clock that moves; the first byte the step writes
# after that takes the notice back, and so does the step ending. A notice never outlives its
# cause (#129's rule), and it is never posted for a step that is talking.
#
# Time is counted in polls rather than read from a clock: five polls a second, each a `sleep`
# and a `wc`, and a second of silence is five polls with the same byte count. A poll can only
# take LONGER than its sleep, so the count never announces early, and the step is released the
# moment it exits (its pipeline is gone at the next poll) — a step costs at most a fifth of a
# second more than it did. `$SECONDS` was tried and rejected: it is whole seconds since the
# agent started, so a threshold of one second could fire after a few hundred milliseconds.
watch_quiet() {
  local id="$1" step_log="$2" pid="$3"
  if [ "$STEP_QUIET_S" -le 0 ] 2>/dev/null; then
    wait "$pid" 2>/dev/null
    return 0
  fi
  local name="${id#tool:}" size last_size='' ticks=0 quiet units=0 announced=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
    size=$(wc -c <"$step_log" 2>/dev/null || echo 0)
    if [ "$size" != "$last_size" ]; then
      last_size=$size
      ticks=0
      units=0
      if [ "$announced" = 1 ]; then
        announced=0
        log "--- $id: output resumed"
        restore_notice
      fi
      continue
    fi
    ticks=$((ticks + 1))
    quiet=$((ticks / 5))
    if [ "$quiet" -ge "$STEP_QUIET_S" ] && [ $((quiet / STEP_QUIET_S)) -gt "$units" ]; then
      units=$((quiet / STEP_QUIET_S))
      announced=1
      log "--- $id: no output for $(human_seconds "$quiet") — still running"
      if [ -n "$STEP_NOTICE" ]; then
        # On a second attempt the standing notice already says what is happening and what the
        # user can do; the clock is appended rather than replacing it.
        set_notice "$STEP_NOTICE Nothing has been written for $(human_seconds "$quiet")."
      else
        set_notice "$name has said nothing for $(human_seconds "$quiet") — usually a download waiting on a mirror that is slow to answer. It is still running; if apt gives up, the agent retries it on another mirror. Nothing is stuck."
      fi
    fi
  done
  [ "$announced" = 1 ] && restore_notice
  return 0
}

# One attempt at a step: the script, then its check. A step is only done when its own check
# says so. Without this, `npm i -g` exiting 0 after a partial install is reported as working
# software.
run_step() {
  local id="$1" run_as="$2" script="$3" check="$4" timeout_s="$5" step_log="$6" rc
  install_tool "$id" "$run_as" "$script" "$timeout_s" "$step_log"
  rc=$?
  if [ $rc -eq 0 ] && [ -n "$check" ]; then
    log "--- $id: verifying with: $check"
    install_tool "$id-check" "$run_as" "$check" "$timeout_s" "$step_log"
    rc=$?
  fi
  return $rc
}

log_lines() { [ -f "$1" ] && wc -l <"$1" | tr -d ' ' || echo 0; }

run_plan() {
  local total i id run_as script check optional timeout_s reports step_log rc before
  total=$(jq '.steps | length' "$PLAN_FILE")
  log "plan: $total step(s), serverId=$(jq -r '.serverId' "$PLAN_FILE"), arch=$ARCH"

  for ((i = 0; i < total; i++)); do
    id=$(jq -r ".steps[$i].id" "$PLAN_FILE")
    reports=$(jq -r ".steps[$i].reports" "$PLAN_FILE")
    run_as=$(jq -r ".steps[$i].runAs // \"root\"" "$PLAN_FILE")
    script=$(jq -r ".steps[$i].run" "$PLAN_FILE")
    check=$(jq -r ".steps[$i].check // \"\"" "$PLAN_FILE")
    optional=$(jq -r ".steps[$i].optional // false" "$PLAN_FILE")
    timeout_s=$(jq -r ".steps[$i].timeoutSeconds // 0" "$PLAN_FILE")
    step_log="$STATE_DIR/steps/$id.log"

    # ONLY `done` is skipped. A step left `running` by a kill re-runs from the top.
    if [ "$(step_status "$id")" = "done" ]; then
      log "--- $id: already done, skipping (resume)"
      continue
    fi

    set_step "$id" running
    before=$(log_lines "$step_log")
    run_step "$id" "$run_as" "$script" "$check" "$timeout_s" "$step_log"
    rc=$?

    # A fetch failure is the mirror's fault, not the step's, so every step gets a second and
    # final attempt at one — the tool-install retry standard (#188). The signature check comes
    # first: a step that failed for its own reasons is not retried, and never pays the wait.
    if [ $rc -ne 0 ] && apt_fetch_failed "$step_log" "$before"; then
      # The user is told what failed, what happens next, how long it can take at most, and
      # that they may terminate now and go elsewhere (#205) — before the wait, so the wait is
      # never silent, and standing until the second attempt has ended either way.
      STEP_NOTICE=$(retry_notice "$id" "$step_log" "$before" "$timeout_s")
      set_notice "$STEP_NOTICE"
      apt_recover "$id"
      log "--- $id: retrying once on the fallback mirror (attempt 2 of 2)"
      run_step "$id" "$run_as" "$script" "$check" "$timeout_s" "$step_log"
      rc=$?
      STEP_NOTICE=''
      clear_notice
      if [ $rc -ne 0 ]; then
        log "--- $id: the second attempt failed too — apt is out of retries for this step"
      fi
    fi

    if [ $rc -eq 0 ]; then
      set_step "$id" "done"
      log "--- $id: done (reports=$reports)"
      continue
    fi

    set_step "$id" failed "$step_log"
    log "--- $id: FAILED (rc=$rc)"
    if [ "$optional" = "true" ]; then
      log "--- $id is optional — continuing"
      continue
    fi
    mark_failed "$id" "$step_log"
    return 1
  done

  set_plan_status "done"
  log "plan complete"
  return 0
}

# --------------------------------------------------------------------------------------
main() {
  log "=== rockysurf bootstrap agent (arch=$ARCH, user=$(id -un), plan=$PLAN_FILE) ==="
  [ -f "$PLAN_FILE" ] || {
    log "FATAL: no plan at $PLAN_FILE"
    exit 2
  }
  ensure_jq || exit 2
  check_plan_version || exit 2
  load_secrets
  load_callback_config
  init_state
  run_plan
}

main "$@"
