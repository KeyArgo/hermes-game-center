"""A room id is one folder name, and rooms never write outside the rooms tree.

Table ids, room ids and save paths reach the filesystem, and in online play they
come from outside. Traversal and absolute paths must be refused rather than
resolved.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from online.server import App  # noqa: E402


@pytest.mark.parametrize("room_id", ["..", "../elsewhere", "../../etc", "/etc", "/tmp/x", "a/b", "a\\b", ""])
def test_a_room_id_that_is_a_path_is_refused(tmp_path: Path, room_id: str) -> None:
    app = App(tmp_path / "data", games={})
    with pytest.raises(ValueError):
        app.rooms.folder(room_id)


def test_a_plain_room_id_still_maps_to_its_folder(tmp_path: Path) -> None:
    app = App(tmp_path / "data", games={})
    folder = app.rooms.folder("MhEbTUN20DeF")
    assert folder == (tmp_path / "data" / "rooms" / "MhEbTUN20DeF").resolve()
    assert folder.parent == (tmp_path / "data" / "rooms").resolve()


def test_a_bad_room_row_does_not_take_a_read_down(tmp_path: Path) -> None:
    """Reads run for every open room in one loop; one bad row must not raise into it."""
    app = App(tmp_path / "data", games={})
    assert app.rooms.state({"id": "../x"}) is None
    assert app.rooms.state({"id": "/etc"}) is None


def test_a_symlinked_room_folder_is_not_another_rooms_folder(tmp_path: Path) -> None:
    """A link inside rooms/ keeps its parent, so the name has to match too."""
    app = App(tmp_path / "data", games={})
    rooms = tmp_path / "data" / "rooms"
    (rooms / "realroom").mkdir(parents=True)
    try:
        (rooms / "linkroom").symlink_to(rooms / "realroom")
    except (OSError, NotImplementedError):
        # Windows needs Developer Mode or an elevated shell to create a symlink; the guard this test
        # covers is exercised on Linux and macOS, and the path-shape cases above cover the rest.
        pytest.skip("this platform will not create a symlink without extra rights")
    with pytest.raises(ValueError):
        app.rooms.folder("linkroom")


def test_a_bad_room_row_does_not_raise_through_picture(tmp_path: Path) -> None:
    """Broadcast walks every connection; a picture read must answer, not raise."""
    app = App(tmp_path / "data")  # the real games: the folder guard is what must answer
    assert app.rooms.picture({"id": "../x", "game": "connect4"}, "web:someone") == {}


def test_a_bad_row_does_not_stop_the_expiry_sweep(tmp_path: Path) -> None:
    """The janitor closes stale rooms in one pass; one unusable id must not end it."""
    app = App(tmp_path / "data", games={})
    app.store.db.execute(
        "INSERT INTO rooms (id, game, host_id, public, created, active) VALUES (?, ?, ?, ?, ?, ?)",
        ("../x", "connect4", "web:host", 1, 0.0, 0.0))
    stale = app.rooms.expire()
    assert "../x" in stale
    assert app.store.room("../x")["closed"] == 1, "the row was not closed"
