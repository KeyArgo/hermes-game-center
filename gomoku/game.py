"""Gomoku. 15 by 15, a1 at the top left. Five or more in a row wins. White plays X and moves first."""

from __future__ import annotations

import importlib.util
import sys
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

ID = "gomoku"
TITLE = "Gomoku"
MARKS = ("X", "O")
EXAMPLE = "move h8"
MAX_PLIES = 225
HELP = ["Place a stone on any empty point. Five or more in a row, in any direction, wins."]

_SIZE = 15
_COLS = "abcdefghijklmno"
_CENTER = (7, 7)
_LINES = ((0, 1), (1, 0), (1, 1), (1, -1))


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    return {"board": [["." for _ in range(_SIZE)] for _ in range(_SIZE)]}


def _mark(side: str) -> str:
    return MARKS[0] if side == "white" else MARKS[1]


def _square(text: str) -> tuple[int, int] | None:
    text = text.strip().lower()
    if len(text) < 2 or text[0] not in _COLS or not text[1:].isdigit():
        return None
    row = int(text[1:]) - 1
    if not 0 <= row < _SIZE:
        return None
    return row, _COLS.index(text[0])


def _name(row: int, col: int) -> str:
    return f"{_COLS[col]}{row + 1}"


def parse(words: list[str]) -> str | None:
    if not words:
        return None
    spot = _square(words[0])
    return _name(*spot) if spot else None


def show(move: str) -> str:
    return move


def legal(state: dict) -> list[str]:
    board = state["board"]
    return [_name(row, col) for row in range(_SIZE) for col in range(_SIZE) if board[row][col] == "."]


def _run(board: list[list[str]], row: int, col: int, mark: str, dr: int, dc: int) -> tuple[int, int]:
    """Stones in a row through (row, col) as if mark stood there, and how many ends are open."""
    count, opened = 1, 0
    for sign in (1, -1):
        r, c = row + dr * sign, col + dc * sign
        while 0 <= r < _SIZE and 0 <= c < _SIZE and board[r][c] == mark:
            count += 1
            r += dr * sign
            c += dc * sign
        if 0 <= r < _SIZE and 0 <= c < _SIZE and board[r][c] == ".":
            opened += 1
    return count, opened


def _wins(board: list[list[str]], row: int, col: int, mark: str) -> bool:
    return any(_run(board, row, col, mark, dr, dc)[0] >= 5 for dr, dc in _LINES)


def play(state: dict, move: str) -> str:
    board = state["board"]
    row, col = _square(move)
    mark = _mark(state["turn"])
    board[row][col] = mark
    if _wins(board, row, col, mark):
        state["status"] = "win"
        state["winner"] = state["turn"]
        state["result_detail"] = "five"
    elif not any("." in line for line in board):
        state["status"] = "draw"
        state["winner"] = ""
        state["result_detail"] = "board_full"
    else:
        state["turn"] = "black" if state["turn"] == "white" else "white"
    return ""


def _winning_line(board: list[list[str]], mark: str) -> list[dict]:
    """The five stones that won, so the result screen can ring them."""
    for row in range(_SIZE):
        for col in range(_SIZE):
            for dr, dc in _LINES:
                end_r, end_c = row + dr * 4, col + dc * 4
                if not (0 <= end_r < _SIZE and 0 <= end_c < _SIZE):
                    continue
                line = [(row + dr * step, col + dc * step) for step in range(5)]
                if all(board[r][c] == mark for r, c in line):
                    return [{"row": r, "col": c} for r, c in line]
    return []


def _worth(count: int, opened: int) -> int:
    """A four wins next move; an open three makes a four. Both must outrank quiet shapes."""
    if count >= 5:
        return 100_000
    if opened == 0:
        return 0
    table = {4: (50_000, 50_000), 3: (500, 5_000), 2: (20, 200), 1: (1, 2)}
    return table[count][opened - 1]


def _near(board: list[list[str]], row: int, col: int) -> bool:
    for r in range(max(0, row - 2), min(_SIZE, row + 3)):
        for c in range(max(0, col - 2), min(_SIZE, col + 3)):
            if board[r][c] != ".":
                return True
    return False


def _points(board: list[list[str]]) -> list[tuple[int, int]]:
    """Every empty point within two of a stone: the only places worth looking at."""
    near = [(row, col) for row in range(_SIZE) for col in range(_SIZE)
            if board[row][col] == "." and _near(board, row, col)]
    return near


def _attack(board: list[list[str]], row: int, col: int, mark: str) -> int:
    """What placing mark on this empty point would be worth: shapes plus a little position."""
    base = 0
    for dr, dc in _LINES:
        base += _worth(*_run(board, row, col, mark, dr, dc))
    base -= abs(row - _CENTER[0]) + abs(col - _CENTER[1])
    return base


