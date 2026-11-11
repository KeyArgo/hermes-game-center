"""Hex on an 11 by 11 board, a1 at the top left. Light (X) joins top and bottom, dark (O) joins left and right.

Light moves first. On dark's first turn dark may answer "swap": light's stone becomes a dark
stone in the mirrored spot. That keeps the first move fair. Hex never ends in a draw.
"""

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

ID = "hex"
TITLE = "Hex"
# Hex cannot end level: one of the two pairs of sides is always joined. The table
# offers no draw and the plugin hides the word.
DRAWS = False
MARKS = ("X", "O")
EXAMPLE = "move f6"
MAX_PLIES = 122
# Hex always has a winner (a full board still joins one pair of sides), so a
# draw can never be agreed: the shelf and the table both offer none.
DRAWS = False
HELP = [
    "Place a stone on any empty cell: move f6. Light joins top to bottom, dark joins left to right.",
    "On dark's first turn, move swap takes light's opening stone instead. No draws.",
]

_SIZE = 11
_COLS = "abcdefghijk"
# Beginner plays the greedy move with the kit's seeded noise. Every rung above
# it answers the opponent's best single reply, and climbs by how many of our
# moves and their replies it looks at. The widths keep every move fast.
_LEVEL_DEPTH = {"beginner": 1, "intermediate": 2, "advanced": 2, "expert": 2}
_LEVEL_WIDTH = {"beginner": (12, 5), "intermediate": (6, 4),
                "advanced": (10, 8), "expert": (14, 12)}
_NEAR = ((-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0))


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    return {"board": [["." for _ in range(_SIZE)] for _ in range(_SIZE)], "stones": 0, "swapped": False}


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


def _around(row: int, col: int):
    for dr, dc in _NEAR:
        r, c = row + dr, col + dc
        if 0 <= r < _SIZE and 0 <= c < _SIZE:
            yield r, c


def parse(words: list[str]) -> str | None:
    if not words:
        return None
    if words[0].lower() == "swap":
        return "swap"
    spot = _square(words[0])
    return _name(*spot) if spot else None


def show(move: str) -> str:
    return move


def _can_swap(state: dict) -> bool:
    return state["turn"] == "black" and int(state.get("stones") or 0) == 1 and not state.get("swapped")


def legal(state: dict) -> list[str]:
    board = state["board"]
    moves = [_name(r, c) for r in range(_SIZE) for c in range(_SIZE) if board[r][c] == "."]
    if _can_swap(state):
        moves.append("swap")
    return moves


def refusal(state: dict, move) -> str:
    """A short, true reason the move was refused."""
    if not move:
        return "That isn't a cell."
    if str(move).lower() == "swap":
        return "You can only swap on your first turn."
    spot = _square(str(move))
    if spot is None:
        return "That isn't a cell."
    row, col = spot
    if state["board"][row][col] != ".":
        return "That cell is taken."
    return "That move isn't allowed."


def connected(board: list[list[str]], mark: str) -> bool:
    """X needs a path from row 0 to the last row; O from column 0 to the last column."""
    if mark == "X":
        todo = [(0, c) for c in range(_SIZE) if board[0][c] == "X"]
        done = lambda r, c: r == _SIZE - 1  # noqa: E731
    else:
        todo = [(r, 0) for r in range(_SIZE) if board[r][0] == "O"]
        done = lambda r, c: c == _SIZE - 1  # noqa: E731
    seen = set(todo)
    while todo:
        r, c = todo.pop()
        if done(r, c):
            return True
        for nr, nc in _around(r, c):
            if board[nr][nc] == mark and (nr, nc) not in seen:
                seen.add((nr, nc))
                todo.append((nr, nc))
    return False


def play(state: dict, move: str) -> str:
    board = state["board"]
    mark = _mark(state["turn"])
    note = ""
    if move == "swap":
        for r in range(_SIZE):
            for c in range(_SIZE):
                if board[r][c] == "X":
                    board[r][c] = "."
                    board[c][r] = "O"
        state["swapped"] = True
        note = "Swapped."
    else:
        row, col = _square(move) or (0, 0)
        board[row][col] = mark
        state["stones"] = int(state.get("stones") or 0) + 1
        if connected(board, mark):
            state["status"] = "win"
            state["winner"] = state["turn"]
            state["result_detail"] = "connected"
            return "Connected."
    state["turn"] = "black" if state["turn"] == "white" else "white"
    return note


