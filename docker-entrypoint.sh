#!/bin/sh
# Mounted volumes (Fly, Render disks) arrive owned by root. Make the snapshot's directory
# writable by the unprivileged `node` user, then drop root and run the app as `node`.
set -e
if [ "$(id -u)" = "0" ]; then
  state_dir=$(dirname "${STATE_FILE:-/app/data/.rooms-state.json}")
  mkdir -p "$state_dir"
  chown -R node:node "$state_dir" 2>/dev/null || echo "entrypoint: could not chown $state_dir; saves may fail"
  # BusyBox su execs in place (no extra process), so the app still receives SIGTERM directly.
  exec su node -s /bin/sh -c 'exec "$0" "$@"' -- "$@"
fi
exec "$@"
