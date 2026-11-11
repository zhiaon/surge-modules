#!/bin/sh
# Local preview runner with a memory cap and automatic restart.
#
# This device aborts Node with std::bad_alloc under memory pressure, so the
# process is restarted rather than left dead. --max-old-space-size keeps the
# heap small enough that a restart is cheap.
set -u
cd "$(dirname "$0")/.." || exit 1

export NODE_OPTIONS="--max-old-space-size=384"

while true; do
  echo "[$(date +%H:%M:%S)] starting dev server"
  node scripts/dev-api.mjs "$@"
  code=$?
  echo "[$(date +%H:%M:%S)] exited ($code), restarting in 2s"
  sleep 2
done
