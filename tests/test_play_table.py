"""Mouse-play table: seating, paced bots, and a dedicated Desktop room."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402
from shelf.fair import blocked  # noqa: E402

from tests.test_center import _own  # noqa: E402


def test_bots_vs_bots_plays_one_ply_then_waits(tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "connect4")
    started = run(catalog, "allow-ai connect4 white=local black=local", source="command")
    assert "Local played" in started
    assert started.count("Local played") == 1
    assert "Game over" not in started
    assert "Yellow to move." in started
    again = run(catalog, "connect4 step", source="command")
    assert again.count("Local played") == 1
    assert "Red to move." in again
    assert "Game over" not in again


def test_human_vs_bot_still_answers_in_the_same_turn(tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "connect4")
    opened = run(catalog, "allow-ai connect4 black=local", source="command")
    assert "Red to move." in opened
    played = run(catalog, "connect4 move 4", source="command")
    assert "Played 4." in played
    assert "Local played" in played


def test_a_tool_cannot_seat_bots(tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "connect4")
    refused = run(catalog, "allow-ai connect4 white=local black=local", source="tool")
    assert "person" in refused.lower() or "consent" in refused.lower()
    off = Catalog([ROOT], tmp_path / "data-off", {"allow_ai": False})
    _own(off, "connect4")
    assert "off" in run(off, "allow-ai connect4 black=local", source="command").lower()
    assert blocked("allow-ai connect4 black=local", "tool", allow_ai=True)


def test_connect4_picture_marks_the_last_drop(tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "connect4")
    run(catalog, "connect4 new", source="command")
    run(catalog, "connect4 move 4", source="command")
    pic = catalog.picture("connect4")
    assert pic["last_to"]["col"] == 3
    assert pic["last_to"]["name"] == "4"
    assert pic["cells"][pic["last_to"]["row"]][3] == "X"


def test_play_table_is_a_room_in_the_desktop_plugin() -> None:
    src = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "function PlayTable" in src
    assert "Two players" in src
    assert "Play the computer" in src
    assert "Watch bots" in src
    assert "white=local black=local" in src
    assert "${gameId} step" in src or "${game.id} step" in src
    assert "setPlaying" in src
    assert "PLAY_HEIGHT" in src


def test_a_drop_game_says_red_and_yellow_never_white_and_black(tmp_path: Path) -> None:
    """The bug hunt: a red-versus-yellow drop game was speaking chess.

    Each game names its own two sides (``SIDE_WORDS``) and kit.py uses those words in
    the text board, so the seat row, the move history and the start screen can never
    tell a newcomer they are playing white against black in Connect Four.
    """
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "connect4")
    said = run(catalog, "connect4 new", source="command")
    assert "Red (X):" in said and "Yellow (O):" in said, said
    assert "White" not in said and "Black" not in said, said
    picture = catalog.picture("connect4")
    assert picture["side_words"] == {"white": "Red", "black": "Yellow"}
    assert picture["seat_words"] == {"white": "Red pieces", "black": "Yellow pieces"}


def test_the_chess_tables_keep_calling_their_sides_white_and_black(tmp_path: Path) -> None:
    """Only the games that are not chess lose the chess words."""
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "reversi")
    picture = catalog.picture("reversi")
    assert picture["side_words"] == {"white": "White", "black": "Black"}
    assert picture["seat_words"] == {"white": "White pieces", "black": "Black pieces"}
