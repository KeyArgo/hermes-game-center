#!/bin/sh
# The browser proof, from a clean table.
#
# Starts the isolated real-page server on a fresh scratch root, drives every table game with
# real pointer input (tools/browser_drive.mjs), and stops only the server it started.
#
#   tools/ux_tour.sh            # port 18810, fresh scratch root, every game
#   tools/ux_tour.sh 18811      # another port
#   tools/ux_tour.sh 18811 hex  # one game only
#   tools/ux_tour.sh 18811 "" --debug
#
set -eu
PORT="${1:-18810}"
ONLY="${2:-}"
shift 2 2>/dev/null || true
ROOT="/tmp/gameshelf-ux-tour-$$"
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
PYTHONPATH="${PYTHONPATH:-}" \
  uv run --python 3.13 --with fastapi --with uvicorn \
  python tests/browser_table_server.py --root "$ROOT" --port "$PORT" &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; rm -r -- "$ROOT" 2>/dev/null || true' EXIT INT TERM
tries=0
while [ "$tries" -lt 90 ]; do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  tries=$((tries + 1))
  sleep 1
done
if [ "$tries" -ge 90 ]; then
  echo "the isolated server did not come up on port $PORT" >&2
  exit 1
fi
if [ -n "$ONLY" ]; then
  node tools/browser_drive.mjs --url "http://127.0.0.1:$PORT/" --out test-artifacts/ux --game "$ONLY" "$@"
else
  node tools/browser_drive.mjs --url "http://127.0.0.1:$PORT/" --out test-artifacts/ux --tour "$@"
fi
