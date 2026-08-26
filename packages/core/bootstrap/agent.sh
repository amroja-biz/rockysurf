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

  # Body on stdin, never in argv: a `-d` with the token in it is readable through `ps` by
  # every user on the box, including the unprivileged steps this agent is about to run.
  if ! jq -nc --arg s "$label" --arg sid "$step" --arg st "$status" --arg t "$CALLBACK_TOKEN" --arg r "$runid" \
    --arg ss "$stepstatus" --arg lt "$tail_txt" \
    '{step:$s, stepId:$sid, status:$st, token:$t, runId:$r}
     + (if $ss != "" then {stepStatus:$ss} else {} end)
     + (if $lt != "" then {logTail:$lt} else {} end)' |
    curl -fsS --max-time 15 --retry 3 --retry-delay 2 --retry-connrefused \
      -H 'Content-Type: application/json' --data @- "$CALLBACK_URL" >/dev/null; then
    # Progress is telemetry, not control flow. A box that cannot reach core still finishes
    # installing, and state.json remains the complete record for whenever it can.
    log "WARNING: progress report failed for $step (continuing)"
  fi
}

# --------------------------------------------------------------------------------------
# apt mirror fallback
# --------------------------------------------------------------------------------------
# Every Ubuntu cloud image points apt at a PER-REGION Canonical mirror — us-east-1.ec2.ports.
# ubuntu.com, azure.archive.ubuntu.com, europe-west1.gce.archive.ubuntu.com — and when that
# one mirror's backend is sick its index files keep serving while every .deb in the pool
# answers 503. apt does not retry a 503 at all (measured on 24.04's apt 2.8.3: one request,
# then "E: Unable to fetch some archives"; Acquire::Retries only covers connection failures),
# so the first apt step of the plan — build-essential, in every pack — dies, and with it the
# whole bootstrap, before anything pack-specific has run. Seen in the wild four times in a
# week, on two mirror IPs at once and for hours at a stretch (issue #117).
#
# The remedy is the one an operator would apply by hand: switch to the global mirror, refresh
# the lists, try the step again. The agent does that ONCE per bootstrap, ONLY for a failure
# whose log carries an apt fetch signature, and says so loudly — a step that fails again after
# the fallback fails for real. The regional mirror stays the default because it is fast and
# in-region; the global one is reached for only when the regional one is proven sick.
#
# Rewriting the sources is safe under the idempotency contract: every step is written to
# converge, and `apt-get install` against a different mirror of the same archive converges on
# the same packages. A pack that hard-codes a regional mirror hostname in its own script is
# already broken on every other cloud (docs/writing-a-pack.md).
APT_FALLBACK_USED=0

# Anything with a subdomain in front of archive/ports — the regional and per-cloud mirrors —
# collapses to the bare global host. `archive.ubuntu.com`, `ports.ubuntu.com` and
# `security.ubuntu.com` do not match, so a box already on the global mirror is left alone.
REGIONAL_MIRROR_RE='[a-z0-9.-]+\.(archive|ports)\.ubuntu\.com'

# $1 = a log file, $2 = the line count it had before this attempt. Only this attempt's output
# is inspected: on a resume, an earlier attempt's fetch failure must not trigger the fallback
# for a step that is now failing for some other reason.
apt_fetch_failed() {
  [ -f "$1" ] || return 1
  tail -n +"$(($2 + 1))" "$1" | grep -qE \
    'Failed to fetch|Unable to fetch some archives|Some index files failed to download|Mirror sync in progress|File has unexpected size|Hash Sum mismatch'
}

# Returns 0 when the fallback has just been engaged and the caller should retry, 1 when it has
# already been spent — the caller then reports the failure it already has.
apt_mirror_fallback() {
  [ "$APT_FALLBACK_USED" = 0 ] || return 1
  APT_FALLBACK_USED=1
  log "!!! apt fetch failure — engaging the mirror fallback (once per bootstrap)"

  local f rewritten=0
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
  [ "$rewritten" = 1 ] || log "!!! no regional Ubuntu mirror in the apt sources — refreshing lists and retrying as-is"

  # The step's own `apt-updated` stamp is stale by definition now, but the lists it guards are
  # refreshed here, so the stamp idiom keeps working without every pack knowing about this.
  if apt-get update -qq 2>&1 | tail -n 5; then
    log "!!! apt lists refreshed"
  else
    log "!!! apt-get update still failing — the retry below will tell"
  fi
  return 0
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
  if apt_fetch_failed "$jq_log" 0 && apt_mirror_fallback; then
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

  "${cmd[@]}" 2>&1 | tee -a "$step_log"
  return "${PIPESTATUS[0]}"
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

    # A fetch failure is the mirror's fault, not the step's: swap mirrors once and give the
    # step one more go. The fallback is spent after the first use, so a second failing step
    # goes straight to the failure below. Order matters — the signature check comes first, so
    # the one fallback is not consumed by a failure it could never have fixed.
    if [ $rc -ne 0 ] && apt_fetch_failed "$step_log" "$before" && apt_mirror_fallback; then
      log "--- $id: retrying once on the fallback mirror"
      run_step "$id" "$run_as" "$script" "$check" "$timeout_s" "$step_log"
      rc=$?
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
