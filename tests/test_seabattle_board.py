"""Where Sea Battle draws what was named, and what the seat across the table is called.

Two things a person can see going wrong on this board: a hull or a shot one row off from the square
they pressed, and an opponent line that does not say who is playing (or says "Computer" when the
person's own model has the seat). The rules name squares a1..j10 with rank 10 at the top, the board
draws rank 10 first, and the drop anchor is the hull's far end — these pin all three together.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import kit  # noqa: E402
import seabattle.game as game  # noqa: E402

FLEET = [("carrier", "a1", "h"), ("battleship", "a3", "h"), ("cruiser", "a5", "h"),
         ("submarine", "f2", "v"), ("destroyer", "h7", "v")]


class Player:
    id = "p1"
    name = "Ada"


def _dealt(tmp_path, line="allow-ai black=local level=intermediate"):
    table = kit.Table(tmp_path / "table", kit.rules(dict(vars(game))))
    table.command("new", player=Player())
    table.command(line, player=Player())
    for name, square, orient in FLEET:
        table.command(f"move place {name} {square} {orient}", player=Player())
    return table


def test_a_hull_is_drawn_on_the_squares_the_drop_showed(tmp_path):
    table = _dealt(tmp_path)
    pictured = table.picture(player=Player())
    assert pictured["phase"] == "fire", pictured["phase"]
    # a1..e1 is the bottom row of YOUR WATERS, left to right.
    assert pictured["own_cells"][9][0:5] == ["S"] * 5, pictured["own_cells"][9]
    carrier = next(ship for ship in pictured["own_ships"] if ship["name"] == "carrier")
    assert sorted(carrier["cells"]) == ["a1", "b1", "c1", "d1", "e1"], carrier["cells"]
    # A vertical hull grows toward higher ranks: f2, f3, f4 is one column going up the board.
    submarine = next(ship for ship in pictured["own_ships"] if ship["name"] == "submarine")
    assert sorted(submarine["cells"]) == ["f2", "f3", "f4"], submarine["cells"]
    assert [pictured["own_cells"][row][5] for row in (8, 7, 6)] == ["S", "S", "S"], pictured["own_cells"]


def test_a_shot_is_drawn_on_the_square_that_was_fired_at(tmp_path):
    table = _dealt(tmp_path)
    table.command("move fire j10", player=Player())
    pictured = table.picture(player=Player())
    # j10 is the top right square of ENEMY WATERS: first drawn row, last column.
    assert pictured["enemy_cells"][0][9] in {"M", "H"}, pictured["enemy_cells"][0]
    assert pictured["enemy_cells"][9][0] == ".", "and a1 is still untouched"


def test_the_seat_across_the_table_is_named_and_leveled(tmp_path):
    table = _dealt(tmp_path)
    pictured = table.picture(player=Player())
    seats = {seat["side"]: seat for seat in pictured["seats"]}
    assert seats["white"]["kind"] == "human", "the person holds the human seat"
    assert seats["black"]["kind"] == "local", "the built-in player holds the other one"
    assert seats["black"]["name"] == "Local"
    assert pictured["level"] == "intermediate", pictured["level"]
    labels = {item["id"]: item["label"] for item in pictured["levels"]}
    assert labels["intermediate"] == "Intermediate", labels
    assert pictured["your_side"] == "white", "and the person never changes sides"
