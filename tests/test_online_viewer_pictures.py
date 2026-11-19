"""An online picture is drawn for the person looking, never for whoever happens to be at the table.

Two people at one online Sea Battle table sit across two different fleets. The room used to ask the
table for its picture without saying who was looking, so the game had no viewer to follow: every
seat got the same board, and a watcher could be handed a fleet that is not theirs (the one-human
fallback below is right for a shared keyboard and wrong for anyone else).

These tests are the seat-and-spectator check the plan asks for: each seat sees its own ships and
only its own, and a watcher sees neither fleet.
"""

from __future__ import annotations

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
    # A fleet is laid down online with the game's own one-move chooser. Two people do not share a
    # keyboard, so the next seat still has to lift the pass card before it may place its own.
    assert rooms.run(room, people["Ada"], "move", ["duplicate"])["ok"]
    assert rooms.run(room, people["Bea"], "move", ["look"])["ok"]
    assert rooms.run(room, people["Bea"], "move", ["duplicate"])["ok"]
    assert rooms.run(room, people["Ada"], "move", ["look"])["ok"]
    return room


def test_each_seat_draws_its_own_fleet_and_the_watcher_draws_neither(setup):
    store, rooms, people = setup
    room = seat_a_table(rooms, people)
    state = rooms.state(room)
    assert state["phase"] == "fire", state["phase"]
    ada_hull, bea_hull = hull_cells(state, "white"), hull_cells(state, "black")
    assert ada_hull and bea_hull and ada_hull != bea_hull, "two real fleets, laid in different places"

    mine = rooms.picture(room, people["Ada"]["id"])
    assert mine["your_side"] == "white", "the host is seated across White's fleet"
    assert ship_cells(mine["own_cells"]) == ada_hull, "Ada's board shows Ada's five ships"
    assert not ship_cells(mine["own_cells"]) & bea_hull, "and not one ship of Bea's fleet"
    assert len(mine["own_ships"]) == 5

    theirs = rooms.picture(room, people["Bea"]["id"])
    assert theirs["your_side"] == "black", "the guest is seated across Black's fleet"
    assert ship_cells(theirs["own_cells"]) == bea_hull, "Bea's board shows Bea's five ships"
    assert not ship_cells(theirs["own_cells"]) & ada_hull, "and not one ship of Ada's fleet"

    watched = rooms.picture(room, people["Eve"]["id"])
    assert watched["your_side"] == "", "a watcher holds no seat, so no side is theirs"
    assert ship_cells(watched["own_cells"]) == set(), "a watcher is shown no fleet at all"
    assert ship_cells(watched["enemy_cells"]) == set()
    assert watched["own_ships"] == [], "and no ship list to read the fleet off"
    assert watched["permissions"]["can_move"] is False


def test_a_watcher_is_not_handed_the_single_person_seat(setup):
    """One person against the built-in player: the person's fleet is theirs, not the watcher's."""
    store, rooms, people = setup
    room, text = rooms.create("seabattle", people["Ada"], public=True, mode="bot")
    assert room, text
    state = rooms.state(room)
    assert state["white_id"] == people["Ada"]["id"], "the host holds the one human seat"
    assert rooms.run(room, people["Ada"], "move", ["duplicate"])["ok"], "the person lays their fleet"

    watched = rooms.picture(room, people["Eve"]["id"])
    assert watched["your_side"] == "", "a viewer who is not at the table is a watcher"
    assert ship_cells(watched["own_cells"]) == set()
    assert watched["own_ships"] == []

    own = rooms.picture(room, people["Ada"]["id"])
    assert own["your_side"] == "white"
    assert len(own["own_ships"]) == 5, "the person seated in it still sees their own fleet"
