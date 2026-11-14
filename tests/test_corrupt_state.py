"""A state file that cannot be decoded is a fresh start, never a traceback.

A crash mid-write, a disk that filled, a file copied between machines with another encoding, or a
Windows editor's UTF-16 save all leave bytes that are not UTF-8. ``json.JSONDecodeError`` covered the
half-written JSON case and ``OSError`` covered the missing file, but ``UnicodeDecodeError`` is
neither: it escaped every loader that read the file as text, so one bad byte in ``state.json`` made
every command in that game raise instead of starting over.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402
from shelf.directory import Directory  # noqa: E402
from shelf.library import Library  # noqa: E402
from shelf.lobby import _load as load_lobby  # noqa: E402
from shelf.setup import Setup  # noqa: E402
from shelf.who import NameBook  # noqa: E402

# Bytes that are not valid UTF-8: what an interrupted write or a UTF-16 save leaves behind.
NOT_UTF8 = b"\xff\xfe\x00junk"

# The games this plugin ships and the shelf lists. A game that is renamed fails the first test below,
# which is the point: the corrupt-state path must be covered for every game that can write state.
GAMES = ["blackjack", "breakthrough", "checkers", "chessboard", "connect4", "doctrine", "go",
         "gomoku", "hex", "mafia", "reversi", "seabattle", "slots"]


def _state_roots(data: Path, game: str) -> list[Path]:
    """Every folder this game's table could be reading its state.json from.

    ``mafia`` keeps its table one level down (``<data>/mafia/mafia/``), so both layouts are written
    rather than assumed: the point of the test is the bytes, not the folder shape.
    """
    found = {data / game, data / game / game}
    found.update(path.parent for path in data.rglob("state.json"))
    return sorted(found)


@pytest.mark.parametrize("game", GAMES)
def test_a_game_state_that_is_not_utf8_starts_over(game: str, tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / game, {"allow_ai": True})
    assert catalog.has(game), f"{game} is no longer listed by the shelf"
    run(catalog, f"{game} new", source="command")
    for folder in _state_roots(tmp_path / game, game):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "state.json").write_bytes(NOT_UTF8)
        (folder / "level.json").write_bytes(NOT_UTF8)

    # A command must answer, and the picture must draw: neither may raise.
    said = run(catalog, f"{game} state", source="command")
    assert isinstance(said, str) and said.strip()
    pictured = catalog.picture(game)
    assert pictured is None or isinstance(pictured, dict)
    # And a move after the bad bytes still lands on a fresh table.
    assert isinstance(run(catalog, f"{game} move 1", source="command"), str)


def test_the_shelf_loaders_treat_undecodable_bytes_as_empty(tmp_path: Path) -> None:
    (tmp_path / "directory.json").write_bytes(NOT_UTF8)
    (tmp_path / "installed.json").write_bytes(NOT_UTF8)
    (tmp_path / "lobby.json").write_bytes(NOT_UTF8)
    (tmp_path / "setup.json").write_bytes(NOT_UTF8)
    (tmp_path / "names.json").write_bytes(NOT_UTF8)

    loaded = Directory(tmp_path).load()
    assert isinstance(loaded, dict)
    assert Library(tmp_path).ids() == set()
    posts = load_lobby(tmp_path)
    assert isinstance(posts, dict) and posts.get("lines") == []
    assert Setup(tmp_path)._read() == {}
    assert NameBook(tmp_path / "names.json").get("anyone") == ""


# Inside the state file's own envelope, the shelf keeps these fields. A file that is valid JSON with
# the wrong shape came from a hand edit, an older build, or a half-written copy: its game fields are
# still readable, so it is repaired rather than thrown away.
MANGLED = {"turn": 42, "status": [], "score": None, "moves": {"a": 1}, "plies": "x",
           "refusals": "x", "rematch": [], "draw_offer": ["x"], "white": None, "black": {},
           "white_id": 1, "black_id": [], "white_name": {}, "black_name": 2,
           "winner": [], "last": {}, "table_id": [], "owner_id": {}}


@pytest.mark.parametrize("game", GAMES)
def test_a_state_with_wrong_shapes_in_the_shelf_fields_is_repaired(game: str, tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / game, {"allow_ai": True})
    run(catalog, f"{game} new", source="command")
    if game == "doctrine":
        # Doctrine has no table until a card is in hand, and that is what writes its state.
        card = (ROOT / "doctrine" / "cards" / "stone-bastion.json").read_text(encoding="utf-8")
        run(catalog, f"doctrine import {card}", source="command")
    states = sorted((tmp_path / game).rglob("state.json"))
    assert states, f"{game} wrote no state.json to mangle"
    for path in states:
        original = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**original, **MANGLED}), encoding="utf-8")

    # The game's own fields survive, so whatever is asked of the table answers in words.
    for command in ("state", "board", "hint", "step", "move 1"):
        said = run(catalog, f"{game} {command}", source="command")
        assert isinstance(said, str) and said.strip(), command
    pictured = catalog.picture(game)
    assert pictured is None or isinstance(pictured, dict)
    # Games with a picture of their own (mafia's town, doctrine's card) may leave a field out; the
    # fields the shelf itself fills must be the right shape when they are there.
    if isinstance(pictured, dict):
        if "score" in pictured:
            assert isinstance(pictured["score"], dict), pictured["score"]
        if "moves" in pictured:
            assert isinstance(pictured["moves"], list), pictured["moves"]
        if "turn" in pictured:
            assert isinstance(pictured["turn"], str), pictured["turn"]
