#!/usr/bin/env bash
#
# Smoke test for packages/core/bootstrap/agent.sh in a real ubuntu:24.04 container.
#
# This is NOT the CI gate — that harness (two runs, two architectures, every pack) belongs to
# the pack smoke-test workflow. This is the developer-facing check for the two behaviours the
# bootstrap contract cares about most and that no unit test can prove:
#
#   1. a multi-step plan executes and every step's result lands in state.json;
#   2. killing the agent mid-plan and re-running RESUMES — steps marked `done` are skipped and
#      a step left `running` re-runs from the top;
#   3. a sick regional Ubuntu mirror engages the apt mirror fallback (#117) — only for an apt
#      fetch failure — and the plan completes on the global mirror;
#   4. the retry standard is per STEP (#188): every step that hits an apt fetch failure gets a
#      second and last attempt, whether or not an earlier step already had one. The mirror
#      SWAP inside that recovery still happens at most once, because after it there is nothing
#      left to swap;
#   5. a box already ON the global mirror gets its retry too, but waits first (#129): an apt
#      fetch failure there is the archive's index out of step with its pool, and a retry within
#      seconds is the failure again.
#
# The counters are the actual evidence: a skipped step's counter does not grow, a re-run
# step's does. Asserting on log lines alone would pass even if the work happened twice.
#
# Usage: scripts/agent-smoke.sh [--platform linux/arm64|linux/amd64]

set -euo pipefail

PLATFORM="${2:-}"
[ "${1:-}" = '--platform' ] && PLATFORM="$2"
DOCKER_ARGS=()
[ -n "$PLATFORM" ] && DOCKER_ARGS+=(--platform "$PLATFORM")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="$REPO_ROOT/packages/core/bootstrap/agent.sh"
WORK="$(mktemp -d)"
IMAGE=ubuntu:24.04
FAILURES=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

mkdir -p "$WORK/state"
cp "$AGENT" "$WORK/agent.sh"

# `sleep_seconds` is the only difference between the two runs: the step that was interrupted
# completes quickly the second time, which keeps the test fast while exercising the same ids.
write_plan() {
  local sleep_seconds="$1"
  cat >"$WORK/state/plan.json" <<EOF
{
  "version": 1,
  "serverId": "srv-smoke01",
  "mode": "push",
  "runId": "run-$sleep_seconds",
  "steps": [
    {
      "id": "tool:first",
      "reports": "installing_tools",
      "runAs": "root",
      "run": "set -euo pipefail\nprintf 'x\\\\n' >> /var/lib/rockysurf/first.count\ntouch /var/lib/rockysurf/first.done",
      "check": "test -f /var/lib/rockysurf/first.done"
    },
    {
      "id": "tool:slow",
      "reports": "installing_tools",
      "runAs": "root",
      "run": "set -euo pipefail\nprintf 'x\\\\n' >> /var/lib/rockysurf/slow.count\nsleep $sleep_seconds"
    },
    {
      "id": "tool:optional-broken",
      "reports": "installing_tools",
      "runAs": "root",
      "optional": true,
      "run": "echo 'this step fails on purpose' >&2\nexit 3"
    },
    {
      "id": "branding",
      "reports": "ready",
      "runAs": "root",
      "run": "set -euo pipefail\nprintf 'x\\\\n' >> /var/lib/rockysurf/branding.count"
    }
  ]
}
EOF
}

state() { jq -r "$1" "$WORK/state/state.json"; }
count() { [ -f "$WORK/state/$1.count" ] && wc -l <"$WORK/state/$1.count" | tr -d ' ' || echo 0; }

echo "==> pulling $IMAGE"
docker pull -q ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} "$IMAGE" >/dev/null

# --------------------------------------------------------------------------- run 1: interrupt
echo "==> run 1: start a plan and kill the agent mid-step"
write_plan 120
CONTAINER=$(
  docker run -d ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} \
    -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
    "$IMAGE" bash /agent.sh
)

# Wait for the slow step to be journalled as running, then kill. The agent bootstraps jq
# first, so the first few seconds are apt, not the plan.
for _ in $(seq 1 90); do
  [ -f "$WORK/state/state.json" ] && [ "$(state '.step')" = 'tool:slow' ] && break
  sleep 1
