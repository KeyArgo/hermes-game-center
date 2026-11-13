"""Tutorial data, replay and the table's learning controls."""

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog
from shelf.commands import run
from shelf import tutorials

CURATED = json.loads((ROOT / "shelf/curated.json").read_text())["games"]
DEMO = {"hex", "connect4", "chessboard", "liars_dice"}
GAMES = sorted(path.parent.name for path in ROOT.glob("*/game.json"))


def learn_paths(game):
    """Where a game's tutorial may live: beside the game, or in shelf/learn.

    Launch card folders hold nothing but their own code (see
    test_launch_cards.py), so those cards ship their text in shelf/learn.
    """
    return [ROOT / game / "learn.json", ROOT / "shelf" / "learn" / f"{game}.json"]


def catalog(tmp_path):
    return Catalog([ROOT], tmp_path / "data", {"allow_ai": True})


def sample(moves):
    return {"title": "Tutorial", "howto": {"goal": "Win.", "sections": [{"title": "One", "text": "One."}, {"title": "Two", "text": "Two."}], "controls": ["Click."]},
            "demo": {"moves": moves, "lines": [{"at": 0, "say": "Start."}]},
            "coach": {"steps": [{"say": "Try."}] * 3}}


def test_existing_learn_files_are_valid(tmp_path):
    shelf = catalog(tmp_path)
    for game in GAMES:
        if any(path.exists() for path in learn_paths(game)):
            loaded = shelf._load(game)
            rules = getattr(loaded, "rules", None) or types.SimpleNamespace(__file__=str(ROOT / game / "game.py"))
            data = tutorials.learn_for(rules)
            assert data is not None, game
            assert tutorials.problems(rules, data) == [], game


def test_required_games_have_learn_files():
    assert not sorted(game for game in set(CURATED) | DEMO if not (ROOT / game / "learn.json").is_file())


def test_every_game_has_a_learn_file():
    # 18 while Backgammon is hidden (its manifest is game.json.future); 19 again when its game.json is back.
    assert len(GAMES) == 18
    assert not [game for game in GAMES if not any(path.is_file() for path in learn_paths(game))]


def test_validation_and_replay(tmp_path):
    rules = catalog(tmp_path)._load("connect4").rules
    data = sample(["4", "3"])
    assert tutorials.problems(rules, data) == []
    frames = tutorials.demo_frames(rules, data)
    assert len(frames) == 3 and frames[0]["say"] == "Start."
    assert frames[1]["picture"]["cells"][5][3] == "X"
    data["demo"] = {"moves": ["99"], "lines": [{"at": 2, "say": "word " * 41}]}
    errors = tutorials.problems(rules, data)
    assert len(errors) == 3


def test_learn_endpoint_replays_table_games(tmp_path, monkeypatch):
    fake = types.ModuleType("fastapi")
    class Router:
        def get(self, path):
            return lambda fn: fn
        post = get
    fake.APIRouter = Router
    monkeypatch.setitem(sys.modules, "fastapi", fake)
    spec = importlib.util.spec_from_file_location("tutorial_test_api", ROOT / "dashboard/plugin_api.py")
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, "_open", lambda: (catalog(tmp_path), None))
    monkeypatch.setattr(api.tutorials, "learn_for", lambda rules: sample({"connect4": ["4"], "hex": ["f6"], "chessboard": ["e2e4"]}[Path(rules.__file__).parent.name]))
    for game in ("hex", "connect4", "chessboard"):
        result = api.learn(game)
        assert result["ok"] and len(result["learn"]["demo"]["frames"]) == 2
    assert not api.learn("missing")["ok"]


# The human's move for a guided rule that teaches one without naming a cell
# (a rule whose say has no highlight). The guided hints that follow are only
# meaningful in a position where the lesson's own advice has been followed.
GUIDED_MOVES = {
    "chessboard": {3: "f1c4"},
}


def test_guided_hints_are_legal(tmp_path):
    """Every guided hint is a legal move in the position it is shown in.

    Walks each front-shelf guided game the way the guide is meant to be
    followed: the person plays each highlighted cell, the built-in player
    answers, and the next rule must ring an empty, legal cell. A hint that
    names a taken cell (the Hex f6-after-swap bug) fails here.
    """
    for game in CURATED:
        shelf = catalog(tmp_path / game)
        assert run(shelf, f"allow-ai {game} black=local learn")
        state_path = next((tmp_path / game).rglob("state.json"))
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["table_id"] = f"guided-{game}"  # freeze the Easy-seed noise
        state_path.write_text(json.dumps(state), encoding="utf-8")
        table = shelf._load(game)
        data = tutorials.learn_for(table.rules)
        steps = ((data.get("coach") or {}).get("steps")) or []
        for number, step in enumerate(steps, 1):
            picture = table.picture()
            legal = {str(move) for move in (picture.get("legal") or [])}
            highlight = [str(cell) for cell in (step.get("highlight") or [])]
            if highlight:
                for cell in highlight:
                    assert cell in legal, (
                        f"{game}: guided hint {cell} (rule {number}) is not a legal "
                        f"empty cell in the position shown"
                    )
                assert run(shelf, f"{game} move {highlight[0]}").startswith("Played")
            else:
                said = GUIDED_MOVES.get(game, {}).get(number)
                if said:
                    assert said in legal, f"{game}: scripted guided move {said} (rule {number}) is not legal"
                    assert run(shelf, f"{game} move {said}").startswith("Played")


