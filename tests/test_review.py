"""Review My Game: the engine finds the last clear one-move mistake, no model.

Every "mistake" here is hand-built and verified against the game's own rules:
replaying ``moves`` through ``review.find_mistake`` must report the exact kind.
The engine is pure (no I/O, no model); the kit ``review`` verb is tested for
its fairness and safety rules separately.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.kitref import kit  # noqa: E402
from shelf import lessons, review  # noqa: E402

ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)
BEA = SimpleNamespace(id="u2", name="Bea", platform="discord", bot=False)

# Games where a one-move mistake must be found, with a hand-built game for each
# kind. moves[-1] is the mistake played; goal is the move that should have been.
MISSED_WIN = {
    "connect4": {"moves": ["4", "1", "5", "2", "6", "3", "4"], "learner": "white", "goal": ["7"]},
    "gomoku": {"moves": ["h8", "a1", "g8", "a2", "f8", "a3", "e8", "a4", "b1"], "learner": "white"},
    "chessboard": {"moves": ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "d2d3"], "learner": "white", "goal": ["h5f7"]},
}
ALLOWED_WIN = {
    "connect4": {"moves": ["5", "1", "5", "2", "7", "3", "6"], "learner": "white", "goal": ["4"]},
    "gomoku": {"moves": ["a1", "h8", "c1", "g8", "e1", "f8", "i8", "e8", "h1"], "learner": "white", "goal": ["d8"]},
    "chessboard": {"moves": ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6"], "learner": "black"},
}

CHECKERS_ALLOWED = [
    "a3-b4", "b6-a5", "b2-a3", "d6-c5", "b4-d6", "c7-e5", "a1-b2", "a5-b4",
    "a3-c5", "e5-d4", "c3-e5", "f6-d4", "b2-a3", "d4-c3", "d2-b4", "h6-g5",
    "c1-b2", "g5-f4", "e3-g5", "a7-b6", "c5-a7", "e7-d6", "e1-d2", "d6-c5",
    "b4-d6", "g7-f6", "g5-e7", "d8-f6", "b2-c3", "f6-e5", "d2-e3", "e5-d4",
    "c3-e5", "b8-c7", "d6-b8", "f8-e7", "a3-b4", "e7-d6", "e5-c7", "h8-g7",
    "e3-d4", "g7-f6", "f2-e3", "f6-e5",
]

GAMES = ["connect4", "reversi", "checkers", "gomoku", "chessboard", "go", "hex", "breakthrough"]
OPTIONAL = ["reversi", "go", "hex", "breakthrough"]  # may report nothing, must not crash


def load(game_id: str):
    spec = importlib.util.spec_from_file_location(f"review_{game_id}", ROOT / game_id / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rules_of(game_id: str):
    return kit.rules(vars(load(game_id)))


def _step(found: dict) -> dict:
    return {key: found[key] for key in ("say", "setup", "goal", "wins", "tip", "praise")}


def _assert_sound(rules, found: dict, played_token: str) -> None:
    """The property every generated step must satisfy, shared by all games."""
    assert set(found) >= {"ply", "kind", "setup", "goal", "wins", "say", "tip", "praise"}
    assert found["wins"] is (found["kind"] == "missed_win")
    step = _step(found)
    position = kit.lesson_position(rules, step)
    legal = {str(rules.show(move)).lower(): move for move in rules.legal(position)}
    for token in found["goal"]:
        assert token in legal, f"goal {token!r} is not legal after setup"
    goal_move = legal[found["goal"][0]]
    assert kit.lesson_passes(rules, step, position, goal_move), "the goal move does not pass its own step"
    trial = copy.deepcopy(position)
    rules.play(trial, goal_move)
    assert not (trial.get("status") == "win" and trial.get("winner") != position["turn"]), \
        "the goal move hands the opponent the win"
    played = rules.parse(str(played_token).split())
    if played is not None and played in rules.legal(position):
        assert not kit.lesson_passes(rules, step, position, played), "the played mistake passes the step"
    broken = [item for item in lessons.problems(rules, [step]) if "steps; use 3 to 7" not in item]
    assert broken == [], f"generated step fails lesson checks: {broken}"


@pytest.mark.parametrize("game_id", ["connect4", "gomoku", "chessboard"])
def test_missed_win_is_detected(game_id: str) -> None:
    spec = MISSED_WIN[game_id]
    found = review.find_mistake(rules_of(game_id), spec["moves"], spec["learner"])
    assert found and found["kind"] == "missed_win"
    if "goal" in spec:
        assert found["goal"] == spec["goal"]
    _assert_sound(rules_of(game_id), found, spec["moves"][-1])


@pytest.mark.parametrize("game_id", ["connect4", "gomoku", "chessboard"])
def test_allowed_win_is_detected(game_id: str) -> None:
    spec = ALLOWED_WIN[game_id]
    found = review.find_mistake(rules_of(game_id), spec["moves"], spec["learner"])
    assert found and found["kind"] == "allowed_win"
    if "goal" in spec:
        assert found["goal"] == spec["goal"]
    _assert_sound(rules_of(game_id), found, spec["moves"][-1])


def test_checkers_allowed_win_is_detected() -> None:
    rules = rules_of("checkers")
    found = review.find_mistake(rules, CHECKERS_ALLOWED, "black")
    assert found and found["kind"] == "allowed_win"
    assert found["ply"] == len(CHECKERS_ALLOWED)
    _assert_sound(rules, found, CHECKERS_ALLOWED[-1])


def test_checkers_missed_win_in_an_endgame() -> None:
    # Checkers only "wins in one move" in a forced-capture endgame: the winning
    # chain takes the last two men, a different capture takes just one. Not
    # reachable from a short opening, so the position is set up directly and the
    # detector is exercised on the real rules.
    rules = rules_of("checkers")
    board = [["." for _ in range(8)] for _ in range(8)]
    board[2][0] = "X"  # a3 king: a3-c5-e3 captures b4 then d4 -> black has no man
    board[2][2] = "x"  # c3 man: c3-e5 captures only d4 -> black still moves
    board[3][1] = "o"  # b4
    board[3][3] = "o"  # d4
    state = {"board": board, "turn": "white", "status": "active", "winner": "", "quiet": 0, "moves": []}
    assert {rules.show(m) for m in rules.legal(state)} == {"a3-c5-e3", "c3-a5", "c3-e5"}

    winning = rules.parse(["a3", "c5", "e3"])
    after = copy.deepcopy(state)
    rules.play(after, winning)
    assert after["status"] == "win" and after["winner"] == "white"

    found = review.examine(rules, state, rules.parse(["c3", "e5"]))
    assert found and found["kind"] == "missed_win"
    assert found["goal"] == ["a3-c5-e3"] and found["wins"] is True


def test_multiple_winning_moves_are_all_goals() -> None:
    # After 3,1,4,1,5,1,7 White has two immediate wins (columns 2 and 6) and
    # played 7. Both winning moves must pass the review, not just the first.
    rules = rules_of("connect4")
    found = review.find_mistake(rules, ["3", "1", "4", "1", "5", "1", "7"], "white")
    assert found and found["kind"] == "missed_win"
    assert set(found["goal"]) == {"2", "6"}
    position = kit.lesson_position(rules, _step(found))
    for token in found["goal"]:
        assert kit.lesson_passes(rules, _step(found), position, rules.parse([token]))


def test_a_clean_game_reports_nothing() -> None:
    rules = rules_of("connect4")
    assert review.find_mistake(rules, ["4", "4", "5", "5", "6", "6", "7"], "white") is None


@pytest.mark.parametrize("game_id", OPTIONAL)
def test_games_that_may_report_nothing_do_not_crash(game_id: str) -> None:
    rules = rules_of(game_id)
    state = review.start(rules)
    moves = []
    for _ in range(40):
        if state.get("status") != "active":
            break
        move = rules.bot(state)
        moves.append(rules.show(move))
        rules.play(state, move)
    for learner in ("white", "black"):
        found = review.find_mistake(rules, moves, learner)
        assert found is None or isinstance(found, dict)
        if found:
            assert set(found) >= {"ply", "kind", "setup", "goal", "wins", "say", "tip", "praise"}


def test_ignores_moves_by_the_other_side() -> None:
    # The learner is white; black's mistakes must never be reported.
    rules = rules_of("connect4")
    # White plays a perfect quick win; black's early move hangs a win for white
    # every ply, but review(learner=white) must not blame white for black's play.
    assert review.find_mistake(rules, ["4", "4", "5", "5", "6", "6", "7"], "white") is None
    assert review.find_mistake(rules, ["4", "1", "5", "2", "6", "3", "7"], "white") is None


# --------------------------------------------------------------------------
# kit verb: fairness and safety
# --------------------------------------------------------------------------


def _finished_state(game_id: str, moves: list[str], *, human="white", winner="black") -> dict:
    """Replay ``moves`` to a finished state, then stamp the table fields."""
    rules = rules_of(game_id)
    state = review.start(rules)
    for token in moves:
        rules.play(state, rules.parse(str(token).split()))
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = rules.show(rules.parse(str(token).split()))
    state.update({
        "schema_version": 2,
        "table_id": "t1",
        "owner_id": "u1",
        "white": "human" if human == "white" else "local",
        "black": "local" if human == "white" else "human",
        "white_id": "u1" if human == "white" else "local",
        "black_id": "local" if human == "white" else "u1",
        "white_name": "Ada" if human == "white" else "Local",
        "black_name": "Local" if human == "white" else "Ada",
        "score": {"white": 0, "black": 1, "draws": 0},
        "result_recorded": True,
        "moves": moves,
    })
    if state.get("status") != "win":
        state["status"] = "win"
        state["winner"] = winner
    return state


def _table(tmp_path, game_id: str, state: dict):
    folder = tmp_path / game_id
    kit.save(folder, state)
    return load(game_id).create(folder)


def test_review_requires_the_command_source(tmp_path) -> None:
    table = _table(tmp_path, "connect4", _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"]))
    assert table.command("review", source="ui", player=ME) == "Refused (consent_required)."


def test_review_refused_while_the_game_is_active(tmp_path) -> None:
    state = _finished_state("connect4", ["4", "1", "5", "2", "6", "3"])
    state["status"] = "active"
    state["winner"] = ""
    table = _table(tmp_path, "connect4", state)
    assert "finished first" in table.command("review", player=ME)


def test_review_refused_for_a_player_vs_player_game(tmp_path) -> None:
    state = _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"])
    state["black"] = "human"
    state["black_id"] = "u2"
    state["black_name"] = "Bea"
    table = _table(tmp_path, "connect4", state)
    assert "not player against player" in table.command("review", player=ME)


def test_review_refused_for_the_wrong_person(tmp_path) -> None:
    state = _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"])
    table = _table(tmp_path, "connect4", state)
    assert "Only the player who played" in table.command("review", player=BEA)


def test_review_refused_for_a_call_without_identity(tmp_path) -> None:
    state = _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"])
    table = _table(tmp_path, "connect4", state)
    assert "Only the player who played" in table.command("review", player=None)


def test_review_builds_a_lesson_without_scoring(tmp_path) -> None:
    state = _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"])
    table = _table(tmp_path, "connect4", state)
    before = dict(state["score"])
    answer = table.command("review", player=ME)
    assert "Review" in answer

    now = json.loads((tmp_path / "connect4" / "state.json").read_text())
    assert now["score"] == before, "the review changed the score"
    assert now.get("lesson") and now["lesson"].get("custom")

    # Play the goal move; the step passes and the score stays put.
    goal = now["lesson"]["custom"]["goal"][0]
    answer = table.command(f"move {goal}", player=ME)
    assert "Good block" in answer or "Well done" in answer
    done = json.loads((tmp_path / "connect4" / "state.json").read_text())
    assert done["score"] == before, "passing the review step changed the score"
    assert done["status"] == "lesson_done"


def test_rematch_after_a_review_keeps_the_opponent_and_the_series(tmp_path) -> None:
    """The review board seats the other side as the built-in player; its
    Rematch must still hand back the game the person actually played."""
    state = _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"])
    state.update(black="agent", black_id="agent", black_name="Your agent",
                 score={"white": 1, "black": 2, "draws": 0},
                 ai_consent={"by": "u1", "seats": ["black"]})
    table = _table(tmp_path, "connect4", state)
    assert "Review" in table.command("review", player=ME)
    now = json.loads((tmp_path / "connect4" / "state.json").read_text())
    goal = now["lesson"]["custom"]["goal"][0]
    table.command(f"move {goal}", player=ME)

    answer = table.command("rematch", player=ME)
    assert not answer.startswith("Refused"), answer
    fresh = json.loads((tmp_path / "connect4" / "state.json").read_text())
    assert fresh["status"] == "active" and fresh["plies"] == 0
    assert fresh["black"] == "agent" and fresh["black_name"] == "Your agent", fresh
    assert fresh["score"] == {"white": 1, "black": 2, "draws": 0}, "the series was reset"
    assert not fresh.get("lesson") and not fresh.get("review_of")
    assert fresh["ai_consent"] == {"by": "u1", "seats": ["black"]}


def test_a_review_rematch_is_still_only_for_the_player_who_reviewed(tmp_path) -> None:
    state = _finished_state("connect4", ALLOWED_WIN["connect4"]["moves"] + ["4"])
    table = _table(tmp_path, "connect4", state)
    table.command("review", player=ME)
    assert "Only the player who reviewed" in table.command("rematch", player=BEA)


def test_review_with_no_mistake_is_honest(tmp_path) -> None:
    state = _finished_state("connect4", ["4", "4", "5", "5", "6", "6", "7"], winner="white")
    state["score"] = {"white": 1, "black": 0, "draws": 0}
    table = _table(tmp_path, "connect4", state)
    answer = table.command("review", player=ME)
    assert "couldn't find a clear one-move mistake" in answer
    # No lesson was written; the finished game is untouched.
    now = json.loads((tmp_path / "connect4" / "state.json").read_text())
    assert now["score"] == {"white": 1, "black": 0, "draws": 0}
    assert "lesson" not in now or not now.get("lesson")
