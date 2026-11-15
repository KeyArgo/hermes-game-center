"""A blackjack save the code did not write, and the chips it must never pay twice.

Two things are here, both defensive rather than reachable from the UI:

* a settled hand still reading phase ``"play"`` (a write cut short, a hand-edited file). The rules
  decided what was playable from the phase alone, never from the hand's own ``done`` flag, and
  ``_settle_round`` paid every hand in the list again whatever its ``result`` already said - so a
  paid hand could be hit once more and collected a second time;
* the shoe. It is shuffled from the table's own seed, so replaying a log re-deals the same cards.
  A round that emptied its shoe rebuilt it from ``f"{shoe}:{hands}"``, and ``hands`` only moves at
  settlement - so a rebuild inside a round reproduced the hand the round started with, from the
  same end of the same order, and dealt a card twice.

``_settle_round`` sets ``phase`` back to ``"bet"`` in the same write, and a round only rebuilds a
shoe it started with, so neither is something a player will meet soon. Both are still wrong.
"""

from __future__ import annotations

import collections
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


def test_a_fresh_shoe_is_dealt_inside_a_round_before_any_card_repeats(bj):
    """A shoe rebuilt inside a round is a new shuffle, not the hand the round started with.

    The old seed was ``f"{shoe}:{hands}"``, and ``hands`` only moves at settlement, so the second
    shoe of a round was the first one exactly: same cards, same order, dealt again.
    """
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **bj.fresh()}
    state["deck"] = []
    state["hands"] = 0

    first_shoe = [bj._draw(state) for _ in range(52)]  # one whole shoe, then the rebuild
    second_shoe = [bj._draw(state) for _ in range(52)]

    assert sorted(first_shoe) == sorted(second_shoe), "a shoe is one whole deck"
    assert second_shoe != first_shoe, "the rebuilt shoe repeated the same cards in the same order"
    repeated = [card for card, count in collections.Counter(first_shoe + second_shoe).items()
                if count > 1]
    assert len(repeated) == 52, "the two shoes are different shuffles of the same deck"
    assert int(state["shoes"]) == 2, "the rebuild is counted in the state: " + str(state.get("shoes"))
