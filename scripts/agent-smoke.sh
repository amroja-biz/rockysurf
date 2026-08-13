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
#      a step left `running` re-runs from the top.
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

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "agent smoke: all checks passed"
else
  echo "agent smoke: $FAILURES check(s) failed"
  exit 1
fi
