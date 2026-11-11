"""Greek-myth names: ladder titles, game subtitles, and the experimental house boss.

The house boss is a virtual champion named after the open model it runs. It must
never exist without a ready model, and it must never be written to the champion
store (it is not the person's champion).
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import myth  # noqa: E402
from shelf.catalog import Catalog  # noqa: E402


class FakeLlm:
    def __init__(self):
        self.calls = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        prompt = kwargs.get("messages", [{}, {"content": ""}])[-1].get("content", "")
        move = "4"
        if "Legal moves: " in prompt:
            move = prompt.split("Legal moves: ", 1)[-1].splitlines()[0].split(", ")[0]
        elif "House cards: " in prompt:
            move = "Sniper"
        return SimpleNamespace(text=move, usage={"total_tokens": 7})


@pytest.fixture
def api(monkeypatch, tmp_path):
    fake = ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        def post(self, _path):
            return lambda handler: handler

    fake.APIRouter = APIRouter
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("myth_bosses_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(module, "_config", lambda: {
        "model": {"default": "Hermes-4-70B", "provider": "nous"},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    module._plugin_llm = lambda: FakeLlm()
    return module


def save(api, name, brief="Play the long game."):
    saved = api.champions_save({"champion": {"name": name, "brief": brief}})
    assert saved["ok"], saved
    return saved["champion"]


def wait(api, tour_id, seconds=60.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = api.tournament_status(tour_id)
        if status.get("status") != "running":
            return status
        time.sleep(0.02)
    raise AssertionError(f"tournament did not finish: {api.tournament_status(tour_id)}")


# The names themselves -------------------------------------------------------

def test_ladder_titles_run_from_wayfarer_to_olympian():
    assert myth.rank_title(1199) == "Wayfarer"
    assert myth.rank_title(1200) == "Messenger"
    assert myth.rank_title(1399) == "Messenger"
    assert myth.rank_title(1400) == "Herald"
    assert myth.rank_title(1599) == "Herald"
    assert myth.rank_title(1600) == "Trickster"
    assert myth.rank_title(1899) == "Trickster"
    assert myth.rank_title(1900) == "Olympian"
    assert myth.rank_title(2600) == "Olympian"


def test_a_bad_rating_never_raises_and_lands_on_the_starting_title():
    for bad in (None, "abc", True, False, float("nan"), float("inf"), object()):
        assert myth.rank_title(bad) == "Herald"


def test_model_labels_are_readable_and_never_raise():
    assert myth.pretty_model("Hermes-4-70B") == "Hermes 4 70B"
    assert myth.pretty_model("deepseek/v4_flash.1017") == "deepseek v4 flash 1017"
    assert myth.pretty_model("  spaced --  name  ") == "spaced name"
    assert myth.pretty_model("") == ""
    assert myth.pretty_model(None) == ""
    assert myth.pretty_model(7) == ""


# Subtitles ------------------------------------------------------------------

def test_a_game_can_carry_a_myth_subtitle_and_play_is_unchanged(tmp_path):
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    store = catalog.storefront()
    arena = next(card for card in store["store"] if card["id"] == "doctrine-arena")
    assert arena["title"] == "Olympus Arena"
    assert arena["subtitle"] == "The arena of the gods"
    dice = next(card for card in store["store"] if card["id"] == "liars-dice")
    assert dice["subtitle"] == "", "the dice card says its name once: no second title under it"
    plain = next(card for card in store["store"] if card["id"] == "connect4")
    assert plain["subtitle"] == ""
    # A subtitle is decoration: the curated Play list is still the only way in.
    assert "doctrine-arena" not in [card["id"] for card in store["play"]]


def test_a_long_or_dirty_subtitle_is_cleaned(tmp_path):
    catalog = Catalog([ROOT], tmp_path / "data", {"allow_ai": True})
    from shelf.directory import Directory

    card = catalog._card(
        {"id": "sub-game", "title": "Sub Game", "kind": "external",
         "subtitle": "  one\nline\tthen   a very long tail that runs past sixty characters  "},
        Directory(catalog.data_root),
    )
    assert card["subtitle"] == "one line then a very long tail that runs past sixty"
    assert len(card["subtitle"]) <= 60
    missing = catalog._card({"id": "plain", "title": "Plain", "kind": "external"},
                            Directory(catalog.data_root))
    assert missing["subtitle"] == ""
    bad = catalog._card({"id": "bad", "title": "Bad", "kind": "external", "subtitle": 7},
                        Directory(catalog.data_root))
    assert bad["subtitle"] == ""


# The house boss -------------------------------------------------------------

def test_the_house_boss_is_hidden_without_a_model(api, monkeypatch):
    monkeypatch.setattr(api, "_config", lambda: {"plugins": {"enabled": ["hermes-gameshelf"]}})
    monkeypatch.setattr(api, "_plugin_llm", lambda: None)
    view = api.champions_view()
    assert view["model_ready"] is False
    assert view["house_bosses"] == []
    assert api.tournament_start({"champions": ["boss-00000000"], "games": ["connect4"],
                                 "division": "open"})["ok"] is False


def test_the_house_boss_is_named_for_the_model_it_runs(api):
    bosses = api._house_bosses(api._config())
    assert len(bosses) == 1
    boss = bosses[0]
    assert boss["name"] == "Hermes 4 70B (boss)"
    assert boss["house"] is True
    assert boss["brain"] == {"kind": "model", "model": "Hermes-4-70B", "provider": "nous"}
    assert boss["runs"] == "Runs Hermes 4 70B through your own provider (nous)."
    assert "hidden" in boss["note"].lower()
    assert len(boss["name"]) <= 32 and len(boss["brief"]) <= 600 and len(boss["motto"]) <= 80
    # The same model keeps the same boss, and it is not in the champion store.
    assert api._house_bosses(api._config())[0]["id"] == boss["id"]
    assert api._store().list() == []


def test_a_local_model_says_where_it_runs(api, monkeypatch):
    monkeypatch.setattr(api, "_config", lambda: {
        "model": {"default": "qwen3-8b", "provider": "local"},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    boss = api._house_bosses(api._config())[0]
    assert boss["runs"] == "Runs qwen3 8b locally on this computer."


def test_a_very_long_model_name_keeps_the_boss_suffix(api, monkeypatch):
    long_name = "hermes-4-very-long-model-name-that-would-overflow"
    monkeypatch.setattr(api, "_config", lambda: {
        "model": {"default": long_name, "provider": "nous"},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    boss = api._house_bosses(api._config())[0]
    assert boss["name"].endswith(" (boss)")
    assert len(boss["name"]) <= 32


def test_the_boss_id_separates_two_local_servers_on_the_same_model(api, monkeypatch):
    monkeypatch.setattr(api, "_config", lambda: {
        "model": {"default": "qwen3-8b", "provider": "local"},
        "auxiliary": {api.MODEL_SLOT: {"provider": "local", "model": "qwen3-8b",
                                       "base_url": "http://127.0.0.1:8001/v1"}},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    first = api._house_bosses(api._config())[0]["id"]
    monkeypatch.setattr(api, "_config", lambda: {
        "model": {"default": "qwen3-8b", "provider": "local"},
        "auxiliary": {api.MODEL_SLOT: {"provider": "local", "model": "qwen3-8b",
                                       "base_url": "http://127.0.0.1:8002/v1"}},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    second = api._house_bosses(api._config())[0]["id"]
    assert first != second


def test_a_retired_boss_keeps_a_plain_name_in_the_leaderboard(api, monkeypatch):
    champion = save(api, "Rook")
    boss = api._house_bosses(api._config())[0]
    started = api.tournament_start({
        "champions": [champion["id"], boss["id"]], "games": ["connect4"],
        "division": "prompt", "seed": 2, "cap_games": 2,
    })
    assert started["ok"], started
    wait(api, started["id"])
    # The model goes away; the boss card is hidden, but its record stays.
    monkeypatch.setattr(api, "_plugin_llm", lambda: None)
    rows = api.champions_view()["leaderboard"]
    row = next(item for item in rows if item["id"] == boss["id"])
    assert row["name"] == "House boss"
    assert row["title"] in {"Wayfarer", "Messenger", "Herald", "Trickster", "Olympian"}


def test_an_imported_tournament_keeps_the_shared_boss_name(api, monkeypatch):
    boss_id = api._house_bosses(api._config())[0]["id"]
    folder = api._data_root() / "tournaments"
    folder.mkdir(parents=True, exist_ok=True)
    tour_id = "tour-12345678"
    (folder / f"{tour_id}.json").write_text(json.dumps({
        "id": tour_id, "status": "done", "played": 1, "total": 1,
        "results": [{"game": "connect4", "white": boss_id, "black": "bot-easy", "winner": "white"}],
        "names": {boss_id: "Hermes 4 70B (boss)"},
    }), encoding="utf-8")
    monkeypatch.setattr(api, "_plugin_llm", lambda: None)  # no boss on this machine
    payload = api._tournament_payload(tour_id)
    assert payload["ok"] is True
    assert payload["names"][boss_id] == "Hermes 4 70B (boss)"


def test_the_boss_can_be_picked_where_a_champion_is(api):
    boss = api._house_bosses(api._config())[0]
    picked = api._champion_pick(boss["id"])
    assert picked is not None and picked["name"] == "Hermes 4 70B (boss)"
    assert api._champion_pick("boss-00000000") is None
    # The ladder door offers the same names as the champion picker.
    ladder = api.online_ladder(game="connect4")
    assert boss["id"] in [row["id"] for row in ladder["champions"]]


def test_a_hidden_boss_cannot_be_picked(api, monkeypatch):
    boss_id = api._house_bosses(api._config())[0]["id"]
    monkeypatch.setattr(api, "_plugin_llm", lambda: None)
    assert api._house_bosses(api._config()) == []
    assert api._champion_pick(boss_id) is None


def test_the_boss_joins_a_tournament_and_is_rated_with_a_ladder_title(api):
    champion = save(api, "Rook")
    view = api.champions_view()
    boss = view["house_bosses"][0]
    assert boss["name"] == "Hermes 4 70B (boss)"
    started = api.tournament_start({
        "champions": [champion["id"], boss["id"]], "games": ["connect4"],
        "division": "prompt", "seed": 1, "cap_games": 4,
    })
    assert started["ok"], started
    status = wait(api, started["id"])
    assert status["status"] == "done"
    names = status["names"]
    assert names.get(boss["id"]) == "Hermes 4 70B (boss)"
    # The boss is rated like any champion, and every row carries a myth title.
    board = api.champions_view()["leaderboard"]
    rows = {row["id"]: row for row in board}
    assert boss["id"] in rows and champion["id"] in rows
    assert rows[boss["id"]]["title"] == myth.rank_title(rows[boss["id"]]["rating"])
    assert rows[boss["id"]]["title"] in {"Wayfarer", "Messenger", "Herald", "Trickster", "Olympian"}
