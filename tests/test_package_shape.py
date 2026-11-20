"""What a judge clones is the plugin, not the build log: no proof screenshots, no lane notes at the root."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# The root keeps only what a reader of the plugin needs.
ROOT_DOCS = {
    "README.md", "LICENSE", "LICENSE.md", "THIRD-PARTY-NOTICES.md",
    "VERIFY.md", "LIMITS.md", "PROVENANCE.md", "SECURITY.md", "CONTRIBUTORS.md",
    "SHIP-GATE.md",  # written there by tools/ship_gate; it is the per-game evidence
    "CHANGELOG.md",  # root by convention: it sits where people look for it
    "CONTRIBUTING.md",  # the one page the app's "How to help" link opens
}


def _tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    return [name for name in out.decode().split("\0") if name]


def test_no_proof_or_scratch_artifacts_are_tracked():
    tracked = _tracked()
    assert not [name for name in tracked if name.startswith("proof/")]
    assert not [name for name in tracked if name.startswith("test-artifacts/")]


def test_proof_and_scratch_are_ignored_so_they_stay_out():
    for path in ("proof/x.png", "test-artifacts/x.json"):
        ignored = subprocess.run(["git", "check-ignore", "-q", path], cwd=ROOT)
        assert ignored.returncode == 0, f"{path} should be git-ignored"


def test_root_carries_no_lane_notes():
    root_md = {name for name in _tracked() if "/" not in name and name.endswith(".md")}
    assert root_md <= ROOT_DOCS, sorted(root_md - ROOT_DOCS)


def test_contributing_exists_and_its_links_resolve():
    """The app's "How to help" link opens one page, and every file it names is in the package."""
    guide = ROOT / "CONTRIBUTING.md"
    assert guide.is_file(), "How to help points at a CONTRIBUTING.md that is not here"
    text = guide.read_text(encoding="utf-8")
    assert "/issues/new" in text, "it must say where to report a problem"
    for rel in ("docs/ADD-YOUR-GAME.md", "docs/DEVELOPMENT.md"):
        assert rel in text, f"CONTRIBUTING.md never mentions {rel}"
        assert (ROOT / rel).is_file(), f"{rel} is named but missing"


def test_lane_notes_were_moved_not_lost():
    history = ROOT / "docs" / "history"
    if not history.is_dir():
        pytest.skip("the public copy ships without the lane history")
    for name in ("RESULTS.md", "KIT-CHANGES.md", "OS-NOTES.md", "AUDIT.md"):
        assert (history / name).is_file(), f"docs/history/{name} missing"


def _stored_bytes() -> int:
    """What the repository stores, not what a checkout happens to write: a Windows checkout turns
    every LF into CRLF, which made the same tree read 15.8 MB there and 15.6 MB on Linux."""
    out = subprocess.run(["git", "ls-tree", "-r", "-l", "HEAD"], cwd=ROOT, capture_output=True, check=True).stdout
    return sum(int(line.split()[3]) for line in out.decode().splitlines() if line.split()[3].isdigit())


def test_tracked_tree_is_small():
    total = _stored_bytes()
    assert total < 15 * 1024 * 1024, f"tracked tree is {total / 1e6:.1f} MB"
