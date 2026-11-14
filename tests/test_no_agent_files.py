"""The shipped package carries no agent-facing files.

A plugin in the catalog is read by people, so the repo holds what a person needs — the
code, the docs, the brand and the tests — and nothing that was written for an agent to pick up (planning
backlogs, handover notes, lane notes, briefs, or issue drafts aimed at Hermes itself).

Those live outside the repo: issue text in the maintainer's folder, planning notes in personal notes.
This test is the fence, so one does not drift back in with a commit that "just adds a note".
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# File names (case-insensitive, anywhere in the tree) that mark a note written for an agent.
BANNED_NAMES = {
    "agents.md", "claude.md", "backlog.md", "handover.md", "brief.md", "notes.md",
    "hermes-issues.md", "todo.md", "roadmap.md", "plan.md", "lane-notes.md", "next-steps.md",
}
# Directories that hold agent scratch rather than the plugin.
BANNED_DIRS = {".lanes", ".agents", "notes", "briefs", "handovers"}


def shipped_files() -> list[Path]:
    """Every tracked file, asked of git so an untracked scratch file cannot fail or hide this."""
    import subprocess

    listed = subprocess.run(["git", "-C", str(ROOT), "ls-files"], capture_output=True, text=True, check=True)
    return [ROOT / line for line in listed.stdout.splitlines() if line.strip()]


def test_no_agent_facing_file_is_shipped() -> None:
    offenders = []
    for path in shipped_files():
        relative = path.relative_to(ROOT)
        if any(part.lower() in BANNED_DIRS for part in relative.parts):
            offenders.append(f"{relative} (agent scratch directory)")
            continue
        if path.name.lower() in BANNED_NAMES:
            offenders.append(str(relative))
    assert not offenders, "the package ships agent-facing files: " + ", ".join(sorted(offenders))


def test_no_document_is_a_draft_for_another_repo() -> None:
    """Issue text for Hermes belongs in the reviewer's folder, not in a plugin's docs."""
    mapped = json.loads((ROOT / "docs" / "doc-map.json").read_text(encoding="utf-8"))
    drafts = [name for name in mapped if re.search(r"issues?|drafts?|brief", name, re.I)]
    assert not drafts, f"doc-map still lists an issue draft: {drafts}"
    for path in shipped_files():
        if path.suffix != ".md":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for line in text.splitlines():
            if re.search(r"\]\([^)]*(backlog|handover|hermes-issues|agents|claude)\.md", line, re.I):
                raise AssertionError(f"{path.relative_to(ROOT)} links to an agent-facing file: {line.strip()}")
