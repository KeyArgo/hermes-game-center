"""Connect Four. Columns are 1 through 7. White plays X and moves first."""

from __future__ import annotations

import importlib.util
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

ID = "connect4"
TITLE = "Connect Four"
MARKS = ("X", "O")
# The discs are red against yellow. The table and the text board say so, rather than
# calling a drop game's players White and Black the way the chess tables do.
SIDE_WORDS = {"white": "Red", "black": "Yellow"}
EXAMPLE = "move 4"
MAX_PLIES = 42
HELP = ["Drop a piece in a column, 1 through 7. Four in a row wins."]

_ROWS = 6
_COLS = 7
_ORDER = (4, 3, 5, 2, 6, 1, 7)


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    return {"board": [["." for _ in range(_COLS)] for _ in range(_ROWS)]}


def parse(words: list[str]) -> int | None:
    if not words or not words[0].isdigit():
        return None
    return int(words[0])


def legal(state: dict) -> list[int]:
    return [column for column in range(1, _COLS + 1) if state["board"][_ROWS - 1][column - 1] == "."]


def refusal(state: dict, move) -> str:
    """A short, true reason the move was refused."""
    if not isinstance(move, int):
        return "That isn't a column."
    if move < 1 or move > _COLS:
        return f"There is no column {move}."
    if state["board"][_ROWS - 1][move - 1] != ".":
        return "That column is full."
    return "That move isn't allowed."


def show(move: int) -> str:
    return str(move)


def play(state: dict, column: int) -> str:
    board = state["board"]
    mark = MARKS[0] if state["turn"] == "white" else MARKS[1]
    for row in range(_ROWS):
        if board[row][column - 1] == ".":
            board[row][column - 1] = mark
            if _won(board, row, column - 1, mark):
                state["status"] = "win"
                state["winner"] = state["turn"]
                state["result_detail"] = "four"
            elif not legal(state):
                state["status"] = "draw"
                state["result_detail"] = "board_full"
            else:
                state["turn"] = "black" if state["turn"] == "white" else "white"
            return ""
    return ""


def _winning_run(board: list[list[str]], mark: str) -> list[dict]:
    """The four cells that made the four. The result screen rings them, so the win is seen."""
    for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
        for row in range(_ROWS):
            for col in range(_COLS):
                end_r, end_c = row + dr * 3, col + dc * 3
                if not (0 <= end_r < _ROWS and 0 <= end_c < _COLS):
                    continue
                line = [(row + dr * step, col + dc * step) for step in range(4)]
                if all(board[r][c] == mark for r, c in line):
                    return [{"row": _ROWS - 1 - r, "col": c} for r, c in line]
    return []


def _won(board: list[list[str]], row: int, col: int, mark: str) -> bool:
    for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
        count = 1
        for sign in (1, -1):
            r, c = row + dr * sign, col + dc * sign
            while 0 <= r < _ROWS and 0 <= c < _COLS and board[r][c] == mark:
                count += 1
                r += dr * sign
                c += dc * sign
        if count >= 4:
            return True
    return False


_WINDOWS = tuple(
    tuple((row + dr * i) * _COLS + (col + dc * i) for i in range(4))
    for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1))
    for row in range(_ROWS)
    for col in range(_COLS)
    if 0 <= row + dr * 3 < _ROWS and 0 <= col + dc * 3 < _COLS
)
_CELL_WINDOWS = tuple(
    tuple(index for index, window in enumerate(_WINDOWS) if cell in window)
    for cell in range(_ROWS * _COLS)
)
_WEIGHT = (0, 2, 8, 60, 100_000)
_MATE = 100_000
_TIME_LIMIT = 1.7
# Depth cap per level. Seven plies is Intermediate, nine Advanced, twelve
# Expert (the time limit below bounds it), one is Beginner (the kit adds the
# light noise that makes Beginner beatable).
_LEVEL_DEPTH = {"beginner": 1, "intermediate": 7, "advanced": 9, "expert": 12}


class _TimeUp(Exception):
    """The search ran out of its budget; the caller plays the best column found so far."""


def _pair_value(counts: list[int]) -> int:
    """A window belongs to whichever side stands alone in it; mixed windows are worth nothing."""
    mine, theirs = counts
    if theirs:
        return 0 if mine else -_WEIGHT[theirs]
    return _WEIGHT[mine]


class _Board:
    """A flat board that keeps its window score up to date as stones go in and out."""

    __slots__ = ("cells", "heights", "counts", "score")

    def __init__(self, state: dict) -> None:
        self.cells = [state["board"][row][col] for row in range(_ROWS) for col in range(_COLS)]
        self.heights = [next((row for row in range(_ROWS) if state["board"][row][col] == "."), _ROWS)
                        for col in range(_COLS)]
        self.counts = [[0, 0] for _ in _WINDOWS]
        for index, window in enumerate(_WINDOWS):
            for cell in window:
                piece = self.cells[cell]
                if piece == "X":
                    self.counts[index][0] += 1
                elif piece == "O":
                    self.counts[index][1] += 1
        self.score = sum(_pair_value(counts) for counts in self.counts)

    def move(self, column: int, mark: str) -> int | None:
        row = self.heights[column]
        if row >= _ROWS:
            return None
        cell = row * _COLS + column
        self.cells[cell] = mark
        self.heights[column] = row + 1
        side = 0 if mark == "X" else 1
        for index in _CELL_WINDOWS[cell]:
            counts = self.counts[index]
            before = _pair_value(counts)
            counts[side] += 1
            self.score += _pair_value(counts) - before
        return row

    def undo(self, column: int, mark: str) -> int:
        row = self.heights[column] - 1
        self.heights[column] = row
        cell = row * _COLS + column
        self.cells[cell] = "."
        side = 0 if mark == "X" else 1
        for index in _CELL_WINDOWS[cell]:
            counts = self.counts[index]
            before = _pair_value(counts)
            counts[side] -= 1
            self.score += _pair_value(counts) - before
        return row

    def won(self, row: int, column: int, mark: str) -> bool:
        for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
            count = 1
            for sign in (1, -1):
                r, c = row + dr * sign, column + dc * sign
                while 0 <= r < _ROWS and 0 <= c < _COLS and self.cells[r * _COLS + c] == mark:
                    count += 1
                    r += dr * sign
                    c += dc * sign
            if count >= 4:
                return True
        return False

    def value(self, mark: str) -> int:
        return self.score if mark == "X" else -self.score


