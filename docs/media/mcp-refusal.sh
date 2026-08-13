#!/usr/bin/env bash
#
# Record the README's MCP refusal clips (rockysurf-o45s.1).
#
# Stands up a THROWAWAY control plane — its own port, its own data directory, the in-memory
# fake provider, no cloud account anywhere — and records `mcp-refusal-demo.mjs` driving the
# real MCP server into a real server-side refusal.
#
#   ./docs/media/mcp-refusal.sh                              # → mcp-refusal.gif  (max servers)
#   ROCKYSURF_DEMO_SPEND_CAP=0.01 ./docs/media/mcp-refusal.sh  # → mcp-spend-cap.gif (the cap)
#   ./docs/media/mcp-refusal.sh --no-record                  # run it in this terminal instead
#
# WHAT IS ARRANGED AND WHAT IS NOT. Arranged: the limits in the config below, and — for the
# spend cap — a seeded fleet, because a cap is crossed by accrued uptime on real wall clock and
# a README GIF cannot wait a fortnight for a cent. Not arranged: everything the clip is about.
# Real JSON-RPC over stdio, real HTTP to a real control plane, real uptime accrued by core's own
# ticker, and a refusal composed by core's own limit enforcer. The demo films whichever limit
# refuses it and does not know which one is configured.
#
# Both clips need a working no-cloud box, which is rockysurf-8fkz's fix, and priced rows, which
# is rockysurf-dec8's. Before those, the fake provider's servers never left `provisioning` and
# no row was ever priced, so nothing accrued and the cap could not fire at all.
#
# Requires: a built repo (`pnpm build`), Node 24+, and vhs (`brew install vhs`) to record.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${ROCKYSURF_DEMO_PORT:-3999}"
# Set to a USD amount to film the SPEND CAP instead of max servers, e.g.
#   ROCKYSURF_DEMO_SPEND_CAP=0.01 ./docs/media/mcp-refusal.sh
# maxServers is raised out of the way when this is set, so the cap is the limit that fires.
SPEND_CAP="${ROCKYSURF_DEMO_SPEND_CAP:-}"
# Out of the way when a cap is in play, tight enough to be the limit that fires when it is not.
MAX_SERVERS=3
SEED_COUNT=0
[[ -n "$SPEND_CAP" ]] && { MAX_SERVERS=50; SEED_COUNT="${ROCKYSURF_DEMO_SEED_COUNT:-8}"; }
RECORD=1
[[ "${1:-}" == "--no-record" ]] && RECORD=0

