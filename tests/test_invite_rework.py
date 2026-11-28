"""An invite reaches the person in the side pane, and the pane plays with people through the Hall.

``tests/invite_rework_harness.cjs`` boots the built bundle with a virtual clock and a small hook
runtime that keeps one set of hooks per mounted component, so the pane and both chrome bells can be
on screen together and the one shared /online/hall poll can be counted read by read. Each check is
reported on its own line (PASS or FAIL) and named here, so a failure says which promise broke.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "tests" / "invite_rework_harness.cjs"
CHECKS = [
    "paneReceivesInviteFromColdStart",
    "titlebarFallbackWhenStatusHidden",
    "notifyOncePerRequest",
    "onePollAndStopsOnDispose",
    "panePeopleUsesHallEndToEnd",
    "panePollWaitsAndSlowsWhenHidden",
    "noticeWhileSearchingOrWindowOpen",
    "hallAnswerClearsBell",
    "lookingTextUnderSearch",
    "paneKeepsLayoutOnFailedRead",
    "soundSwitchesAgree",
    "inviteNoteBelongsToItsRequest",
    "replacementInvitePauses",
    "seekerOpensAcceptedSeat",
]


@pytest.mark.parametrize("check", CHECKS)
def test_invite_rework(check):
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    result = subprocess.run([node, str(SCRIPT), check], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0 and f"PASS {check}" in result.stdout, result.stdout + result.stderr
