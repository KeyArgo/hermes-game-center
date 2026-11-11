"""Double is not a split: it is one more card, then you stand, for twice the stake.

These pin the two things that were wrong after a person doubled and lost: the table never
said a double takes exactly one card (so it read like a broken hit), and the doubled stake
was left as the next hand's bet. They also pin that a settled hand cannot be doubled at
all — the move is refused, not merely hidden.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture()
def bj(tmp_path):
    spec = importlib.util.spec_from_file_location("blackjack_double", REPO / "blackjack" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.use_wallet(tmp_path / "wallet.json")
    return module


def seeded(bj, deck: list[str]) -> dict:
    """A live hand with a known shoe, listed in deal order.

    The table deals the way a real one does: your card, the dealer's up-card, your card,
    the dealer's hole card. _draw pops from the END, so the list is reversed here."""
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **bj.fresh()}
    state["deck"] = list(reversed(deck))
    return state


def chips(bj) -> int:
    return int(bj._wallet().read()["chips"])


def test_double_takes_exactly_one_card_then_stands(bj):
    # 10+5 = 15, the double card is a face card: bust, and no third decision was offered.
    state = seeded(bj, ["10H", "9S", "5C", "KD", "QD"])
    bj.play(state, "bet25")
    assert bj._hand_value(state["hand"]) == 15
    staked = chips(bj)

    bj.play(state, "double")

    assert len(state["hand"]) == 3, "a double draws one card and stops"
    assert state["outcome"] == "bust"
    assert staked - chips(bj) == 25 and chips(bj) == 9950, \
        "the double stakes the original bet again, and the doubled stake is lost"
    assert "one card only" in state["note"], f"the table must say what a double did: {state['note']}"


def test_a_doubled_win_pays_twice_the_doubled_stake(bj):
    # 10+5 = 15, double draws a 6 for 21; the dealer sits on 19.
    state = seeded(bj, ["10H", "9S", "5C", "QD", "6D"])
    bj.play(state, "bet25")
    bj.play(state, "double")

    assert bj._hand_value(state["hand"]) == 21
    assert state["outcome"] == "win"
    assert state["won"] == 50, "a 50 stake winning returns 100, so the win is 50"
    assert chips(bj) == 10050


def test_the_next_hand_bets_the_original_amount_not_the_double(bj):
    state = seeded(bj, ["10H", "9S", "5C", "QD", "6D"])
    bj.play(state, "bet25")
    bj.play(state, "double")

    assert state["phase"] == "bet"
    assert state["bet"] == 25, "the double is for one hand only"


def test_a_settled_hand_cannot_be_doubled(bj):
    state = seeded(bj, ["10H", "9S", "5C", "QD", "6D"])
    bj.play(state, "bet25")
    bj.play(state, "double")
    assert state["phase"] == "bet"
    before = chips(bj)

    answer = bj.play(state, "double")

    assert chips(bj) == before, "a refused double must not touch the stack"
    assert "not on offer" in answer, answer
    assert state["bet"] == 25
    assert len(state["hand"]) == 3, "the settled hand is not dealt another card"


def test_double_is_offered_only_on_the_first_two_cards(bj):
    state = seeded(bj, ["10H", "5C", "2D", "9S", "3H", "4H"])
    bj.play(state, "bet25")
    assert "double" in bj.legal(state)
    bj.play(state, "hit")
    assert len(state["hand"]) == 3
    assert "double" not in bj.legal(state), "after a hit a double is no longer allowed"