done
docker kill "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true

echo "--- after the kill"
check "first step recorded done" "$(state '.steps[] | select(.id=="tool:first") | .status')" "done"
check "interrupted step left running" "$(state '.steps[] | select(.id=="tool:slow") | .status')" running
check "first step ran once" "$(count first)" 1
check "slow step ran once" "$(count slow)" 1
check "later step never started" "$(state '.steps[] | select(.id=="branding") | .status')" pending
check "run id stamped before any step" "$(state '.runId')" run-120

# ------------------------------------------------------------------------------ run 2: resume
echo "==> run 2: re-run against the same state directory"
write_plan 0
docker run --rm ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} \
  -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
  "$IMAGE" bash /agent.sh >"$WORK/run2.log" 2>&1
RUN2_RC=$?

echo "--- after the resume"
check "agent exited 0" "$RUN2_RC" 0
check "plan complete" "$(state '.status')" "done"
check "done step SKIPPED — its counter did not grow" "$(count first)" 1
check "running step RE-RAN — its counter grew" "$(count slow)" 2
check "remaining step executed" "$(count branding)" 1
check "optional failure did not stop the plan" "$(state '.steps[] | select(.id=="tool:optional-broken") | .status')" failed
# Per-step evidence (ADR-0010): an optional step's reason would otherwise be gone the moment the
# next step started, and callback mode has no other way to learn why a repository did not clone.
check "optional failure carries its own log tail in the journal" "$(state '.steps[] | select(.id=="tool:optional-broken") | .logTail')" "this step fails on purpose"
check "new run id adopted" "$(state '.runId')" run-0
if grep -q 'already done, skipping (resume)' "$WORK/run2.log"; then
  pass "resume announced in the log"
else
  fail "resume announced in the log"
fi

# ------------------------------------------------------------------- required-failure semantics
echo "==> run 3: a required failure stops the plan and exits 1"
rm -f "$WORK/state/state.json"
cat >"$WORK/state/plan.json" <<'EOF'
{
  "version": 1, "serverId": "srv-smoke01", "mode": "push", "runId": "run-fail",
  "steps": [
    { "id": "tool:broken", "reports": "installing_tools", "runAs": "root",
      "run": "echo 'could not resolve host' >&2\nexit 7" },
    { "id": "branding", "reports": "ready", "runAs": "root", "run": "echo unreachable" }
  ]
}
EOF
set +e
docker run --rm ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} \
  -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
  "$IMAGE" bash /agent.sh >"$WORK/run3.log" 2>&1
RUN3_RC=$?
set -e
check "agent exited 1" "$RUN3_RC" 1
check "plan marked failed" "$(state '.status')" failed
check "failing step named" "$(state '.failedStep')" tool:broken
check "later step never ran" "$(state '.steps[] | select(.id=="branding") | .status')" pending
if [ -n "$(state '.logTail')" ]; then pass "logTail captured"; else fail "logTail captured"; fi
check "mirror fallback NOT engaged for a non-apt failure" "$(grep -c 'mirror fallback' "$WORK/run3.log")" 0

# ------------------------------------------------------------------------ version enforcement
echo "==> run 4: an unsupported plan version is refused"
rm -f "$WORK/state/state.json"
printf '{"version":2,"serverId":"s","mode":"push","runId":"r","steps":[]}\n' >"$WORK/state/plan.json"
set +e
docker run --rm ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} \
  -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
  "$IMAGE" bash /agent.sh >"$WORK/run4.log" 2>&1
RUN4_RC=$?
set -e
check "agent exited 2 (could not start)" "$RUN4_RC" 2

# --------------------------------------------------------------------- apt mirror fallback (#117)
# The container plays a cloud image whose apt sources name a regional mirror — the same shape
# cloud-init writes on EC2, Azure and GCE — and that mirror is dead: `--add-host` points the
# hostname at the container's own loopback, where nothing listens. jq is installed BEFORE the
# mirror is broken so the fallback is exercised by a plan step, not by the agent's own jq
# bootstrap (run 6 covers that path). The apt lists are removed so the step's `apt-get update`
# genuinely has to reach the mirror.
DEAD_MIRROR_ARGS=(--add-host smoke.ec2.archive.ubuntu.com:127.0.0.1 --add-host smoke.ec2.ports.ubuntu.com:127.0.0.1)
BREAK_MIRROR='sed -i -E "s#http://(archive|ports)\.ubuntu\.com#http://smoke.ec2.\1.ubuntu.com#g" /etc/apt/sources.list.d/ubuntu.sources && rm -rf /var/lib/apt/lists/*'

