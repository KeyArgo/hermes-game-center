"""Ship placement lands on the squares the player was shown.

The board draws rank 10 at the top, so a hull that hangs downward from the square under
the pointer is a *descending* run of ranks. The rules module grows a vertical hull toward
*higher* ranks. Those two conventions are opposite, so the square the surface names for a
vertical hull must be its far end, not the square under the pointer.

That mismatch was live: dropping a carrier at a5 showed a ghost over a5..a1 and stored the
hull at a5..a9 — the ship appeared on the other side of the drop, and at the top of the
board a legal placement was refused because the ghost ran off the water. `seaAnchor()` in
`desktop/src/16-seabattle.js` is the fix; these tests pin both halves of the contract, so a
future flip on either side fails here instead of in a game.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import kit  # noqa: E402
import seabattle.game as game  # noqa: E402

FILES = "abcdefghij"
SIZES = {"carrier": 5, "battleship": 4, "cruiser": 3, "submarine": 3, "destroyer": 2}


class Player:
    id = "p1"
    name = "P1"


def _table():
    root = Path(tempfile.mkdtemp()) / "table"
    table = kit.Table(root, kit.rules(vars(game)))
    table.command("new", player=Player())
    return table, root


def _fleet(root: Path) -> dict[str, list[str]]:
    state = json.loads((root / "state.json").read_text(encoding="utf-8"))
    return {ship["name"]: [game._name(tuple(cell)) for cell in ship["cells"]]
            for ship in state["fleets"]["white"]}


def _row_col(square: str) -> tuple[int, int]:
    """The board's own coordinates: row 0 is rank 10, col 0 is file a."""
    return 10 - int(square[1:]), FILES.index(square[0])


def ghost(size: int, square: str, orient: str) -> list[str]:
    """The squares the surface highlights under the pointer (seaFootprint)."""
    row, col = _row_col(square)
    return [f"{FILES[col + (i if orient == 'h' else 0)]}{10 - (row + (i if orient == 'v' else 0))}"
            for i in range(size)]


def anchor(size: int, square: str, orient: str) -> str:
    """The square the surface names in the command (seaAnchor)."""
    row, col = _row_col(square)
    rank = 10 - (row + size - 1 if orient == "v" else row)
    return f"{FILES[col]}{rank}"


def test_the_rules_grow_a_vertical_hull_toward_higher_ranks():
    """Pinned deliberately: if this flips, seaAnchor() must flip with it."""
    table, root = _table()
    table.command("move place carrier a5 v", player=Player())
    assert _fleet(root)["carrier"] == ["a5", "a6", "a7", "a8", "a9"]


def test_a_horizontal_hull_grows_along_the_rank_it_was_dropped_on():
    table, root = _table()
    table.command("move place carrier a5 h", player=Player())
    assert sorted(_fleet(root)["carrier"]) == sorted(ghost(5, "a5", "h")) == sorted(["a5", "b5", "c5", "d5", "e5"])


@pytest.mark.parametrize("name,size", sorted(SIZES.items()))
@pytest.mark.parametrize("orient", ["h", "v"])
@pytest.mark.parametrize("square", ["a1", "a5", "e7", "j1", "c9"])
def test_every_drop_stores_the_squares_the_ghost_showed(name, size, orient, square):
    """The whole contract: what the surface previews is what the rules store."""
    row, col = _row_col(square)
    last_row = row + (size - 1 if orient == "v" else 0)
    last_col = col + (size - 1 if orient == "h" else 0)
    if last_row > 9 or last_col > 9:
        pytest.skip("that drop hangs off the water and the surface refuses it")
    shown = ghost(size, square, orient)
    table, root = _table()
    answer = table.command(f"move place {name} {anchor(size, square, orient)} {orient}", player=Player())
    stored = _fleet(root).get(name)
    # The rules sort a hull's cells by rank, the ghost lists them top-down: same squares.
    assert stored is not None, answer[:80]
    assert sorted(stored) == sorted(shown), f"stored {stored}, ghost showed {shown}"


def test_a_vertical_drop_at_the_top_of_the_board_is_offered_and_lands():
    """Before the fix the ghost fine but nothing was stored: the near-square anchor ran off
    the water at the top edge, so a legal spot did nothing at all."""
    assert ghost(5, "a10", "v") == ["a10", "a9", "a8", "a7", "a6"]
    table, root = _table()
    answer = table.command(f"move place carrier {anchor(5, 'a10', 'v')} v", player=Player())
    assert "Ship placed" in answer or "Fleet placed" in answer, answer[:80]
    assert sorted(_fleet(root)["carrier"]) == sorted(ghost(5, "a10", "v"))


def test_the_near_square_anchor_would_have_been_refused_at_that_edge():
    """The bug, stated directly: the square under the pointer is not a legal anchor there."""
    table, root = _table()
    answer = table.command("move place carrier a10 v", player=Player())
    assert "Refused" in answer
    assert "carrier" not in _fleet(root)


def test_a_hull_that_would_leave_the_water_is_refused_rather_than_stored_empty():
    table, root = _table()
    answer = table.command("move place carrier a8 v", player=Player())
    assert "Refused" in answer
    assert "carrier" not in _fleet(root)
