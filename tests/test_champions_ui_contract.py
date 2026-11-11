"""The Champions page's contract with its own backend.

Every field read here is read by a component in desktop/src/48-playbook.js or
50-champions.js. A rename on either side breaks this test instead of the page.
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


class FakeLlm:
    """A model that reads a playbook, writes its private answers, then moves."""

    def __init__(self):
        self.calls = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        prompt = kwargs.get("messages", [{}, {"content": ""}])[-1].get("content", "")
        move = "4"
        if "Legal moves: " in prompt:
            move = prompt.split("Legal moves: ", 1)[-1].splitlines()[0].split(", ")[0]
        if "Before you move" in prompt:
            text = "Their column is open.\nTake the centre first.\nMOVE: " + move
        else:
            text = move
        return SimpleNamespace(text=text, usage={"total_tokens": 9})


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
    spec = importlib.util.spec_from_file_location("champions_ui_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(module, "_config", lambda: {
        "model": {"default": "test-model", "provider": "nous",
                  "aliases": {"fast": {"model": "small-model", "provider": "nous"}}},
        "providers": {"local-fleet": {"base_url": "http://127.0.0.1:8890/v1",
                                      "models": {"house-model": {}}}},
        "display": {"pet": {"enabled": False, "slug": ""}},
        "plugins": {"enabled": ["hermes-gameshelf"]},
    })
    module._plugin_llm = lambda: FakeLlm()
    return module


PLAYBOOK = {
    "read": ["What did their last move leave open?", "Which column is cheapest to take?"],
    "tactics": ["If they stack one column, then open the other side and keep the trade even."],
    "scout": "Note which side they open and what they do when they are behind.",
    "voice": "Dry and brief, gives credit when it loses.",
}


def champion(api, name="Rook"):
    saved = api.champions_save({"champion": {"name": name, "brief": "Plays the long game."}})
    assert saved["ok"], saved
    return saved["champion"]


def test_the_page_reads_the_caps_it_enforces(api):
    view = api.champions_view()
    limits = view["playbook_limits"]
    # 48-playbook.js maps these exact keys (playbookLimits).
    assert limits["cap_total_words"] == 250
    assert limits["cap_read_questions"] == 3
    assert limits["min_read_questions"] == 2
    assert limits["cap_read_question_words"] == 20
    assert limits["cap_tactics"] == 4
    assert limits["cap_tactic_words"] == 40
    assert limits["cap_scout_words"] == 40
    assert limits["cap_voice_words"] == 40
    assert limits["max_dossier_words"] == 80


def test_the_seven_pet_states_reach_the_page(api):
    pet = api.champions_view()["pet"]
    assert pet["states"] == ["idle", "wave", "run", "jump", "failed", "review", "waiting"]
    # No pet on this host: the page falls back to its own figure and the gallery link.
    assert pet["enabled"] is False
    cells = api.pet_cells("idle", 24)
    assert cells["enabled"] is False
    assert api.pet_view()["states"] == pet["states"]


def test_a_model_route_is_offered_without_a_key(api):
    answer = api.models_view()
    assert answer["ok"] is True
    labels = [route["label"] for route in answer["routes"]]
    assert "Main model" in labels and "fast" in labels
    assert any(route["model"] == "house-model" for route in answer["routes"])
    text = json.dumps(answer)
    assert "api_key" not in text and "base_url" not in text and "sk-" not in text


def words_of(playbook):
    return (sum(len(line.split()) for line in playbook["read"])
            + sum(len(line.split()) for line in playbook["tactics"])
            + len(playbook["scout"].split()) + len(playbook["voice"].split()))


def test_a_playbook_is_saved_as_a_named_version_and_becomes_the_brain(api):
    rook = champion(api)
    assert api.playbook_view(rook["id"])["current"] is None
    total = words_of(PLAYBOOK)

    saved = api.playbook_save({"champion": rook["id"], "name": "Patient wall", "playbook": PLAYBOOK})
    assert saved["ok"], saved
    assert saved["version"]["name"] == "Patient wall"
    assert saved["version"]["playbook"]["words"]["total"] == total

    view = api.playbook_view(rook["id"])
    assert view["current"]["id"] == saved["version"]["id"]
    assert view["versions"][0]["id"] == saved["version"]["id"]
    # The passport line reads the counted block, not a bare number.
    assert view["versions"][0]["words"]["total"] == total

    listed = [row for row in api.champions_view()["champions"] if row["id"] == rook["id"]][0]
    assert listed["playbook"]["id"] == saved["version"]["id"]
    assert listed["versions"] == 1
    assert listed["playbook"]["name"] == "Patient wall"


def test_the_caps_are_refused_with_a_sentence(api):
    rook = champion(api)
    too_long = dict(PLAYBOOK, tactics=["if " + "then " * 40])
    answer = api.playbook_save({"champion": rook["id"], "name": "", "playbook": too_long})
    assert answer["ok"] is False
    assert "40 words" in answer["text"]

    # Every field inside its own cap, and the playbook still over the 250-word whole.
    twenty = " ".join(["word"] * 20)
    forty = " ".join(["word"] * 40)
    stuffed = {"read": [twenty, twenty, twenty], "tactics": [forty] * 4,
               "scout": forty, "voice": forty}
    assert words_of(stuffed) > 250
    answer = api.playbook_save({"champion": rook["id"], "name": "", "playbook": stuffed})
    assert answer["ok"] is False
    assert "250" in answer["text"]


def test_an_older_version_can_be_played_again(api):
    rook = champion(api)
    first = api.playbook_save({"champion": rook["id"], "name": "v1", "playbook": PLAYBOOK})
    second = api.playbook_save({"champion": rook["id"], "name": "v2",
                                "playbook": dict(PLAYBOOK, voice="Loud and quick.")})
    assert first["ok"] and second["ok"]
    assert api.playbook_select({"champion": rook["id"], "version": first["version"]["id"]})["ok"]
    assert api.playbook_view(rook["id"])["current"]["name"] == "v1"
    assert [row["name"] for row in api.playbook_view(rook["id"])["versions"]] == ["v2", "v1"]


def test_the_test_game_runs_and_reports_its_private_read(api):
    rook = champion(api)
    api.playbook_save({"champion": rook["id"], "name": "Patient wall", "playbook": PLAYBOOK})
    started = api.playbook_test_start({"champion": rook["id"], "game": "connect4"})
    assert started["ok"], started
    status = {}
    for _ in range(120):
        status = api.playbook_test_status(started["id"])
        if status.get("status") != "running":
            break
        time.sleep(0.1)
    assert status["status"] == "done", status
    assert status["game"] == "connect4"
    assert status["moves"], "the test game must show its moves"
    assert status["reads"], "the test game must show the private read answers"
    assert status["reads"][0].lower().startswith("their")
    assert status["winner"] in ("champion", "house", "")
    # A second request while one is running returns the same game, not a second one.
    again = api.playbook_test_start({"champion": rook["id"], "game": "connect4"})
    assert again["ok"] and again["id"] != ""


def test_a_champion_with_no_model_says_so(api, monkeypatch):
    rook = champion(api)
    monkeypatch.setattr(api, "_model_ready", lambda config: False)
    answer = api.playbook_test_start({"champion": rook["id"], "game": "connect4"})
    assert answer["ok"] is False
    assert "No model" in answer["text"]
