"""The hub: discovery, the external game.json contract, and games that fail to load."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGINS = ROOT.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog, plugin_roots  # noqa: E402
from shelf.commands import run  # noqa: E402

EXAMPLE = ROOT / "examples" / "hello-game"


def _plugin(root: Path, name: str, manifest: dict, *, game_py: str | None = None) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plugin.yaml").write_text(f"name: {name}\nversion: \"0.1.0\"\n", encoding="utf-8")
    (folder / "game.json").write_text(json.dumps(manifest), encoding="utf-8")
    if game_py is not None:
        (folder / "game.py").write_text(game_py, encoding="utf-8")
    return folder


def _external(**overrides) -> dict:
    manifest = {
        "id": "my-game",
        "schema_version": 1,
        "plugin_id": "my-plugin",
        "title": "My Game",
        "summary": "A game with its own screen.",
        "kind": "external",
        "desktop_route": "/my-game",
    }
    manifest.update(overrides)
    return manifest


def _own(catalog: Catalog, *game_ids: str) -> None:
    for game_id in game_ids:
        catalog.library.add(game_id)


def test_plugin_roots_follow_hermes_home_and_the_active_profile(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("HERMES_PROFILE", "dev")
    roots = [str(item) for item in plugin_roots()]
    assert roots[0] == str(tmp_path / "home" / "plugins"), "installed plugins are ranked first"
    assert str(tmp_path / "home" / "profiles" / "dev" / "plugins") in roots
    assert str(ROOT.parent) in roots, "the folder holding this plugin is still scanned"
    assert str(tmp_path / "user" / ".hermes" / "plugins") not in roots, (
        "an isolated HERMES_HOME does not scan the default home"
    )
    assert len(roots) == len(set(roots))


def test_an_isolated_hermes_home_ignores_the_default_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "isolated"))
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    _plugin(tmp_path / "user" / ".hermes" / "plugins", "my-plugin", _external())
    catalog = Catalog(plugin_roots(), tmp_path / "data", {"allow_ai": True})
    assert not catalog.has("my-game"), "another home's plugins are not loaded here"
    _plugin(tmp_path / "isolated" / "plugins", "my-plugin", _external())
    assert Catalog(plugin_roots(), tmp_path / "data", {"allow_ai": True}).has("my-game")


def test_a_symlinked_install_still_sees_the_other_plugins(tmp_path: Path, monkeypatch) -> None:
    real = tmp_path / "somewhere" / "else" / "hermes-gameshelf"
    real.mkdir(parents=True)
    (real / "plugin.yaml").write_text("name: hermes-gameshelf\n", encoding="utf-8")
    (real / "connect4").mkdir()
    (real / "connect4" / "game.json").write_text(
        (ROOT / "connect4" / "game.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    (real / "connect4" / "game.py").write_text(
        (ROOT / "connect4" / "game.py").read_text(encoding="utf-8"), encoding="utf-8"
    )
    home = tmp_path / "home"
    (home / "plugins").mkdir(parents=True)
    (home / "plugins" / "hermes-gameshelf").symlink_to(real, target_is_directory=True)
    foreign = _plugin(
        home / "plugins",
        "my-plugin",
        _external(),
    )
    assert foreign.is_dir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    catalog = Catalog(
        plugin_roots(),
        tmp_path / "data",
        {"allow_ai": True},
        enabled=lambda name: name in {"hermes-gameshelf", "my-plugin"},
    )
    assert catalog.has("connect4"), "a symlinked install must not hide the games"
    assert catalog.has("my-game"), "another plugin in $HERMES_HOME/plugins is found"


def test_external_game_shows_a_card_and_opens_its_own_screen(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(plugins, "my-plugin", _external())
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    card = catalog.card("my-game")
    assert card is not None and card["kind"] == "external"
    assert card["plugin_id"] == "my-plugin"
    assert card["desktop_route"] == "/my-game"
    assert card["title"] == "My Game" and card["summary"] == "A game with its own screen."
    assert "error" not in card
    assert "my-game:" in catalog.list_text()
    _own(catalog, "my-game")
    assert [item["id"] for item in catalog.cards()] == ["my-game"]
    assert "opens its own screen" in run(catalog, "my-game new", source="command")


def test_a_bad_external_manifest_is_one_friendly_error_on_its_card(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(plugins, "my-plugin", _external(desktop_route="https://evil.example/x"))
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    card = catalog.card("my-game")
    assert card is not None, "a bad route still gets a card"
    assert "desktop_route" in card["error"]
    _own(catalog, "my-game")
    said = run(catalog, "my-game new", source="command")
    assert said.startswith("My Game could not start.")
    assert "desktop_route" in said
    assert "chessboard:" in Catalog([PLUGINS], tmp_path / "data", {"allow_ai": True}).list_text()


def test_a_mismatched_plugin_id_and_schema_are_refused(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(plugins, "my-plugin", _external(plugin_id="someone-else"))
    _plugin(plugins, "second-plugin", _external(id="other", schema_version=2, plugin_id="second-plugin"))
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    assert "plugin_id" in catalog.card("my-game")["error"]
    assert "schema_version" in catalog.card("other")["error"]


def test_a_manifest_with_no_usable_id_is_skipped_with_a_problem(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    bad_id = plugins / "bad-id"
    bad_id.mkdir(parents=True)
    (bad_id / "game.json").write_text(json.dumps(_external(id="Not Valid!")), encoding="utf-8")
    no_title = plugins / "no-title"
    no_title.mkdir()
    (no_title / "game.json").write_text(json.dumps({**_external(), "title": ""}), encoding="utf-8")
    broken = plugins / "broken-plugin"
    broken.mkdir()
    (broken / "game.json").write_text("{not json", encoding="utf-8")
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    assert not catalog.has("my-game")
    assert any("id must be lowercase" in problem for problem in catalog.problems)
    assert any("no title" in problem for problem in catalog.problems)
    assert any("could not be read" in problem for problem in catalog.problems)


def test_a_game_that_fails_on_import_shows_one_friendly_error(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(
        plugins,
        "bad-plugin",
        {
            "id": "broken",
            "title": "Broken",
            "summary": "It does not load.",
            "entry": "game.py",
        },
        game_py="raise RuntimeError('boom at import')\n",
    )
    catalog = Catalog([plugins, ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "broken", "connect4")
    said = run(catalog, "broken new", source="command")
    assert said == "Broken could not start. RuntimeError: boom at import"
    # The Center and the other games keep working.
    assert "connect4:" in catalog.list_text()
    assert "Red to move." in run(catalog, "connect4 new", source="command")


def test_a_game_whose_factory_raises_shows_one_friendly_error(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(
        plugins,
        "bad-plugin",
        {"id": "broken", "title": "Broken", "entry": "game.py"},
        game_py="def create(root, settings):\n    raise ValueError('no seats')\n",
    )
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "broken")
    assert run(catalog, "broken new", source="command") == (
        "Broken could not start. ValueError: no seats"
    )
    assert catalog.picture("broken") is None


def test_a_game_without_create_says_so_once(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(
        plugins,
        "bad-plugin",
        {"id": "empty", "title": "Empty", "entry": "game.py"},
        game_py="HELP = []\n",
    )
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "empty")
    assert run(catalog, "empty help", source="command") == "Empty could not start. AttributeError: no create()"


def test_our_games_use_our_kit_even_when_another_kit_is_loaded_first(tmp_path: Path, monkeypatch) -> None:
    import importlib.util
    import types

    fake = tmp_path / "classic-games"
    fake.mkdir()
    (fake / "kit.py").write_text(
        "class Table:\n"
        "    def __init__(self, *args, **kwargs):\n"
        "        raise RuntimeError('someone else kit')\n",
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_file_location("kit", fake / "kit.py")
    assert spec and spec.loader
    foreign = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(foreign)
    assert isinstance(foreign, types.ModuleType)
    monkeypatch.syspath_prepend(str(fake))
    monkeypatch.setitem(sys.modules, "kit", foreign)
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "connect4")
    said = run(catalog, "connect4 new", source="command")
    assert "Red to move." in said, said
    assert "someone else kit" not in said


def test_one_plugin_folder_reached_twice_is_scanned_once(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    folder = _plugin(plugins, "my-plugin", _external())
    mirror = tmp_path / "mirror"
    mirror.mkdir()
    (mirror / "my-plugin").symlink_to(folder, target_is_directory=True)
    catalog = Catalog([plugins, mirror], tmp_path / "data", {"allow_ai": True})
    assert [card["id"] for card in catalog.storefront()["store"]] == ["my-game"]
    assert catalog.problems == [], "a symlinked folder is not a second copy"


def test_a_second_copy_of_one_plugin_does_not_add_more_games(tmp_path: Path) -> None:
    first = tmp_path / "a-plugins"
    second = tmp_path / "b-plugins"
    _plugin(first, "my-plugin", _external())
    _plugin(second, "my-plugin", _external(id="my-game-two", title="Second copy"))
    catalog = Catalog([first, second], tmp_path / "data", {"allow_ai": True})
    assert catalog.has("my-game")
    assert not catalog.has("my-game-two"), "a stale second copy must not add games"
    assert any("already installed from" in problem for problem in catalog.problems)


def test_an_installed_copy_beats_a_copy_beside_a_checkout(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    checkout = tmp_path / "checkout"
    _plugin(checkout, "my-plugin", _external(summary="old copy"))
    installed = tmp_path / "home" / "plugins"
    _plugin(installed, "my-plugin", _external(summary="installed copy"))
    # The checkout is scanned first; the installed copy must still win.
    catalog = Catalog([checkout, installed], tmp_path / "data", {"allow_ai": True})
    card = catalog.card("my-game")
    assert card is not None and card["summary"] == "installed copy"
    assert not [problem for problem in catalog.problems if "my-game" in problem]


def test_our_own_folder_beats_a_copy_in_the_plugins_folder(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    installed = tmp_path / "home" / "plugins"
    _plugin(
        installed,
        "hermes-gameshelf",
        {"id": "stale-game", "title": "Stale", "entry": "game.py", "kind": "table"},
        game_py="def create(root, settings):\n    return None\n",
    )
    catalog = Catalog([installed, ROOT], tmp_path / "data", {"allow_ai": True})
    assert catalog.has("connect4"), "the running copy of this plugin wins"
    assert not catalog.has("stale-game"), "an older installed copy adds no games"


def test_a_route_is_used_exactly_as_validated(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(plugins, "my-plugin", _external(desktop_route="  /hello  "))
    card = Catalog([plugins], tmp_path / "data", {"allow_ai": True}).card("my-game")
    assert card is not None
    assert card["desktop_route"] == "/hello"
    assert "error" not in card


def test_a_manifest_that_is_not_utf8_is_skipped_not_a_crash(tmp_path: Path) -> None:
    folder = tmp_path / "plugins" / "my-plugin"
    folder.mkdir(parents=True)
    (folder / "game.json").write_bytes(b"\xff\xfe{\"id\": \"my-game\"")
    catalog = Catalog([tmp_path / "plugins"], tmp_path / "data", {"allow_ai": True})
    assert not catalog.has("my-game")
    assert any("could not be read" in problem for problem in catalog.problems)


def test_a_symlinked_install_keeps_its_installed_rank(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    real = tmp_path / "checkout" / "my-plugin"
    _plugin(tmp_path / "checkout", "my-plugin", _external(summary="the symlinked install"))
    (home / "plugins").mkdir(parents=True)
    (home / "plugins" / "my-plugin").symlink_to(real, target_is_directory=True)
    _plugin(home / "plugins", "my-plugin-old", _external(summary="another installed copy"))
    catalog = Catalog(plugin_roots(), tmp_path / "data", {"allow_ai": True})
    card = catalog.card("my-game")
    assert card is not None and card["summary"] == "the symlinked install"


def test_a_sibling_plugin_cannot_take_a_shipped_game_id(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    plugins = tmp_path / "home" / "plugins"
    _plugin(
        plugins,
        "other-plugin",
        {
            "id": "connect4",
            "schema_version": 1,
            "plugin_id": "other-plugin",
            "title": "Fake Four",
            "entry": "game.py",
            "kind": "table",
        },
        game_py="def create(root, settings):\n    return None\n",
    )
    # The installed plugin is scanned first; the shipped game must still win.
    catalog = Catalog([plugins, ROOT], tmp_path / "data", {"allow_ai": True})
    assert catalog.title("connect4") == "Connect Four"
    card = catalog.card("connect4")
    assert card is not None and card["plugin_id"] == "hermes-gameshelf"


def test_a_better_copy_keeps_all_its_games_after_an_id_clash(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "user"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    checkout = tmp_path / "checkout"
    _plugin(checkout, "my-plugin", _external(id="shared", title="Old shared", summary="old"))
    other = tmp_path / "other"
    _plugin(other, "other-plugin", _external(id="taken", title="Taken", plugin_id="other-plugin"))
    installed = tmp_path / "home" / "plugins" / "my-plugin"
    installed.mkdir(parents=True)
    (installed / "plugin.yaml").write_text("name: my-plugin\n", encoding="utf-8")
    for folder, game_id, title in (
        ("a-one", "one", "One"),
        ("b-clash", "taken", "Taken from the better copy"),
        ("c-three", "three", "Three"),
    ):
        nested = installed / folder
        nested.mkdir()
        (nested / "game.json").write_text(
            json.dumps(_external(id=game_id, title=title, summary="installed")), encoding="utf-8"
        )
    catalog = Catalog([other, checkout, tmp_path / "home" / "plugins"], tmp_path / "data", {"allow_ai": True})
    assert catalog.title("one") == "One", "a game accepted before the clash is kept"
    assert catalog.title("three") == "Three", "the better copy keeps its other games"
    assert catalog.title("taken") == "Taken from the better copy", "a better copy wins a game id"


def test_the_enabled_state_accepts_the_folder_name_too(tmp_path: Path, monkeypatch) -> None:
    folder = tmp_path / "plugins" / "my-folder"
    folder.mkdir(parents=True)
    (folder / "plugin.yaml").write_text("name: my-game\n", encoding="utf-8")
    (folder / "game.json").write_text(json.dumps(_external()), encoding="utf-8")
    fake = types.ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("hermes_gameshelf_api_hub", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    plugins = tmp_path / "plugins"
    off = Catalog([plugins], tmp_path / "data", {"allow_ai": True}, enabled=api._enabled({"plugins": {"disabled": ["my-folder"]}}))
    assert not off.has("my-game"), "plugins.disabled may name the folder, not the manifest name"
    on = Catalog([plugins], tmp_path / "data", {"allow_ai": True}, enabled=api._enabled({"plugins": {"enabled": ["my-folder"]}}))
    assert on.has("my-game"), "plugins.enabled may name the folder too"
    named = Catalog([plugins], tmp_path / "data", {"allow_ai": True}, enabled=api._enabled({"plugins": {"enabled": ["my-game"]}}))
    assert named.has("my-game"), "the manifest name still works"


def test_the_example_plugin_installs_plays_and_disables(tmp_path: Path) -> None:
    catalog = Catalog([ROOT / "examples"], tmp_path / "data", {"allow_ai": True})
    assert "hello:" in catalog.list_text()
    assert "Installed Hello" in run(catalog, "install hello", source="command")
    assert [item["id"] for item in catalog.cards()] == ["hello"]
    assert run(catalog, "hello ping", source="command") == "Hello from command. You said: ping."
    assert "Removed Hello" in run(catalog, "remove hello", source="command")
    assert [item["id"] for item in catalog.cards()] == []
    off = Catalog(
        [ROOT / "examples"],
        tmp_path / "data",
        {"allow_ai": True},
        enabled=lambda name: name != "hello-game",
    )
    assert not off.has("hello")
    assert "hello:" not in off.list_text()


def test_the_example_plugin_with_a_broken_game_py_is_friendly(tmp_path: Path) -> None:
    plugins = tmp_path / "plugins"
    _plugin(
        plugins,
        "hello-game",
        json.loads((EXAMPLE / "game.json").read_text(encoding="utf-8")),
        game_py=(EXAMPLE / "game.py").read_text(encoding="utf-8") + "\nraise SystemExit(3)\n",
    )
    catalog = Catalog([plugins], tmp_path / "data", {"allow_ai": True})
    _own(catalog, "hello")
    assert run(catalog, "hello ping", source="command") == "Hello could not start. SystemExit: 3"
