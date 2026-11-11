"""Reversi. 8 by 8, a1 at the top left. White plays X and moves first. A side with no move passes."""

from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
# Load this plugin's own kit.py under a name no other plugin can claim. A plain
# `import kit` would hand us another plugin's module when both ship a kit.py.
_KIT_NAME = "hermes_gameshelf_kit"
if _KIT_NAME not in sys.modules:
    _kit_spec = importlib.util.spec_from_file_location(_KIT_NAME, _ROOT / "kit.py")
    _kit_module = importlib.util.module_from_spec(_kit_spec)
    sys.modules[_KIT_NAME] = _kit_module
    _kit_spec.loader.exec_module(_kit_module)
kit = sys.modules[_KIT_NAME]

ID = "reversi"
TITLE = "Reversi"
MARKS = ("X", "O")
EXAMPLE = "move d3"
MAX_PLIES = 130
HELP = [
    "Place a disc so it traps a line of the other color. Those discs flip.",
    "If you have no move, you pass. Most discs at the end wins.",
]

_SIZE = 8
_COLS = "abcdefgh"
# Depth cap per level: two plies is the shipped Intermediate, Beginner scores
# the move alone, Advanced also sees what we can do back, Expert one deeper —
# guarded by the wall clock below so it never leaves a person waiting.
_TIME_LIMIT = 1.8
_LEVEL_DEPTH = {"beginner": 1, "intermediate": 2, "advanced": 3, "expert": 4}
_DIRECTIONS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
_WEIGHTS = (
    (100, -20, 10, 5, 5, 10, -20, 100),
    (-20, -50, -2, -2, -2, -2, -50, -20),
    (10, -2, 1, 1, 1, 1, -2, 10),
    (5, -2, 1, 0, 0, 1, -2, 5),
    (5, -2, 1, 0, 0, 1, -2, 5),
    (10, -2, 1, 1, 1, 1, -2, 10),
    (-20, -50, -2, -2, -2, -2, -50, -20),
    (100, -20, 10, 5, 5, 10, -20, 100),
)


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    board = [["." for _ in range(_SIZE)] for _ in range(_SIZE)]
    board[3][3] = "O"
    board[4][4] = "O"
    board[3][4] = "X"
    board[4][3] = "X"
    return {"board": board}


def _mark(side: str) -> str:
    return MARKS[0] if side == "white" else MARKS[1]


def _square(text: str) -> tuple[int, int] | None:
    text = text.strip().lower()
    if len(text) != 2 or text[0] not in _COLS or not text[1].isdigit():
        return None
    row = int(text[1]) - 1
    if not 0 <= row < _SIZE:
        return None
    return row, _COLS.index(text[0])


def parse(words: list[str]) -> str | None:
    if not words or _square(words[0]) is None:
        return None
    return words[0].strip().lower()


def show(move: str) -> str:
    return move


def _flips(board: list[list[str]], row: int, col: int, mark: str) -> list[tuple[int, int]]:
    if board[row][col] != ".":
        return []
    other = "O" if mark == "X" else "X"
    found: list[tuple[int, int]] = []
    for dr, dc in _DIRECTIONS:
        line: list[tuple[int, int]] = []
        r, c = row + dr, col + dc
        while 0 <= r < _SIZE and 0 <= c < _SIZE and board[r][c] == other:
            line.append((r, c))
            r += dr
            c += dc
        if line and 0 <= r < _SIZE and 0 <= c < _SIZE and board[r][c] == mark:
            found.extend(line)
    return found


def _moves(board: list[list[str]], mark: str) -> list[str]:
    return [
        f"{_COLS[col]}{row + 1}"
        for row in range(_SIZE)
        for col in range(_SIZE)
        if _flips(board, row, col, mark)
    ]


def legal(state: dict) -> list[str]:
    return _moves(state["board"], _mark(state["turn"]))


def _count(board: list[list[str]]) -> tuple[int, int]:
    flat = [cell for row in board for cell in row]
    return flat.count("X"), flat.count("O")


def play(state: dict, move: str) -> str:
    board = state["board"]
    side = state["turn"]
    other = "black" if side == "white" else "white"
    row, col = _square(move)
    mark = _mark(side)
    for r, c in _flips(board, row, col, mark):
        board[r][c] = mark
    board[row][col] = mark
    if _moves(board, _mark(other)):
        state["turn"] = other
        return ""
    if _moves(board, mark):
        return f"{other.capitalize()} has no move and passes."
    white, black = _count(board)
    if white == black:
        state["status"] = "draw"
        state["winner"] = ""
        state["result_detail"] = "no_moves"
    else:
        state["status"] = "win"
        state["winner"] = "white" if white > black else "black"
        state["result_detail"] = "no_moves"
    return f"Final {white} to {black}."


