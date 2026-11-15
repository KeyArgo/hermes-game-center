"""The UI harness passes on a Windows checkout too, not only on Linux.

Windows CI failed (run 43696878077) because a harness check measured a fixed 700-character window
of the bundle, and git on Windows writes CRLF line endings: one extra character a line pushed the
text past the window. This runs the same harness against a CRLF copy of the bundle and harness, so
the next check that counts characters is caught on any machine, not only by Windows CI.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


def _crlf(source: Path, target: Path) -> None:
    text = source.read_text(encoding="utf-8").replace("\r\n", "\n")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_the_table_ui_harness_passes_on_a_crlf_checkout(tmp_path):
    _crlf(REPO / "desktop" / "plugin.js", tmp_path / "desktop" / "plugin.js")
    _crlf(REPO / "tests" / "table_ui_harness.cjs", tmp_path / "tests" / "table_ui_harness.cjs")
    result = subprocess.run([NODE, str(tmp_path / "tests" / "table_ui_harness.cjs")],
                            capture_output=True, text=True, cwd=tmp_path, timeout=600)
    assert result.returncode == 0, (result.stdout + result.stderr)[-3000:]
