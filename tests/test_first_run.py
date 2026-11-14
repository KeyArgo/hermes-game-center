"""First run, Settings, and the quiet "someone wants a match" alert.

The page is only a view of these: every rule lives in shelf/setup.py, shelf/who.py
and the /setup, /settings and /alerts routes, so it is all testable without a browser.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.lobby import looking  # noqa: E402
from shelf.setup import MAX_ROWS, RATE_SECONDS, Setup, looking_now  # noqa: E402
from shelf.who import NameBook, Player, identify, name_problem, suggest_name  # noqa: E402

_CONFIG = {
    "plugins": {"entries": {"hermes-gameshelf": {"settings": {"allow_ai": True}}}},
}


def _api(tmp_path: Path, monkeypatch, config: dict | None = None):
    """The real dashboard module, with the shelf data folder and config redirected."""

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake = types.ModuleType("fastapi")
    fake.APIRouter = APIRouter  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("hermes_gameshelf_first_run_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(api, "_config", lambda: config if config is not None else dict(_CONFIG))
    return api


def _looker(folder: Path, name: str = "Bea", player_id: str = "desktop:bea", game: str = "connect4",
            address: str = "") -> str:
    return looking(folder, Player(player_id, name, "desktop", named=True), game, True, address=address)


# --- the welcome -----------------------------------------------------------

def test_the_welcome_is_asked_once_and_never_again(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    view = api.view()
    assert view["setup"]["welcome_needed"] is True
    assert view["player"]["named"] is False
    suggested = view["setup"]["suggested_name"]
    assert suggested and name_problem(suggested) == ""

    answer = api.setup_save({"name": suggested, "games": ["connect4"], "done": True})
    assert answer["ok"] is True
    assert answer["setup"]["welcome_needed"] is False
    assert answer["setup"]["watched"] == {"connect4": True}
    assert answer["player"] == {"name": suggested, "named": True}

    # A later visit, in a brand new process, reads the same answer from disk.
    again = _api(tmp_path, monkeypatch)
    later = again.view()
    assert later["setup"]["welcome_needed"] is False
    assert later["player"]["name"] == suggested
    assert later["setup"]["watched"] == {"connect4": True}


def test_skip_ends_the_welcome_and_asks_for_nothing(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    answer = api.setup_save({"done": True})
    assert answer["ok"] is True
    view = api.view()
    assert view["setup"]["welcome_needed"] is False
    assert view["player"]["named"] is False, "skipping does not invent a name"
    assert view["setup"]["watched"] == {}
    assert view["setup"]["allow_ai"] is True, "skipping changes no other setting"


def test_the_welcome_can_be_opened_again_from_settings(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"name": "Argo", "done": True})
    assert api.view()["setup"]["welcome_needed"] is False
    answer = api.setup_save({"reopen": True})
    assert answer["ok"] is True
    assert api.view()["setup"]["welcome_needed"] is True
    assert api.view()["player"]["name"] == "Argo", "re-opening it keeps the name"

    # Answering it a second time closes it again.
    api.setup_save({"name": "Argo", "done": True})
    assert api.view()["setup"]["welcome_needed"] is False


def test_every_suggested_name_passes_the_same_rules():
    seen = set()
    for seed in ["local", "desktop", "discord:1", "irc:ada", "a", "b"]:
        name = suggest_name(seed)
        assert name_problem(name) == "", f"{seed} suggested an unusable name: {name}"
        assert name == suggest_name(seed), "the same person always sees the same suggestion"
        seen.add(name)
    assert len(seen) > 1, "the suggestion is not one fixed name for everybody"


def test_the_games_offered_in_the_welcome_are_the_play_games(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    games = {item["id"] for item in api.setup_state()["games"]}
    play = {item["id"] for item in api.view()["play"]}
    assert games == play and "connect4" in games
    # A game that is not on the shelf is ignored instead of breaking the save.
    answer = api.setup_save({"games": ["connect4", "not-a-game"], "done": True})
    assert answer["setup"]["watched"] == {"connect4": True}


# --- names -----------------------------------------------------------------

@pytest.mark.parametrize("bad", ["", "!!!", "a", "..", "%%%"])
def test_invalid_names_are_refused_and_nothing_is_saved(tmp_path, monkeypatch, bad):
    api = _api(tmp_path, monkeypatch)
    answer = api.settings_save({"name": bad})
    if not str(bad).strip():
        # An empty field is "no change", never a blank name.
        assert answer["ok"] is True
        assert api.view()["player"]["named"] is False
        return
    assert answer["ok"] is False
    assert answer["text"] in {
        "Use letters or numbers, up to 32 characters.",
        "Use at least two letters or numbers.",
    }
    assert answer["field"] == "name"
    assert api.view()["player"]["named"] is False


@pytest.mark.parametrize("bad", ["fuck", "F.u.c.k", "sh1t", "nigger", "system", "bot", "Hermes"])
def test_offensive_and_reserved_names_are_refused(tmp_path, monkeypatch, bad):
    api = _api(tmp_path, monkeypatch)
    api.settings_save({"name": "Argo"})
    answer = api.settings_save({"name": bad})
    assert answer["ok"] is False, f"{bad} should be refused"
    assert answer["text"] == "Pick a different name."
    assert api.view()["player"]["name"] == "Argo", "the old name stays"

    # The chat command obeys the same filter, so there is one rule, not two.
    assert api.command({"line": f"/games name {bad}"})["text"] == "Pick a different name."
    assert api.view()["player"]["name"] == "Argo"


def test_a_good_name_is_accepted_and_can_be_changed(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    first = api.settings_save({"name": "Argo"})
    assert first["ok"] is True and first["player"]["name"] == "Argo"
    second = api.settings_save({"name": "Scout"})
    assert second["ok"] is True and second["player"]["name"] == "Scout"
    assert api.view()["player"]["name"] == "Scout"
    assert api.command({"line": "/games name Ada"})["text"] == "You are Ada on desktop."
    assert api.view()["player"]["name"] == "Ada"


def test_the_name_rules_are_one_shared_answer():
    assert name_problem("Argo") == ""
    assert name_problem("ada.discord") == ""
    assert name_problem("Blue Wren") == ""
    assert name_problem("") == "Type a name first."
    assert name_problem("a") == "Use at least two letters or numbers."
    assert name_problem("fuck") == "Pick a different name."
    assert name_problem("local") == "Use letters or numbers, up to 32 characters."


def test_names_that_only_contain_the_letters_still_pass():
    """A filter that refuses Ashita or Scunthorpe is a bug, not a safeguard."""
    for good in ["Ashita", "Scunthorpe", "Grape", "Spices", "Therapist", "Mishima", "Wholesome"]:
        assert name_problem(good) == "", f"{good} is an ordinary name"
    for bad in ["fuck", "Fuckyou", "youfuck", "F.u.c.k", "f u c k", "s h i t"]:
        assert name_problem(bad) == "Pick a different name.", f"{bad} is the spelling it is meant to catch"


# --- settings --------------------------------------------------------------

def test_every_game_starts_off_and_the_toggles_persist(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    fresh = api.view()["setup"]
    assert fresh["watched"] == {}, "a new install watches nothing"
    assert fresh["paused"] is False
    assert fresh["ai_choice"] is None

    api.settings_save({"watch": {"connect4": True, "reversi": True}})
    # Read back through a new module: the choice is on disk, not in memory.
    again = _api(tmp_path, monkeypatch)
    assert again.view()["setup"]["watched"] == {"connect4": True, "reversi": True}

    api.settings_save({"watch": {"connect4": False}})
    assert api.view()["setup"]["watched"] == {"reversi": True}
    saved = json.loads((tmp_path / "data" / "setup.json").read_text(encoding="utf-8"))
    assert saved["watched"] == {"reversi": True}


def test_pause_and_ai_choices_persist(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.settings_save({"paused": True, "allow_ai": False})
    view = api.view()
    assert view["setup"]["paused"] is True
    assert view["setup"]["ai_choice"] is False
    assert view["allow_ai"] is False
    # The choice is the profile floor: no game may seat an AI while it is off.
    assert "AI is off" in api.command({"line": "allow-ai connect4 black=local"})["text"]

    api.settings_save({"allow_ai": True})
    assert api.view()["allow_ai"] is True
    assert "Red to move" in api.command({"line": "allow-ai connect4 black=local"})["text"]

    api.settings_save({"allow_ai": None})
    assert api.view()["setup"]["ai_choice"] is None
    assert api.view()["allow_ai"] is True, "None follows the plugin's own setting"


def test_an_unreadable_config_still_turns_ai_off(tmp_path, monkeypatch):
    def refuse():
        raise RuntimeError("no config")

    api = _api(tmp_path, monkeypatch)
    monkeypatch.setattr(api, "_config", refuse)
    api.settings_save({"allow_ai": True})  # the person opted in to AI seats...
    assert api.view()["allow_ai"] is False, "...but a broken config still fails closed"


# --- the quiet alert -------------------------------------------------------

def test_nothing_alerts_until_a_game_is_turned_on(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    _looker(api._data_root())
    assert api.alerts()["count"] == 0
    assert api.view()["alerts"]["rows"] == []

    api.settings_save({"watch": {"connect4": True}})
    alerts = api.alerts()
    assert alerts["count"] == 1
    row = alerts["rows"][0]
    assert (row["name"], row["game"], row["title"], row["key"]) == (
        "Bea", "connect4", "Connect Four", "desktop:bea|connect4")
    assert alerts["source"] == "this Hermes and the chats it shares"


def test_only_the_games_turned_on_are_shown(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"reversi": True}})
    _looker(api._data_root(), game="connect4")
    _looker(api._data_root(), name="Cy", player_id="desktop:cy", game="reversi")
    rows = api.alerts()["rows"]
    assert [row["game"] for row in rows] == ["reversi"]
    assert rows[0]["name"] == "Cy"


def test_the_persons_own_row_never_alerts(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"name": "Argo", "done": True})
    api.settings_save({"watch": {"connect4": True}})
    # The Desktop person is "local"; their own /games looking line is not news to them.
    assert api.command({"line": "/games looking connect4"})["text"]
    assert api.alerts()["count"] == 0
    _looker(api._data_root())
    assert api.alerts()["count"] == 1


def test_the_line_clears_when_the_person_stops_looking(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    _looker(api._data_root())
    assert api.alerts()["count"] == 1
    _looker(api._data_root(), game="stop")
    assert api.alerts()["count"] == 0
    assert api.view()["alerts"]["rows"] == []


def test_pause_hides_the_badge(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    _looker(api._data_root())
    assert api.alerts()["count"] == 1
    api.settings_save({"paused": True})
    assert api.alerts()["count"] == 0
    assert api.view()["alerts"]["count"] == 0
    api.settings_save({"paused": False})
    assert api.alerts()["count"] == 1


def test_dismiss_clears_the_line_and_rate_limits_a_repeat(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    _looker(api._data_root())
    row = api.alerts()["rows"][0]

    cleared = api.alerts_dismiss({"key": row["key"]})
    assert cleared["count"] == 0, "Dismiss clears it at once"
    assert api.view()["alerts"]["rows"] == []

    # Looking again straight away is the repeat the rate limit exists for.
    _looker(api._data_root())
    assert api.alerts()["count"] == 0

    # The window passes: the same person looking again may quietly appear once more.
    folder = api._data_root()
    later = looking_now(folder, Setup(folder), "local", now=time.time() + RATE_SECONDS + 1)
    assert [item["name"] for item in later] == ["Bea"]
    # ...and the row is then treated as live again, so Dismiss can clear it once more.
    assert api.alerts()["count"] == 1


def test_a_join_address_travels_with_the_line(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    _looker(api._data_root(), address="bea.example:2300")
    row = api.alerts()["rows"][0]
    assert row["where"] == "bea.example:2300"


def test_many_lookers_are_all_counted_and_the_list_is_capped(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    folder = api._data_root()
    for index in range(MAX_ROWS + 4):
        _looker(folder, name=f"P{index:02d}", player_id=f"desktop:p{index}")
    rows = looking_now(folder, Setup(folder), "local")
    assert len(rows) == MAX_ROWS + 4
    assert [row["name"] for row in rows] == sorted(row["name"] for row in rows)
    alerts = api.alerts()
    assert alerts["count"] == MAX_ROWS + 4, "the badge counts everyone looking"
    assert len(alerts["rows"]) == MAX_ROWS, "the home page lists a short, sorted set"


def test_the_source_sits_behind_one_function(tmp_path, monkeypatch):
    """The online design replaces this one function; the page and the badge do not change."""
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    seen = {}

    def website(folder, setup, viewer_id="", *, now=None):
        seen["called"] = (str(folder), viewer_id)
        return [{"key": "web:1|connect4", "game": "connect4", "name": "Dee", "where": ""}]

    monkeypatch.setattr(api, "looking_now", website)
    alerts = api.alerts()
    assert [row["name"] for row in alerts["rows"]] == ["Dee"]
    assert alerts["rows"][0]["title"] == "Connect Four"
    assert alerts["count"] == 1
    # The page and the badge read that same function, so both change together.
    assert api.view()["alerts"]["rows"][0]["name"] == "Dee"
    assert seen["called"][1] == "local"


def test_a_broken_setup_file_is_ignored(tmp_path, monkeypatch):
    folder = tmp_path / "data"
    folder.mkdir(parents=True)
    (folder / "setup.json").write_text("{not json", encoding="utf-8")
    api = _api(tmp_path, monkeypatch)
    view = api.view()
    assert view["setup"]["welcome_needed"] is True
    assert view["setup"]["watched"] == {}
    assert api.alerts()["count"] == 0


def test_no_network_and_no_config_write(tmp_path, monkeypatch):
    """This build never calls out, and the person's settings stay in the plugin's folder."""
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"name": "Argo", "games": ["connect4"], "done": True})
    api.settings_save({"watch": {"connect4": True}, "paused": False, "allow_ai": True})
    api.settings_save({"name": "Scout"})
    _looker(api._data_root())
    api.alerts()
    api.alerts_dismiss({"key": "desktop:bea|connect4"})
    written = sorted(path.name for path in (tmp_path / "data").iterdir())
    assert written == ["lobby.json", "players.json", "setup.json"]
    source = (ROOT / "shelf" / "setup.py").read_text(encoding="utf-8")
    for call in ("import urllib", "import requests", "import socket", "http.client", "urlopen("):
        assert call not in source, f"{call} does not belong in the local alert source"


# --- the choice is the same at every door ----------------------------------

def _plugin_module(tmp_path: Path):
    """The plugin's own __init__.py, loaded the way Hermes loads it."""
    name = "hermes_gameshelf_first_run_plugin"
    for stale in [key for key in sys.modules if key == name or key.startswith(name + ".")]:
        del sys.modules[stale]
    spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    module.__package__ = name
    module.__path__ = [str(ROOT)]  # type: ignore[attr-defined]
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_the_ai_choice_covers_chat_as_well_as_the_page(tmp_path):
    module = _plugin_module(tmp_path)

    class Ctx:
        def __init__(self) -> None:
            self.commands: dict = {}
            self.tools: dict = {}

        def get_config(self, key, default=None):
            return {"allow_ai": True}.get(key, default)

        def has_plugin(self, plugin_id: str) -> bool:
            return True

        def register_command(self, name, handler, description="", **_kwargs):
            self.commands[name] = handler

        def register_tool(self, **kwargs):
            self.tools[kwargs["name"]] = kwargs["handler"]

    ctx = Ctx()
    module.register(ctx, data_root=tmp_path / "data", roots=[ROOT.parent])
    says = lambda: ctx.commands["games"]("allow-ai connect4 black=local")
    assert "Red to move" in says(), "with no choice made, the plugin setting is used"

    Setup(tmp_path / "data").set_ai(False)
    assert "AI is off" in says(), "Settings turned AI off, so chat must not seat one"
    tool = json.loads(ctx.tools["games_play"]({"game": "connect4", "line": "allow-ai black=local"}))
    assert "AI is off" in tool["text"], "the plugin's own tool takes the same gate"

    Setup(tmp_path / "data").set_ai(True)
    assert "Red to move" in says(), "turning it back on in Settings applies here too"


