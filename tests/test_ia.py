"""Where games live: Play is curated, Experimental Games is installed, Community is a side link.

The rules this file holds the code to:
- Play is `shelf/curated.json` and nothing else. A manifest cannot promote itself.
- Experimental Games is every installed, enabled plugin's game that Play does not name. Each
  card says, in one plain line, that it has no lobby and no matchmaking.
- One broken plugin is one friendly note. It never takes the page down.
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

from shelf.catalog import Catalog, curated_games, known_games  # noqa: E402

GAME_PY = (
    "class Game:\n"
    "    def command(self, raw, *, source='command', complete=None):\n"
    "        return 'hello:' + str(raw)\n"
    "\n"
    "def create(root, settings=None):\n"
    "    return Game()\n"
)


def _plugin(plugins: Path, name: str, manifest: dict, *, game_py: str | None = GAME_PY) -> Path:
    folder = plugins / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plugin.yaml").write_text(f"name: {name}\nversion: \"0.1.0\"\n", encoding="utf-8")
    (folder / "game.json").write_text(json.dumps(manifest), encoding="utf-8")
    if game_py is not None:
        (folder / "game.py").write_text(game_py, encoding="utf-8")
    return folder


def _table(game_id: str, plugin: str, **overrides) -> dict:
    manifest = {
        "id": game_id,
        "schema_version": 1,
        "plugin_id": plugin,
        "title": game_id.replace("-", " ").title(),
        "summary": "A game another plugin brings.",
        "entry": "game.py",
        "factory": "create",
        "kind": "table",
        "bots": True,
    }
    manifest.update(overrides)
    return manifest


def _home(tmp_path: Path, monkeypatch) -> Path:
    """An isolated Hermes home, so an install means what it means in the real app."""
    home = tmp_path / "hermes"
    (home / "plugins").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _api(monkeypatch, tmp_path: Path, config: dict):
    fake = types.ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("ia_plugin_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(api, "_config", lambda: config)
    return api


def _checker():
    spec = importlib.util.spec_from_file_location("ia_check_game", ROOT / "tools" / "check_game.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- Play is the curated list -------------------------------------------------


def test_the_shipped_play_list_is_short_clean_and_match_ready() -> None:
    shelf = curated_games()
    assert shelf["problems"] == []
    assert shelf["games"][:3] == ["connect4", "reversi", "checkers"]
    assert "doom" not in shelf["games"], "a launch card is not a match-ready table"


def test_play_holds_exactly_the_curated_games_and_nothing_else(tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    play = catalog.play_cards()
    assert [card["id"] for card in play] == curated_games()["games"]
    assert all(card["kind"] == "table" and card["bots"] for card in play), "Play is seats and turns"
    assert catalog.play_cards() and catalog.curated_problems == []


def test_no_game_sits_in_play_and_your_games_at_once(tmp_path: Path) -> None:
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    play = {card["id"] for card in catalog.play_cards()}
    your = {card["id"] for card in catalog.your_games()}
    assert play and your
    assert not (play & your), "one card per game: nothing may be listed twice"


def test_a_plugin_that_calls_itself_curated_stays_out_of_play(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    _plugin(
        home / "plugins",
        "pushy-game",
        _table(
            "pushy",
            "pushy-game",
            curated=True,
            match_ready=True,
            in_play=True,
            play=True,
            verified=True,
            reviewed=True,
        ),
    )
    catalog = Catalog([home / "plugins", ROOT], tmp_path / "data", {"allow_ai": True})
    assert [card["id"] for card in catalog.play_cards()] == curated_games()["games"]
    assert catalog.in_play("pushy") is False, "a manifest can never promote itself"
    your = {card["id"]: card for card in catalog.your_games()}
    assert "pushy" in your, "it still gets a card of its own, clearly labelled"
    assert your["pushy"]["line"] == "This game has no screen of its own. No lobby or matchmaking."


def test_another_plugin_cannot_borrow_a_curated_id(tmp_path: Path, monkeypatch) -> None:
    """A curated id is only that game when this plugin ships it."""
    home = _home(tmp_path, monkeypatch)
    _plugin(home / "plugins", "copycat-game", _table("connect4", "copycat-game"))
    catalog = Catalog([home / "plugins"], tmp_path / "data", {"allow_ai": True})
    assert catalog.in_play("connect4") is True, "the list names the id"
    assert catalog.play_cards() == [], "but Play only shows the game this plugin ships"
    your = {card["id"]: card for card in catalog.your_games()}
    assert "connect4" in your, "the impostor still gets a card of its own"
    assert your["connect4"]["plugin"] == "copycat-game"
    assert your["connect4"]["opens"] == "none"
    assert your["connect4"]["line"] == "This game has no screen of its own. No lobby or matchmaking."


def test_the_curated_list_is_the_only_way_in(tmp_path: Path) -> None:
    empty = Catalog([ROOT], tmp_path / "one", {"allow_ai": True}, curated=[])
    assert empty.play_cards() == [], "with an empty list, Play is empty"
    one = Catalog([ROOT], tmp_path / "two", {"allow_ai": True}, curated=["connect4", "nope", "Bad Id"])
    assert [card["id"] for card in one.play_cards()] == ["connect4"]
    assert {card["id"] for card in one.your_games()} >= {"reversi", "checkers", "doctrine"}


def test_a_bad_curated_entry_is_reported_not_silently_dropped(tmp_path: Path) -> None:
    path = tmp_path / "curated.json"
    path.write_text(json.dumps({"games": ["connect4", "Not A Game", 7, "connect4", "slots"]}), encoding="utf-8")
    shelf = curated_games(path)
    assert shelf["games"] == ["connect4", "slots"]
    assert shelf["problems"], "a typo in the list must be visible to a test, not quietly shrink Play"
    missing = tmp_path / "missing.json"
    assert curated_games(missing)["games"] == []
    assert curated_games(missing)["problems"]


# --- Experimental Games is installed code, treated as outside code --------------------


def test_your_games_lists_an_installed_plugin_it_does_not_curate(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    _plugin(home / "plugins", "other-game", _table("other", "other-game"))
    catalog = Catalog([home / "plugins", ROOT], tmp_path / "data", {"allow_ai": True})
    your = {card["id"]: card for card in catalog.your_games()}
    assert "other" in your
    assert your["other"]["plugin"] == "other-game", "the card names the plugin it came from"
    assert your["other"]["opens"] == "none", "Game Center does not seat outside code at its table"
    assert "No lobby or matchmaking" in your["other"]["line"]


def test_a_copy_beside_the_checkout_is_not_installed(tmp_path: Path, monkeypatch) -> None:
    _home(tmp_path, monkeypatch)
    beside = tmp_path / "checkout"
    _plugin(beside, "side-game", _table("side", "side-game"))
    catalog = Catalog([beside], tmp_path / "data", {"allow_ai": True})
    assert catalog.your_games() == [], "only an installed plugin's game belongs in Experimental Games"


def test_a_disabled_plugin_is_nowhere(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    _plugin(home / "plugins", "off-game", _table("off", "off-game"))
    catalog = Catalog(
        [home / "plugins", ROOT],
        tmp_path / "data",
        {"allow_ai": True},
        enabled=lambda name: name != "off-game",
    )
    assert "off" not in {card["id"] for card in catalog.your_games()}
    assert "off" not in {card["id"] for card in catalog.play_cards()}


def test_a_broken_plugin_is_one_friendly_note_and_never_breaks_the_page(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    plugins = home / "plugins"
    # A card whose own screen has no usable address: one plain sentence, no Open.
    _plugin(plugins, "bad-route", {
        "id": "bad-route",
        "schema_version": 1,
        "plugin_id": "bad-route",
        "title": "Bad Route",
        "kind": "external",
        "desktop_route": "https://evil.example/x",
    }, game_py=None)
    # A table game whose module cannot even be imported: still one card, still no crash.
    _plugin(plugins, "broken-game", _table("broken", "broken-game"), game_py="raise RuntimeError('boom')\n")
    catalog = Catalog([plugins, ROOT], tmp_path / "data", {"allow_ai": True})

    your = {card["id"]: card for card in catalog.your_games()}
    assert set(your) >= {"bad-route", "broken", "doctrine"}
    bad = your["bad-route"]
    assert bad["opens"] == "none"
    assert bad["line"] == "This game's own screen cannot be opened here. No lobby or matchmaking.", \
        "a broken plugin gets one plain note, not a developer message"
    assert "desktop_route" in bad["error"], "the technical reason stays in the card data"
    # The rest of the page is untouched by either broken plugin.
    assert [card["id"] for card in catalog.play_cards()] == curated_games()["games"]
    loaded = catalog._load("broken")
    assert isinstance(loaded, str) and loaded.startswith("Broken could not start.")
    assert "Traceback" not in loaded


def test_a_known_plugin_without_game_json_says_the_route_is_unchecked(tmp_path: Path, monkeypatch) -> None:
    shelf = known_games()
    assert shelf["problems"] == []
    assert "agent-hold-em" in shelf["plugins"], "the short hand-kept list starts with agent-hold-em"
    assert shelf["plugins"]["agent-hold-em"]["route"] == "", "no route is written until one is checked by hand"

    home = _home(tmp_path, monkeypatch)
    folder = home / "plugins" / "agent-hold-em"
    folder.mkdir(parents=True)
    (folder / "plugin.yaml").write_text("name: agent-hold-em\nversion: \"0.1.0\"\n", encoding="utf-8")
    catalog = Catalog([home / "plugins"], tmp_path / "data", {"allow_ai": True})
    cards = {card["id"]: card for card in catalog.your_games()}
    assert "agent-hold-em" in cards, "an installed plugin we know by name still gets a card"
    assert cards["agent-hold-em"]["opens"] == "none"
    assert "not been checked" in cards["agent-hold-em"]["line"]
    assert "Traceback" not in cards["agent-hold-em"]["line"]


def test_a_known_plugin_screen_opens_only_when_a_route_was_written(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    folder = home / "plugins" / "agent-hold-em"
    folder.mkdir(parents=True)
    (folder / "plugin.yaml").write_text("name: agent-hold-em\n", encoding="utf-8")
    known = {"agent-hold-em": {"id": "agent-hold-em", "title": "Agent Hold'Em", "summary": "", "route": "/hold-em"}}
    catalog = Catalog([home / "plugins"], tmp_path / "data", {"allow_ai": True}, known=known)
    card = {item["id"]: item for item in catalog.your_games()}["agent-hold-em"]
    assert card["opens"] == "screen" and card["desktop_route"] == "/hold-em"
    assert card["line"] == "Opens in its own screen. No lobby or matchmaking."


def test_a_known_plugin_is_not_a_shop(tmp_path: Path, monkeypatch) -> None:
    """Not installed means no card, and no marketing: the list only labels what is there."""
    home = _home(tmp_path, monkeypatch)
    catalog = Catalog([home / "plugins"], tmp_path / "data", {"allow_ai": True})
    assert catalog.your_games() == []


# --- the Desktop view ---------------------------------------------------------


def test_the_view_serves_play_your_games_and_a_submit_link(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    _plugin(home / "plugins", "other-game", _table("other", "other-game"))
    api = _api(monkeypatch, tmp_path, {"plugins": {"enabled": ["hermes-gameshelf", "other-game"]}})
    view = api.view()
    play = [card["id"] for card in view["play"]]
    assert play == curated_games()["games"]
    your = {card["id"]: card for card in view["your_games"]}
    assert "other" in your and "doctrine" in your
    assert not set(play) & set(your)
    assert view["submit"]["url"] == "https://games.hermesnet.xyz/submit"
    assert view["play_problems"] == []


def test_the_submit_button_falls_back_to_the_guide_when_unset(tmp_path: Path, monkeypatch) -> None:
    config = {
        "plugins": {
            "entries": {
                "hermes-gameshelf": {
                    "settings": {"submit_url": "", "submit_docs_url": "https://example.org/submit-guide"}
                }
            }
        }
    }
    api = _api(monkeypatch, tmp_path, config)
    view = api.view()
    assert view["submit"] == {"url": "", "docs": "https://example.org/submit-guide"}


def test_a_submit_link_must_be_https(tmp_path: Path, monkeypatch) -> None:
    config = {
        "plugins": {
            "entries": {
                "hermes-gameshelf": {
                    "settings": {"submit_url": "javascript:alert(1)", "submit_docs_url": "http://example.org/x"}
                }
            }
        }
    }
    api = _api(monkeypatch, tmp_path, config)
    assert api.view()["submit"] == {"url": "", "docs": ""}


def test_a_third_party_table_game_never_enters_a_tournament(tmp_path: Path, monkeypatch) -> None:
    home = _home(tmp_path, monkeypatch)
    _plugin(home / "plugins", "other-game", _table("other", "other-game"))
    api = _api(monkeypatch, tmp_path, {"plugins": {"enabled": ["hermes-gameshelf", "other-game"]}})
    catalog = Catalog([home / "plugins", ROOT], tmp_path / "data", {"allow_ai": True})
    catalog.library.add("other")
    games = [row["id"] for row in api._tournament_games(catalog)]
    assert "other" not in games, "not curated, so no tournament and no rating"
    assert "connect4" in games


# --- the match-ready checker --------------------------------------------------


def test_the_checker_passes_every_game_in_play(tmp_path: Path, capsys) -> None:
    tool = _checker()
    for game_id in curated_games()["games"]:
        assert tool.check(ROOT / game_id, 1) is True, f"{game_id} is in Play but fails its own contract"
    printed = capsys.readouterr().out
    assert "PASS  bot versus bot reaches a clear finish" in printed
    assert "PASS  replaying the recorded moves reaches the same result" in printed


def test_the_checker_passes_the_match_ready_example() -> None:
    assert _checker().check(ROOT / "examples" / "match-ready-game", 1) is True


def test_the_checker_reports_a_factory_that_cannot_take_settings(tmp_path: Path) -> None:
    """Game Center always calls create(root, settings), so a one-argument factory fails here too."""
    tool = _checker()
    folder = tmp_path / "one-arg-game"
    folder.mkdir()
    (folder / "game.json").write_text(json.dumps(_table("one-arg", "one-arg-game")), encoding="utf-8")
    (folder / "game.py").write_text(
        "def create(root):\n"
        "    return None\n",
        encoding="utf-8",
    )
    assert tool.check(folder, 1) is False
    assert tool._TEMP == [], "the checker cleans up its throwaway folders"


def test_the_checker_says_plainly_when_a_game_is_not_match_ready(capsys) -> None:
    assert _checker().check(ROOT / "examples" / "hello-game", 1) is False
    printed = capsys.readouterr().out
    assert "FAIL" in printed
    assert "bots must be true" in printed