def test_guided_first_rule_matches_the_opening_position(tmp_path):
    """The first rule a guided game shows must fit the real opening position.

    The person holds White, the side that moves first in these games, so the
    first rule's hints must be legal empty cells. If following the first hint
    lets the computer take it, the next rule must have a legal hint (or none),
    so the guide can move on instead of pointing at a taken cell.
    """
    for game in CURATED:
        shelf = catalog(tmp_path / game)
        assert run(shelf, f"allow-ai {game} black=local learn")
        table = shelf._load(game)
        picture = table.picture()
        data = tutorials.learn_for(table.rules)
        steps = ((data.get("coach") or {}).get("steps")) or []
        assert steps, f"{game} has no guided rules"
        human = [seat for seat in (picture.get("seats") or []) if seat.get("kind") == "human"]
        assert len(human) == 1 and human[0]["side"] == "white", game
        assert picture.get("turn") == "white", game
        legal = {str(move) for move in (picture.get("legal") or [])}
        first = steps[0]
        for cell in first.get("highlight") or []:
            assert str(cell) in legal, (
                f"{game}: first guided rule points at {cell}, which is not a legal "
                f"empty cell in the opening"
            )
        hinted = [str(cell) for cell in (first.get("highlight") or [])]
        if not hinted:
            continue
        assert run(shelf, f"{game} move {hinted[0]}").startswith("Played")
        after = table.picture()
        legal_after = {str(move) for move in (after.get("legal") or [])}
        if any(cell in legal_after for cell in hinted):
            continue
        assert len(steps) > 1, f"{game}: the first hint was taken and no rule follows"
        nxt = steps[1]
        nxt_hints = [str(cell) for cell in (nxt.get("highlight") or [])]
        assert not nxt_hints or any(cell in legal_after for cell in nxt_hints), (
            f"{game}: after the first rule was followed the guide has no legal hint"
        )


def test_guided_hints_are_legal_on_talking_tables(tmp_path):
    """The talking table's guide names no cells: nothing can point at a taken one.

    Liar's Dice hides its dice from the table picture, so a highlighted cell
    could never be checked for legality; its guide must stay a plain rule.
    """
    shelf = catalog(tmp_path)
    assert run(shelf, "liars-dice new seats=2 learn")
    data = json.loads((ROOT / "liars_dice" / "learn.json").read_text(encoding="utf-8"))
    for number, step in enumerate(((data.get("coach") or {}).get("steps")) or [], 1):
        assert not (step.get("highlight") or []), f"liars-dice: guided rule {number} highlights a hidden cell"


def test_lesson_and_learn_undo(tmp_path):
    shelf = catalog(tmp_path)
    table = shelf._load("connect4")
    run(shelf, "connect4 lesson")
    before = table.picture()
    assert run(shelf, "connect4 lesson undo").startswith("Nothing")
    move = before["lesson"]["goal"][0]
    run(shelf, f"connect4 move {move}")
    assert table.picture()["lesson"]["undo"]
    run(shelf, "connect4 lesson undo")
    assert table.picture()["cells"] == before["cells"]
    assert not table.picture()["lesson"]["undo"]
    run(shelf, "allow-ai connect4 black=local learn")
    before = table.picture()
    assert before["learn"] and before["level"] == "beginner"
    run(shelf, "connect4 move 4")
    assert table.picture()["coach_note"]
    run(shelf, "connect4 learn undo")
    assert table.picture()["cells"] == before["cells"]
    assert run(shelf, "connect4 learn undo").startswith("Nothing")


def test_white_computer_learn_seats_owner(tmp_path):
    from shelf.who import Player
    shelf = catalog(tmp_path)
    owner = Player("discord:1", "Ada", "discord")
    run(shelf, "allow-ai connect4 white=local learn", player=owner)
    picture = shelf._load("connect4").picture()
    assert picture["learn"] and picture["level"] == "beginner"
    assert picture["turn"] == "black" and picture["coach_note"]
    assert picture["seats"][1]["id"] == owner.id