echo "==> run 5: a dead regional mirror engages the fallback and the plan completes"
rm -f "$WORK/state/state.json" "$WORK/state/apt.count" "$WORK/state/sources.after"
cat >"$WORK/state/plan.json" <<'EOF'
{
  "version": 1, "serverId": "srv-smoke01", "mode": "push", "runId": "run-mirror",
  "steps": [
    { "id": "tool:tree", "reports": "installing_tools", "runAs": "root",
      "run": "set -euo pipefail\nprintf 'x\\n' >> /var/lib/rockysurf/apt.count\n[ -f /var/lib/rockysurf/apt-updated ] || { apt-get update -qq && touch /var/lib/rockysurf/apt-updated; }\napt-get install -y -qq tree >/dev/null",
      "check": "command -v tree" },
    { "id": "branding", "reports": "ready", "runAs": "root",
      "run": "cp /etc/apt/sources.list.d/ubuntu.sources /var/lib/rockysurf/sources.after" }
  ]
}
EOF
set +e
docker run --rm ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} "${DEAD_MIRROR_ARGS[@]}" \
  -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
  "$IMAGE" bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq jq >/dev/null 2>&1 && $BREAK_MIRROR && bash /agent.sh" >"$WORK/run5.log" 2>&1
RUN5_RC=$?
set -e
check "agent exited 0" "$RUN5_RC" 0
check "plan complete" "$(state '.status')" "done"
check "apt step failed once, then succeeded — ran exactly twice" "$(count apt)" 2
check "fallback announced in the log" "$(grep -c 'engaging the mirror fallback' "$WORK/run5.log")" 1
check "retry announced in the log" "$(grep -c 'retrying once on the fallback mirror' "$WORK/run5.log")" 1
check "regional mirror gone from the sources" "$(grep -c 'smoke.ec2' "$WORK/state/sources.after")" 0
if grep -qE 'http://(archive|ports)\.ubuntu\.com' "$WORK/state/sources.after"; then
  pass "global mirror in the sources"
else
  fail "global mirror in the sources"
fi

# The jq bootstrap hits the dead mirror first and swaps it; the plan step that follows then hits
# a fetch failure of its own. Under the old one-retry-per-bootstrap budget that step got nothing,
# because jq had spent it. The standard is per step (#188), so it gets its own second attempt —
# with nothing left to swap, which is why the wait override is needed here.
echo "==> run 6: the jq bootstrap gets the same fallback, the swap happens once, and a later step still gets its own retry"
rm -f "$WORK/state/state.json" "$WORK/state/sick.count"
cat >"$WORK/state/plan.json" <<'EOF'
{
  "version": 1, "serverId": "srv-smoke01", "mode": "push", "runId": "run-spent",
  "steps": [
    { "id": "tool:sick", "reports": "installing_tools", "runAs": "root",
      "run": "printf 'x\\n' >> /var/lib/rockysurf/sick.count\necho 'E: Failed to fetch http://mirror.invalid/pool/main/x/x_1_all.deb  503  Service Unavailable' >&2\nexit 100" },
    { "id": "branding", "reports": "ready", "runAs": "root", "run": "echo unreachable" }
  ]
}
EOF
set +e
docker run --rm ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} "${DEAD_MIRROR_ARGS[@]}" \
  -e ROCKYSURF_APT_RETRY_WAIT_S=1 \
  -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
  "$IMAGE" bash -c "$BREAK_MIRROR && bash /agent.sh" >"$WORK/run6.log" 2>&1
