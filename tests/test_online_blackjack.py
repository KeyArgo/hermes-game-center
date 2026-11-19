"""Online blackjack is two people each playing their own hand against the dealer.

A lobby blackjack table is not a white-versus-black duel, so nothing here follows the colour
of a board game: seat 1 is the host, seat 2 the person who sits down, and each has their own
bet, their own hand and their own 10,000-chip stack. The stacks live in the table state, never
in a wallet file: a lobby table spends, wins, refills and mints nothing from the owner's Jackpot
chips. The move on offer belongs to one person at a time, and the table takes a new person only
between hands.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import kit  # noqa: E402
from online.rooms import Rooms, load_games  # noqa: E402
from online.store import Store  # noqa: E402

LOADED = load_games()


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    rooms = Rooms(store, tmp_path, games=LOADED, clock=Clock())
    people = {name: store.create_player(name)[0] for name in ("Ada", "Bea", "Eve")}
    yield store, rooms, people, tmp_path
    store.close()


def sit_down(rooms, people, guest="Bea"):
    room, text = rooms.create("blackjack", people["Ada"], public=True)
    assert room, text
    if guest:
        assert rooms.run(room, people[guest], "join")["ok"]
    return room


def pinned(rooms, people, seed="seed-1"):
    """A table with both people seated and the shoe pinned, so the deal is the same every run.

    The table seeds its own shoe, and a hand can end before anybody plays it (a natural, or a
    dealer natural). These tests are about seats, bets and turns, so the shoe is chosen once.
    """
    room = sit_down(rooms, people)
    state = rooms.state(room)
    state["shoe"] = seed
    kit.write(rooms.folder(room["id"]), state)
    return room


def dealt(rooms, people, seed="seed-1"):
    room = pinned(rooms, people, seed)
    for who in ("Ada", "Bea"):
        answer = rooms.run(room, people[who], "move", ["bet10"])
        assert answer["ok"], answer["text"]
    state = rooms.state(room)
    assert state["phase"] == "play", state["note"]
    assert not any(hand["done"] for hand in state["player_hands"]), "a plain deal, both hands live"
    return room


def test_both_people_bet_and_play_their_own_hand(setup):
    store, rooms, people, _root = setup
    room = pinned(rooms, people)
    assert rooms.state(room)["phase"] == "bet"

    assert rooms.run(room, people["Ada"], "move", ["bet10"])["ok"], "the host's own bet"
    assert rooms.state(room)["betting"] == 1, "and the table waits for the second person"
    assert not rooms.run(room, people["Ada"], "move", ["bet10"])["ok"], "one bet each"
    assert rooms.run(room, people["Bea"], "move", ["bet10"])["ok"], "the guest's own bet"

    state = rooms.state(room)
    assert state["phase"] == "play", state["note"]
    assert not any(hand["done"] for hand in state["player_hands"]), "both hands are being played"
    assert [hand["player"] for hand in state["player_hands"]] == [0, 1], "one hand each"
    assert state["stacks"] == [9990, 9990], "each person staked from their own table stack"

    ada = rooms.picture(room, people["Ada"]["id"])
    bea = rooms.picture(room, people["Bea"]["id"])
    assert (ada["your_seat"], bea["your_seat"]) == (0, 1), "each picture knows which seat is theirs"
    assert ada["permissions"]["can_move"], "the host's hand is the one acting"
    assert not bea["permissions"]["can_move"], "the guest waits their turn"
    assert ada["chips"] == 9990 and bea["chips"] == 9990, "each person reads their own stack"
    assert ada["player_hands"][0]["cards"] == state["player_hands"][0]["cards"]
    assert [hand["seat"] for hand in ada["player_hands"]] == [0, 1], "the felt shows both hands"
    assert [player["name"] for player in ada["players"]] == ["Ada", "Bea"], \
        "and it names the two people who sat down"


def test_the_hand_on_the_felt_belongs_to_one_person_at_a_time(setup):
    store, rooms, people, _root = setup
    room = dealt(rooms, people)
    before = rooms.state(room)
    assert before["turn"] == "white", "the first hand is the host's, in the kit's own words"

    # The host plays her hand out: it is the guest's hand that is acting afterwards.
    assert rooms.run(room, people["Ada"], "move", ["stand"])["ok"]
    ada = rooms.picture(room, people["Ada"]["id"])
    bea = rooms.picture(room, people["Bea"]["id"])
    assert not ada["permissions"]["can_move"], "the host is done for this hand"
    assert bea["permissions"]["can_move"], "the guest plays her own hand now"
    assert bea["player_hands"][1]["active"] is True, "and it is her hand the felt marks"
    assert rooms.state(room)["turn"] == "black"

    assert rooms.run(room, people["Bea"], "move", ["stand"])["ok"]
    state = rooms.state(room)
    assert state["phase"] == "bet", "the round settles back to betting, the table stays open"
    assert state["round_bets"] == [0, 0] and state["betting"] == 0
    assert all(hand["result"] for hand in state["player_hands"]), "every hand was settled"
    assert rooms.picture(room, people["Ada"]["id"])["permissions"]["can_move"], "and the table bets again"


def test_a_person_cannot_act_on_the_other_persons_hand(setup):
    store, rooms, people, _root = setup
    room = dealt(rooms, people)
    state = rooms.state(room)

    refused = rooms.run(room, people["Bea"], "move", ["hit"])
    assert not refused["ok"], "the guest cannot press hit on the host's hand"
    assert rooms.state(room)["player_hands"][0]["cards"] == state["player_hands"][0]["cards"], \
        "and no card was dealt"

    # The same the other way: once the host's hand is done it is the guest's, and the host
    # cannot reach into it.
    assert rooms.run(room, people["Ada"], "move", ["stand"])["ok"]
    assert rooms.state(room)["turn"] == "black"
    assert not rooms.run(room, people["Ada"], "move", ["hit"])["ok"]
    assert rooms.state(room)["player_hands"][1]["cards"] == state["player_hands"][1]["cards"]


def test_a_spectator_cannot_act(setup):
    store, rooms, people, _root = setup
    room = dealt(rooms, people)
    watched = rooms.picture(room, people["Eve"]["id"])
    assert watched["your_seat"] == -1, "a watcher holds no seat"
    assert not watched["permissions"]["can_move"]
    assert not rooms.run(room, people["Eve"], "move", ["hit"])["ok"]
    assert not rooms.run(room, people["Eve"], "move", ["bet10"])["ok"]


def test_a_hand_finishes_and_the_next_one_is_dealt(setup):
    store, rooms, people, _root = setup
    room = dealt(rooms, people)
    first = rooms.state(room)
    assert rooms.run(room, people["Ada"], "move", ["stand"])["ok"]
    assert rooms.run(room, people["Bea"], "move", ["stand"])["ok"]
    settled = rooms.state(room)
    assert settled["hands"] == 1, "one hand played"
    assert settled["phase"] == "bet"

    for who in ("Ada", "Bea"):
        answer = rooms.run(room, people[who], "move", ["bet10"])
        assert answer["ok"], f"{who} bets the next hand: {answer['text']}"
    second = rooms.state(room)
    assert second["phase"] == "play", "the next hand is being played"
    assert [hand["player"] for hand in second["player_hands"]] == [0, 1]
    assert [hand["cards"] for hand in second["player_hands"]] != \
        [hand["cards"] for hand in first["player_hands"]], "a new deal, not the last one again"
    assert second["stacks"] != [9990, 9990], "the second round staked its own bets"


def test_a_new_person_joins_between_hands_only(setup):
    store, rooms, people, _root = setup
    room = sit_down(rooms, people, guest=None)
    # Nobody is in the second seat yet, so the host plays their own hand rather than waiting
    # on a bet that nobody can make.
    assert rooms.run(room, people["Ada"], "move", ["bet10"])["ok"]
    state = rooms.state(room)
    assert state["phase"] == "play", "a lone host plays their own hand"
    refused = rooms.run(room, people["Eve"], "join")
    assert not refused["ok"] and "between hands" in refused["text"], refused["text"]
    assert not rooms.picture(room, people["Eve"]["id"])["permissions"]["can_join"], \
        "and the table offers no seat in the middle of a hand"
    assert rooms.run(room, people["Ada"], "move", ["stand"])["ok"]
    assert rooms.state(room)["phase"] == "bet", "the hand is over"
    assert rooms.run(room, people["Eve"], "join")["ok"], "so the seat is open again"
    assert rooms.state(room)["black_id"] == people["Eve"]["id"], "and the new person holds it"


def test_reconnecting_keeps_both_seats(setup):
    store, rooms, people, root = setup
    room = sit_down(rooms, people)
    before = rooms.state(room)
    # A server restart: the same store and data root, a fresh Rooms.
    again = Rooms(store, root, games=LOADED, clock=Clock())
    state = again.state(store.room(room["id"]))
    assert state["white_id"] == before["white_id"], "the host keeps their seat"
    assert state["black_id"] == before["black_id"], "and so does the guest"
    for who, seat in (("Ada", 0), ("Bea", 1)):
        picture = again.picture(store.room(room["id"]), people[who]["id"])
        assert picture["your_seat"] == seat, f"{who} is still in seat {seat}"
        assert picture["chips"] == 10000, "with the stack the table saved for them"
    # And the table still takes the next bet from the person whose turn it is.
    assert again.run(store.room(room["id"]), people["Ada"], "move", ["bet10"])["ok"]
    assert not again.run(store.room(room["id"]), people["Ada"], "move", ["bet10"])["ok"], \
        "the host has already bet this round"
    assert again.run(store.room(room["id"]), people["Bea"], "move", ["bet10"])["ok"]


def test_resigning_is_refused_because_there_is_no_match(setup):
    store, rooms, people, _root = setup
    room = dealt(rooms, people)
    answer = rooms.run(room, people["Ada"], "resign")
    assert not answer["ok"], "a session table has no match to resign"
    assert "no match to resign" in answer["text"], answer["text"]
    assert rooms.state(room)["status"] == "active", "and the table is still open"


def test_the_table_keeps_its_chips_and_never_opens_a_wallet(setup):
    store, rooms, people, _root = setup
    room = dealt(rooms, people)
    folder = rooms.folder(room["id"])
    assert not (folder / "wallet.json").exists(), "a lobby table has no wallet file at all"
    assert rooms.state(room)["stacks"] == [9990, 9990], "both seats bet from their own stack"
    assert rooms.run(room, people["Ada"], "move", ["stand"])["ok"]
    assert rooms.run(room, people["Bea"], "move", ["stand"])["ok"]
    state = rooms.state(room)
    assert sum(state["stacks"]) != 20000, "the round moved chips between the table and the two seats"
    assert sum(state["stacks"]) >= 19980, "and never minted any: the dealer only takes what was bet"
    assert state["players"] == 2
    assert not (folder / "wallet.json").exists(), "still no wallet file after a settled hand"
