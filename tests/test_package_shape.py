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
    "CHANGELOG.md",  # root by convention: the 1.0.0 identity lane put it where people look
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


def test_lane_notes_were_moved_not_lost():
    history = ROOT / "docs" / "history"
    if not history.is_dir():
        pytest.skip("the public copy ships without the lane history")
    for name in ("RESULTS.md", "KIT-CHANGES.md", "OS-NOTES.md", "AUDIT.md"):
        assert (history / name).is_file(), f"docs/history/{name} missing"


def test_tracked_tree_is_small():
    total = sum((ROOT / name).stat().st_size for name in _tracked() if (ROOT / name).is_file())
    assert total < 15 * 1024 * 1024, f"tracked tree is {total / 1e6:.1f} MB"
