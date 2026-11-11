#!/usr/bin/env python3
"""Prove that what Hermes will run is this tree.

Game Center runs inside the desktop app rather than as its own service, so there is no port to
poll: the checks are the installed copy's manifest, its build stamp, and the bundle Hermes loads.

  python3 scripts/verify-served.py

Exits non-zero on any break, so a deploy cannot report success while the app runs older code.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INSTALLED = Path.home() / ".hermes" / "plugins" / "hermes-gameshelf"

# Strings only a recent build carries. Update them when the work moves on.
MARKERS = ["GamesVersionChip", "/v1/version"]


def declared(path: Path) -> str:
    manifest = path / "plugin.yaml"
    if not manifest.is_file():
        return ""
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def main() -> int:
    problems = []

    if not INSTALLED.is_dir():
        print("FAILED — Game Center is not installed at %s" % INSTALLED)
        return 1

    wanted, have = declared(REPO), declared(INSTALLED)
    if not have:
        problems.append("the installed copy has no plugin.yaml version")
    elif wanted and have != wanted:
        problems.append("installed version %r is not this tree's %r" % (have, wanted))

    stamp_path = INSTALLED / "BUILD_INFO.json"
    stamp = {}
    if stamp_path.is_file():
        try:
            stamp = json.loads(stamp_path.read_text(encoding="utf-8"))
        except ValueError:
            problems.append("BUILD_INFO.json is not valid JSON")
    else:
        problems.append("no BUILD_INFO.json in the installed copy — it cannot say which commit it is")

    bundle = INSTALLED / "desktop" / "plugin.js"
    if not bundle.is_file():
        problems.append("the installed copy has no desktop/plugin.js")
    else:
        text = bundle.read_text(encoding="utf-8", errors="replace")
        for marker in MARKERS:
            if marker not in text:
                problems.append("the installed bundle is missing %r" % marker)

    if problems:
        print("FAILED — what Hermes will run is not this tree:")
        for problem in problems:
            print("  -", problem)
        return 1

    print("installed: %s · %s · %s" % (stamp.get("version") or have,
                                       (stamp.get("commit") or "")[:8],
                                       (stamp.get("commit_date") or "")[:10]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
