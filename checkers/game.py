"""English checkers. 8 by 8, a1 at the bottom left. White plays x from rows 1 to 3 and moves first."""

from __future__ import annotations

import os
import re
import time
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

ID = "checkers"
TITLE = "Checkers"
MARKS = ("x", "o")
EXAMPLE = "move c3 d4"
MAX_PLIES = 400
HELP = [
    "Move diagonally forward. A capture is required when one exists, and a jump chain is one move: move c3 e5 c7.",
    "A man that reaches the far row is crowned (X or O) and can move backward. Crowning ends the move.",
    "80 moves with no capture and no crowning is a draw.",
]

_SIZE = 8
_COLS = "abcdefgh"
_QUIET = 80
_DEPTH = 4
_NODES = 20000
# Depth cap and node ceiling per level: Intermediate is the shipped search,
# Beginner looks one ply ahead with a small budget, Advanced one ply deeper
# with a bigger one, Expert one deeper still.
_LEVEL_DEPTH = {"beginner": 1, "intermediate": _DEPTH, "advanced": 6, "expert": 8}
_LEVEL_NODES = {"beginner": 2000, "intermediate": _NODES, "advanced": 60000, "expert": 150000}
# A move has to arrive while the person is still looking at the board. Depth and node caps
# alone let an "expert" position spend minutes in the search; the clock is the real budget.
MOVE_SECONDS = 1.2
# A wall clock makes strength depend on how busy the machine is: under load the expert's search
# was cut short and it played like a beginner, which is why the strength tests passed alone and
# failed in a full run. GAMESHELF_BOT_DETERMINISTIC=1 drops the clock and leaves the node budget,
# so a test measures the search rather than the CPU. The shipped default keeps the clock: a player
# is waiting for the move.
DETERMINISTIC = "GAMESHELF_BOT_DETERMINISTIC"
# A cheaper move is enough at a shallow level: the beginner looks a ply ahead, so it must
# not hold the same budget as the expert.
LEVEL_SECONDS = {"beginner": 0.05, "intermediate": 0.35, "advanced": 0.8, "expert": MOVE_SECONDS}

Move = tuple[str, ...]


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    board = [["." for _ in range(_SIZE)] for _ in range(_SIZE)]
    for row in range(_SIZE):
        for col in range(_SIZE):
            if (row + col) % 2:
                continue
            if row <= 2:
                board[row][col] = "x"
            elif row >= 5:
                board[row][col] = "o"
    return {"board": board, "quiet": 0}


def _mark(side: str) -> str:
    return "x" if side == "white" else "o"


def _name(row: int, col: int) -> str:
    return f"{_COLS[col]}{row + 1}"


def _square(text: str) -> tuple[int, int] | None:
    if len(text) != 2 or text[0] not in _COLS or not text[1].isdigit():
        return None
    row = int(text[1]) - 1
    if not 0 <= row < _SIZE:
        return None
    return row, _COLS.index(text[0])


def parse(words: list[str]) -> Move | None:
    pieces = [item for item in re.split(r"[\s\-x:]+", " ".join(words).lower()) if item]
    if len(pieces) < 2 or any(_square(item) is None for item in pieces):
        return None
    return tuple(pieces)


def show(move: Move) -> str:
    return "-".join(move)


def _directions(piece: str) -> tuple[tuple[int, int], ...]:
    if piece in "XO":
        return ((1, -1), (1, 1), (-1, -1), (-1, 1))
    return ((1, -1), (1, 1)) if piece == "x" else ((-1, -1), (-1, 1))


def _far_row(piece: str) -> int:
    return _SIZE - 1 if piece == "x" else 0


def _inside(row: int, col: int) -> bool:
    return 0 <= row < _SIZE and 0 <= col < _SIZE


def _jumps(board, row: int, col: int, piece: str, taken: frozenset) -> list[list[tuple[int, int]]]:
    enemy = "o" if piece.lower() == "x" else "x"
    paths: list[list[tuple[int, int]]] = []
    for dr, dc in _directions(piece):
        mid_r, mid_c = row + dr, col + dc
        land_r, land_c = row + 2 * dr, col + 2 * dc
        if not _inside(land_r, land_c):
            continue
        if board[mid_r][mid_c].lower() != enemy or (mid_r, mid_c) in taken or board[land_r][land_c] != ".":
            continue
        if piece in "xo" and land_r == _far_row(piece):
            paths.append([(land_r, land_c)])
            continue
        more = _jumps(board, land_r, land_c, piece, taken | {(mid_r, mid_c)})
        if more:
            paths.extend([(land_r, land_c), *tail] for tail in more)
        else:
            paths.append([(land_r, land_c)])
    return paths


def _moves(board, side: str) -> list[Move]:
    mark = _mark(side)
    captures: list[Move] = []
    steps: list[Move] = []
    for row in range(_SIZE):
        for col in range(_SIZE):
            piece = board[row][col]
            if piece.lower() != mark:
                continue
            board[row][col] = "."
            for path in _jumps(board, row, col, piece, frozenset()):
                captures.append((_name(row, col), *(_name(r, c) for r, c in path)))
            board[row][col] = piece
            for dr, dc in _directions(piece):
                r, c = row + dr, col + dc
                if _inside(r, c) and board[r][c] == ".":
                    steps.append((_name(row, col), _name(r, c)))
    return captures or steps


def legal(state: dict) -> list[Move]:
    return _moves(state["board"], state["turn"])


def _is_capture(move: Move) -> bool:
    spots = [_square(item) for item in move]
    return any(a is not None and b is not None and abs(b[0] - a[0]) == 2
               for a, b in zip(spots, spots[1:]))


