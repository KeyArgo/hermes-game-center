"""Split, and the multi-hand round it makes: two hands, each with its own wager and result.

A dealt A/A offered nothing at this table, because Split had never been written: ``legal()``
knew hit, stand and double and nothing else, and ``_settle`` scored one hand. These tests pin
the whole round - the move, the extra wager, split aces taking one card each, a split 21
paying even money rather than 3:2, the dealer waiting for every hand, and each hand settling
on its own - plus the double that was already right (one card, then that hand stands).

Every deck is stacked in deal order: player, dealer, player, dealer, then one card per hit or
split. ``_draw`` pops from the end of the list, so the helper reverses it.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
START = 10_000


@pytest.fixture()
def bj(tmp_path):
    spec = importlib.util.spec_from_file_location("blackjack_split", REPO / "blackjack" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.use_wallet(tmp_path / "wallet.json")
    return module


def start(bj, deck: list[str]) -> dict:
    state = {"turn": "white", "status": "active", "winner": "", "moves": [], "plies": 0, **bj.fresh()}
    state["deck"] = list(reversed(deck))
    return state


def chips(bj) -> int:
    return int(bj._wallet().read()["chips"])


def test_the_grammar_knows_split(bj):
    assert bj.show(bj.parse(["split"])) == "split"
    assert bj.explain("split", {}) != bj.explain("fold", {})


def test_a_pair_of_aces_offers_split_and_double(bj):
    state = start(bj, ["AS", "9H", "AD", "8H", "KC", "5C"])
    bj.play(state, "bet10")

    assert "split" in bj.legal(state), bj.legal(state)
    assert "double" in bj.legal(state), "a pair can still be doubled instead"


def test_a_pair_of_eights_offers_split(bj):
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C"])
    bj.play(state, "bet10")

    assert "split" in bj.legal(state)


def test_two_different_ranks_are_not_a_pair_unless_the_flag_is_on(bj):
    state = start(bj, ["KS", "9H", "QD", "8H", "2C", "3C"])
    bj.play(state, "bet10")

    assert "split" not in bj.legal(state), "a king and a queen are both ten, not a pair"
    bj.SPLIT_EQUAL_VALUE = True
    try:
        assert "split" in bj.legal(state), "equal value is a rule flag, and it is off by default"
    finally:
        bj.SPLIT_EQUAL_VALUE = False


def test_split_makes_exactly_two_hands_with_a_card_each(bj):
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C"])
    bj.play(state, "bet10")

    bj.play(state, "split")

    hands = state["player_hands"]
    assert len(hands) == 2, hands
    assert [hand["cards"] for hand in hands] == [["8S", "KD"], ["8D", "3C"]]
    assert all(hand["from_split"] for hand in hands)
    assert state["active_hand"] == 0, "the first hand is played first"


def test_split_deducts_the_extra_wager(bj):
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C"])
    bj.play(state, "bet10")
    assert chips(bj) == START - 10

    bj.play(state, "split")

    assert chips(bj) == START - 20, "a split puts a second bet of the same size on the felt"
    assert [hand["wager"] for hand in state["player_hands"]] == [10, 10]


def test_split_aces_take_one_card_each_and_finish(bj):
    state = start(bj, ["AS", "9H", "AD", "8H", "KC", "5C"])
    bj.play(state, "bet10")

    bj.play(state, "split")

    hands = state["player_hands"]
    assert [len(hand["cards"]) for hand in hands] == [2, 2], "exactly one card each, no hits"
    assert all(hand["done"] for hand in hands) and state["phase"] == "bet", \
        "split aces are finished as soon as they have their card"


def test_a_split_ace_and_ten_is_twenty_one_not_a_blackjack(bj):
    state = start(bj, ["AS", "9H", "AD", "8H", "KC", "5C"])
    bj.play(state, "bet10")

    bj.play(state, "split")

    win, lose = state["player_hands"]
    assert bj._hand_value(win["cards"]) == 21
    assert win["result"] == "win" and bj.picture(state)["player_hands"][0]["blackjack"] is False, \
        "21 after a split is not a natural"
    assert lose["result"] == "lose"
    assert state["won"] == 0 and chips(bj) == START
    assert state["outcome"] == "mixed"
    # 3:2 would have paid 25 on the 10 stake and left 10,005 chips; even money left 10,000.
    assert chips(bj) != START + 5


def test_double_draws_exactly_one_card_and_ends_that_hand(bj):
    # 5+5 = 10; the double card is a 6 for 16, the dealer sits on 17.
    state = start(bj, ["5S", "9H", "5D", "8H", "6C"])
    bj.play(state, "bet10")
    assert "double" in bj.legal(state), "a pair can be doubled as it stands"

    bj.play(state, "double")

    assert len(state["player_hands"][0]["cards"]) == 3, "a double draws one card and stops"
    assert state["phase"] == "bet", "and the hand is finished"
    assert state["won"] == -20, "both stakes of the doubled hand are lost"
    assert chips(bj) == START - 20


def test_no_double_after_a_hit(bj):
    state = start(bj, ["10H", "5C", "2D", "9S", "3H", "4H"])
    bj.play(state, "bet10")
    assert "double" in bj.legal(state)

    bj.play(state, "hit")

    assert len(state["player_hands"][0]["cards"]) == 3
    assert "double" not in bj.legal(state), "double is for the first two cards only"


def test_double_and_split_are_not_offered_without_the_chips(bj):
    bj._wallet().debit(chips(bj) - 15)
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C"])
    bj.play(state, "bet10")
    assert chips(bj) == 5, "the bet itself was affordable"

    offered = bj.legal(state)

    assert offered == ["hit", "stand"], offered
    assert "double" not in offered and "split" not in offered


def test_each_split_hand_settles_on_its_own(bj):
    # Hand 1: 8+K = 18 (wins). Hand 2: 8+3 = 11, hit a 2 for 13 (loses). Dealer sits on 17.
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C", "2C"])
    bj.play(state, "bet10")
    bj.play(state, "split")

    bj.play(state, "stand")
    bj.play(state, "hit")
    bj.play(state, "stand")

    hands = state["player_hands"]
    assert [hand["result"] for hand in hands] == ["win", "lose"]
    assert state["outcome"] == "mixed"
    assert state["won"] == 0, "one stake won and one lost"
    assert chips(bj) == START


def test_the_dealer_plays_only_after_every_hand_is_finished(bj):
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C", "2C"])
    bj.play(state, "bet10")
    bj.play(state, "split")

    bj.play(state, "stand")

    assert state["phase"] == "play", "the second hand is still to play"
    assert len(state["dealer"]) == 2, "the dealer has not drawn while a hand is unfinished"
    assert state["active_hand"] == 1

    bj.play(state, "hit")
    bj.play(state, "stand")

    assert state["phase"] == "bet"
    assert bj._hand_value(state["dealer"]) >= 17, "and then the dealer plays out"


def test_a_round_where_every_hand_busts_never_reaches_the_dealer(bj):
    # Both hands are 16 and both hit a ten: 26. The dealer is on 16 and would have to draw.
    state = start(bj, ["6S", "10H", "6D", "6H", "KD", "QC", "10D", "JD"])
    bj.play(state, "bet10")
    bj.play(state, "split")

    bj.play(state, "hit")
    bj.play(state, "hit")

    assert [hand["result"] for hand in state["player_hands"]] == ["bust", "bust"]
    assert len(state["dealer"]) == 2, "there is nothing left to beat, so the dealer stays"
    assert state["outcome"] == "bust" and state["won"] == -20
    assert chips(bj) == START - 20


def test_a_split_hand_that_pushes_returns_its_stake(bj):
    # Both hands total 20 against the dealer's 20.
    state = start(bj, ["10S", "QH", "10D", "10C", "JS", "JC"])
    bj.play(state, "bet10")
    bj.play(state, "split")

    bj.play(state, "stand")
    bj.play(state, "stand")

    assert [hand["result"] for hand in state["player_hands"]] == ["push", "push"]
    assert state["outcome"] == "push" and state["won"] == 0
    assert chips(bj) == START, "a push returns the stake, so nothing is lost"


def test_picture_shows_each_hand_wager_and_the_net_result(bj):
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C", "2C"])
    bj.play(state, "bet10")
    bj.play(state, "split")
    bj.play(state, "stand")
    bj.play(state, "hit")
    bj.play(state, "stand")

    pic = bj.picture(state)

    assert pic["total_wager"] == 20 and pic["bet"] == 10, "the round's wagers, and the next bet"
    assert [hand["wager"] for hand in pic["player_hands"]] == [10, 10]
    assert [hand["result"] for hand in pic["player_hands"]] == ["win", "lose"]
    assert pic["won"] == 0, "the net result is the sum of the hands"
    assert pic["active_hand"] == 0 and not any(hand["active"] for hand in pic["player_hands"])


def test_picture_shows_a_doubled_hands_original_bet_and_total_wager(bj):
    # 10+5 = 15, double draws a 6 for 21; the dealer sits on 19.
    state = start(bj, ["10H", "9S", "5C", "QD", "6D"])
    bj.play(state, "bet25")
    bj.play(state, "double")

    pic = bj.picture(state)
    hand = pic["player_hands"][0]

    assert hand["doubled"] is True
    assert hand["original"] == 25 and hand["wager"] == 50
    assert pic["total_wager"] == 50
    assert pic["bet"] == 25, "the next hand does not start at the doubled stake"
    assert pic["won"] == 50


def test_a_hand_still_shows_which_hand_is_being_played(bj):
    state = start(bj, ["8S", "9H", "8D", "8H", "KD", "3C", "2C"])
    bj.play(state, "bet10")
    bj.play(state, "split")

    pic = bj.picture(state)

    assert pic["active_hand"] == 0
    assert [hand["active"] for hand in pic["player_hands"]] == [True, False]
    bj.play(state, "stand")
    assert [hand["active"] for hand in bj.picture(state)["player_hands"]] == [False, True]


def test_an_old_saved_state_still_plays(bj):
    """A state written before Split has one hand in state["hand"] and no hand records."""
    state = {
        "turn": "white", "status": "active", "winner": "", "moves": [], "plies": 1,
        "shoe": "legacy", "phase": "play", "hand": ["10S", "9S"], "dealer": ["10H", "7H"],
        "deck": ["2C"], "bet": 10, "outcome": "", "note": "",
    }

    assert "hit" in bj.legal(state) and "stand" in bj.legal(state)
    pic = bj.picture(state)
    assert len(pic["player_hands"]) == 1
    assert pic["player_hands"][0]["cards"] == ["10S", "9S"]
    assert pic["player_hands"][0]["wager"] == 10

    bj.play(state, "stand")

    assert state["phase"] == "bet" and state["outcome"] == "win" and state["won"] == 10


def test_a_legacy_doubled_state_keeps_its_doubled_wager(bj):
    state = {
        "turn": "white", "status": "active", "winner": "", "moves": [], "plies": 2,
        "shoe": "legacy", "phase": "play", "hand": ["5S", "6D", "10C"], "dealer": ["9H", "8H"],
        "deck": [], "bet": 20, "base_bet": 10, "outcome": "", "note": "",
    }

    pic = bj.picture(state)
    hand = pic["player_hands"][0]

    assert hand["wager"] == 20 and hand["original"] == 10 and hand["doubled"] is True
    assert "double" not in bj.legal(state), "a doubled hand has had its one card"


def test_aces_count_one_or_eleven_without_busting_needlessly(bj):
    # A+6 is soft 17; a 5 makes it 12 (the ace becomes 1), not 22.
    state = start(bj, ["AS", "9H", "6S", "8H", "5C"])
    bj.play(state, "bet10")
    assert bj.picture(state)["player_hands"][0]["soft"] is True

    bj.play(state, "hit")

    hand = bj.picture(state)["player_hands"][0]
    assert bj._hand_value(state["hand"]) == 12
    assert hand["total"] == 12 and hand["soft"] is False and hand["bust"] is False
    assert state["phase"] == "play", "12 is not a bust"


def test_splitting_an_ace_again_is_off_by_default(bj):
    # The card dealt to each split ace is another ace, which some tables let you split again.
    state = start(bj, ["AS", "9H", "AD", "8H", "AC", "5C", "KD", "3C"])
    bj.play(state, "bet10")

    bj.play(state, "split")

    assert len(state["player_hands"]) == 2, "the aces are finished with their one card"
    assert state["phase"] == "bet"
    assert state["won"] == -20, "12 and 16 both lose to the dealer's 17"
    assert chips(bj) == START - 20


def test_splitting_an_ace_again_behind_the_flag_takes_no_hit_or_double(bj):
    bj.RESPLIT_ACES = True
    try:
        state = start(bj, ["AS", "9H", "AD", "8H", "AC", "5C", "KD", "3C"])
        bj.play(state, "bet10")
        bj.play(state, "split")

        assert state["phase"] == "play", "the ace pair can be split once more"
        assert bj.legal(state) == ["stand", "split"], "but a split ace takes no hit and no double"

        bj.play(state, "split")

        assert len(state["player_hands"]) == 3
        assert state["phase"] == "bet", "no more aces, so every hand is finished"
        assert state["won"] == -10, "one hand won and two lost, at 10 each"
        assert chips(bj) == START - 10
    finally:
        bj.RESPLIT_ACES = False


def test_the_built_in_player_splits_aces(bj):
    state = start(bj, ["AS", "9H", "AD", "8H", "KC", "5C"])
    bj.play(state, "bet10")

    assert bj.bot(state) == "split"


def test_split_plays_through_the_game_center(bj, tmp_path):
    class Me:
        id = "u1"
        name = "Ada"
        platform = "desktop"
        bot = False

    table = bj.create(tmp_path / "blackjack")
    table.command("new", player=Me())
    state_path = tmp_path / "blackjack" / "state.json"
    state = json.loads(state_path.read_text())
    # Deal order: player, dealer, player, dealer, then one card to each split hand.
    state["deck"] = list(reversed(["8S", "9H", "8D", "8H", "KD", "3C"]))
    state_path.write_text(json.dumps(state))
    table.command("move bet10", player=Me())

    answer = table.command("move split", player=Me())

    assert "Played split" in answer, answer
    saved = json.loads(state_path.read_text())
    assert len(saved["player_hands"]) == 2 and saved["active_hand"] == 0
