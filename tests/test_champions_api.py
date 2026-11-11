"""The champion creator and tournament doors on the Desktop backend."""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


class FakeLlm:
    def __init__(self, refuse_task=False):
        self.refuse_task = refuse_task
        self.calls = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("task") and self.refuse_task:
            self.refuse_task = False
            raise PermissionError("task gate closed for the test")
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
    spec = importlib.util.spec_from_file_location("champions_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(module, "_config", lambda: {
        "model": {"default": "test-model", "provider": "nous"},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    module._plugin_llm = lambda: FakeLlm()
    return module


def save(api, name="Rook", brief="Play the long game."):
    saved = api.champions_save({"champion": {"name": name, "brief": brief}})
    assert saved["ok"], saved
    return saved["champion"]


def test_the_creator_lists_built_in_avatars_and_the_one_model(api):
    view = api.champions_view()
    assert view["ok"] is True
    assert {item["id"] for item in view["avatars"]} >= {"knight", "rook", "queen"}
    assert view["colors"]
    assert view["model_ready"] is True
    assert view["brain"]["model"] == "test-model"
    assert view["limits"]["brief"] == 600
    assert view["divisions"][0]["id"] == "prompt"
    assert {item["id"] for item in view["games"]} >= {"connect4", "gomoku", "doctrine-arena"}
    assert [bot["id"] for bot in view["bots"]] == ["bot-beginner", "bot-intermediate", "bot-advanced", "bot-expert"]


def test_save_export_import_and_delete(api):
    champion = save(api)
    assert api.champions_view()["champions"][0]["name"] == "Rook"
    assert api.champions_save({"champion": {"name": "", "brief": "x"}})["ok"] is False

    exported = api.champions_export({"id": champion["id"]})
    assert exported["ok"] and "gamecenter-champion" in exported["text"]
    assert exported["filename"].endswith(".champion.json")

    imported = api.champions_import({"text": exported["text"]})
    assert imported["ok"] and imported["champion"]["id"] != champion["id"]
    assert imported["champion"]["name"] == "Rook (2)"
    assert api.champions_import({"text": "junk"})["ok"] is False

    assert api.champions_delete({"id": champion["id"]})["ok"] is True
    assert api.champions_delete({"id": "champ-00000000"})["ok"] is False


def test_no_model_still_lets_the_computer_spar_but_not_champions(api, monkeypatch):
    monkeypatch.setattr(api, "_config", lambda: {"plugins": {"enabled": ["hermes-gameshelf"]}})
    monkeypatch.setattr(api, "_plugin_llm", lambda: None)
    view = api.champions_view()
    assert view["model_ready"] is False

    champion = save(api)
    refused = api.tournament_start({"champions": [champion["id"]], "bots": ["beginner"],
                                    "games": ["connect4"], "division": "open"})
    assert refused["ok"] is False
    assert "Champions need a model" in refused["text"]

    started = api.tournament_start({"bots": ["beginner", "expert"], "games": ["connect4"],
                                    "division": "open", "seed": 1})
    assert started["ok"], started
    status = wait(api, started["id"])
    assert status["status"] == "done"
    assert status["played"] == 2


def test_prompt_division_is_champions_only_and_open_division_takes_bots(api):
    one = save(api, "One")
    two = save(api, "Two")
    refused = api.tournament_start({"champions": [one["id"], two["id"]], "bots": ["beginner"],
                                    "games": ["connect4"], "division": "prompt"})
    assert refused["ok"] is False and "champions only" in refused["text"]

    many = api.tournament_start({"champions": [one["id"]], "bots": ["beginner"],
                                 "games": ["connect4"], "division": "prompt"})
    assert many["ok"] is False

    allowed = api.tournament_start({"champions": [one["id"]], "bots": ["beginner"],
                                    "games": ["connect4"], "division": "open", "seed": 2})
    assert allowed["ok"], allowed


def test_a_tournament_reports_progress_ratings_and_replays(api):
    one = save(api, "One")
    two = save(api, "Two")
    started = api.tournament_start({"champions": [one["id"], two["id"]], "bots": ["expert"],
                                    "games": ["gomoku"], "division": "open", "seed": 3})
    assert started["ok"], started
    assert started["estimate"]["games"] == 6

    status = wait(api, started["id"])
    assert status["status"] == "done"
    assert status["played"] == 6
    assert status["names"][one["id"]] == "One"
    assert status["leaderboard"]
    overall = api.champions_view()["ratings"]
    assert overall[one["id"]]["games"] == 4 and overall[one["id"]]["rating"] > 0

    replay = api.tournament_replay(started["id"], 0)
    assert replay["ok"] is True
    assert len(replay["frames"]) == status["results"][0]["plies"] + 1
    last = replay["frames"][-1]
    assert last["status"] == status["results"][0]["status"]
    assert last["white"] in {"One", "Two", "Computer (Expert)"}
    assert api.tournament_replay(started["id"], 99)["ok"] is False

    saved = api.tournament_export({"id": started["id"]})
    assert saved["ok"] and "gamecenter-tournament" in saved["text"]
    # A reloaded result file can still be watched.
    api._RUNS.clear()
    again = api.tournament_replay(started["id"], 1)
    assert again["ok"] is True and again["frames"]


def test_doctrine_games_are_replayed_as_an_arena(api):
    one = save(api, "One")
    two = save(api, "Two")
    started = api.tournament_start({"champions": [one["id"], two["id"]], "games": ["doctrine-arena"],
                                    "division": "prompt", "seed": 4})
    assert started["ok"], started
    status = wait(api, started["id"])
    assert status["status"] == "done" and status["played"] == 2
    replay = api.tournament_replay(started["id"], 0)
    assert replay["ok"] and replay["frames"][0]["view"] == "arena"
    assert replay["frames"][0]["frames"]


def test_the_caps_are_shown_before_the_tournament_starts(api):
    people = [save(api, f"P{i}") for i in range(8)]
    refused = api.tournament_start({"champions": [p["id"] for p in people],
                                    "games": ["connect4", "reversi", "checkers", "gomoku",
                                              "kalah", "chessboard", "go", "hex", "breakthrough"],
                                    "division": "prompt"})
    assert refused["ok"] is False
    assert "entrants" in refused["text"] or "games" in refused["text"]
    assert api.tournament_start({"champions": [p["id"] for p in people], "games": ["connect4"],
                                 "division": "prompt", "cap_games": 10})["ok"] is False


def test_a_running_tournament_can_be_stopped(api):
    one = save(api, "One")
    two = save(api, "Two")
    started = api.tournament_start({"champions": [one["id"], two["id"]], "games": ["connect4", "gomoku"],
                                    "division": "prompt", "seed": 5})
    assert started["ok"], started
    stopped = api.tournament_stop({"id": started["id"]})
    assert stopped["ok"] is True
    status = wait(api, started["id"])
    assert status["status"] == "stopped"
    assert status["played"] <= status["total"]


def test_prompt_division_uses_one_model_for_every_champion(api):
    llm = FakeLlm()
    api._plugin_llm = lambda: llm
    one = api.champions_save({"champion": {"name": "One", "brief": "b",
                                           "brain": {"kind": "model", "model": "other-model"}}})["champion"]
    two = save(api, "Two")
    started = api.tournament_start({"champions": [one["id"], two["id"]], "games": ["connect4"],
                                    "division": "prompt", "seed": 6})
    assert started["ok"], started
    wait(api, started["id"])
    assert llm.calls, "champions must play through the model"
    for call in llm.calls:
        assert "model" not in call and "provider" not in call, call
        assert call.get("task") == "gameshelf_opponent"

    llm.calls.clear()
    started = api.tournament_start({"champions": [one["id"]], "bots": ["beginner"], "games": ["connect4"],
                                    "division": "open", "seed": 7})
    assert started["ok"], started
    wait(api, started["id"])
    assert any(call.get("model") == "other-model" for call in llm.calls), llm.calls


def test_a_tournament_result_file_can_be_imported_and_watched(api):
    payload = {"kind": "gamecenter-tournament", "schema_version": 1,
               "champions": [{"id": "champ-aaaaaaaa", "name": "Rook"}],
               "tournament": {"id": "tour-abc12345", "status": "done",
                              "results": [{"game": "connect4", "white": "champ-aaaaaaaa",
                                           "black": "champ-bbbbbbbb", "status": "win",
                                           "winner": "white",
                                           "moves": ["1", "2", "1", "2", "1", "2", "1"]}]}}
    imported = api.tournament_import({"text": json.dumps(payload)})
    assert imported["ok"] is True and imported["id"] == "tour-abc12345"
    assert api.tournament_import({"text": json.dumps(payload)})["ok"] is False
    status = api.tournament_status("tour-abc12345")
    assert status["played"] == 1
    assert status["names"]["champ-aaaaaaaa"] == "Rook"
    replay = api.tournament_replay("tour-abc12345", 0)
    assert replay["ok"] is True and len(replay["frames"]) == 8
    assert replay["names"]["white"] == "Rook"
    assert replay["frames"][-1]["white"] == "Rook"
    assert replay["frames"][-1]["status"] == "win"

    hostile = {"kind": "gamecenter-tournament", "schema_version": 1,
               "tournament": {"id": "../../etc/passwd", "results": []}}
    assert api.tournament_import({"text": json.dumps(hostile)})["ok"] is False
    assert api.tournament_import({"text": "junk"})["ok"] is False
    assert api.tournament_import({"text": "x" * 2000001})["ok"] is False


def test_a_tournament_id_cannot_read_another_file(api):
    for bad in ("../../config", "../state", "tour-123", "tour-zzzzzzzz", ""):
        answer = api.tournament_status(bad)
        assert answer["ok"] is False, bad
        assert "No tournament" in answer["text"]
    assert api.tournament_replay("../../etc/passwd", 0)["ok"] is False
    assert api.tournament_export({"id": "../x"})["ok"] is False


def wait(api, tour_id, seconds=60.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = api.tournament_status(tour_id)
        if status.get("status") != "running":
            return status
        time.sleep(0.02)
    raise AssertionError(f"tournament did not finish: {api.tournament_status(tour_id)}")


def test_playbook_routes_and_spar(api):
    champion = save(api)
    book = {'read': ['What threatens me?', 'What can I improve?'], 'tactics': ['Play carefully.'], 'scout': 'Watch the endgame.', 'voice': 'Calm.'}
    first = api.playbook_save({'champion': champion['id'], 'name': 'First', 'playbook': book})
    second = api.playbook_save({'champion': champion['id'], 'name': 'Second', 'playbook': book})
    assert first['ok'] and second['ok']
    assert api.playbook_select({'champion': champion['id'], 'version': first['version']['id']})['ok']
    assert api.playbook_view(champion['id'])['current']['id'] == first['version']['id']
    view = api.champions_view()
    assert view['playbook_limits'] and 'pet' in view and view['champions'][0]['versions'] == 2
    class ReadingLlm(FakeLlm):
        def complete(self, **kwargs):
            answer = super().complete(**kwargs)
            answer.text = 'Look ahead.\nMOVE: ' + answer.text
            return answer
    api._plugin_llm = lambda: ReadingLlm()
    started = api.playbook_test_start({'champion': champion['id'], 'game': 'connect4'})
    assert started['ok']
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        status = api.playbook_test_status(started['id'])
        if status['status'] != 'running': break
        time.sleep(.02)
    assert status['status'] == 'done' and status['reads']


def test_models_do_not_expose_credentials(api):
    result = api.models({'model': {'default': 'main', 'provider': 'local', 'aliases': {'Small': 'small'}, 'base_url': 'http://localhost', 'key': 'secret'}, 'providers': {'local': {'models': ['small', 'large'], 'base_url': 'http://localhost', 'key': 'secret'}}})
    assert result['ok'] and len(result['routes']) == 3
    assert 'secret' not in json.dumps(result) and 'base_url' not in json.dumps(result)


def test_old_champion_file_loads(api):
    folder = api._data_root() / 'champions'
    folder.mkdir(parents=True)
    (folder / 'champ-12345678.json').write_text(json.dumps({'schema_version': 1, 'id': 'champ-12345678', 'name': 'Old', 'brief': 'Play well.'}))
    champion = api._store().get('champ-12345678')
    assert champion['name'] == 'Old' and champion['brain']['kind'] == 'model'
    assert champion['playbook'] == ''
