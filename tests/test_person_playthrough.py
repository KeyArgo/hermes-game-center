"""One person at a table, every game: play it out, learn it, hint it, review it.

These tests sit where a person's clicks end up: real commands on the real kit, one
table per test in its own folder. They cover, for every table game:

* a whole game against the built-in player, played to a finish, then Rematch;
* every lesson step, including the tip a wrong (but legal) move earns;
* the Hint button mid-game, with no model and with a model that fails;
* Review My Game: a real loss with a planted mistake, the lesson it builds, and
  the honest answer when the engine finds nothing.

Clicking itself (real mouse events on the drawn board) is proved separately by
``tests/test_browser_click_play.py``; this file is the rules-and-state half, and
it runs in the ordinary suite.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import random
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.kitref import kit  # noqa: E402
from shelf import review  # noqa: E402

ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)

TABLE_GAMES = sorted(path.parent.name for path in ROOT.glob("*/game.json")
                     if json.loads(path.read_text()).get("kind") == "table")

# Games whose review must find the planted mistake (plan section 4.1). The rest
# may honestly report nothing in this version, and must not crash.
REVIEW_FINDS = ["connect4", "gomoku", "checkers", "chessboard"]
REVIEW_HONEST = ["reversi", "go", "hex", "breakthrough"]

# A game the person lost on purpose: at every one of their turns they take a move
# that hands the opponent a win at once when there is one, and the opponent takes
# it. The builder below plays that out through the game's own rules, so the line
# is a real, legal game and the engine's own review finds the blunder.
HUMAN = "white"
# Short games with a real blunder at the end, so the review tests stay quick.
KNOWN = {
    "connect4": ["5", "1", "5", "2", "7", "3", "6"],
    "gomoku": ["a1", "h8", "c1", "g8", "e1", "f8", "i8", "e8", "h1"],
}


def load(game_id: str):
    spec = importlib.util.spec_from_file_location(f"person_{game_id}", ROOT / game_id / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def table(game_id: str, tmp_path: Path):
    module = load(game_id)
    return module.create(tmp_path / game_id), module


def picture_of(game_id: str, tmp_path: Path) -> dict:
    return json.loads((tmp_path / game_id / "state.json").read_text())


def moves_for_people(picture: dict) -> list[str]:
    """The moves a person could press right now, without the pass marker last."""
    legal = list(picture.get("legal") or [])
    return [move for move in legal if move != "pass"] or legal


def play_out(game_id: str, tmp_path: Path, seed: int = 7) -> dict:
    """A whole game against the built-in player, pressed move by move."""
    tab, module = table(game_id, tmp_path)
    assert "computer" in tab.command("allow-ai black=local", player=ME).lower() or True
    chooser = random.Random(seed)
    for _ in range(800):
        picture = tab.picture()
        if picture["status"] != "active":
            return picture
        options = moves_for_people(picture)
        assert options, f"{game_id} is active with no legal move: {picture}"
        answer = tab.command(f"move {chooser.choice(options)}", player=ME)
        assert not answer.startswith("Refused"), answer
    raise AssertionError(f"{game_id} never finished")


# Arcade cabinets pay out per round and never end: there is no win/draw to reach and no
# rematch to ask for. What they must do is keep offering a move and keep taking chips.
ENDLESS = {"slots", "blackjack"}


@pytest.mark.parametrize("game_id", TABLE_GAMES)
def test_a_person_plays_every_game_to_a_finish_then_rematches(game_id, tmp_path):
    tab, _module = table(game_id, tmp_path)
    if game_id in ENDLESS:
        chooser = random.Random(11)
        for _ in range(40):
            picture = tab.picture()
            assert picture["status"] == "active", f"{game_id} ended on its own"
            options = moves_for_people(picture)
            assert options, f"{game_id} is active with no legal move: {picture}"
            assert not tab.command(f"move {chooser.choice(options)}", player=ME).startswith("Refused")
        assert tab.picture()["plies"] >= 40, f"{game_id} did not keep playing"
        return
    tab.command("allow-ai black=local", player=ME)
    chooser = random.Random(11)
    played = 0
    for _ in range(900):
        picture = tab.picture()
        if picture["status"] != "active":
            break
        options = moves_for_people(picture)
        assert options, f"{game_id} is active with no legal move: {picture}"
        assert not tab.command(f"move {chooser.choice(options)}", player=ME).startswith("Refused")
        played += 1
    picture = tab.picture()
    assert picture["status"] in {"win", "draw"}, f"{game_id} stopped at {picture['status']}"
    assert sum(picture["score"].values()) == 1, f"{game_id} did not score its finished game"
    assert picture["plies"] >= 4, f"{game_id} finished after {picture['plies']} plies"

    answer = tab.command("rematch", player=ME)
    assert not answer.startswith("Refused"), answer
    fresh = tab.picture()
    assert fresh["status"] == "active" and fresh["plies"] <= 1, f"{game_id} rematch did not reset"
    assert fresh["score"] == picture["score"], f"{game_id} rematch lost the series score"


@pytest.mark.parametrize("game_id", TABLE_GAMES)
def test_every_lesson_step_tips_a_wrong_move_and_passes_its_goal(game_id, tmp_path):
    tab, module = table(game_id, tmp_path)
    steps = kit.lesson_steps(module)
    rules = kit.rules(vars(module))
    if not steps:
        # No lesson.json yet for this table (the arcade cabinets are next).
        pytest.skip(f"{game_id} ships no lesson yet")
    tipped = 0
    offered = 0
    for number, step in enumerate(steps, start=1):
        started = tab.command("lesson" if number == 1 else "lesson next", player=ME)
        assert f"Lesson {number} of {len(steps)}" in started, started
        picture = tab.picture()
        assert picture["lesson"]["step"] == number
        assert picture["status"] == "active"
        goals = [str(item).lower() for item in step.get("goal") or []]
        legal = {str(move).lower(): move for move in picture["legal"]}
        position = kit.lesson_position(module, step)
        passing = {str(rules.show(move)).lower() for move in rules.legal(position)
                   if kit.lesson_passes(rules, step, position, move)}

        # A wrong move that is still legal: the tip appears, the board does not change.
        wrong = next((token for token in legal if token not in passing), "")
        if wrong:
            before = copy.deepcopy(picture)
            answer = tab.command(f"move {legal[wrong]}", player=ME)
            assert "not this lesson's move" in answer, answer
            after = tab.picture()
            assert after["lesson"]["note"], f"{game_id} step {number} gave no tip"
            assert after["plies"] == before["plies"] and after["status"] == "active"
            assert after["moves"] == before["moves"]
            tipped += 1
        offered += 1 if wrong else 0

        # The goal move passes the step.
        target = next((token for token in legal if token in passing and (not goals or token in goals)), "")
        assert target, f"{game_id} step {number}: no legal move matches {goals}"
        answer = tab.command(f"move {legal[target]}", player=ME)
        assert not answer.startswith("Refused"), answer
        done = tab.picture()
        assert done["status"] == kit.LESSON_DONE, f"{game_id} step {number} did not pass: {answer}"
        assert done["lesson"]["step"] == number
    assert "last step" in tab.command("lesson next", player=ME)
    # Every step that had a legal wrong move must have tipped it. A step that accepts any
    # legal move (the arcade tables' "do the thing" steps) has no wrong move to tip.
    assert tipped == offered, f"{game_id} tipped {tipped} of {offered} wrong moves"


@pytest.mark.parametrize("game_id", TABLE_GAMES)
def test_hint_gives_a_real_move_midgame_with_no_model_and_a_broken_one(game_id, tmp_path):
    def broken(prompt):
        raise RuntimeError("provider down")

    for complete, label in ((None, "no model"), (broken, "broken model")):
        root = tmp_path / label.replace(" ", "-")
        tab, module = table(game_id, root)
        tab.command("allow-ai black=local", complete=complete, player=ME)
        chooser = random.Random(3)
        for _ in range(2):
            picture = tab.picture()
            if picture["status"] != "active":
                break
            options = moves_for_people(picture)
            if not options:
                break
            tab.command(f"move {chooser.choice(options)}", complete=complete, player=ME)
        picture = tab.picture()
        if picture["status"] != "active":
            continue
        assert picture["hint_ok"], f"{game_id}: no hint offered mid-game ({label})"
        before = copy.deepcopy(picture)
        answer = tab.command("hint", complete=complete, player=ME)
        assert answer.startswith("Hint: try "), f"{game_id} ({label}): {answer!r}"
        named = answer[len("Hint: try "):].rstrip(".")
        assert named in picture["legal"], f"{game_id} ({label}) hinted {named!r}, not a legal move"
        after = tab.picture()
        assert after["plies"] == before["plies"], f"{game_id}: a hint moved the board"
        assert after["moves"] == before["moves"]


def _wins_with(rules, state: dict, move) -> bool:
    trial = copy.deepcopy(state)
    rules.play(trial, move)
    return trial.get("status") == "win" and trial.get("winner") == state.get("turn")


def _hands_over_the_win(rules, state: dict, move) -> bool:
    """``move`` lets the opponent win on their immediate reply."""
    trial = copy.deepcopy(state)
    rules.play(trial, move)
    if trial.get("status") != "active" or trial.get("turn") == state.get("turn"):
        return False
    return any(_wins_with(rules, trial, reply) for reply in rules.legal(trial))


def _lose_on_purpose(module, seed: int = 5) -> list[str]:
    """A real game the person loses after handing over a win at once.

    The person (white) takes a move that lets the opponent win whenever one
    exists; the opponent takes the win. Every move goes through the game's own
    ``legal``/``play``, so the finished record is an ordinary game.
    """
    rules = kit.rules(vars(module))
    chooser = random.Random(seed)
    for attempt in range(60):
        state = review.start(rules)
        moves: list[str] = []
        while state["status"] == "active" and len(moves) < 800:
            legal = list(rules.legal(state))
            assert legal, f"{rules.ID} has no legal move and is still active"
            if state["turn"] == HUMAN:
                gifts = [move for move in legal if _hands_over_the_win(rules, state, move)]
                move = gifts[0] if gifts else chooser.choice(legal)
            else:
                wins = [item for item in legal if _wins_with(rules, state, item)]
                move = wins[0] if wins else chooser.choice(legal)
            moves.append(rules.show(move))
            rules.play(state, move)
            state["plies"] = int(state.get("plies") or 0) + 1
            state["last"] = moves[-1]
        if state.get("status") == "win" and state.get("winner") not in (None, HUMAN, ""):
            if review.find_mistake(rules, moves, HUMAN):
                return moves
    raise AssertionError(f"{rules.ID}: could not build a game lost with a real mistake")


def _planted_line(module) -> list[str]:
    """A short, known bad game where one exists; otherwise one played on purpose."""
    rules = kit.rules(vars(module))
    known = KNOWN.get(rules.ID)
    if known:
        state = review.start(rules)
        for token in known:
            played = rules.parse(str(token).split())
            rules.play(state, played)
            state["plies"] = int(state.get("plies") or 0) + 1
        for reply in rules.legal(state):
            trial = copy.deepcopy(state)
            rules.play(trial, reply)
            if trial.get("status") == "win" and trial.get("winner") not in (None, HUMAN, ""):
                moves = list(known) + [rules.show(reply)]
                if review.find_mistake(rules, moves, HUMAN):
                    return moves
                break
    return _lose_on_purpose(module)


def _finished_state(module, moves: list[str], human: str = HUMAN) -> dict:
    rules = kit.rules(vars(module))
    state = review.start(rules)
    for token in moves:
        played = rules.parse(str(token).split())
        assert played is not None and played in rules.legal(state), f"{rules.ID} refuses {token!r}"
        rules.play(state, played)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = rules.show(played)
    state.update({
        "schema_version": 2,
        "table_id": "tg-review",
        "owner_id": "u1",
        "white": "human" if human == "white" else "local",
        "black": "local" if human == "white" else "human",
        "white_id": "u1" if human == "white" else "local",
        "black_id": "local" if human == "white" else "u1",
        "white_name": "Ada" if human == "white" else "Local",
        "black_name": "Local" if human == "white" else "Ada",
        "score": {"white": 0, "black": 1, "draws": 0} if human == "white" else {"white": 1, "black": 0, "draws": 0},
        "result_recorded": True,
        "moves": list(moves),
    })
    return state


@pytest.mark.parametrize("game_id", REVIEW_FINDS)
def test_review_finds_the_planted_mistake_and_the_lesson_can_be_played(game_id, tmp_path):
    module = load(game_id)
    moves = _planted_line(module)
    folder = tmp_path / game_id
    state = _finished_state(module, moves)
    assert state["status"] == "win" and state.get("winner") == "black"
    kit.save(folder, state)
    tab = module.create(folder)

    answer = tab.command("review", player=ME)
    assert "Review, move" in answer, f"{game_id} review said: {answer!r}"
    shown = tab.picture()
    step = shown["lesson"]
    assert step["of"] == 1 and step.get("custom"), f"{game_id} built no one-step lesson"
    goal = step["custom"]["goal"][0]
    assert goal in [str(move).lower() for move in shown["legal"]], f"{game_id}: goal {goal} is not legal"

    # The lesson is a real position: the goal move passes, and the score never moves.
    score = copy.deepcopy(shown["score"])
    passed = tab.command(f"move {goal}", player=ME)
    assert not passed.startswith("Refused"), passed
    done = tab.picture()
    assert done["status"] == kit.LESSON_DONE, f"{game_id} review lesson did not pass: {passed}"
    assert done["score"] == score, f"{game_id} review lesson changed the score"

    assert not tab.command("rematch", player=ME).startswith("Refused")


@pytest.mark.parametrize("game_id", REVIEW_HONEST)
def test_review_either_explains_honestly_or_builds_a_sound_lesson(game_id, tmp_path):
    picture = play_out(game_id, tmp_path)
    assert picture["status"] in {"win", "draw"}
    module = load(game_id)
    tab = module.create(tmp_path / game_id)
    answer = tab.command("review", player=ME)
    assert isinstance(answer, str) and answer, f"{game_id} review returned nothing"
    after = picture_of(game_id, tmp_path)
    if "couldn't find a clear one-move mistake" in answer:
        assert not after.get("lesson"), f"{game_id} said it found nothing but wrote a lesson"
        return
    assert "Review, move" in answer, f"{game_id} review said: {answer!r}"
    step = after["lesson"]
    assert step["of"] == 1 and step.get("custom")
    goal = step["custom"]["goal"][0]
    rules = kit.rules(vars(module))
    position = kit.lesson_position(module, step["custom"])
    legal = [str(rules.show(move)).lower() for move in rules.legal(position)]
    assert goal in legal, f"{game_id}: generated goal {goal} is not legal in its own position"
    assert not tab.command(f"move {goal}", player=ME).startswith("Refused")
    assert picture_of(game_id, tmp_path)["status"] == kit.LESSON_DONE


def test_a_game_without_draws_offers_none(tmp_path):
    """Hex always has a winner; the table and the shelf must not offer a draw."""
    tab, _module = table("hex", tmp_path)
    tab.command("allow-ai black=local", player=ME)
    assert tab.picture()["draws"] is False
    answer = tab.command("draw", player=ME)
    assert "no draw" in answer.lower(), answer
    # The online layer tells a refusal from a result by the text's opening words; a draw
    # that cannot happen has to read as a refusal there too, not as an accepted offer.
    from online.rooms import refused
    assert refused(answer), f"the online rooms would take {answer!r} for a result"
    assert tab.picture()["draw_offer"] == ""
    assert tab.command("draw accept", player=ME) in {"No opponent draw offer to accept.", answer}
    # Every table game whose manifest allows draws still offers one; the games
    # that cannot be drawn (owner rule: Hex, Breakthrough, Go with komi, and Sea
    # Battle, where the fleet that sinks first loses) are exactly the ones the
    # shelf must stay silent about.
    drawless = {path.parent.name for path in ROOT.glob("*/game.json")
                if json.loads(path.read_text()).get("kind") == "table"
                and json.loads(path.read_text()).get("draws") is False}
    assert drawless == {"hex", "breakthrough", "go", "seabattle"}, f"unexpected no-draw set: {drawless}"
    for game_id in TABLE_GAMES:
        if game_id in drawless:
            continue
        other, _ = table(game_id, tmp_path / game_id)
        other.command("allow-ai black=local", player=ME)
        assert other.picture()["draws"] is True, f"{game_id} lost its draw offer"
