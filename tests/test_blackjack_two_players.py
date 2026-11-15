"""Two people on one screen: two seats against the dealer, and two separate chip stacks.

The owner asked for a way to sit down opposite a human as well as against the computer or
their own Hermes model, and chose "a second player on the same screen". So this table has
one dealer and two people:

* both bet first (Player 1, then Player 2), then the two hands are dealt;
* Player 1 plays every hand of their round (split and double included), then Player 2,
  and only then does the dealer play - once, for both;
* each hand settles on its own, against the person who staked it;
* Player 2's chips are a table-only stack kept in the table state. The Jackpot wallet is
  never debited or credited for a guest, so a friend at the keyboard cannot spend or win
  the owner's chips.

Deal order for two people is Player 1, Player 2, dealer, twice; the whole deck is stacked
in deal order and ``_draw`` pops from the end, so the helper reverses it.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parent.parent
START = 10_000
GUEST_START = 10_000
ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)


@pytest.fixture()
def bj(tmp_path):
    spec = importlib.util.spec_from_file_location("blackjack_two", REPO / "blackjack" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.use_wallet(tmp_path / "wallet.json")
    return module


def start(bj, deck: list[str], **options) -> dict:
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0,
             **bj.fresh()}
    state["deck"] = list(reversed(deck))
    if options:
        refused = bj.setup(state, options)
        assert refused == "", refused
    return state


def chips(bj) -> int:
    return int(bj._wallet().read()["chips"])


def guest_chips(bj, state) -> int:
    return int(bj._guest(state)["chips"])


def test_a_second_person_brings_their_own_table_stack(bj):
    state = start(bj, [], players="2")

    assert state["players"] == 2
    assert guest_chips(bj, state) == GUEST_START, "a guest's stack lives on the table"
    assert chips(bj) == START, "and the Jackpot wallet is untouched by sitting down"


def test_a_third_person_is_refused_in_words(bj):
    state = {"status": "active", **bj.fresh()}

    refused = bj.setup(state, {"players": "3"})

    assert refused.startswith("Usage:") and "one or two people" in refused, refused
    assert state["players"] == 1


def test_both_people_bet_before_a_card_is_dealt(bj):
    # Deal order: P1, P2, dealer, P1, P2, dealer. P1 19, P2 15, dealer 17.
    state = start(bj, ["10S", "8S", "10H", "9S", "7S", "7H"], players="2")

    bj.play(state, "bet10")

    assert state["phase"] == "bet", "the deal waits for the second bet"
    assert state["player_hands"] == [] and state["dealer"] == []
    assert state["betting"] == 1
    assert chips(bj) == START - 10, "Player 1's bet comes from the wallet"
    assert guest_chips(bj, state) == GUEST_START, "and Player 2 has not bet yet"

    bj.play(state, "bet10")

    assert state["phase"] == "play"
    assert [hand["cards"] for hand in state["player_hands"]] == [["10S", "9S"], ["8S", "7S"]]
    assert [hand["player"] for hand in state["player_hands"]] == [0, 1]
    assert state["dealer"] == ["10H", "7H"]
    assert guest_chips(bj, state) == GUEST_START - 10


def test_turn_order_is_player_one_then_player_two_then_the_dealer(bj):
    state = start(bj, ["10S", "8S", "10H", "9S", "7S", "7H"], players="2")
    bj.play(state, "bet10")
    bj.play(state, "bet10")

    assert state["active_hand"] == 0, "Player 1 plays first"
    bj.play(state, "stand")
    assert state["active_hand"] == 1, "then Player 2"
    assert len(state["dealer"]) == 2, "and the dealer has not drawn a card yet"

    bj.play(state, "stand")

    assert state["phase"] == "bet"
    assert bj._hand_value(state["dealer"]) == 17, "the dealer plays once, after both"

    pic = bj.picture(state)
    assert [player["seat"] for player in pic["players"]] == [0, 1]
    assert [hand["seat"] for hand in pic["player_hands"]] == [0, 1]


def test_each_person_settles_their_own_hand(bj):
    state = start(bj, ["10S", "8S", "10H", "9S", "7S", "7H"], players="2")
    bj.play(state, "bet10")
    bj.play(state, "bet10")
    bj.play(state, "stand")
    bj.play(state, "stand")

    pic = bj.picture(state)

    assert [hand["result"] for hand in pic["player_hands"]] == ["win", "lose"]
    assert pic["players"][0]["outcome"] == "win" and pic["players"][0]["net"] == 10
    assert pic["players"][1]["outcome"] == "lose" and pic["players"][1]["net"] == -10
    assert pic["won"] == 10, "the wallet's own net is Player 1's"


def test_a_guests_winnings_never_reach_the_wallet(bj):
    # P1 10+9 = 19 loses to the dealer's 20; P2 has A+K: a natural, paid 3:2 on 10.
    state = start(bj, ["10S", "AS", "10H", "9S", "KH", "QC"], players="2")
    bj.play(state, "bet10")
    bj.play(state, "bet10")

    assert state["active_hand"] == 0, "the other person still plays their own hand"
    bj.play(state, "stand")

    assert state["phase"] == "bet", "a natural in one seat does not end the other person's hand"
    assert chips(bj) == START - 10, "the guest's 3:2 payout never lands in the wallet"
    assert guest_chips(bj, state) == GUEST_START - 10 + 25
    assert bj.picture(state)["players"][1]["outcome"] == "blackjack"


def test_player_two_can_split_and_pays_for_it_from_their_own_stack(bj):
    # P1 19 stands and wins. P2 8/8 splits into 18 (wins) and 11, hit a 2 for 13 (loses).
    state = start(bj, ["10S", "8D", "10H", "9S", "8C", "7H", "KD", "3C", "2C"], players="2")
    bj.play(state, "bet10")
    bj.play(state, "bet10")
    bj.play(state, "stand")

    assert "split" in bj.legal(state), bj.legal(state)
    bj.play(state, "split")

    assert guest_chips(bj, state) == GUEST_START - 20, "the split's second wager is the guest's"
    assert chips(bj) == START - 10, "and never the owner's"
    assert [hand["cards"] for hand in state["player_hands"]] == [["10S", "9S"], ["8D", "KD"], ["8C", "3C"]]
    assert all(hand["player"] == 1 for hand in state["player_hands"][1:])

    bj.play(state, "stand")
    bj.play(state, "hit")
    bj.play(state, "stand")

    assert state["phase"] == "bet"
    assert [hand["result"] for hand in state["player_hands"]] == ["win", "win", "lose"]
    assert guest_chips(bj, state) == GUEST_START, "one hand won and one lost at 10 each"
    assert chips(bj) == START + 10, "the owner's own hand won and nothing else moved"


def test_a_guest_never_spends_the_wallets_chips_across_a_whole_round(bj):
    state = start(bj, ["10S", "8S", "10H", "9S", "7S", "7H"], players="2")
    before = chips(bj)

    bj.play(state, "bet10")
    assert chips(bj) == before - 10, "only Player 1's stake left the wallet"
    bj.play(state, "bet10")
    bj.play(state, "stand")
    bj.play(state, "stand")

    # P1 won 10 and was paid 20 back; the guest's loss never touched the wallet either way.
    assert chips(bj) == before + 10


def test_a_broke_guest_is_offered_a_table_top_up_not_the_wallet(bj):
    state = start(bj, ["10S", "8S", "10H", "9S", "7S", "7H"], players="2")
    bj.play(state, "bet10")
    bj._guest(state)["chips"] = 5

    assert bj.legal(state) == ["topup"], "the guest's stack, not the wallet, decides the bet"
    note = bj.play(state, "topup")

    assert "table chips" in note, note
    assert guest_chips(bj, state) == GUEST_START
    assert chips(bj) == START - 10, "the owner's wallet is not refilled for a guest"


def test_a_single_player_table_is_unchanged(bj):
    state = start(bj, ["10S", "10H", "9S", "7H"])
    bj.play(state, "bet10")

    pic = bj.picture(state)

    assert pic["table_players"] == 1, "one person at the table unless a second sits down"
    assert len(pic["players"]) == 1 and pic["players"][0]["wallet"] is True
    assert [hand["seat"] for hand in pic["player_hands"]] == [0]
    assert pic["two_players"] is True, "the table can seat a second person, it just has not"


def test_an_old_hand_record_belongs_to_player_one(bj):
    state = {
        "turn": "white", "status": "active", "winner": "", "moves": [], "plies": 1,
        "shoe": "legacy", "phase": "play", "hand": ["10S", "9S"], "dealer": ["10H", "7H"],
        "deck": ["2C"], "bet": 10, "outcome": "", "note": "",
        "player_hands": [{"cards": ["10S", "9S"], "wager": 10, "base": 10, "done": False,
                          "result": "", "doubled": False, "from_split": False, "split_aces": False}],
    }

    pic = bj.picture(state)

    assert pic["table_players"] == 1
    assert pic["player_hands"][0]["seat"] == 0
    bj.play(state, "stand")
    assert state["outcome"] == "win", "a save written before two players still plays"


def test_the_second_person_sits_down_through_one_game_center_line(bj, tmp_path):
    table = bj.create(tmp_path / "blackjack")
    table.command("new", player=ME)

    answer = table.command("allow-ai black=local players=2", player=ME)

    pic = table.picture(player=ME)
    assert pic["table_players"] == 2, answer
    assert [player["name"] for player in pic["players"]] == ["Player 1", "Player 2"]
    assert pic["players"][1]["wallet"] is False and pic["players"][1]["chips"] == GUEST_START
    # The refusal for a third person is a refusal the page can report, not a silent deal.
    refused = table.command("abandon", player=ME)
    assert refused
    answer = table.command("allow-ai black=local players=3", player=ME)
    assert answer.startswith("Usage:"), answer
    assert table.picture(player=ME)["table_players"] == 1

    # A whole round through the table: two bets, two stands, both stacks settle.
    table.command("allow-ai black=local players=2", player=ME)
    state_path = tmp_path / "blackjack" / "state.json"
    state = json.loads(state_path.read_text())
    state["deck"] = list(reversed(["10S", "8S", "10H", "9S", "7S", "7H"]))
    state_path.write_text(json.dumps(state))
    assert "Player 2 to bet" in table.command("move bet10", player=ME)
    assert "Bets in" in table.command("move bet10", player=ME)
    table.command("move stand", player=ME)
    table.command("move stand", player=ME)
    saved = json.loads(state_path.read_text())
    assert saved["phase"] == "bet" and saved["guest"]["chips"] == GUEST_START - 10
    assert saved["players"] == 2
