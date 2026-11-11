"""A third-party game.json must not point `entry` outside its own folder.

The manifest is data written by a plugin, and the host imports whatever it names.
An `entry` of `../../outside.py`, or an absolute path, makes the trusted loader
execute a file the installer never vetted — another plugin's code, or any script
that happens to be on the disk. The entry must be a file inside the game folder
it was found in.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402

MARKER = 'open({p!r}, "w").write("ran")\n'


def _outside(tmp_path: Path, name: str = "outside.py") -> Path:
    """A module that records being imported, outside every plugin folder."""
    target = tmp_path / name
    target.write_text(MARKER.format(p=str(tmp_path / "pwned.txt"))
                      + "def create(root, settings):\n    return None\n", encoding="utf-8")
    return target


def _plugin(tmp_path: Path, game_id: str, entry: str) -> Path:
    folder = tmp_path / "plugins" / f"{game_id}-plugin"
    folder.mkdir(parents=True)
    (folder / "game.json").write_text(json.dumps({
        "id": game_id, "title": game_id.title(), "entry": entry, "factory": "create",
    }), encoding="utf-8")
    return folder


def test_entry_cannot_climb_out_of_its_folder(tmp_path: Path) -> None:
    _outside(tmp_path)
    _plugin(tmp_path, "escaper", "../../outside.py")
    catalog = Catalog([tmp_path / "plugins"], tmp_path / "data", {"allow_ai": True})
    assert any("entry" in problem.lower() for problem in catalog.problems), catalog.problems
    catalog.library.add("escaper")
    run(catalog, "escaper ping", source="tool")
    assert not (tmp_path / "pwned.txt").exists(), "the loader imported a file outside the plugin"


def test_entry_cannot_be_an_absolute_path(tmp_path: Path) -> None:
    target = _outside(tmp_path, "absolute.py")
    _plugin(tmp_path, "abser", str(target))
    catalog = Catalog([tmp_path / "plugins"], tmp_path / "data", {"allow_ai": True})
    assert any("entry" in problem.lower() for problem in catalog.problems), catalog.problems
    catalog.library.add("abser")
    run(catalog, "abser ping", source="tool")
    assert not (tmp_path / "pwned.txt").exists(), "the loader imported an absolute path"


def test_an_entry_inside_its_own_folder_still_loads(tmp_path: Path) -> None:
    folder = _plugin(tmp_path, "good", "game.py")
    (folder / "game.py").write_text(
        "def create(root, settings):\n"
        "    class Game:\n"
        "        def command(self, raw, **kwargs):\n"
        "            return 'good loaded'\n"
        "    return Game()\n",
        encoding="utf-8",
    )
    catalog = Catalog([tmp_path / "plugins"], tmp_path / "data", {"allow_ai": True})
    catalog.library.add("good")
    assert run(catalog, "good ping", source="tool") == "good loaded"
