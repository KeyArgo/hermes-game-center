"""The Inference Auto Play button is on the Games page, and it turns both switches.

The owner could not find the feature. "Spin while Hermes thinks" is two settings — the wallet's
autoplay switch (`POST /jackpot/autoplay`) and the Jackpot backdrop switch (`jackpot2.overchat`) —
and the shelf refuses a reply's spin while no machine reports itself visible, so either one alone
looks like a feature that does nothing. One press on the Games page now sets both.

``tests/inference_autoplay_harness.cjs`` draws the real page from the built bundle (no browser, no
route): it finds the button above the Play shelf, presses it, and reads the POST it made and the
switch it wrote; presses it again and reads both off; makes the shelf refuse and reads the button back
in its real state with a one-line note; proves the button is on only while BOTH switches are; pins the
backdrop's room (60% of a 1000 px window is 600 px), that 100% still draws the 320 px copy, that 160%
draws a taller one, and that Small / Medium / Large write 0.75 / 1 / 1.6.

The words themselves are pinned in ``tests/test_backdrop_wording.py``.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "inference_autoplay_harness.cjs"


def test_the_button_and_the_backdrop_are_drawn_and_pressed():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed, so the bundle cannot be drawn")
    assert SCRIPT.is_file(), "tests/inference_autoplay_harness.cjs is missing"
    result = subprocess.run([node, str(SCRIPT)], cwd=ROOT, capture_output=True, text=True, timeout=120)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "DONE" in output, output
    # A run that skipped a beat is not a pass.
    for beat in (
        "the home button turns both switches, follows them, and stays honest",
        "the backdrop may grow to 60% of the window, and 100% is unchanged",
        "Small, Medium and Large size the backdrop in one press",
    ):
        assert beat in output, f"the harness never reported '{beat}':\n{output}"
