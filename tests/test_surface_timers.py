"""Every surface stops its clock when it closes.

The Games page is a route and the wait pane is a panel: both unmount when the person closes them,
and the status bar, the over-chat strip and every table are unmounted with them. A timer that
outlives its surface keeps reading the shelf forever — a poll with nowhere to paint, a machine
that goes on spinning — so ``tests/timers_harness.cjs`` mounts each surface with a fake clock,
runs its effects, closes it, and fails if any timer is still live.

The harness draws component by component, with React's dependencies and its cleanups, so a poll
armed three components down is counted too. A timer found alive is named by the part that armed it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_no_surface_leaves_a_timer_running_after_it_closes():
    result = subprocess.run(
        ["node", str(ROOT / "tests" / "timers_harness.cjs")],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "surface clocks: passed" in result.stdout
