#!/bin/sh
# Build the Game Center Online release tarball: the server, every table game (game.json kind table), the shared
# referee (kit.py) and the board drawing (desktop/plugin.js). Nothing else from the plugin.
# Usage: online/deploy/package.sh OUT_DIR   (run from plugins/hermes-gameshelf)
set -eu
out=${1:?usage: package.sh OUT_DIR}
here=$(cd "$(dirname "$0")/../.." && pwd)
stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$out"
# Normalised ownership and modes: a checkout with group-only modes (rw-rw----) otherwise ships files the
# service user cannot read, and the server dies with "No module named online.server" (2026-11-11).
tar --owner=0 --group=0 --numeric-owner --mode="u+rwX,go+rX,go-w" -C "$here" -czf "$out/gameshelf-online-$stamp.tar.gz" \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='online/deploy/*.tar.gz' \
  __init__.py kit.py desktop/plugin.js online shelf \
  $(cd "$here" && grep -l '"kind": *"table"' */game.json | xargs -n1 dirname)
echo "$out/gameshelf-online-$stamp.tar.gz"
