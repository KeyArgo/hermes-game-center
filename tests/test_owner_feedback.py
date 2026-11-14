"""Two things a person hit with their own hands, on a test build:

* only Connect Four looked playable, because every other shipped game sat in Get;
* the table never said which model was playing, or where it runs.

The page-side feedback (hover offset, drop zoom, thinking status) lives in
``tests/table_ui_harness.cjs``; these are the shelf and backend halves.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402


def _foreign_plugin(folder: Path, game_id: str = "hello") -> None:
    """A game another plugin brings: it still has to be taken from the store."""
    folder.mkdir(parents=True)
    (folder / "plugin.yaml").write_text("name: hello-game\n", encoding="utf-8")
    (folder / "game.json").write_text(json.dumps({
        "id": game_id,
        "plugin": "hello-game",
        "title": "Hello",
        "summary": "A one-word game.",
        "entry": "game.py",
        "factory": "create",
    }), encoding="utf-8")
    (folder / "game.py").write_text(
        "def create(root, settings):\n"
        "    class Game:\n"
        "        def command(self, raw, *, source='command', complete=None):\n"
        "            return f'hello:{source}:{raw}'\n"
        "    return Game()\n",
        encoding="utf-8",
    )


def _shelf(tmp_path: Path, *roots: Path) -> Catalog:
    return Catalog(
        [ROOT, *roots],
        tmp_path / "data",
        {"allow_ai": True},
        enabled=lambda name: name in {"hermes-gameshelf", "hello-game"},
    )


def test_shipped_games_are_in_the_library_before_anyone_clicks_get(tmp_path: Path) -> None:
    catalog = _shelf(tmp_path)
    store = catalog.storefront()
    in_library = {card["id"] for card in store["games"]}
    # Every board game that ships with Game Center, not just Connect Four.
    for game_id in ("connect4", "reversi", "checkers", "chessboard", "gomoku",
                    "chessboard", "go", "hex", "breakthrough"):
        assert game_id in in_library, f"{game_id} ships with Game Center"
        assert game_id not in store["get"], f"{game_id} must not sit behind Get"
        assert catalog._needs_install(game_id) is False
        card = next(item for item in store["store"] if item["id"] == game_id)
        assert card["installed"] is True and card["builtin"] is True
    # No file was written: a first run with no installed.json is still a full library.
    assert not (tmp_path / "data" / "installed.json").exists()


def test_get_stays_for_a_game_another_plugin_brings(tmp_path: Path) -> None:
    _foreign_plugin(tmp_path / "plugins" / "hello-game")
    catalog = _shelf(tmp_path, tmp_path / "plugins")
    store = catalog.storefront()
    card = next(item for item in store["store"] if item["id"] == "hello")
    assert card["installed"] is False and card["builtin"] is False
    assert "hello" in store["get"]
    assert catalog._needs_install("hello") is True


def _api(tmp_path: Path, monkeypatch, config: dict):
    fake = types.ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("owner_feedback_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(api, "_config", lambda: config)
    return api


CLOUD = {"model": {"default": "deepseek-v4-flash", "provider": "openrouter"}}


def test_the_chooser_lists_the_computer_and_your_agent(tmp_path: Path, monkeypatch) -> None:
    view = _api(tmp_path, monkeypatch, CLOUD).view()
    listed = view["opponents"]
    assert [item["id"] for item in listed] == ["computer", "agent"]
    computer, agent = listed
    assert computer["line"] == "allow-ai {game} black=local"
    assert [level["id"] for level in computer["levels"]] == ["beginner", "intermediate", "advanced", "expert"]
    assert computer["levels"][0]["line"] == "allow-ai {game} black=local level=beginner"
    assert computer["levels"][-1]["line"] == "allow-ai {game} black=local level=expert"
    assert computer["default_level"] == "intermediate", "Intermediate until a person picks"
    assert agent["line"] == "allow-ai {game} black=agent"
    assert "Game Shelf opponent" in agent["settings"]


def test_the_agent_entry_names_the_model_it_will_use(tmp_path: Path, monkeypatch) -> None:
    view = _api(tmp_path, monkeypatch, CLOUD).view()
    agent = next(item for item in view["opponents"] if item["id"] == "agent")
    assert agent["model"] == "deepseek-v4-flash", "an unpinned slot follows the main model"
    assert agent["where"] == "cloud"
    assert view["opponent"]["slot"] == "gameshelf_opponent"


def test_a_pinned_local_model_is_named_local(tmp_path: Path, monkeypatch) -> None:
    config = {
        "model": {"default": "deepseek-v4-flash", "provider": "openrouter"},
        "auxiliary": {
            "gameshelf_opponent": {
                "provider": "ollama",
                "model": "qwen3:8b",
                "base_url": "http://127.0.0.1:11434",
            }
        },
    }
    api = _api(tmp_path, monkeypatch, config)
    reaches = api._opponent_model(config)
    assert reaches["model"] == "qwen3:8b"
    assert reaches["where"] == "local"
    assert reaches["follows_main"] is False


def test_a_slot_on_the_house_network_counts_as_local(tmp_path: Path, monkeypatch) -> None:
    config = {
        "model": {"default": "deepseek-v4-flash", "provider": "openrouter"},
        "auxiliary": {
            "gameshelf_opponent": {"provider": "auto", "model": "spark-model", "base_url": "http://192.0.2.31:8080/v1"}
        },
    }
    api = _api(tmp_path, monkeypatch, config)
    assert api._opponent_model(config)["where"] == "local"


def test_a_cloud_model_is_not_called_local(tmp_path: Path, monkeypatch) -> None:
    config = {
        "model": {"default": "deepseek-v4-flash", "provider": "openrouter"},
        "auxiliary": {"gameshelf_opponent": {"provider": "openrouter", "model": "vendor/model-b"}},
    }
    api = _api(tmp_path, monkeypatch, config)
    reaches = api._opponent_model(config)
    assert (reaches["provider"], reaches["where"]) == ("openrouter", "cloud")


def test_no_model_configured_still_shows_the_chooser(tmp_path: Path, monkeypatch) -> None:
    view = _api(tmp_path, monkeypatch, {}).view()
    agent = next(item for item in view["opponents"] if item["id"] == "agent")
    assert agent["model"] == "" and agent["where"] == ""
    assert "Game Shelf opponent" in agent["settings"], "the way to set one is still shown"


def test_an_older_install_cannot_remove_a_built_in(tmp_path: Path) -> None:
    """A built-in saved by an older build stays put, and the answer says so."""
    from shelf.library import Library

    catalog = _shelf(tmp_path)
    # What an install made before this change looks like: connect4 was got from the store.
    Library(tmp_path / "data").add("connect4")
    assert catalog.library.has("connect4")
    said = catalog.remove("connect4")
    assert "comes with Game Center" in said, said
    assert catalog.library.has("connect4"), "the game is still in the library"
    card = next(item for item in catalog.storefront()["games"] if item["id"] == "connect4")
    assert card["installed"] is True
