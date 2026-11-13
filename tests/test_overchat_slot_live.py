"""The over-chat strip, in a real React render: off -> on, and a resize after the switch.

Quality review, 2026-11-13: the strip attached its ResizeObserver in an effect with `[]` deps, so a mount
with both switches off never attached it, and turning a machine on afterwards rendered it at width 0 for
good. No stubbed-hooks harness can see that — they call components and read the tree, so a ref filled in
by hand is always "there". It takes a real commit, so this test runs tests/overchat_slot_live.mjs, which
drives the built bundle in headless Chrome against the QA server:

  both switches off at mount -> no strip; click the cabinet's own switch -> the copy appears inside the
  composer slot at a visible size; resize narrower than the height cap -> it re-measures; turn it off ->
  both go.

Chrome is not installed on the CI runner, so this skips there with a reason (the same way the other
browser checks are opt-in). Where Chrome exists it is part of the suite and fails loudly.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "overchat_slot_live.mjs"


def _chrome() -> str | None:
    configured = os.environ.get("CHROME_BIN", "").strip()
    if configured and Path(configured).exists():
        return configured
    for candidate in ("/opt/google/chrome/chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(candidate) or (candidate if Path(candidate).exists() else None)
        if found:
            return found
    return None


def _node() -> str | None:
    return shutil.which("node")


def test_the_machine_appears_when_the_switch_is_turned_on_live():
    """A real render, a real click and a real resize — not a source scan."""
    node, chrome = _node(), _chrome()
    if node is None:
        pytest.skip("node is not installed, so the browser check cannot run")
    if chrome is None:
        pytest.skip("no Chrome/Chromium binary, so the browser check cannot run (CHROME_BIN sets one)")
    assert SCRIPT.is_file(), "tests/overchat_slot_live.mjs is missing"
    result = subprocess.run(
        [node, str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=420,
        env={**os.environ, "CHROME_BIN": chrome},
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "all over-chat live checks passed" in output, output
    # The three beats the review asked for are in that output by name; a run that skipped them is not a pass.
    for beat in ("both switches off at mount", "turning it on draws the copy",
                 "a narrower window re-measures the copy", "turning it off takes the copy"):
        assert beat in output, f"the live run never reported '{beat}':\n{output}"
