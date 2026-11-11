"""Every current document says which version it describes, and describes it.

A guide that was true at 0.2.1 and is read at 0.4.0 is worse than a missing guide: the reader has no
way to tell. The stamp under each H1 is the reader's signal; this test is the gate that keeps it true.

Three failures this catches, all of which happened here:
- a feature ships and no doc mentions it (the Points economy was written, spent and won, and appeared
  in no document at all);
- a doc is edited for a new version and the old one is left stamped;
- code moves and the doc that describes it never gets re-read.
"""

import importlib.util
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_tool():
    spec = importlib.util.spec_from_file_location("doc_stamp", ROOT / "tools" / "doc_stamp.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stamp = _load_tool()
DOC_MAP = json.loads((ROOT / "docs" / "doc-map.json").read_text(encoding="utf-8"))


def test_every_document_is_stamped_with_the_manifest_version():
    current = stamp.version()
    missing = []
    behind = []
    for path in stamp.docs():
        rel = path.relative_to(ROOT).as_posix()
        _, match = stamp.find_stamp(path.read_text(encoding="utf-8").splitlines())
        if not match:
            missing.append(rel)
        elif match.group("version") != current:
            behind.append(f"{rel} says {match.group('version')}, plugin.yaml says {current}")
    assert not missing, f"no 'Applies to {stamp.PRODUCT} <version> · last revised <date>' line: {missing}"
    assert not behind, f"stamped for an older version: {behind}"


def test_every_document_is_in_the_map():
    on_disk = {p.relative_to(ROOT).as_posix() for p in stamp.docs()}
    mapped = {k for k in DOC_MAP if not k.startswith("_")}
    assert on_disk == mapped, f"unmapped: {sorted(on_disk - mapped)}; mapped but missing: {sorted(mapped - on_disk)}"


def test_each_document_mentions_what_it_is_supposed_to_cover():
    silent = []
    for rel, entry in DOC_MAP.items():
        if rel.startswith("_"):
            continue
        text = (ROOT / rel).read_text(encoding="utf-8").lower()
        for marker in entry.get("markers", []):
            if marker.lower() not in text:
                silent.append(f"{rel} never mentions {marker!r}")
    assert not silent, "; ".join(silent)


def test_no_document_is_older_than_the_code_it_describes():
    """If code changed after a doc's revision date, someone must re-read the doc and restamp it."""
    stale = []
    for rel, entry in DOC_MAP.items():
        if rel.startswith("_") or not entry.get("code"):
            continue
        path = ROOT / rel
        _, match = stamp.find_stamp(path.read_text(encoding="utf-8").splitlines())
        assert match, f"{rel} has no stamp"
        try:
            changed = subprocess.run(
                ["git", "-C", str(ROOT), "log", "-1", "--format=%cs", "--", *entry["code"]],
                capture_output=True, text=True, check=True, timeout=30,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue  # not a git checkout: the stamp checks above still hold
        if changed and changed > match.group("date"):
            stale.append(f"{rel}: revised {match.group('date')}, code changed {changed}")
    assert not stale, "; ".join(stale) + " — read the doc, fix it if the feature moved, then run tools/doc_stamp.py --write"
