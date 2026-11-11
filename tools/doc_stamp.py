#!/usr/bin/env python3
"""Keep every document stamped with the version it describes and the date it was last revised.

A doc that describes version 0.2.1 and still says so at 0.4.0 is a lie the reader cannot see.
This tool makes that visible in the file itself and, with --check, in CI.

    python3 tools/doc_stamp.py --write     # refresh every stamp: version from plugin.yaml,
                                           # today's date, the current commit
    python3 tools/doc_stamp.py --check     # report what is missing, behind the manifest, or older
                                           # than the code the doc covers (docs/doc-map.json)

The stamp sits on its own line right under the H1, because a reader meets it before the first
paragraph and because a reviewer can diff it:

    _Applies to Game Center 0.2.1 · last revised 2026-11-09 (c3a85e8)_

`docs/history/` is never stamped: those files are records of past runs, not current guides.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRODUCT = "Game Center"
DOC_MAP = ROOT / "docs" / "doc-map.json"

STAMP_RE = re.compile(
    r"^_Applies to " + re.escape(PRODUCT) + r" (?P<version>\S+) · last revised "
    r"(?P<date>\d{4}-\d{2}-\d{2}) \((?P<commit>[0-9a-f]{7,40})\)_$"
)


def version() -> str:
    for line in (ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip().strip("\"'")
    raise SystemExit("plugin.yaml has no version: line")


def docs() -> list[Path]:
    found = [ROOT / "README.md", ROOT / "SECURITY.md"]
    found += sorted((ROOT / "docs").glob("*.md"))
    return [p for p in found if p.is_file()]


def stamp_line(ver: str, day: str, commit: str) -> str:
    return f"_Applies to {PRODUCT} {ver} · last revised {day} ({commit})_"


def head_commit() -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--short=8", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def last_code_change(globs: list[str]) -> str:
    """The date of the newest commit touching the code this doc describes, or ''."""
    if not globs:
        return ""
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "log", "-1", "--format=%cs", "--", *globs],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""
    return out


def read_map() -> dict:
    if not DOC_MAP.is_file():
        return {}
    return json.loads(DOC_MAP.read_text(encoding="utf-8"))


def find_stamp(lines: list[str]) -> tuple[int, re.Match | None]:
    for i, line in enumerate(lines[:8]):
        m = STAMP_RE.match(line.strip())
        if m:
            return i, m
    return -1, None


def write_all(ver: str, day: str, commit: str) -> int:
    line = stamp_line(ver, day, commit)
    changed = 0
    for path in docs():
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        idx, _ = find_stamp(lines)
        if idx >= 0:
            if lines[idx].strip() == line:
                continue
            lines[idx] = line
        else:
            at = next((i for i, l in enumerate(lines) if l.startswith("# ")), -1)
            if at < 0:
                print(f"  skip (no H1): {path.relative_to(ROOT)}")
                continue
            insert = at + 1
            if insert < len(lines) and lines[insert].strip():
                lines.insert(insert, "")
                insert += 1
            lines.insert(insert, line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        changed += 1
        print(f"  stamped {path.relative_to(ROOT)}")
    return changed


def check() -> int:
    ver = version()
    mapping = read_map()
    problems = 0
    for path in docs():
        rel = path.relative_to(ROOT).as_posix()
        lines = path.read_text(encoding="utf-8").splitlines()
        idx, m = find_stamp(lines)
        if not m:
            print(f"UNSTAMPED  {rel}")
            problems += 1
            continue
        stamped, revised = m.group("version"), m.group("date")
        if stamped != ver:
            print(f"OLD VERSION {rel}: stamped {stamped}, plugin.yaml says {ver}")
            problems += 1
        entry = mapping.get(rel)
        if entry is None:
            print(f"UNMAPPED   {rel}: add it to docs/doc-map.json")
            problems += 1
            continue
        for marker in entry.get("markers", []):
            if marker.lower() not in path.read_text(encoding="utf-8").lower():
                print(f"MISSING    {rel}: the doc never mentions {marker!r}")
                problems += 1
        code_date = last_code_change(entry.get("code") or [])
        if code_date and code_date > revised:
            print(f"STALE      {rel}: revised {revised}, but its code changed {code_date}")
            problems += 1
    if problems:
        print(f"\n{problems} documentation problem(s). Run --write after reviewing the docs.")
        return 1
    print(f"documentation is current for {PRODUCT} {ver} across {len(docs())} files")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--write", action="store_true", help="refresh every stamp")
    ap.add_argument("--check", action="store_true", help="report stale or unstamped docs")
    args = ap.parse_args()
    if args.write:
        n = write_all(version(), dt.date.today().isoformat(), head_commit())
        print(f"{n} file(s) updated")
        return 0
    if args.check:
        return check()
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
