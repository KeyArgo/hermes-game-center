"""Two statements in the docs can be checked against the tree, so they are.

A guide that lists four checks while CI runs six is worse than no list: the reader trusts it and
misses the two that were added. The same goes for a changelog whose sections say which pass a change
belongs to - a pass written for the current release must not sit under the development history.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "tests.yml"
GUIDE = ROOT / "docs" / "TESTING.md"
CHANGELOG = ROOT / "CHANGELOG.md"

COUNT_WORDS = "one two three four five six seven eight nine ten".split()


def _ci_harnesses() -> list[str]:
    """The Node harnesses the workflow runs, in the order it runs them."""
    text = WORKFLOW.read_text(encoding="utf-8")
    return re.findall(r"^\s*node (tests/\S+\.cjs)\s*$", text, re.MULTILINE)


def test_the_testing_guide_lists_every_node_harness_ci_runs() -> None:
    harnesses = _ci_harnesses()
    assert harnesses, f"{WORKFLOW.relative_to(ROOT)} names no Node harness: has the step been renamed?"
    guide = GUIDE.read_text(encoding="utf-8")
    missing = [name for name in harnesses if name not in guide]
    assert not missing, f"{GUIDE.relative_to(ROOT)} never names {missing}, which CI runs"
    if len(harnesses) <= len(COUNT_WORDS):
        counted = f"{COUNT_WORDS[len(harnesses) - 1]} Node harnesses"
        assert counted in guide, (
            f"CI runs {len(harnesses)} Node harnesses, so the guide cannot say another number: "
            f"expected {counted!r}"
        )


def test_changelog_sections_stay_under_the_release_they_describe() -> None:
    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()
    headings = [line for line in lines if line.startswith("## ") or line.startswith("### ")]
    assert "## Development history (before 1.0.0)" in headings, "the release history has no heading"
    history = lines.index("## Development history (before 1.0.0)")
    strays = [line for line in lines[history:] if line.startswith("### ")]
    assert not strays, (
        "a section written for the current release is filed under the development history: "
        + ", ".join(strays)
    )
