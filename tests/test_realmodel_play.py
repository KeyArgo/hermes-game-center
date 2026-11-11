"""One whole game against the real local GLM, for every table game.

This is the only test that calls a real model. It uses the OpenAI-compatible
server on this network exactly as the plugin does: one ``complete(prompt)``
callback that returns the model's text, seated with
``/games allow-ai <game> black=agent``. Nothing else is substituted, so the
numbers it prints are what a person would get.

Run it with ``pytest --realmodel tests/test_realmodel_play.py -s``. It is
skipped by default because the model server lives on another machine.

The endpoint and model come from the environment (defaults below are the ones
this project uses), and every game's result is written to
``test-artifacts/tg/realmodel-<game>.json`` for TESTS-REPORT.md.
"""

from __future__ import annotations

import importlib.util
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.kitref import kit  # noqa: E402

URL = os.environ.get("GAMESHELF_GLM_URL", "http://127.0.0.1:8888/v1").rstrip("/")
MODEL = os.environ.get("GAMESHELF_GLM_MODEL", "GLM-5.3-Flash-EXL3")
MAX_TOKENS = int(os.environ.get("GAMESHELF_GLM_MAX_TOKENS", "48"))
ARTIFACTS = ROOT / "test-artifacts" / "tg"
ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)

TABLE_GAMES = sorted(path.parent.name for path in ROOT.glob("*/game.json")
                     if json.loads(path.read_text()).get("kind") == "table")

pytestmark = pytest.mark.realmodel


def load(game_id: str):
    spec = importlib.util.spec_from_file_location(f"glm_{game_id}", ROOT / game_id / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


READY, WHY = False, ""  # decided at run time, never at import: the default suite makes no request


def answering() -> tuple[bool, str]:
    """Is the model server there, and does it list our model?"""
    try:
        with urllib.request.urlopen(f"{URL}/models", timeout=5) as answer:
            listed = json.load(answer)
    except (urllib.error.URLError, OSError, ValueError) as error:
        return False, f"{URL} is not answering ({error})"
    names = [str(item.get("id", "")) for item in listed.get("data", [])]
    if MODEL not in names:
        return False, f"{URL} does not serve {MODEL} (has: {', '.join(names) or 'nothing'})"
    return True, "models: " + ", ".join(names)


@pytest.fixture(scope="session")
def glm_endpoint():
    """Skip the whole file when the model server is not up. Never contacts it at import."""
    ready, why = answering()
    if not ready:
        pytest.skip(f"local GLM: {why}")
    return URL


pytestmark = pytest.mark.realmodel


def ask(prompt: str) -> str:
    """One chat completion, the way the plugin's complete() callback does it."""
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
    }).encode()
    request = urllib.request.Request(
        f"{URL}/chat/completions", data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as answer:
        reply = json.load(answer)
    return str(reply["choices"][0]["message"]["content"] or "")


@pytest.mark.parametrize("game_id", TABLE_GAMES)
def test_one_whole_game_against_the_real_model(game_id, tmp_path, glm_endpoint):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    module = load(game_id)
    tab = module.create(tmp_path / game_id)
    ledger = {"game": game_id, "model": MODEL, "calls": 0, "seconds": [], "illegal": 0,
              "fallbacks": 0, "agent_moves": 0, "human_moves": 0}

    def complete(prompt: str) -> dict:
        started = time.monotonic()
        text = ask(prompt)
        ledger["seconds"].append(round(time.monotonic() - started, 3))
        ledger["calls"] += 1
        return {"move": text}

    tab.command("allow-ai black=agent", complete=complete, player=ME)
    assert "Your agent" in tab.picture()["black"] or tab.picture()["seats"][1]["kind"] == "agent"
    chooser = random.Random(len(game_id))
    for _ in range(600):
        picture = tab.picture()
        if picture["status"] != "active":
            break
        legal = [move for move in picture["legal"] if move != "pass"] or picture["legal"]
        assert legal, f"{game_id} is active with no legal move"
        answer = tab.command(f"move {chooser.choice(legal)}", complete=complete, player=ME)
        assert not answer.startswith("Refused"), answer
        ledger["human_moves"] += 1
        if "the built-in player chose" in answer:
            ledger["fallbacks"] += 1
            if "gave no legal move" in answer or "sent an empty reply" in answer:
                ledger["illegal"] += 1
        # One human move is one ply; anything beyond that is the agent's own reply.
        if tab.picture()["plies"] - picture["plies"] >= 2:
            ledger["agent_moves"] += 1
    done = tab.picture()
    ledger["status"] = done["status"]
    ledger["plies"] = done["plies"]
    ledger["average_seconds"] = round(sum(ledger["seconds"]) / len(ledger["seconds"]), 3) if ledger["seconds"] else 0.0
    ledger["slowest_seconds"] = max(ledger["seconds"]) if ledger["seconds"] else 0.0
    (ARTIFACTS / f"realmodel-{game_id}.json").write_text(json.dumps(ledger, indent=2))
    print(json.dumps(ledger))

    assert done["status"] in {"win", "draw", "resigned"}, f"{game_id} never finished: {done['status']}"
    assert ledger["agent_moves"] > 0, f"{game_id}: the agent never made a move"
    assert ledger["fallbacks"] < ledger["agent_moves"], (
        f"{game_id}: the model answered nothing usable ({ledger['fallbacks']} fallbacks of "
        f"{ledger['agent_moves']} agent moves)"
    )