def test_apply_choice_leaves_the_setting_alone_until_a_choice_is_made(tmp_path):
    from shelf.setup import apply_choice

    settings = {"allow_ai": True, "role": "referee"}
    assert apply_choice(settings, tmp_path) == settings
    Setup(tmp_path).set_ai(False)
    assert apply_choice(settings, tmp_path) == {"allow_ai": False, "role": "referee"}
    assert settings == {"allow_ai": True, "role": "referee"}, "the caller's dict is not changed"
    Setup(tmp_path).set_ai(None)
    assert apply_choice(settings, tmp_path)["allow_ai"] is True


def test_two_writers_cannot_lose_a_choice(tmp_path):
    """The page polls, the badge polls and a person saves: none may undo another."""
    from concurrent.futures import ThreadPoolExecutor

    folder = tmp_path / "data"
    setup = Setup(folder)
    setup.watch("connect4", True)
    jobs = []
    for index in range(30):
        jobs.append(lambda i=index: setup.watch("reversi", i % 2 == 0))
        jobs.append(lambda: setup.remember_quiet({"a|connect4": {"at": 1.0, "dismissed": False}}, [], now=1.0))
        jobs.append(lambda: looking_now(folder, Setup(folder), "local"))
        jobs.append(lambda: setup.set_paused(False))
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda job: job(), jobs))
    saved = json.loads((folder / "setup.json").read_text(encoding="utf-8"))
    assert saved["watched"].get("connect4") is True, "a concurrent write never drops a watch"
    assert saved["paused"] is False
    assert sorted(path.name for path in folder.iterdir()) == ["setup.json"], "no temporary file is left behind"


