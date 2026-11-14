"""A model seat's fleet is laid out in one move, not one model call a ship.

Sea Battle opens with five ships to place. A model seat used to be asked for each one in turn, and
every call happens inside the person's own request: the fourth and fifth drop waited on the model,
up to ``kit.AGENT_SECONDS`` each when the model is slow or stuck. The placement is setup — the
rules already offer a move that lays the whole fleet down — so a machine seat never spends the
model's time (or the person's) on it. The model still plays every shot.
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import kit  # noqa: E402
import seabattle.game as game  # noqa: E402

LAYOUT = [("carrier", "a1", "h"), ("battleship", "a3", "h"), ("cruiser", "a5", "h"),
          ("submarine", "f2", "v"), ("destroyer", "h7", "v")]


class Player:
    id = "p1"
    name = "P1"


class Model:
    """A model seat that answers with the first legal move it is offered, and remembers the ask."""

    def __init__(self) -> None:
        self.asked: list[str] = []

    def __call__(self, prompt: str) -> dict:
        self.asked.append(prompt)
        legal = prompt.split("Legal moves: ", 1)[-1].split("\n", 1)[0]
        return {"move": legal.split(", ")[0].strip(), "tokens": 4}


class Stuck:
    """A model that never answers, so the call can only end on the table's own bound."""

    def __init__(self) -> None:
        self.asked = 0

    def __call__(self, prompt: str) -> dict:
        self.asked += 1
        threading.Event().wait(60)
        return {"move": "", "tokens": 0}


def _table(tmp_path: Path):
    table = kit.Table(tmp_path / "table", kit.rules(dict(vars(game))))
    table.command("new", player=Player())
    return table


def _place_all(table, model):
    for name, square, orient in LAYOUT:
        table.command(f"move place {name} {square} {orient}", player=Player(), complete=model)


def test_a_model_seat_places_its_fleet_without_asking_the_model_a_ship_at_a_time(tmp_path):
    table = _table(tmp_path)
    model = Model()
    table.command("allow-ai black=agent", player=Player(), complete=model)
    assert table.command("state", player=Player()).startswith("place"), "the table opens on placement"

    _place_all(table, model)

    assert model.asked == [], (
        "placing a fleet must not be a model call per ship: " + str(len(model.asked)) + " calls")
    board = table.picture(player=Player())
    assert board["phase"] == "fire", board["phase"]
    assert board["your_side"] == "white", "the person is seated across the model's fleet"


def test_the_fleet_really_is_there_and_the_game_moves_on(tmp_path):
    table = _table(tmp_path)
    model = Model()
    table.command("allow-ai black=agent", player=Player(), complete=model)
    _place_all(table, model)

    state = kit.load(table.root)
    assert state is not None
    assert sorted(ship["name"] for ship in state["fleets"]["black"]) == [
        "battleship", "carrier", "cruiser", "destroyer", "submarine"]
    assert state["phase"] == "fire", state["phase"]
    assert state["turn"] == "white", "the person fires first"
    assert not state.get("refusals"), "nothing was refused: the model was never asked"


def test_the_person_never_waits_the_model_bound_to_place_a_fleet(tmp_path):
    """The report: the drop that ends the person's fleet hung for about twenty seconds."""
    table = _table(tmp_path)
    stuck = Stuck()
    table.command("allow-ai black=agent", player=Player(), complete=stuck)
    for name, square, orient in LAYOUT[:-1]:
        table.command(f"move place {name} {square} {orient}", player=Player(), complete=stuck)
    started = time.monotonic()
    table.command(f"move place {LAYOUT[-1][0]} {LAYOUT[-1][1]} {LAYOUT[-1][2]}",
                  player=Player(), complete=stuck)
    took = time.monotonic() - started
    assert stuck.asked == 0, "a stuck model was not asked at all"
    assert took < kit.AGENT_SECONDS / 4, f"the last placement took {took:.1f}s"
    state = kit.load(table.root)
    assert state is not None and state["phase"] == "fire"


def test_a_model_seat_still_plays_its_shots(tmp_path):
    """Placement is setup; the fire phase is play, and the model is asked there."""
    table = _table(tmp_path)
    model = Model()
    table.command("allow-ai black=agent", player=Player(), complete=model)
    _place_all(table, model)
    assert model.asked == []
    table.command("move fire e5", player=Player(), complete=model)
    assert len(model.asked) == 1, "the model answers the person's shot"
    state = kit.load(table.root)
    assert state is not None and state["turn"] == "white", "and the shot came back to the person"
