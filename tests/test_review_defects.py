"""Code-review defects: dashboard backend surface (agent model, fail-closed config, refusal ok)."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def api(monkeypatch, tmp_path):
    """dashboard/plugin_api.py with a fake fastapi and a data root in tmp."""
    fake = ModuleType("fastapi")

    class APIRouter:
        def get(self, _path):
            return lambda handler: handler

        post = get

    fake.APIRouter = APIRouter
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("review_defects_api", ROOT / "dashboard" / "plugin_api.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_data_root", lambda: tmp_path / "data")
    monkeypatch.setattr(module, "_config", lambda: {"plugins": {"enabled": ["hermes-gameshelf"]}})
    return module


class FakeLlm:
    """Stands in for agent.plugin_llm.PluginLlm bound to this plugin."""

    def __init__(self, move="4", refuse_task_once=False):
        self.move = move
        self.refuse_task_once = refuse_task_once
        self.calls = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("task") and self.refuse_task_once:
            self.refuse_task_once = False
            # PluginLlmTrustError is a PermissionError subclass; the stand-in
            # raises the base class so the test has no hermes-agent import.
            raise PermissionError("task gate closed for the test")
        return SimpleNamespace(text=f"I will play {self.move}.", usage={"total_tokens": 7})


def seat_the_agent(api, llm):
    """Install connect4, start a table, seat Your agent on black."""
    api._plugin_llm = lambda: llm
    assert "library" in api.command({"line": "install connect4"})["text"].lower()
    assert "Red to move." in api.command({"line": "connect4 new"})["text"]
    seated = api.command({"line": "allow-ai connect4 black=agent"})["text"]
    assert "inside Hermes" not in seated, seated
    return seated


def test_agent_seat_uses_the_person_model_through_the_plugin_api(api):
    llm = FakeLlm()
    seat_the_agent(api, llm)
    played = api.command({"line": "connect4 move 1"})["text"]
    assert "Played 1." in played
    assert llm.calls, "the agent seat must call the model"
    first = llm.calls[0]
    assert first.get("task") == "gameshelf_opponent"
    assert first.get("purpose") == "hermes-gameshelf"
    picture = api.board("connect4")["picture"]
    assert picture["plies"] == 2, "the agent answers on its turn"


def test_agent_seat_survives_a_closed_task_gate(api):
    llm = FakeLlm(refuse_task_once=True)
    seat_the_agent(api, llm)
    played = api.command({"line": "connect4 move 2"})["text"]
    assert "Played 2." in played
    assert llm.calls, "the agent seat must call the model"
    assert [bool(call.get("task")) for call in llm.calls] == [True, False], (
        "a refused slot must retry once on the plain model, not vanish"
    )


def test_unreachable_model_keeps_the_clear_refusal(api):
    api._plugin_llm = lambda: None
    assert "library" in api.command({"line": "install reversi"})["text"].lower()
    assert "White to move." in api.command({"line": "reversi new"})["text"]
    seated = api.command({"line": "allow-ai reversi black=agent"})["text"]
    assert "inside Hermes" in seated


def test_config_failure_fails_closed(api, monkeypatch):
    def broken():
        raise RuntimeError("config disk gone")

    monkeypatch.setattr(api, "_config", broken)
    view = api.view()
    assert view.get("allow_ai") is False
    assert view.get("notice"), "the reader must be told why AI is off"
    assert "hermes" in view["notice"].lower()
    store_ids = {card["id"] for card in view["store"]}
    assert "connect4" in store_ids, "our own games stay available"
    assert "library" in api.command({"line": "install connect4"})["text"].lower(), (
        "fail-closed must not break the plain commands"
    )


def test_refusing_answers_are_not_reported_ok(api):
    ok_lines = ["install reversi", "reversi new", "reversi sit white"]
    for line in ok_lines:
        result = api.command({"line": line})
        assert result["ok"] is True, f"{line!r}: {result['text']!r}"
    assert api.command({"line": "install go"})["ok"] is True
    refusals = [
        ("reversi sit", "Usage: sit white|black"),
        ("go new white=human black=agent", "Your agent needs your yes first."),
        ("reversi rematch", "Finish the current game"),
        ("reversi draw accept", "No opponent draw offer"),
    ]
    for line, refusal in refusals:
        result = api.command({"line": line})
        assert result["ok"] is False, f"{line!r}: {result['text']!r} must not be ok:true"
        assert result["text"].startswith(refusal)