BIN="$REPO/packages/rockysurf/dist/bin.js"
[[ -f "$BIN" ]] || { echo "build the repo first: pnpm build" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rockysurf-mcp-demo.XXXXXX")"
CORE_PID=""
cleanup() {
  [[ -n "$CORE_PID" ]] && kill "$CORE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/rockysurf.config.yaml" <<YAML
# Throwaway config for the refusal recording. No provider is enabled, so core registers its
# in-memory fake provider and no cloud account is involved.
server:
  port: $PORT
  dataDir: "$WORK/data"

limits:
  # Small enough that the third create is the last one. Everything else is left generous, so
  # the limit that refuses is unambiguously this one.
  maxServers: $MAX_SERVERS
  createRatePerHour: 50
$([[ -n "$SPEND_CAP" ]] && printf '  spendCap:\n    amount: %s\n    currency: USD\n' "$SPEND_CAP")

mcp:
  # No 'terminate': the agent may make servers, never destroy them.
  scopes: [read, stop, create]
YAML

echo "› minting a token"
TOKEN="$(node "$BIN" token --config "$WORK/rockysurf.config.yaml" 2>/dev/null)"

echo "› starting a throwaway control plane on :$PORT"
# A short simulated install (rockysurf-8fkz): the trial run's boxes reach `ready` in seconds
# rather than the default ~28s, so the seeded fleet is billing before the tape rolls.
ROCKYSURF_SIMULATED_BOOTSTRAP_MS="${ROCKYSURF_SIMULATED_BOOTSTRAP_MS:-8000}" \
  node "$BIN" --config "$WORK/rockysurf.config.yaml" > "$WORK/core.log" 2>&1 &
CORE_PID=$!
for _ in $(seq 1 40); do
  curl -fsS -o /dev/null -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/v1/servers" 2>/dev/null && break
  sleep 0.5
done

servers_json() {
  curl -fsS -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/v1/servers"
}

if [[ -n "$SPEND_CAP" ]]; then
  # A FLEET, ONLY BECAUSE OF ARITHMETIC. A spend cap is crossed by accrued uptime on real wall
  # clock, and one box at the fake provider's cheapest 0.01 USD/hour would take twenty minutes
  # to spend a cent. Eight boxes on its dearest offering spend the same cent in about two.
  #
  # `offeringId` is passed explicitly because a create that names only a SIZE resolves to the
  # cheapest available offering whatever size it asks for (ADR-0003 leaves t-shirt resolution
  # deliberately unfinished), so `size: medium` alone would quietly give eight more 0.01/hour
  # boxes and a twenty-minute wait.
  echo "› seeding a fleet of $SEED_COUNT, so the cap is crossed in the length of a clip"
  for i in $(seq 1 "$SEED_COUNT"); do
    curl -fsS -o /dev/null -X POST "http://127.0.0.1:$PORT/api/v1/servers" \
      -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"name\":\"fleet-$i\",\"size\":\"medium\",\"offeringId\":\"fake-medium\",\"arch\":\"amd64\"}"
  done

  # Wait for every one of them to be RUNNING before the tape rolls, for two reasons: uptime
  # only accrues in that state, and a row still in `provisioning` would be settled out from
  # under the recording by the startup recovery that `rockysurf mcp`'s own boot performs
  # (rockysurf-o2t5). A running row is not examined by that pass.
  echo -n "› waiting for the fleet to come up"
  for _ in $(seq 1 60); do
    RUNNING="$(servers_json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).filter(r=>r.status==="running").length))')"
    [[ "$RUNNING" == "$SEED_COUNT" ]] && break
    printf '.'
    sleep 2
  done
  echo " $RUNNING/$SEED_COUNT running"

  # And then for the ticker's FIRST accrual, which is what puts a real number on screen. The
  # ticker runs once a minute, so a tape that rolls before it has fired opens on "0 of 0.01 USD
  # cap (0%)" — a fleet that has been billing for a minute, reporting nothing. Starting after
  # it means act one opens part-way through the budget, which is the picture that makes the
  # refusal a minute later mean something.
  echo -n "› waiting for the first accrual tick"
  for _ in $(seq 1 45); do
    FRACTION="$(curl -fsS -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/v1/costs" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).cap.fraction??0))')"
    awk -v f="$FRACTION" 'BEGIN { exit !(f > 0) }' && break
    printf '.'
    sleep 3
  done
  echo " $(awk -v f="$FRACTION" 'BEGIN { printf "%d%%", f * 100 }') of the cap billed"
fi

export ROCKYSURF_URL="http://127.0.0.1:$PORT"
export ROCKYSURF_TOKEN="$TOKEN"
export ROCKYSURF_MCP_CMD="node $BIN mcp --config $WORK/rockysurf.config.yaml"
# Holds the refused create until a fixed point, so the tape's hidden stretch lands after the
# ticker crosses the cap rather than guessing at a 60-second tick boundary.
export ROCKYSURF_DEMO_ACT2_AT_MS="${ROCKYSURF_DEMO_ACT2_AT_MS:-90000}"

TAPE="docs/media/mcp-refusal.tape"
[[ -n "$SPEND_CAP" ]] && TAPE="docs/media/mcp-spend-cap.tape"

if [[ "$RECORD" == "1" ]]; then
  echo "› recording $TAPE"
  cd "$REPO" && vhs "$TAPE"
  echo "› wrote ${TAPE%.tape}.gif"
else
  node "$REPO/docs/media/mcp-refusal-demo.mjs"
fi
