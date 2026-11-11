#!/usr/bin/env bash
# Deploy Game Center: rebuild the bundle, install this tree, stamp the build, prove what is served.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLED="$HOME/.hermes/plugins/hermes-gameshelf"
cd "$REPO"

VERSION="$(grep -m1 '^version:' plugin.yaml | cut -d: -f2- | tr -d '"' | xargs)"
COMMIT="$(git rev-parse HEAD)"
COMMIT_DATE="$(git log -1 --format=%cI)"
BUILT_AT="$(date -Iseconds)"
DISPLAY="${VERSION}-dev.$(git rev-list --count HEAD)"
DIRTY="false"
# Build outputs and the stamp itself are excluded: counting them would mark every deploy modified.
[ -n "$(git status --porcelain -- . ':!dist' ':!BUILD_INFO.json' ':!*.pyc')" ] && DIRTY="true"

echo "==> building desktop/plugin.js"
python3 tools/build_plugin.py

echo "==> installing $COMMIT"
hermes plugins install KeyArgo/hermes-game-center --ref "$COMMIT" --force --yes-deps --enable 2>&1 | tail -2

python3 - "$INSTALLED" "$DISPLAY" "$VERSION" "$COMMIT" "$COMMIT_DATE" "$BUILT_AT" "$DIRTY" <<'PY'
import json, pathlib, sys
installed, display, release, commit, date, built, dirty = sys.argv[1:8]
payload = {"version": display, "release": release, "commit": commit, "commit_date": date,
           "built_at": built, "dirty": dirty == "true",
           "channel": "dev" if "-dev." in display else "release"}
pathlib.Path(installed, "BUILD_INFO.json").write_text(json.dumps(payload, indent=2) + "\n")
print(f"==> stamped {display} · {commit[:8]}")
PY

# Hermes re-applies local edits on top of an install; sync afterwards so the tree is what runs.
rsync -a --exclude '.git' --exclude '__pycache__' --exclude '*.pyc' --exclude 'BUILD_INFO.json' \
  --exclude '.lanes' --exclude 'node_modules' "$REPO/" "$INSTALLED/"

python3 scripts/verify-served.py
echo "==> reload the desktop app (Ctrl+K -> Reload desktop plugins) to pick up the new bundle"
