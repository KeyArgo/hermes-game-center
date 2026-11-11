"""Lessons (scripted positions replayed through the real rules) and hints (single player only)."""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.kitref import kit  # noqa: E402
from shelf import lessons  # noqa: E402

TABLE_GAMES = sorted(path.parent.name for path in ROOT.glob("*/game.json")
                     if json.loads(path.read_text()).get("kind") == "table")
ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)
BEA = SimpleNamespace(id="u2", name="Bea", platform="discord", bot=False)


def load(game_id: str):
    spec = importlib.util.spec_from_file_location(f"lesson_{game_id}", ROOT / game_id / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def table(game_id: str, tmp_path: Path):
    module = load(game_id)
    return module.create(tmp_path / game_id), module


def state_of(tmp_path, game_id):
    return json.loads((tmp_path / game_id / "state.json").read_text())


@pytest.mark.parametrize("game_id", TABLE_GAMES)
def test_every_game_has_a_working_lesson(game_id):
    module = load(game_id)
    steps = kit.lesson_steps(module)
    assert steps, f"{game_id} has no lesson.json"
    assert lessons.problems(module, steps) == []


@pytest.mark.parametrize("game_id", TABLE_GAMES)
def test_lesson_walkthrough_passes_every_step(game_id, tmp_path):
    tab, module = table(game_id, tmp_path)
    steps = kit.lesson_steps(module)
    for number, step in enumerate(steps, start=1):
        started = tab.command("lesson" if number == 1 else "lesson next", player=ME)
        assert f"Lesson {number} of {len(steps)}" in started, started
        state = state_of(tmp_path, game_id)
        legal = [module.show(move) for move in module.legal(state)]
        goal = [str(item).lower() for item in step.get("goal") or []]
        move = next(item for item in legal if not goal or str(item).lower() in goal)
        answer = tab.command(f"move {move}", player=ME)
        assert state_of(tmp_path, game_id)["status"] == kit.LESSON_DONE, answer
        assert tab.picture()["lesson"]["step"] == number
    assert "last step" in tab.command("lesson next", player=ME)


def test_a_first_step_that_names_a_move_checks_that_move():
    """Step 1 used to accept any legal move even where its words say which one
    is right (Connect Four names the middle column)."""
    expected = {"connect4": "4", "gomoku": "h8", "hex": "f6"}
    for game_id, move in expected.items():
        module = load(game_id)
        first = kit.lesson_steps(module)[0]
        goal = [str(item).lower() for item in first.get("goal") or []]
        assert move in goal, f"{game_id} step 1 says {move!r} but checks {goal}"
        state = kit.lesson_position(module, first)
        legal = {str(module.show(item)).lower(): item for item in module.legal(state)}
        wrong = next((token for token in legal if token not in goal), "")
        assert wrong, f"{game_id} offers no wrong first move to teach against"
        assert not kit.lesson_passes(module, first, state, legal[wrong]), \
            f"{game_id} passes {wrong!r}, which step 1 says is not the move"


def test_free_first_steps_are_only_where_any_move_is_the_point():
    """A step with no goal must say so in plain words ("click any ...")."""
    for game_id in TABLE_GAMES:
        module = load(game_id)
        first = kit.lesson_steps(module)[0]
        if first.get("goal"):
            continue
        assert " any " in f" {first.get('say', '').lower()} ", (
            f"{game_id} step 1 accepts any move but its words do not say any: {first.get('say')}"
        )


def test_wrong_lesson_move_gets_the_tip_and_is_not_played(tmp_path):
    tab, module = table("connect4", tmp_path)
    steps = kit.lesson_steps(module)
    number, step = next((n, s) for n, s in enumerate(steps, start=1) if s.get("goal"))
    tab.command(f"lesson {number}", player=ME)
    before = state_of(tmp_path, "connect4")
    wrong = next(module.show(m) for m in module.legal(before) if str(module.show(m)).lower() not in [g.lower() for g in step["goal"]])
    answer = tab.command(f"move {wrong}", player=ME)
    assert "not this lesson's move" in answer
    after = state_of(tmp_path, "connect4")
    assert after["plies"] == before["plies"] and after["status"] == "active"
    assert tab.picture()["lesson"]["note"]


def test_lesson_is_never_scored(tmp_path):
    tab, module = table("connect4", tmp_path)
    steps = kit.lesson_steps(module)
    last = len(steps)
    tab.command(f"lesson {last}", player=ME)
    goal = steps[-1]["goal"][0]
    tab.command(f"move {goal}", player=ME)
    state = state_of(tmp_path, "connect4")
    assert state["status"] == kit.LESSON_DONE and state["score"] == {"white": 0, "black": 0, "draws": 0}


def test_hint_vs_computer_uses_the_built_in_choice(tmp_path):
    tab, module = table("reversi", tmp_path)
    tab.command("allow-ai black=local", player=ME)
    answer = tab.command("hint", player=ME)
    legal = [module.show(m) for m in module.legal(state_of(tmp_path, "reversi"))]
    assert answer.startswith("Hint: try ") and any(f"try {m}." in answer for m in legal)
    assert state_of(tmp_path, "reversi")["plies"] == 0  # a hint never moves
    assert tab.picture()["hint_ok"]


def test_hint_explained_by_own_model_without_names(tmp_path):
    tab, _ = table("connect4", tmp_path)
    prompts = []

    def model(prompt):
        prompts.append(prompt)
        return {"move": "It builds toward the middle.", "tokens": 3}

    tab.command("allow-ai black=local", complete=model, player=ME)
    answer = tab.command("hint", complete=model, player=ME)
    assert "It builds toward the middle." in answer
    assert "Ada" not in prompts[0]


def test_hint_keeps_the_move_when_the_model_fails(tmp_path, monkeypatch):
    """No model, a slow one, a broken one and an empty reply all still give a hint.

    The slow model is held on a gate the test only opens after the hint is back,
    so a hint that waited for the model at all would block for the gate's whole
    timeout — no timing race, and no weakening of what is proved.
    """

    def silent(prompt):
        raise RuntimeError("provider down")

    def empty(prompt):
        return {"move": ""}

    def hint_with(complete, folder):
        tab, _ = table("connect4", tmp_path / folder)
        tab.command("allow-ai black=local", complete=complete, player=ME)
        monkeypatch.setattr(kit, "AGENT_SECONDS", 0.05)
        start = time.monotonic()
        answer = tab.command("hint", complete=complete, player=ME)
        return answer, time.monotonic() - start

    def checked(answer):
        assert answer.startswith("Hint: try ") and answer.endswith(".")
        assert len(answer) < 40, f"a failed model left words behind: {answer!r}"
        return answer

    for complete, folder in ((None, "none"), (silent, "silent"), (empty, "empty")):
        answer, spent = hint_with(complete, folder)
        checked(answer)
        assert spent < 3.0, f"the hint took {spent:.2f}s with no usable model to wait for"

    asked, release = threading.Event(), threading.Event()

    def slow(prompt):
        asked.set()
        release.wait(30)
        return {"move": "It builds toward the middle."}

    try:
        answer, spent = hint_with(slow, "slow")
    finally:
        release.set()
    checked(answer)
    assert "builds toward the middle" not in answer, "a late model answer leaked into the hint"
    assert asked.wait(5), "the hint never asked the model at all"
    assert spent < 3.0, f"the hint waited {spent:.2f}s while the model was still running"


def test_no_hints_against_people_or_from_tools(tmp_path):
    tab, _ = table("connect4", tmp_path)
    tab.command("new", player=ME)
    assert "only for games against the computer" in tab.command("hint", player=ME)
    assert not tab.picture()["hint_ok"]
    tab2, _ = table("checkers", tmp_path / "b")
    tab2.command("allow-ai black=local", player=ME)
    assert tab2.command("hint", source="tool", player=ME) == "Refused (consent_required)."
    assert tab2.command("lesson", source="tool", player=ME) == "Refused (consent_required)."


def test_no_hint_during_a_lesson(tmp_path):
    tab, _ = table("connect4", tmp_path)
    tab.command("lesson", player=ME)
    assert "only for games against the computer" in tab.command("hint", player=ME)


def test_lesson_does_not_replace_a_match_with_a_person(tmp_path):
    tab, _ = table("connect4", tmp_path)
    tab.command("new", player=ME)
    tab.command("move 4", player=ME)
    tab.command("sit black", player=BEA)
    answer = tab.command("lesson", player=ME)
    assert "Lesson 1" not in answer


def test_someone_else_cannot_take_over_a_lesson(tmp_path):
    tab, _ = table("connect4", tmp_path)
    tab.command("lesson", player=ME)
    assert "Only the person taking this lesson" in tab.command("lesson next", player=BEA)
    assert state_of(tmp_path, "connect4")["owner_id"] == "u1"


@pytest.mark.parametrize("action", ["resign", "rematch", "draw", "leave", "step", "sit black", "join"])
def test_match_actions_are_refused_during_a_lesson(tmp_path, action):
    tab, _ = table("connect4", tmp_path)
    tab.command("lesson", player=ME)
    answer = tab.command(action, player=ME)
    assert answer.startswith("Refused (lesson)")
    state = state_of(tmp_path, "connect4")
    assert state["score"] == {"white": 0, "black": 0, "draws": 0} and state["lesson"]


def test_new_game_after_a_lesson_has_no_lesson_left(tmp_path):
    tab, _ = table("connect4", tmp_path)
    tab.command("lesson 2", player=ME)  # mid-lesson, with setup moves on the board
    tab.command("allow-ai black=local", player=ME)
    assert not state_of(tmp_path, "connect4").get("lesson")
    assert tab.picture()["hint_ok"]


def test_a_rematch_never_inherits_lesson_metadata(tmp_path):
    """A lesson never follows a resigned board into the next game.

    Commands refuse ``rematch`` while a lesson is on the board, so this can only
    come from an older save; ``_rematch`` itself must still drop the lesson or
    the first move of the new game is judged as a lesson move.
    """
    tab, module = table("connect4", tmp_path)
    tab.command("lesson", player=ME)
    state_path = tmp_path / "connect4" / "state.json"
    saved = state_of(tmp_path, "connect4")
    saved.update(status="resigned", winner="black", result_reason="resignation", result_recorded=False)
    state_path.write_text(json.dumps(saved))
    assert tab.command("rematch", player=ME).startswith("Refused (lesson)")
    tab._rematch(kit.load(tab.root), ME)  # the same call, past the command gate
    fresh = state_of(tmp_path, "connect4")
    assert fresh["status"] == "active" and not fresh.get("lesson")
    legal = [module.show(move) for move in module.legal(fresh)]
    answer = tab.command(f"move {legal[0]}", player=ME)
    assert "not this lesson's move" not in answer, answer
