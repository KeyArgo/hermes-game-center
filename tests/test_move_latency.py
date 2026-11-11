"""Where a move's time actually goes, and the two facts the table's redraw rests on.

A move against the computer is one request. Measured here on the dev box (best of a
few runs, milliseconds):

    chessboard Normal   move POST ~1900 ms at Expert, ~40 ms at Normal
    checkers   Normal   move POST  ~220 ms   (the game's own clock caps at 350 ms)
    connect4   Normal   move POST   ~75 ms   (the built-in player answers at once)
    GET /board                      ~130 ms
    GET /view                        ~75 ms

So two things are true, and the page and the pane are built on them:

* the wait before the *person's* piece lands is never the table's: the reply to the
  move carries the new board, so the UI paints from that reply and needs no second
  read (``dashboard/plugin_api.py`` command() answers with ``picture``);
* the wait for the *computer's* piece is its own search (chess caps at 1.7 s, checkers
  at 0.35 s), which is the game thinking, not the table dawdling.

The ceilings below are generous — ten times the measured times on an idle box — so a
regression that adds a whole extra round trip or a second search is caught without the
test going red on a busy machine.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402

from tests.test_center import _own  # noqa: E402

# What the table may cost on its own, in milliseconds. The search is the game's.
TABLE_CEILING_MS = 1000
BOARD_CEILING_MS = 500


def _catalog(tmp_path: Path) -> Catalog:
    return Catalog([ROOT], tmp_path / "data", {"allow_ai": True})


def _ms(fn):
    started = time.perf_counter()
    answer = fn()
    return (time.perf_counter() - started) * 1000, answer


def _started(tmp_path: Path, game: str, level: str = "intermediate") -> Catalog:
    catalog = _catalog(tmp_path)
    _own(catalog, game)
    run(catalog, f"allow-ai {game} black=local level={level}", source="command")
    return catalog


def _one_move(catalog: Catalog, game: str) -> tuple[float, float, str]:
    """Time the move line and the board read after it, and return the move played."""
    before = catalog.picture(game)
    legal = [str(move) for move in (before or {}).get("legal") or [] if str(move) != "pass"]
    assert legal, f"{game} is active with no legal move"
    move_ms, _ = _ms(lambda: run(catalog, f"{game} move {legal[0]}", source="command"))
    board_ms, after = _ms(lambda: catalog.picture(game))
    return move_ms, board_ms, str((after or {}).get("plies"))


def test_one_move_line_already_carries_the_new_board(tmp_path: Path) -> None:
    """The person's move and the computer's answer are in the reply, not a second read.

    Both the page and the pane paint the board from the command's own reply
    (``setBoard`` on ``answer.picture``). That only works because one move line
    settles both plies: if a move left the computer's answer for a later read, the
    reply would paint a board with the bot still to move.
    """
    for game in ("connect4", "checkers", "chessboard"):
        catalog = _started(tmp_path / game, game)
        _move_ms, _board_ms, plies = _one_move(catalog, game)
        assert plies == "2", f"{game}: one move line left the table on ply {plies}"


def test_the_table_adds_no_wait_of_its_own_to_a_move(tmp_path: Path) -> None:
    """The move line costs the game's own answer plus a little; the board read is cheap.

    connect4's built-in player answers at once, so its move line is the table's own
    cost. checkers and chess are measured against their published clocks (0.35 s and
    1.7 s at the top level), so the ceiling is the table's, not the search's.
    """
    measured = []
    for game, level, ceiling in (
        ("connect4", "intermediate", TABLE_CEILING_MS),
        ("checkers", "intermediate", 2000),
        ("chessboard", "intermediate", 3000),
    ):
        catalog = _started(tmp_path / game, game, level)
        move_ms, board_ms, _plies = _one_move(catalog, game)
        measured.append(f"{game} {level}: move {move_ms:.0f} ms, board {board_ms:.0f} ms")
        assert move_ms < ceiling, f"{game} {level}: a move took {move_ms:.0f} ms"
        assert board_ms < BOARD_CEILING_MS, f"{game}: reading the board took {board_ms:.0f} ms"
    print("move timing (ms): " + " | ".join(measured))


def test_the_reply_carries_the_picture_the_page_paints(tmp_path: Path, monkeypatch) -> None:
    """The gateway's own answer to a move holds the board, so the page needs no second read.

    This is the door the Desktop actually posts to (``/command``), so the claim is
    about the shipped route and not about the shelf underneath it.
    """
    import importlib.util
    import types

    if "fastapi" not in sys.modules:
        fake = types.ModuleType("fastapi")

        class APIRouter:
            def get(self, _path):
                return lambda handler: handler

            post = get

        fake.APIRouter = APIRouter
        sys.modules["fastapi"] = fake
    spec = importlib.util.spec_from_file_location("move_latency_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(api, "_config", lambda: {"plugins": {"enabled": ["hermes-gameshelf"]}})

    api.command({"line": "allow-ai connect4 black=local level=intermediate"})
    answer = api.command({"line": "connect4 move 4"})
    assert answer["ok"] is True, answer["text"]
    picture = answer.get("picture") or {}
    assert picture, "the move reply carries no board at all"
    assert picture["plies"] == 2, "the reply left the computer's answer for a second read"
    assert picture["view"] == "connect4"