def _distance(board: list[list[str]], mark: str) -> int:
    """Fewest empty cells ``mark`` still needs to connect its sides (0-1 BFS)."""
    from collections import deque

    big = _SIZE * _SIZE + 1
    best = [[big] * _SIZE for _ in range(_SIZE)]
    queue: deque = deque()
    for i in range(_SIZE):
        r, c = (0, i) if mark == "X" else (i, 0)
        cost = 0 if board[r][c] == mark else 1 if board[r][c] == "." else big
        if cost < big:
            best[r][c] = cost
            (queue.appendleft if cost == 0 else queue.append)((cost, r, c))
    while queue:
        cost, r, c = queue.popleft()
        if cost != best[r][c]:
            continue
        if (mark == "X" and r == _SIZE - 1) or (mark == "O" and c == _SIZE - 1):
            return cost
        for nr, nc in _around(r, c):
            here = board[nr][nc]
            step = 0 if here == mark else 1 if here == "." else None
            if step is None:
                continue
            if cost + step < best[nr][nc]:
                best[nr][nc] = cost + step
                (queue.appendleft if step == 0 else queue.append)((cost + step, nr, nc))
    return big


def _worth(board: list[list[str]], row: int, col: int, mark: str, other: str, centre: float) -> float:
    """One move's value: how much closer it takes us and pushes them."""
    board[row][col] = mark
    try:
        mine = _distance(board, mark)
        theirs = _distance(board, other)
    finally:
        board[row][col] = "."
    return 2 * theirs - 2 * mine - 0.05 * (abs(row - centre) + abs(col - centre))


def bot(state: dict, depth: int | None = None) -> str:
    """Shortens its own path and lengthens the other side's.

    Beginner plays the greedy move and now and then some other legal move (the
    kit's seeded noise), so a beginner has a chance. Intermediate and above also
    play out the opponent's best single answer, so they block a lane being built
    rather than only counting steps. The higher rungs widen both lists.
    """
    board = state["board"]
    mark = _mark(state["turn"])
    other = "O" if mark == "X" else "X"
    if depth is None:
        said = kit.level(state)
        deep = kit.level_depth(state, _LEVEL_DEPTH)
    else:
        said = "advanced" if int(depth) >= 2 else "beginner"
        deep = max(1, min(int(depth), 3))
    if _can_swap(state):
        for r in range(_SIZE):
            for c in range(_SIZE):
                if board[r][c] == "X" and 2 <= r <= _SIZE - 3 and 2 <= c <= _SIZE - 3:
                    return "swap"
    centre = (_SIZE - 1) / 2
    spots = [move for move in legal(state) if move != "swap"]
    scored: list[tuple[float, str]] = []
    for move in spots:
        row, col = _square(move) or (0, 0)
        board[row][col] = mark
        try:
            mine = _distance(board, mark)
            theirs = _distance(board, other)
        finally:
            board[row][col] = "."
        if mine == 0:
            return move  # this move connects: take it
        scored.append((2 * theirs - 2 * mine - 0.05 * (abs(row - centre) + abs(col - centre)), move))
    if not scored:
        return "swap" if "swap" in legal(state) else legal(state)[0]
    scored.sort(key=lambda item: item[0], reverse=True)
    if deep >= 2:
        # Their best single answers, ranked once on the board as it stands. This
        # is a little lookahead, not a full search: enough to see our lane stopped.
        # The higher rungs widen both lists.
        breadth = _LEVEL_WIDTH.get(said, (10, 8))
        replies = sorted(
            ((_worth(board, *(_square(move) or (0, 0)), other, mark, centre), move) for move in spots),
            key=lambda item: item[0],
            reverse=True,
        )[:breadth[1]]
        best_move, best_value = scored[0][1], None
        for value, move in scored[:breadth[0]]:
            row, col = _square(move) or (0, 0)
            board[row][col] = mark
            try:
                worst = None
                for _worth_them, reply in replies:
                    if reply == move:
                        continue
                    rrow, rcol = _square(reply) or (0, 0)
                    board[rrow][rcol] = other
                    try:
                        mine = _distance(board, mark)
                        theirs = _distance(board, other)
                    finally:
                        board[rrow][rcol] = "."
                    after = 2 * theirs - 2 * mine
                    worst = after if worst is None or after < worst else worst
            finally:
                board[row][col] = "."
            combined = value + (worst if worst is not None else 0)
            if best_value is None or combined > best_value:
                best_move, best_value = move, combined
        return kit.level_pick(state, spots, best_move)
    best = scored[0][1]
    return kit.level_pick(state, spots, best)


def draw(state: dict) -> list[str]:
    lines = [" " * row + f"{row + 1:>2} " + " ".join(state["board"][row]) for row in range(_SIZE)]
    lines.append("   " + " ".join(_COLS))
    return lines


def picture(state: dict) -> dict:
    spot = _square(str(state.get("last") or ""))
    last_to = {"row": spot[0], "col": spot[1], "name": str(state.get("last") or "")} if spot else None
    return {
        "view": "hex",
        "cells": [row[:] for row in state["board"]],
        "files": _COLS,
        "ranks": list(range(1, _SIZE + 1)),
        "legal": list(legal(state)),
        "last_to": last_to,
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
    return "It swaps sides and takes the opening stone." if move == "swap" else f"It places a stone at {show(move)} to build a connection."