RUN6_RC=$?
set -e
check "jq bootstrapped through the fallback" "$(grep -c 'jq: retrying once on the fallback mirror' "$WORK/run6.log")" 1
check "agent exited 1 (the sick step is a real failure)" "$RUN6_RC" 1
check "failing step named" "$(state '.failedStep')" tool:sick
check "recovery ran for both the jq bootstrap and the step" "$(grep -c 'engaging the mirror fallback' "$WORK/run6.log")" 2
check "the mirror was swapped once — the second recovery had nothing left to swap" "$(grep -c 'rewritten to the global one' "$WORK/run6.log")" 1
check "the second recovery waited instead" "$(grep -c 'already on the global Ubuntu mirror' "$WORK/run6.log")" 1
check "the sick step got its own second attempt, and only one" "$(count sick)" 2
check "and was told it is out of retries" "$(grep -c 'out of retries for this step' "$WORK/run6.log")" 1

# --------------------------------------------------------- global mirror: wait, then retry (#129)
# The sources already name the global mirror (the stock image's own, exactly what the pack smoke
# runs in) and that host is dead. There is nothing to swap, so the fallback must wait before
# its one retry rather than fail again within the second. The wait is shortened to 1s by the
# override the agent exposes for this purpose; the assertion is that it happened and was
# announced, and that the step still ran exactly twice. jq is installed while the mirror is
# still alive, so the fallback is exercised by the plan step and not by the agent's own jq
# bootstrap (which would exit 2 before any step ran); the mirror is then killed from inside
# the container via /etc/hosts, since --add-host would kill it before jq could be fetched.
echo "==> run 7: on the global mirror the fallback waits, refreshes, retries once, and fails honestly"
# The apt-updated stamp survives from run 5 in the shared state volume; left in place, the step
# would skip `apt-get update`, fail on "Unable to locate package" with no fetch signature, and
# the fallback would (correctly) never engage.
rm -f "$WORK/state/state.json" "$WORK/state/global.count" "$WORK/state/sources.after" "$WORK/state/apt-updated"
KILL_GLOBAL_MIRROR='printf "127.0.0.1 archive.ubuntu.com ports.ubuntu.com security.ubuntu.com\n" >> /etc/hosts && rm -rf /var/lib/apt/lists/*'
cat >"$WORK/state/plan.json" <<'EOF'
{
  "version": 1, "serverId": "srv-smoke01", "mode": "push", "runId": "run-global",
  "steps": [
    { "id": "tool:tree", "reports": "installing_tools", "runAs": "root",
      "run": "set -euo pipefail\nprintf 'x\\n' >> /var/lib/rockysurf/global.count\n[ -f /var/lib/rockysurf/apt-updated ] || { apt-get update -qq && touch /var/lib/rockysurf/apt-updated; }\napt-get install -y -qq tree >/dev/null",
      "check": "command -v tree" },
    { "id": "branding", "reports": "ready", "runAs": "root", "run": "echo unreachable" }
  ]
}
EOF
set +e
docker run --rm ${DOCKER_ARGS[@]+"${DOCKER_ARGS[@]}"} \
  -e ROCKYSURF_APT_RETRY_WAIT_S=1 \
  -v "$WORK/state:/var/lib/rockysurf" -v "$WORK/agent.sh:/agent.sh:ro" \
  "$IMAGE" bash -c "apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq jq >/dev/null 2>&1 && $KILL_GLOBAL_MIRROR && bash /agent.sh" >"$WORK/run7.log" 2>&1
RUN7_RC=$?
set -e
check "agent exited 1 (the mirror never came back)" "$RUN7_RC" 1
check "failing step named" "$(state '.failedStep')" tool:tree
check "fallback engaged exactly once" "$(grep -c 'engaging the mirror fallback' "$WORK/run7.log")" 1
check "nothing rewritten — the wait was announced" "$(grep -c 'already on the global Ubuntu mirror' "$WORK/run7.log")" 1
check "the wait honoured the override" "$(grep -c 'waiting 1s' "$WORK/run7.log")" 1
check "retry announced" "$(grep -c 'retrying once on the fallback mirror' "$WORK/run7.log")" 1
check "apt step ran exactly twice" "$(count global)" 2
check "no regional mirror was invented" "$(grep -c 'rewritten to the global one' "$WORK/run7.log")" 0
# The journal carried a reason while the wait lasted and dropped it after: a notice that
# outlived its cause would sit under a failed step claiming nothing is stuck.
check "notice cleared once the wait was over" "$(state '.notice // "none"')" none

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "agent smoke: all checks passed"
else
  echo "agent smoke: $FAILURES check(s) failed"
  exit 1
fi
