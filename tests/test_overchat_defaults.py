"""Both see-through machines are off until somebody asks for them.

Each switch lives somewhere different — the cabinet's in localStorage, Jackpot v2's on the shelf's plugin
storage — and each can fail differently: a key that is not there, an empty string, a store that refuses
reads, a host with no store at all. Every one of those has to read as "off", because a see-through machine
over the conversation that nobody asked for is the worst version of this feature.

tests/overchat_defaults.mjs loads the built bundle once per world and answers for both. It skips where node
is missing, which is the only piece it needs.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "overchat_defaults.mjs"


def test_both_switches_read_off_in_every_storage_world():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed, so the bundle cannot be loaded")
    assert SCRIPT.is_file(), "tests/overchat_defaults.mjs is missing"
    result = subprocess.run(
        [node, str(SCRIPT)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "all over-chat default checks passed" in output, output
    # A run that never reached the two machines is not a pass.
    for beat in ("the cabinet is off", "Jackpot v2 is off", "draws nothing while both switches are off"):
        assert beat in output, f"the defaults run never reported '{beat}':\n{output}"