def _negamax(game: _Board, mark: str, depth: int, alpha: int, beta: int,
             deadline: float, ply: int) -> int:
    """Depth in plies; a made four scores as a win, a finished board as a draw."""
    if time.monotonic() > deadline:
        raise _TimeUp
    other = "O" if mark == "X" else "X"
    moves = [column for column in range(_COLS) if game.heights[column] < _ROWS]
    if not moves:
        return 0
    if depth <= 0:
        return game.value(mark)
    moves.sort(key=lambda column: abs(column - 3))
    best = -2 * _MATE
    for column in moves:
        row = game.move(column, mark)
        if row is None:
            continue
        if game.won(row, column, mark):
            value = _MATE - ply
        elif depth == 1:
            value = game.value(mark)
        else:
            value = -_negamax(game, other, depth - 1, -beta, -alpha, deadline, ply + 1)
        game.undo(column, mark)
        if value > best:
            best = value
        if value > alpha:
            alpha = value
        if alpha >= beta:
            break
    return best


def bot(state: dict, depth: int | None = None) -> int:
    """Negamax with alpha-beta, seven plies by default: it now sees a double threat coming.

    Win in one is taken, a loss in one is blocked, and the clock keeps every move well
    inside the table's patience. The level sets the depth cap and Easy's light noise.
    """
    side = state["turn"]
    mark = MARKS[0] if side == "white" else MARKS[1]
    open_columns = legal(state)
    if not open_columns:
        return 1
    level = kit.level_depth(state, _LEVEL_DEPTH) if depth is None else max(1, min(int(depth), 12))
    game = _Board(state)
    other = "O" if mark == "X" else "X"
    for who in (mark, other):  # take a win now, then stop a loss now
        for column in open_columns:
            row = game.move(column - 1, who)
            won = row is not None and game.won(row, column - 1, who)
            if row is not None:
                game.undo(column - 1, who)
            if won:
                return column
    deadline = time.monotonic() + _TIME_LIMIT
    columns = sorted(open_columns, key=lambda column: abs(column - 4))
    best = columns[0]
    # Iterative deepening: each shallower depth is finished and kept, so a clock
    # that runs out on the deepest one still leaves a searched move rather than
    # the middle column by default.
    for deep in range(1, level + 1):
        alpha = -2 * _MATE
        found, found_value = None, -2 * _MATE
        try:
            for column in columns:
                row = game.move(column - 1, mark)
                try:
                    value = -_negamax(game, other, deep - 1, -2 * _MATE, -alpha, deadline, 1)
                finally:
                    if row is not None:
                        game.undo(column - 1, mark)
                if value > found_value:
                    found, found_value = column, value
                if value > alpha:
                    alpha = value
        except _TimeUp:
            break
        if found is not None:
            best = found
        if time.monotonic() > deadline:
            break
    return kit.level_pick(state, open_columns, best)


def draw(state: dict) -> list[str]:
    lines = [" ".join(state["board"][row]) for row in range(_ROWS - 1, -1, -1)]
    lines.append("1 2 3 4 5 6 7")
    return lines


def picture(state: dict) -> dict:
    cells = [state["board"][row][:] for row in range(_ROWS - 1, -1, -1)]
    last_to = None
    shown = str(state.get("last") or "")
    if shown.isdigit():
        col = int(shown) - 1
        if 0 <= col < _COLS:
            for vis, row in enumerate(cells):
                if row[col] != ".":
                    last_to = {"row": vis, "col": col, "name": shown}
                    break
    return {
        "view": "connect4",
        "cells": cells,
        "files": "1234567",
        "ranks": list(range(_ROWS, 0, -1)),
        "legal": [str(column) for column in legal(state)],
        "last_to": last_to,
        "highlight": _winning_run(state["board"], MARKS[0] if state.get("winner") == "white" else MARKS[1])
        if state.get("status") == "win" else [],
    }


def wins_next(state: dict, side: str):
    """Find an immediate win without changing the game."""
    import copy

    if state.get("status") != "active":
        return ""
    position = copy.deepcopy(state)
    position["turn"] = side
    for move in legal(position):
        trial = copy.deepcopy(position)
        play(trial, move)
        if trial.get("status") == "win" and trial.get("winner") == side:
            return move
    return ""


def explain(move, state: dict) -> str:
    return "It takes the middle column." if move == 4 else f"It drops a piece in column {show(move)}."