def refusal(state: dict, move) -> str:
    """A short, true reason the move was refused."""
    if not move or len(move) < 2:
        return "That isn't a move."
    board = state["board"]
    mark = _mark(state["turn"])
    start = _square(str(move[0]))
    if start is None:
        return "That isn't a move."
    row, col = start
    piece = board[row][col]
    if piece == "." or piece.lower() != mark:
        return "That's not your piece."
    allowed = legal(state)
    if any(_is_capture(item) for item in allowed) and not _is_capture(move):
        return "You must capture: Checkers makes captures compulsory."
    if any(_is_capture(item) for item in allowed):
        return "You must capture: Checkers makes captures compulsory."
    return "That move isn't allowed."


def play(state: dict, move: Move) -> str:
    board = state["board"]
    side = state["turn"]
    other = "black" if side == "white" else "white"
    spots = [_square(item) for item in move]
    row, col = spots[0]
    piece = board[row][col]
    board[row][col] = "."
    captured = 0
    for (r1, c1), (r2, c2) in zip(spots, spots[1:]):
        if abs(r2 - r1) == 2:
            board[(r1 + r2) // 2][(c1 + c2) // 2] = "."
            captured += 1
    end_r, end_c = spots[-1]
    notes = []
    crowned = piece in "xo" and end_r == _far_row(piece)
    if crowned:
        piece = piece.upper()
        notes.append("Crowned.")
    board[end_r][end_c] = piece
    if captured:
        notes.insert(0, f"Took {captured}.")
    state["quiet"] = 0 if captured or crowned else int(state.get("quiet") or 0) + 1
    if not _moves(board, other):
        state["status"] = "win"
        state["winner"] = side
        state["result_detail"] = "no_moves"
        notes.append(f"{other.capitalize()} has no move.")
    elif state["quiet"] >= _QUIET:
        state["status"] = "draw"
        state["winner"] = ""
        state["result_detail"] = "quiet"
        notes.append(f"{_QUIET} moves with no capture or crowning.")
    else:
        state["turn"] = other
    return " ".join(notes)


def _copy(state: dict) -> dict:
    return {
        "board": [row[:] for row in state["board"]],
        "turn": state["turn"],
        "status": "active",
        "winner": "",
        "quiet": state.get("quiet", 0),
    }


def _value(state: dict, me: str) -> float:
    if state["status"] == "win":
        return 10000 if state["winner"] == me else -10000
    if state["status"] != "active":
        return 0
    mine = _mark(me)
    score = 0.0
    for row in range(_SIZE):
        for col in range(_SIZE):
            piece = state["board"][row][col]
            if piece == ".":
                continue
            worth = 5 if piece in "XO" else 3 + 0.1 * (row if piece == "x" else _SIZE - 1 - row)
            score += worth if piece.lower() == mine else -worth
    return score


def _search(state: dict, me: str, depth: int, alpha: float, beta: float, budget: list) -> float:
    budget[0] -= 1
    if depth == 0 or state["status"] != "active" or budget[0] <= 0 or time.monotonic() > budget[1]:
        return _value(state, me)
    maximizing = state["turn"] == me
    best = float("-inf") if maximizing else float("inf")
    for move in legal(state):
        child = _copy(state)
        play(child, move)
        score = _search(child, me, depth - 1, alpha, beta, budget)
        if maximizing:
            best = max(best, score)
            alpha = max(alpha, score)
        else:
            best = min(best, score)
            beta = min(beta, score)
        if beta <= alpha:
            break
    return best


def bot(state: dict, depth: int | None = None) -> Move:
    me = state["turn"]
    choices = legal(state)
    if len(choices) == 1:
        return choices[0]
    deep = kit.level_depth(state, _LEVEL_DEPTH) if depth is None else max(1, min(int(depth), 8))
    nodes = _LEVEL_NODES[kit.level(state)] if depth is None else _NODES
    share = max(1, nodes // len(choices))
    seconds = LEVEL_SECONDS.get(kit.level(state), MOVE_SECONDS) if depth is None else 0.35
    deadline = float("inf") if os.environ.get(DETERMINISTIC) == "1" else time.monotonic() + seconds
    best_move, best_score = choices[0], float("-inf")
    for move in choices:
        child = _copy(state)
        play(child, move)
        score = _search(child, me, deep - 1, float("-inf"), float("inf"), [share, deadline])
        if score > best_score:
            best_move, best_score = move, score
    return kit.level_pick(state, choices, best_move)


def draw(state: dict) -> list[str]:
    board = state["board"]
    lines = ["  " + " ".join(_COLS)]
    for row in range(_SIZE - 1, -1, -1):
        cells = [board[row][col] if (row + col) % 2 == 0 else " " for col in range(_SIZE)]
        lines.append(f"{row + 1} " + " ".join(cells))
    return lines


def picture(state: dict) -> dict:
    cells = [state["board"][row][:] for row in range(_SIZE - 1, -1, -1)]
    last_to = None
    shown = str(state.get("last") or "")
    parts = [item for item in shown.replace("-", " ").split() if item]
    if parts:
        spot = _square(parts[-1])
        if spot:
            row, col = spot
            last_to = {"row": _SIZE - 1 - row, "col": col, "name": parts[-1]}
    return {
        "view": "checkers",
        "cells": cells,
        "files": _COLS,
        "ranks": list(range(_SIZE, 0, -1)),
        "legal": [show(move) for move in legal(state)],
        "last_to": last_to,
    }
