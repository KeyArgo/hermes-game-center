"""Who is dealing, and how long the dealer takes.

Two things were wrong for the person at the table:

* the felt never said who was dealing unless a machine seat was already drawn as the
  opponent chip, so a table whose dealer seat was still the plain house (the state a
  fresh table is created in) named nobody;
* an AI dealer was handed the two quiet turns of every hand - the deal check and the
  play-out - as if they were decisions. Against the built-in player that left the rules
  sitting in phase "deal" until a second request ticked it over; against a Hermes model
  it spent two model calls per hand, one of them on a check the rules answer themselves.

These tests pin the rules half: the deal is checked inside the bet, and the dealer's cards
are played out inside the stand. The dealer has no choices in blackjack - the house rules
are the whole of its play - so nobody asks a model for the dealer's turn, whatever is
seated in that seat, and no refusal is ever recorded for it. The felt's own words are
pinned in tests/table_ui_harness.cjs.
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


def test_a_model_dealer_leaves_no_turn_to_wait_for(bj):
    """The dealer has no decisions, so a model in that seat never takes a turn of its own."""
    state = start(bj, ["10S", "10H", "9S", "7H"], black="agent")

    bj.play(state, "bet10")

    assert state["phase"] == "play", f"the deal check is the rules' own work: {state['phase']}"
    assert state["turn"] == "white", "the person's hand comes first"
    assert len(state["dealer"]) == 2

    bj.play(state, "stand")

    assert state["phase"] == "bet", f"the dealer's cards are played out inside the stand: {state['phase']}"
    assert state["turn"] == "white", "no seat is left waiting on a dealer turn"
    assert (state["outcome"], state["won"]) == ("win", 10)
    assert bj._hand_value(state["dealer"]) == 17


def test_a_model_dealer_is_never_asked_for_a_turn(bj, tmp_path):
    """The whole table: the dealer's seat asks the model nothing and records no refusal.

    A model in the dealer's seat used to be handed the play-out as if it were a decision:
    two calls a hand, and a model that answered anything but "stand" wrote a false
    "Referee said no" into the ledger for a seat with nothing to decide.
    """
    asked: list[str] = []

    def complete(prompt: str, max_tokens: int = 0) -> dict:
        asked.append(prompt)
        # The dealer's seat offers exactly one move, so any model answer is the wrong one.
        return {"move": "hit"}

    table = bj.create(tmp_path / "blackjack")
    me = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)
    table.command("new", player=me)
    state_path = tmp_path / "blackjack" / "state.json"

    def stack(deck: list[str]) -> None:
        state = json.loads(state_path.read_text())
        state["deck"] = list(reversed(deck))
        state_path.write_text(json.dumps(state))

    table.command("allow-ai black=agent level=intermediate", complete=complete, player=me)
    stack(["10S", "10H", "9S", "7H"])
    table.command("move bet10", complete=complete, player=me)
    said = table.command("move stand", complete=complete, player=me)

    state = json.loads(state_path.read_text())
    assert asked == [], f"the dealer's seat has no decisions to ask about: {asked[:1]}"
    assert not state.get("refusals"), f"no refusal belongs to a dealer turn: {state.get('refusals')}"
    assert state["phase"] == "bet" and state["outcome"] == "win"
    assert "refused" not in said.lower(), said


def test_the_model_dealer_line_says_it_follows_the_house_rules(bj):
    """The felt still names the model, and says the truth about it: no decisions, no wait."""
    state = start(bj, ["10S", "10H", "9S", "7H"], black="agent")
    bj.play(state, "bet10")
    bj.play(state, "stand")

    pic = bj.picture(state)

    assert pic["dealer_kind"] == "agent", "the felt reads who is dealing off the picture"
    assert pic["dealer_line"] == "Dealer: Hermes model (follows house rules, instant)", pic["dealer_line"]
    assert pic["dealer_note"] == "", f"the dealer never sits thinking: {pic['dealer_note']}"
    assert "dealing" not in (pic["note"] + " " + pic["dealer_note"]).lower(), pic


def test_the_picture_names_the_dealer_for_every_setup(bj):
    """A fresh table is white=human black=human; that dealer still has to be named."""
    for seats, kind in (({}, "house"), ({"black": "local"}, "local"), ({"black": "agent"}, "agent")):
        state = start(bj, ["10S", "10H", "9S", "7H"], **seats)
        pic = bj.picture(state)
        assert pic["dealer_kind"] == kind, (seats, pic["dealer_kind"])
        assert pic["dealer_line"].startswith("Dealer: "), pic["dealer_line"]