def test_a_dismissal_still_hides_them_if_they_stop_and_come_back(tmp_path, monkeypatch):
    """Dismiss is a quiet window, not a one-visit note: a poll in between must not undo it."""
    api = _api(tmp_path, monkeypatch)
    api.setup_save({"done": True})
    api.settings_save({"watch": {"connect4": True}})
    folder = api._data_root()
    _looker(folder)
    key = api.alerts()["rows"][0]["key"]
    assert api.alerts_dismiss({"key": key})["count"] == 0

    _looker(folder, game="stop")
    assert api.alerts()["count"] == 0, "a poll while they are away keeps the dismissal"
    _looker(folder)
    assert api.alerts()["count"] == 0, "coming back inside the window is still a repeat"
    later = looking_now(folder, Setup(folder), "local", now=time.time() + RATE_SECONDS + 1)
    assert [row["name"] for row in later] == ["Bea"], "after the window it may show again"


def test_a_dismissal_that_lands_during_a_poll_is_kept(tmp_path):
    """A poll reads the rows, then a Dismiss arrives, then the poll writes: Dismiss wins."""
    folder = tmp_path / "data"
    setup = Setup(folder)
    key = "desktop:bea|connect4"
    setup.dismiss(key, now=100.0)
    # The poll's own snapshot was taken before that dismissal and says "not dismissed".
    setup.remember_quiet({key: {"at": 90.0, "dismissed": False}}, [], now=100.0)
    assert Setup(folder).data()["quiet"][key]["dismissed"] is True, "the poll did not clear it"
    # Once the window has passed, a live row may be recorded again.
    setup.remember_quiet({key: {"at": 100.0 + RATE_SECONDS + 1, "dismissed": False}}, [], now=100.0 + RATE_SECONDS + 1)
    assert Setup(folder).data()["quiet"][key]["dismissed"] is False
