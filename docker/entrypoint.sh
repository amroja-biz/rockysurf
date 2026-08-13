#!/bin/sh
# Container entrypoint (rockysurf-ftl9.4).
#
# One job beyond `exec`: make sure a config file exists before core looks for one.
#
# `loadConfig` treats a missing file as a fatal error that names the file and exits — which is
# right for someone at a terminal and wrong for a container, where it means `docker compose up`
# dies before anyone has seen a page. So the first start seeds the volume from the image's
# default and says so; every start after that finds the operator's copy and leaves it alone.
#
# The seed lives in the VOLUME rather than the image so it is editable and survives a rebuild.
set -eu

CONFIG="${ROCKYSURF_CONFIG:-/data/rockysurf.config.yaml}"
SEED=/app/docker/rockysurf.config.yaml

if [ ! -e "$CONFIG" ]; then
  mkdir -p "$(dirname "$CONFIG")"
  cp "$SEED" "$CONFIG"
  echo "rockysurf: seeded $CONFIG from the image default — edit it and restart to change anything." >&2
elif ! sed -n '/^server:/,/^[^[:space:]#]/p' "$CONFIG" | grep -qE '^[[:space:]]+host:[[:space:]]*[^[:space:]#]'; then
  # A volume seeded before server.host existed (rockysurf-pii7). Core now defaults to
  # loopback, which inside a container is the container's own — the published port would
  # connect to nothing, and the healthcheck would still pass because it also runs in here.
  # "Healthy but unreachable" is the worst kind of failure to debug, so name it up front.
  echo "rockysurf: WARNING — $CONFIG has no 'server.host'. The default is 127.0.0.1, which in a" >&2
  echo "rockysurf: container is unreachable from the host. Add 'host: 0.0.0.0' under 'server:'" >&2
  echo "rockysurf: and restart. (The compose file still publishes on the host's loopback.)" >&2
fi

# `exec` so node becomes PID 1 and receives SIGTERM directly: the CLI's handler checkpoints the
# SQLite WAL on the way down, and a shell in the middle would swallow the signal and leave that
# to the 10-second kill instead.
exec node /app/packages/rockysurf/dist/bin.js --config "$CONFIG" "$@"