def _copy(state: dict) -> dict:
    return {"board": [row[:] for row in state["board"]], "turn": state["turn"], "status": "active", "winner": ""}


def _value(state: dict, me: str) -> float:
    board = state["board"]
    mine = _mark(me)
    theirs = "O" if mine == "X" else "X"
    if state["status"] != "active":
        white, black = _count(board)
        diff = (white - black) if me == "white" else (black - white)
        return diff * 10000
    score = 0
    for row in range(_SIZE):
        for col in range(_SIZE):
            if board[row][col] == mine:
                score += _WEIGHTS[row][col]
            elif board[row][col] == theirs:
                score -= _WEIGHTS[row][col]
    score += 5 * (len(_moves(board, mine)) - len(_moves(board, theirs)))
    return score


def _search(state: dict, me: str, depth: int, deadline: float | None = None) -> float:
    """Score for ``me``: deeper levels look further through the opponent's replies."""
    if deadline is not None and time.monotonic() > deadline:
        raise _TimeUp
    if depth <= 0 or state["status"] != "active":
        return _value(state, me)
    replies = legal(state)
    if not replies:
        return _value(state, me)
    scores = []
    for reply in replies:
        child = _copy(state)
        play(child, reply)
        scores.append(_search(child, me, depth - 1, deadline))
    return max(scores) if state["turn"] == me else min(scores)


class _TimeUp(Exception):
    """Raised inside the search when the wall clock runs past the budget."""


def _best_at_depth(state: dict, me: str, choices: list[str], deep: int,
                   deadline: float | None = None) -> str:
    """The move the plain minimax prefers at exactly ``deep`` plies."""
    best_move, best_score = choices[0], float("-inf")
    for move in choices:
        child = _copy(state)
        play(child, move)
        if child["status"] != "active" or child["turn"] == me:
            score = _value(child, me)
        else:
            score = _search(child, me, deep - 1, deadline)
        if score > best_score:
            best_move, best_score = move, score
    return best_move


def bot(state: dict, depth: int | None = None) -> str:
    """Iterative deepening: keep the best move from the deepest full search.

    The search is plain minimax, so depth 4 in a busy midgame costs seconds.
    We try 1, 2, 3, 4 plies in order and stop at whichever first misses the
    deadline, playing the best move from the deepest one that completed. At
    Intermediate and Advanced the depth is small enough to always complete,
    so those levels play exactly the shipped move.
    """
    me = state["turn"]
    choices = legal(state)
    deep = kit.level_depth(state, _LEVEL_DEPTH) if depth is None else max(1, min(int(depth), 4))
    # Same rule as checkers: the clock is for the player, not for a measurement. With
    # GAMESHELF_BOT_DETERMINISTIC=1 the iterative deepening runs to its depth cap, so a strength
    # test does not depend on how loaded the machine is.
    deadline = float("inf") if os.environ.get("GAMESHELF_BOT_DETERMINISTIC") == "1" else time.monotonic() + _TIME_LIMIT
    best_move = None
    for trial in range(1, deep + 1):
        try:
            best_move = _best_at_depth(state, me, choices, trial, deadline)
        except _TimeUp:
            break
    if best_move is None:
        best_move = choices[0]  # not even one ply finished; any legal move beats stalling
    return kit.level_pick(state, choices, best_move)


def draw(state: dict) -> list[str]:
    board = state["board"]
    lines = ["  " + " ".join(_COLS)]
    lines += [f"{row + 1} " + " ".join(board[row]) for row in range(_SIZE)]
    white, black = _count(board)
    lines.append(f"Discs: X {white}  O {black}")
    return lines


def picture(state: dict) -> dict:
    white, black = _count(state["board"])
    spot = _square(str(state.get("last") or ""))
    last_to = None
    if spot:
        last_to = {"row": spot[0], "col": spot[1], "name": str(state.get("last") or "")}
    return {
        "view": "reversi",
        "cells": [row[:] for row in state["board"]],
        "files": _COLS,
        "ranks": list(range(1, _SIZE + 1)),
        "legal": list(legal(state)),
        "score": [white, black],
        "last_to": last_to,
    }
