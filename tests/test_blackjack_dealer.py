"""Who is dealing, and how long the dealer takes.

Two things were wrong for the person at the table:

* the felt never said who was dealing unless a machine seat was already drawn as the
  opponent chip, so a table whose dealer seat was still the plain house (the state a
  fresh table is created in) named nobody;
* an AI dealer was handed the two quiet turns of every hand - the deal check and the
  play-out - as if they were decisions. Against the built-in player that left the rules
  sitting in phase "deal" until a second request ticked it over; against a Hermes model
  it spent two model calls per hand, one of them on a check the rules answer themselves.

These tests pin the rules half: the deal is checked inside the bet, the built-in dealer
plays out inside the stand, and a Hermes-model dealer gets exactly one turn per hand and
says it is dealing while it thinks. The felt's own words are pinned in
tests/table_ui_harness.cjs.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture()
def bj(tmp_path):
    spec = importlib.util.spec_from_file_location("blackjack_dealer", REPO / "blackjack" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.use_wallet(tmp_path / "wallet.json")
    return module


def start(bj, deck: list[str], **seats) -> dict:
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0,
             **bj.fresh(), **seats}
    state["deck"] = list(reversed(deck))
    return state


def test_the_built_in_dealer_checks_the_deal_inside_the_bet(bj):
    """One bet is one request: the dealer's check of the deal is not a turn to wait for."""
    # Deal order: player, dealer, player, dealer -> 19 against 17.
    state = start(bj, ["10S", "10H", "9S", "7H"], black="local")

    bj.play(state, "bet10")

    assert state["phase"] == "play", f"a built-in dealer leaves no turn to tick: {state['phase']}"
    assert len(state["dealer"]) == 2, "the deal is already checked"
    assert {"hit", "stand"} <= set(bj.legal(state)), bj.legal(state)


def test_the_built_in_dealer_plays_out_inside_the_stand(bj):
    state = start(bj, ["10S", "10H", "9S", "7H"], black="local")
    bj.play(state, "bet10")

    bj.play(state, "stand")

    assert state["phase"] == "bet", "the round settled without a second request"
    assert (state["outcome"], state["won"]) == ("win", 10)
    assert bj._hand_value(state["dealer"]) == 17


def test_a_model_dealer_gets_one_turn_per_hand(bj):
    """The model deals the cards out; it is not asked to approve the deal as well."""
    state = start(bj, ["10S", "10H", "9S", "7H"], black="agent")

    bj.play(state, "bet10")

    assert state["phase"] == "play", f"the deal check is not a model turn: {state['phase']}"
    assert state["turn"] == "white", "the person's hand comes first"
    assert len(state["dealer"]) == 2

    bj.play(state, "stand")

    assert state["phase"] == "dealer" and state["turn"] == "black", "the model's one turn"
    assert "Hermes model is dealing" in state["note"], state["note"]

    bj.play(state, "stand")

    assert state["phase"] == "bet" and state["outcome"] == "win"


def test_the_model_dealer_is_asked_once_per_hand_and_the_computer_never(bj, tmp_path):
    """The whole table: a model dealer costs one call a hand, the built-in dealer none."""
    asked: list[str] = []

    def complete(prompt: str, max_tokens: int = 0) -> dict:
        asked.append(prompt)
        return {"move": "stand"}

    table = bj.create(tmp_path / "blackjack")
    table.command("new", player=SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False))
    me = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)
    state_path = tmp_path / "blackjack" / "state.json"

    def stack(deck: list[str]) -> None:
        state = json.loads(state_path.read_text())
        state["deck"] = list(reversed(deck))
        state_path.write_text(json.dumps(state))

    table.command("allow-ai black=local level=intermediate", complete=complete, player=me)
    stack(["10S", "10H", "9S", "7H"])
    table.command("move bet10", complete=complete, player=me)
    assert "hit" in table.picture(player=me)["legal"]
    table.command("move stand", complete=complete, player=me)
    assert asked == [], "the built-in dealer never asks the person's model for anything"

    table.command("abandon", player=me)
    table.command("allow-ai black=agent level=intermediate", complete=complete, player=me)
    asked.clear()
    stack(["10S", "10H", "9S", "7H"])
    table.command("move bet10", complete=complete, player=me)
    assert asked == [], "checking the deal is the rules' own work, not the model's"
    table.command("move stand", complete=complete, player=me)

    assert len(asked) == 1, f"one model turn a hand, not two: {len(asked)}"
    assert table.picture(player=me)["phase"] == "bet"


def test_a_model_dealer_says_it_is_dealing_while_it_thinks(bj):
    state = start(bj, ["10S", "10H", "9S", "7H"], black="agent")
    bj.play(state, "bet10")
    bj.play(state, "stand")

    pic = bj.picture(state)

    assert pic["phase"] == "dealer"
    assert pic["dealer_kind"] == "agent", "the felt reads who is dealing off the picture"
    assert "dealing" in (pic["note"] + " " + pic["dealer_note"]).lower(), pic


def test_the_picture_names_the_dealer_for_every_setup(bj):
    """A fresh table is white=human black=human; that dealer still has to be named."""
    for seats, kind in (({}, "house"), ({"black": "local"}, "local"), ({"black": "agent"}, "agent")):
        state = start(bj, ["10S", "10H", "9S", "7H"], **seats)
        pic = bj.picture(state)
        assert pic["dealer_kind"] == kind, (seats, pic["dealer_kind"])
        assert pic["dealer_line"].startswith("Dealer: "), pic["dealer_line"]
