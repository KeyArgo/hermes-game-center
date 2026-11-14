"""The Play while you code pane fills the frame it is given, measured in a real browser.

The pane opens at 720 px and the divider drags it from 300 px to 1200 px, but its pieces were laid out
for ~360 px: the game tiles stayed two small columns and the board kept a width of its own. Two checks
cover the fix, and neither can stand in for the other:

* ``tests/table_ui_harness.cjs`` (``paneFillContract``) reads what a render hands back - the pane root
  declares the container, the wide rules exist and target the pane's own classes, and nothing in the
  pane caps its own width in pixels;
* this test runs ``tests/pane_fill_checks.mjs``, which lays the real module out in headless Chrome at
  300 px, 320 px and 1000 px and measures it: the lobby's used width is >= 90% of the pane, nothing
  scrolls sideways, the tiles use the width, and the board fills its column with the turn beside it.

It skips where the pieces are missing - no node, no Chrome, or no uvicorn for the QA server - with the
missing piece named, and fails everywhere else.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "pane_fill_checks.mjs"


def _chrome() -> str:
    """The browser to drive, or "" when this machine has none."""
    configured = os.environ.get("CHROME_BIN", "").strip()
    if configured and Path(configured).exists():
        return configured
    for candidate in ("/opt/google/chrome/chrome", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(candidate) or (candidate if Path(candidate).exists() else "")
        if found:
            return found
    return ""


def test_the_pane_fills_its_frame_at_320_and_1000_px() -> None:
    """The pane, laid out for real at both widths: it must fill the frame at each."""
    node, chrome = shutil.which("node") or "", _chrome()
    if not node:
        pytest.skip("node is not installed, so the browser check cannot run")
    if not chrome:
        pytest.skip("no Chrome/Chromium binary, so the browser check cannot run (CHROME_BIN sets one)")
    if importlib.util.find_spec("uvicorn") is None:
        pytest.skip("the QA server needs uvicorn, which is not installed here")
    assert SCRIPT.is_file(), "tests/pane_fill_checks.mjs is missing"
    result = subprocess.run(
        [node, str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=420,
        # The check starts the QA server; hand it the interpreter this test runs under, so a
        # machine without a `python3` on PATH (Windows) still starts it.
        env={**os.environ, "CHROME_BIN": chrome, "PYTHON_BIN": sys.executable},
    )
    output = result.stdout + result.stderr
    if result.returncode == 77:
        first = output.strip().splitlines()
        pytest.skip(f"the browser check could not run here: {first[0] if first else 'no output'}")
    assert result.returncode == 0, output
    assert "all pane fill checks passed" in output, output
    # Each width is reported by name: a run that measured only one of them is not a pass.
    for beat in (
        "the game view fills the pane at 320 px",
        "the game view fills the pane at 1000 px",
        "the lobby fills the pane at 320 px",
        "the lobby fills the pane at 1000 px",
        "nothing in the lobby scrolls sideways at 320 px",
        "nothing in the lobby scrolls sideways at 1000 px",
        "the lobby stacks in one column at 320 px",
        "the lobby sits in two columns at 720 px",
        "the sections sit side by side at 720 px",
        "the lobby sits in two columns at 1000 px",
        "the game tiles use the width at 320 px",
        "the game tiles use the width at 1000 px",
        "the board fills its column at 320 px",
        "the board fills its column at 1000 px",
        "the turn sits beside the board at 1000 px",
        "the turn sits under the board at 320 px",
    ):
        assert beat in output, f"the browser run never reported '{beat}':\n{output}"
