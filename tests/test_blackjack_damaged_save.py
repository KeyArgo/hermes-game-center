"""A blackjack save the code did not write, and the chips it must never pay twice.

One thing is here, defensive rather than reachable from the UI: a settled hand still reading phase
``"play"`` (a write cut short, a hand-edited file). The rules decided what was playable from the
phase alone, never from the hand's own ``done`` flag, and ``_settle_round`` paid every hand in the
list again whatever its ``result`` already said - so a paid hand could be hit once more and
collected a second time. ``_settle_round`` sets ``phase`` back to ``"bet"`` in the same write, so
this is not something a player meets soon. It is still wrong.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture()
def bj(tmp_path):
    spec = importlib.util.spec_from_file_location("blackjack_damaged", REPO / "blackjack" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.use_wallet(tmp_path / "wallet.json")
    return module


def paid_round(bj) -> dict:
    """A hand the table has already settled and paid, left reading phase ``"play"``."""
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **bj.fresh()}
    state["phase"] = "play"  # the round never went back to "bet"
    state["dealer"] = ["10H", "7D"]  # 17
    state["deck"] = ["2C"] * 10
    state["player_hands"] = [{
        "cards": ["KS", "9S"], "wager": 100, "base": 100, "player": 0, "doubled": False,
        "from_split": False, "split_aces": False, "done": True, "result": "win",
    }]
    state["hand"] = ["KS", "9S"]
    state["bet"] = 100
    bj._wallet().credit(200, hand=True)  # the settle that already paid this hand
    return state


def chips(bj) -> int:
    return int(bj._wallet().read()["chips"])


def test_a_settled_hand_cannot_be_played_again(bj):
    """A finished hand has no move left, whatever the phase says: 19 stands, and pays nothing."""
    state = paid_round(bj)
    before = chips(bj)
    cards = list(state["player_hands"][0]["cards"])

    said = bj.play(state, "hit")

    assert state["player_hands"][0]["cards"] == cards, "a finished hand took another card"
    assert chips(bj) == before, f"a hand already paid was played for chips again: {said}"
    assert not bj.legal(state), f"a finished hand offers moves: {bj.legal(state)}"
    assert "finished" in said.lower(), said


def test_a_round_is_never_settled_twice(bj):
    """Settling again pays nothing: every hand with a result is a hand already paid."""
    state = paid_round(bj)
    before = chips(bj)

    bj._settle_round(state)

    assert chips(bj) == before, "a settled round paid its hands a second time"
    assert state["player_hands"][0]["result"] == "win", "the result is the one that was paid"
