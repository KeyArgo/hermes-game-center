"""A Sea Battle fleet is the person's own business, in the move list too.

The boards were already drawn per viewer (T8). The move list was not: every ply is written down
as its text ("place carrier b2 h"), and the picture handed that list - and the mover's whole
legal list - to the other seat and to anybody watching. That rebuilt the fleet the boards keep
hidden. A game can now say which of its moves are public; Sea Battle's answer is a shot and
nothing else.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

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
    yield store, rooms, people
    store.close()


def hull_cells(state, side):
    return {(r, c) for ship in state["fleets"][side] for r, c in ship["cells"]}


def ship_cells(board):
    """The 'S' cells of one drawn 10x10 board, back in (rank, file) coordinates."""
    return {(9 - row, col) for row, line in enumerate(board) for col, mark in enumerate(line) if mark == "S"}


def seat_a_table(rooms, people):
    room, text = rooms.create("seabattle", people["Ada"], public=True)
    assert room, text
    assert rooms.run(room, people["Bea"], "join")["ok"]
    return room


# Every ship lies left to right: a room keeps three words of a move, so the
# orientation is the game's own default ("h").
ADA_SHIPS = (("carrier", "a1"), ("battleship", "a3"), ("cruiser", "a5"),
             ("submarine", "f2"), ("destroyer", "h7"))
BEA_SHIPS = (("carrier", "b9"), ("battleship", "b7"), ("cruiser", "b5"),
             ("submarine", "b3"), ("destroyer", "b1"))


def place(rooms, room, player, ships):
    for name, square in ships:
        answer = rooms.run(room, player, "move", ["place", name, square])
        assert answer["ok"], answer["text"]


def test_the_other_seat_and_a_watcher_never_see_a_placement(setup):
    store, rooms, people = setup
    room = seat_a_table(rooms, people)
    ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
    # White lays three of her five ships by hand: the table is mid-placement, White to move.
    place(rooms, room, ada, ADA_SHIPS[:3])
    state = rooms.state(room)
    assert state["phase"] == "place" and state["turn"] == "white"
    assert len(state["moves"]) == 3 and state["moves"][0].startswith("place ")
    ada_hull = hull_cells(state, "white")

    theirs = rooms.picture(room, bea["id"])
    assert "place " not in json.dumps(theirs), "Black's picture carries White's placements"
    assert ship_cells(theirs["own_cells"]) == set(), "and no hull of White's drawn on Black's board"
    assert not ship_cells(theirs["enemy_cells"]) & ada_hull
    assert theirs["own_ships"] == [] and theirs["enemy_ships"] == [] and theirs["enemy_fleet"] == []

    watched = rooms.picture(room, eve["id"])
    assert "place " not in json.dumps(watched), "a watcher's picture carries White's placements"
    assert ship_cells(watched["own_cells"]) == set() and ship_cells(watched["enemy_cells"]) == set()
    assert watched["own_ships"] == [] and watched["enemy_fleet"] == []

    # White's own table is untouched: her ships, and her own next placements, are hers.
    mine = rooms.picture(room, ada["id"])
    assert len(mine["own_ships"]) == 3, mine["own_ships"]
    assert ship_cells(mine["own_cells"]) == ada_hull
    assert any(move.startswith("place ") for move in mine["legal"]), "White can still place her fleet"


def test_shots_are_listed_for_both_people_and_placements_never_are(setup):
    store, rooms, people = setup
    room = seat_a_table(rooms, people)
    ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
    place(rooms, room, ada, ADA_SHIPS)
    # Two people, two keyboards: the pass card is lifted before the second fleet is laid.
    assert rooms.run(room, bea, "move", ["look"])["ok"]
    place(rooms, room, bea, BEA_SHIPS)
    assert rooms.run(room, ada, "move", ["look"])["ok"]
    state = rooms.state(room)
    assert state["phase"] == "fire", state["phase"]
    assert rooms.run(room, ada, "move", ["fire", "b2"])["ok"]

    for who in (ada, bea, eve):
        pictured = rooms.picture(room, who["id"])
        dumped = json.dumps(pictured)
        assert "fire b2" in pictured["moves"], f"{who['name']} lost the public shot"
        assert "place " not in dumped, f"{who['name']}'s picture carries a placement"
    assert hull_cells(rooms.state(room), "white") == hull_cells(state, "white")