def _shape(board: list[list[str]], spots: list[tuple[int, int]], mine: str, theirs: str) -> tuple[int, int]:
    """Both sides' two best shapes, summed: a double threat must outrank a single one."""
    mine_values: list[int] = []
    their_values: list[int] = []
    for row, col in spots:
        if board[row][col] != ".":
            continue
        mine_values.append(_attack(board, row, col, mine))
        their_values.append(_attack(board, row, col, theirs))
    mine_values.sort(reverse=True)
    their_values.sort(reverse=True)
    return sum(mine_values[:2]), sum(their_values[:2])


# Weights that decide how much a reply is feared: named so the suite can pin them.
_W = {"candidates": 12, "replies": 5, "defend": 1.2, "own": 0.3}
# Depth cap per level. This minimax is two plies by construction (our move,
# their best answer, then shape scoring), so the levels above Intermediate buy
# wider candidate lists, not more plies — the deepest affordable search here
# is the widest one; Beginner plays the one-ply greedy move (plus noise).
_LEVEL_DEPTH = {"beginner": 1, "intermediate": 2, "advanced": 2, "expert": 3}
_LEVEL_WIDTH = {"beginner": (12, 5), "intermediate": (_W["candidates"], _W["replies"]),
                "advanced": (18, 7), "expert": (24, 9)}


def bot(state: dict, depth: int | None = None) -> str:
    """Win in one, stop a five, then two plies of shape scoring.

    The second ply is what makes it refuse a four or an open three: it plays our move, plays
    the opponent's best answer, and only then scores the board. A move that hands them five
    in a row is dropped outright.
    """
    board = state["board"]
    mine = _mark(state["turn"])
    theirs = "O" if mine == "X" else "X"
    empty = sum(row.count(".") for row in board)
    if empty == _SIZE * _SIZE:
        return _name(*_CENTER)
    level = kit.level_depth(state, _LEVEL_DEPTH) if depth is None else max(1, min(int(depth), 3))
    candidates, replies_wanted = _LEVEL_WIDTH[kit.level(state)] if depth is None else (12, 5)
    spots = _points(board) or [(row, col) for row in range(_SIZE) for col in range(_SIZE)
                               if board[row][col] == "."]
    if not spots:
        return _name(*_CENTER)
    for spot in spots:
        if _wins(board, spot[0], spot[1], mine):
            return _name(*spot)
    stops = [spot for spot in spots if _wins(board, spot[0], spot[1], theirs)]
    if stops:
        return _name(*max(stops, key=lambda spot: _attack(board, *spot, mine)))
    ranked = sorted(spots, key=lambda spot: _attack(board, *spot, mine)
                    + _attack(board, *spot, theirs), reverse=True)[:candidates]
    if level == 1:
        greedy = _name(*max(spots, key=lambda spot: _attack(board, *spot, mine)
                            + _W["defend"] * _attack(board, *spot, theirs)))
        return kit.level_pick(state, [_name(*spot) for spot in spots], greedy)

    best_spot, best_value = ranked[0], None
    for row, col in ranked:
        own = _attack(board, row, col, mine)
        board[row][col] = mine
        after = _points(board)
        if any(_wins(board, r, c, theirs) for r, c in after):
            board[row][col] = "."
            continue  # this move hands them five in a row
        replies = sorted(after, key=lambda spot: _attack(board, *spot, theirs),
                         reverse=True)[:replies_wanted]
        worst = None
        for r2, c2 in replies:
            board[r2][c2] = theirs
            my_shape, their_shape = _shape(board, _points(board), mine, theirs)
            board[r2][c2] = "."
            value = my_shape - _W["defend"] * their_shape
            if worst is None or value < worst:
                worst = value
        board[row][col] = "."
        value = _W["own"] * own + (worst or 0)
        if best_value is None or value > best_value:
            best_spot, best_value = (row, col), value
    return kit.level_pick(state, [_name(*spot) for spot in spots], _name(*best_spot))


def draw(state: dict) -> list[str]:
    board = state["board"]
    lines = ["   " + " ".join(_COLS)]
    lines += [f"{row + 1:2d} " + " ".join(board[row]) for row in range(_SIZE)]
    return lines


def picture(state: dict) -> dict:
    spot = _square(str(state.get("last") or ""))
    last_to = {"row": spot[0], "col": spot[1], "name": str(state.get("last") or "")} if spot else None
    return {
        "view": "gomoku",
        "cells": [row[:] for row in state["board"]],
        "files": _COLS,
        "ranks": list(range(1, _SIZE + 1)),
        "legal": list(legal(state)),
        "last_to": last_to,
        "highlight": _winning_line(state["board"], _mark(state.get("winner") or "white"))
        if state.get("status") == "win" else [],
    }
