"""Breakthrough: the rules proved on hand-built boards, the bot on spots it must get right.

Breakthrough is small enough to check by hand: eight by eight, sixteen pawns a
side, a pawn steps one square straight forward or one square diagonally forward
(moving to an empty square or taking an enemy pawn). The first pawn to the far
rank wins, and so does the side that takes every enemy pawn.

Every position below is written as eight lines, rank 8 first, ``x`` white and
``o`` black, so a test reads like the board a person sees.
"""

from __future__ import annotations

import importlib.util
import json
import copy
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf import lessons, review  # noqa: E402
from shelf.kitref import kit  # noqa: E402

ME = SimpleNamespace(id="u1", name="Ada", platform="desktop", bot=False)


def load():
    spec = importlib.util.spec_from_file_location("test_breakthrough_rules", ROOT / "breakthrough" / "game.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GAME = load()


def board(rows: str, turn: str = "white") -> dict:
    """A state from eight lines, rank 8 first."""
    white = black = 0
    lines = [line.replace(" ", "") for line in rows.strip().splitlines() if line.strip()]
    assert len(lines) == 8 and all(len(line) == 8 for line in lines), "a board is eight lines of eight"
    for index, line in enumerate(lines):
        row = 7 - index
        for col, mark in enumerate(line):
            bit = 1 << (row * 8 + col)
            if mark == "x":
                white |= bit
            elif mark == "o":
                black |= bit
            else:
                assert mark == ".", f"unexpected mark {mark!r}"
    return {"w": white, "b": black, "turn": turn, "status": "active", "winner": ""}


def names(state: dict, side: str | None = None) -> set[str]:
    if side is not None:
        state = {**state, "turn": side}
    return {GAME.show(move) for move in GAME.legal(state)}


def fresh_state() -> dict:
    return {"turn": "white", "status": "active", "winner": "", "plies": 0, "moves": [], "last": "",
            **GAME.fresh()}


# --------------------------------------------------------------------------
# rules
# --------------------------------------------------------------------------


def test_starting_position_is_two_full_ranks_a_side() -> None:
    state = fresh_state()
    assert state["w"].bit_count() == 16 and state["b"].bit_count() == 16
    cells = GAME._cells(state)
    assert cells[0] == ["o"] * 8 and cells[1] == ["o"] * 8  # ranks 8 and 7 black
    assert cells[6] == ["x"] * 8 and cells[7] == ["x"] * 8  # ranks 2 and 1 white
    assert len(GAME.legal(state)) == 22  # 8 straight steps plus 14 diagonal steps
    assert GAME.show(GAME.bot(state)) and GAME.bot(state) in GAME.legal(state)


def test_a_pawn_steps_forward_or_diagonally_and_takes_only_diagonally() -> None:
    state = board("""
........
........
........
....o...
...x....
........
........
........
""")
    # straight to d5, diagonally to the empty c5, or diagonally onto the black e5
    assert names(state) == {"d4-d5", "d4-c5", "d4-e5"}
    # a straight move never captures, even when an enemy pawn stands there
    blocked = board("""
........
........
........
...o....
...x....
........
........
........
""")
    assert "d4-d5" not in names(blocked)
    assert names(blocked) == {"d4-c5", "d4-e5"}


def test_pawns_never_move_sideways_or_backward() -> None:
    state = board("""
........
........
........
...o....
...x....
........
........
........
""", turn="black")
    for move in GAME.legal(state):
        start, end = move
        assert end // 8 == start // 8 - 1, "black only ever moves down one rank"
        assert abs(end % 8 - start % 8) <= 1, "no sideways move"
    white = board("""
........
........
........
...o....
...x....
........
........
........
""")
    for move in GAME.legal(white):
        start, end = move
        assert end // 8 == start // 8 + 1, "white only ever moves up one rank"


def test_a_capture_takes_the_pawn_and_taking_the_last_one_wins() -> None:
    state = board("""
........
........
........
....o...
...x....
........
........
........
""")
    note = GAME.play(state, GAME.parse(["d4-e5"]))
    assert "Took a pawn" in note and "no pawns" in note
    assert state["status"] == "win" and state["winner"] == "white"
    assert state["b"] == 0


def test_reaching_the_far_rank_wins_at_once() -> None:
    white = board("""
........
......x.
........
........
........
........
........
....o...
""")
    note = GAME.play(white, GAME.parse(["g7-g8"]))
    assert "far rank" in note
    assert white["status"] == "win" and white["winner"] == "white"

    black = board("""
........
........
........
........
........
........
..o.....
......x.
""", turn="black")
    GAME.play(black, GAME.parse(["c2-c1"]))
    assert black["status"] == "win" and black["winner"] == "black"


def test_play_refuses_a_square_that_is_not_yours() -> None:
    state = fresh_state()
    with pytest.raises(ValueError):
        GAME.play(state, GAME.parse(["a5-a6"]))


@pytest.mark.parametrize("written", ["b2-b3", "B2B3", "b2 b3", "b2xb3", "b2:b3"])
def test_parse_reads_the_ways_a_person_types_a_move(written: str) -> None:
    assert GAME.parse(written.split()) == GAME.parse(["b2-b3"])
    assert GAME.show(GAME.parse(written.split())) == "b2-b3"


@pytest.mark.parametrize("written", ["b2", "b9-b3", "b2-b3-c4", "hello", "b2-b2"])
def test_parse_refuses_nonsense(written: str) -> None:
    assert GAME.parse(written.split()) is None


def test_the_rules_text_matches_the_moves_the_game_allows() -> None:
    """A person and the model are both told the rules; the words must agree with legal()."""
    text = " ".join(GAME.HELP).lower()
    assert "onto an empty square" in text, "a diagonal step onto an empty square is legal"
    assert "only a diagonal move can take a pawn" in text
    state = fresh_state()
    diagonal_steps = [move for move in GAME.legal(state) if move[0] % 8 != move[1] % 8]
    assert diagonal_steps, "the diagonal step onto an empty square is a real move"
    for move in diagonal_steps:
        assert not state["b"] >> move[1] & 1, "opening diagonal moves are steps, never captures"


def test_draw_and_picture_read_like_the_board() -> None:
    state = fresh_state()
    lines = GAME.draw(state)
    assert lines[0].split() == list("abcdefgh")
    assert lines[1].startswith("8 ") and lines[8].startswith("1 ")
    picture = GAME.picture(state)
    assert picture["files"] == "abcdefgh" and picture["ranks"] == [8, 7, 6, 5, 4, 3, 2, 1]
    assert picture["cells"][0] == ["o"] * 8
    assert "b2-b3" in picture["legal"]


# --------------------------------------------------------------------------
# lesson
# --------------------------------------------------------------------------


def test_the_lesson_is_sound_and_teaches_a_real_breakthrough() -> None:
    steps = kit.lesson_steps(GAME)
    assert 3 <= len(steps) <= 7
    assert lessons.problems(GAME, steps) == []
    last = kit.lesson_position(GAME, steps[-1])
    assert steps[-1]["wins"] is True
    assert kit.lesson_passes(GAME, steps[-1], last, GAME.parse(["h7-g8"]))


# --------------------------------------------------------------------------
# the built-in player
# --------------------------------------------------------------------------


def test_the_bot_takes_a_win_it_is_given() -> None:
    state = board("""
........
......x.
........
........
........
........
........
....o...
""")
    assert GAME.show(GAME.bot(state)) == "g7-g8"


def test_the_bot_saves_the_game_it_must() -> None:
    """Black's pawn on h2 takes g1 next move and reaches the far rank.

    Only g1-h2 removes the threat; every other white move loses at once, so a
    shallow player picks one of them. This is the search doing real work.
    """
    state = fresh_state()
    state["w"] &= ~(1 << (1 * 8 + 7))  # h2 is black's
    state["b"] &= ~(1 << (6 * 8 + 7))  # its own h7 disappears for this test
    state["b"] |= 1 << (1 * 8 + 7)
    assert "g1-h2" in names(state)
    others = [move for move in GAME.legal(state) if GAME.show(move) != "g1-h2"]
    for move in others:
        trial = {**state}
        GAME.play(trial, move)
        assert trial["status"] == "active"
        assert any(GAME.show(reply) == "h2-g1" for reply in GAME.legal(trial)), GAME.show(move)
    assert GAME.show(GAME.bot(state)) == "g1-h2"


def test_every_bot_move_is_legal_and_under_a_second() -> None:
    assert GAME._DEPTH >= 4
    state = fresh_state()
    slowest = 0.0
    for _ in range(12):
        start = time.monotonic()
        move = GAME.bot(state)
        slowest = max(slowest, time.monotonic() - start)
        assert move in GAME.legal(state)
        GAME.play(state, move)
    assert slowest < 1.0, f"the bot took {slowest:.2f}s for one move"


def test_the_bot_plays_a_whole_game_to_a_real_finish() -> None:
    state = fresh_state()
    for _ in range(GAME.MAX_PLIES):
        if state["status"] != "active":
            break
        GAME.play(state, GAME.bot(state))
    assert state["status"] == "win"
    assert state["winner"] in {"white", "black"}
    assert state["w"] and state["b"], "a pawn was left on the far rank rather than taken"


# --------------------------------------------------------------------------
# Review My Game
# --------------------------------------------------------------------------

# White marches a pawn to h7 while black shuffles, then plays a quiet move
# instead of the capture on g8 that ends the game.
MISSED_WIN_LINE = [
    "g2-g3", "a7-a6", "g3-g4", "b7-b6", "g4-g5", "c7-c6", "g5-g6", "d7-d6",
    "g6-h7", "a6-a5", "a2-a3",
]

ALLOWED_WIN_BOARD = """
........
o......o
........
........
........
........
.o......
x.x....x
"""


def test_review_finds_the_missed_win_in_a_whole_game() -> None:
    found = review.find_mistake(GAME, MISSED_WIN_LINE, "white")
    assert found and found["kind"] == "missed_win"
    assert found["ply"] == len(MISSED_WIN_LINE)
    assert "h7-g8" in found["goal"]
    step = {key: found[key] for key in ("say", "setup", "goal", "wins", "tip", "praise")}
    position = kit.lesson_position(GAME, step)
    legal = {GAME.show(move).lower(): move for move in GAME.legal(position)}
    for token in found["goal"]:
        assert token in legal
        assert kit.lesson_passes(GAME, step, position, legal[token])
    assert [item for item in lessons.problems(GAME, [step]) if "steps; use 3 to 7" not in item] == []


# Black walks a pawn down the b-file and turns onto c2, where it wins by taking
# on b1 or d1. White plays a quiet move instead of taking it.
ALLOWED_WIN_LINE = [
    "h2-h3", "b7-b6", "h3-h4", "b6-b5", "g2-g3", "b5-b4", "g3-g4", "b4-b3",
    "f2-f3", "b3-c2", "f3-f4",
]

ALLOWED_WIN_BOARD = """
........
o......o
........
........
........
........
.o......
x.x....x
"""


def test_review_finds_the_win_a_move_allowed() -> None:
    """Black's pawn on c2 takes on b1 or d1 and wins; f3-f4 lets it happen."""
    found = review.find_mistake(GAME, ALLOWED_WIN_LINE, "white")
    assert found and found["kind"] == "allowed_win"
    assert found["ply"] == len(ALLOWED_WIN_LINE)
    assert set(found["goal"]) == {"b1-c2", "d1-c2"}
    step = {key: found[key] for key in ("say", "setup", "goal", "wins", "tip", "praise")}
    position = kit.lesson_position(GAME, step)
    legal = {GAME.show(move).lower(): move for move in GAME.legal(position)}
    for token in found["goal"]:
        assert token in legal, token
        assert kit.lesson_passes(GAME, step, position, legal[token]), token
        trial = copy.deepcopy(position)
        GAME.play(trial, legal[token])
        assert trial["status"] == "active", "a save must keep the game alive"
    assert not kit.lesson_passes(GAME, step, position, GAME.parse(["f3-f4"]))
    assert [item for item in lessons.problems(GAME, [step]) if "steps; use 3 to 7" not in item] == []


def test_a_hand_built_board_is_read_the_same_way() -> None:
    """The same shape on a board built by hand: black on b2, white pawns on a1 and c1."""
    state = board(ALLOWED_WIN_BOARD)
    assert "h1-h2" in names(state)
    found = review.examine(GAME, state, GAME.parse(["h1-h2"]))
    assert found and found["kind"] == "allowed_win"
    assert set(found["goal"]) == {"a1-b2", "c1-b2"}
    for token in found["goal"]:
        trial = copy.deepcopy(state)
        GAME.play(trial, GAME.parse([token]))
        assert trial["status"] == "active"


def test_review_through_the_table_turns_the_mistake_into_a_lesson(tmp_path) -> None:
    state = review.start(GAME)
    for token in MISSED_WIN_LINE:
        move = GAME.parse(token.split())
        assert move in GAME.legal(state), token
        GAME.play(state, move)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = GAME.show(move)
    state.update({
        "schema_version": 2,
        "table_id": "t1",
        "owner_id": "u1",
        "game": "breakthrough",
        "white": "human", "black": "local",
        "white_id": "u1", "black_id": "local",
        "white_name": "Ada", "black_name": "Local",
        "score": {"white": 0, "black": 1, "draws": 0},
        "result_recorded": True,
        "result_reason": "breakthrough",
        "moves": MISSED_WIN_LINE,
    })
    assert state["status"] == "active"
    state["status"] = "win"
    state["winner"] = "black"
    table = GAME.create(tmp_path)
    kit.save(tmp_path, state)
    answer = table.command("review", player=ME)
    assert "Review" in answer and "winning move" in answer, answer
    saved = json.loads((tmp_path / "state.json").read_text())
    assert saved["lesson"]["custom"]["wins"] is True
    assert saved["score"] == {"white": 0, "black": 1, "draws": 0}, "a review never scores"
    goal = saved["lesson"]["custom"]["goal"][0]
    assert saved["lesson"]["custom"]["praise"] in table.command(f"move {goal}", player=ME)
