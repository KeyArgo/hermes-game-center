"""Breakthrough. 8 by 8, a1 at the bottom left. White fills ranks 1 and 2 and moves first.

Each side has sixteen pawns. A pawn steps one square straight forward, or one
square diagonally forward onto an empty square or onto an enemy pawn, which it
takes. Nothing moves sideways or backward, so every game moves forward and must
end.
"""

from __future__ import annotations

import importlib.util
import re
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

ID = "breakthrough"
TITLE = "Breakthrough"
# Every game moves forward and one side gets a pawn home, so Breakthrough never
# ends level. No draw is offered.
DRAWS = False
MARKS = ("x", "o")
EXAMPLE = "move b2-b3"
MAX_PLIES = 300
HELP = [
    "A pawn moves one square straight forward, or one square diagonally forward, onto an empty square or onto an enemy pawn to take it.",
    "Pawns never move sideways or backward, and only a diagonal move can take a pawn.",
    "You win when one of your pawns reaches the far rank, or when the other side has no pawns left.",
]

_COLS = "abcdefgh"
_SIZE = 8
_FULL = (1 << 64) - 1
_FILE_A = 0x0101010101010101
_FILE_H = _FILE_A << 7
_RANK1 = 0xFF
_RANK8 = 0xFF << 56
_LOW4 = 0xFFFFFFFF
_ADV_W = _FULL & ~0xFFFF  # white pawns past their own back two ranks (rows 2 to 7)
_ADV_B = _FULL >> 16  # black pawns past their own back two ranks (rows 0 to 5)
_WIN = 1_000_000
_DEPTH = 4
_NODES = 60000  # ceiling shared across the root moves, so one move stays well under a second
# Depth cap and node ceiling per level: Intermediate is the shipped search,
# Beginner two plies on a small budget, Advanced three with room to look,
# Expert one deeper still.
_LEVEL_DEPTH = {"beginner": 2, "intermediate": _DEPTH, "advanced": 5, "expert": 6}
_LEVEL_NODES = {"beginner": 6000, "intermediate": _NODES, "advanced": 90000, "expert": 160000}

Move = tuple[int, int]  # (from square, to square) as bit positions


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def _side_rows(side: str) -> tuple[int, int]:
    """The two ranks a side starts on (0 is rank 1 in the game's own numbering)."""
    return (0, 1) if side == "white" else (6, 7)


def fresh() -> dict:
    white = 0
    black = 0
    for row in (0, 1):
        white |= 0xFF << (row * 8)
    for row in (6, 7):
        black |= 0xFF << (row * 8)
    return {"w": white, "b": black}


def _mark(side: str) -> str:
    return "x" if side == "white" else "o"


def _name(square: int) -> str:
    row, col = divmod(square, _SIZE)
    return f"{_COLS[col]}{row + 1}"


def _square(text: str) -> int | None:
    if len(text) != 2 or text[0] not in _COLS or not text[1].isdigit():
        return None
    row = int(text[1]) - 1
    if not 0 <= row < _SIZE:
        return None
    return row * _SIZE + _COLS.index(text[0])


def parse(words: list[str]) -> Move | None:
    pieces = re.findall(r"[a-h][1-8]", " ".join(words).lower())
    if len(pieces) != 2:
        return None
    spots = [_square(item) for item in pieces]
    if spots[0] == spots[1]:
        return None
    return int(spots[0]), int(spots[1])


def show(move: Move) -> str:
    return f"{_name(move[0])}-{_name(move[1])}"


def _masks(w: int, b: int, side: str) -> tuple[int, int, int]:
    """(straight targets, diagonal-left targets, diagonal-right targets) as square masks.

    A diagonal target may be empty or hold an enemy pawn; capturing is only ever
    diagonal, and a pawn never moves sideways or backward.
    """
    occ = w | b
    if side == "white":
        mine = w
        straight = (mine << 8) & ~occ & _FULL
        left = (mine << 7) & ~_FILE_H & ~mine & _FULL
        right = (mine << 9) & ~_FILE_A & ~mine & _FULL
    else:
        mine = b
        straight = (mine >> 8) & ~occ
        left = (mine >> 9) & ~_FILE_H & ~mine
        right = (mine >> 7) & ~_FILE_A & ~mine
    return straight, left, right


def _codes(w: int, b: int, side: str) -> list[int]:
    """Every legal move as ``from * 64 + to``, captures first, furthest pawn first.

    A packed int keeps the search cheap: one object per move, no tuple; the
    table-facing ``legal`` list is the same moves unpacked.
    """
    straight, left, right = _masks(w, b, side)
    theirs = b if side == "white" else w
    if side == "white":
        groups = ((straight, 8), (left, 7), (right, 9))
    else:
        groups = ((straight, -8), (left, -9), (right, -7))
    found: list[int] = []
    for capture in (True, False):
        for mask, back in groups:
            mask = mask & theirs if capture else mask & ~theirs
            while mask:
                if side == "white":  # high squares are furthest forward: search them first
                    to = mask.bit_length() - 1
                    mask ^= 1 << to
                else:
                    bit = mask & -mask
                    to = bit.bit_length() - 1
                    mask ^= bit
                found.append(((to - back) << 6) | to)
    return found


def _apply(w: int, b: int, side: str, code: int) -> tuple[int, int]:
    start, end = code >> 6, code & 63
    if side == "white":
        return (w & ~(1 << start)) | (1 << end), b & ~(1 << end)
    return w & ~(1 << end), (b & ~(1 << start)) | (1 << end)


def _moves(w: int, b: int, side: str) -> list[Move]:
    return [(code >> 6, code & 63) for code in _codes(w, b, side)]


def legal(state: dict) -> list[Move]:
    return _moves(int(state["w"]), int(state["b"]), state["turn"])


def _won_by(w: int, b: int, side: str) -> bool:
    """``side`` has already won on the board alone (far rank, or no enemy pawns)."""
    if side == "white":
        return bool(w & _RANK8) or not b
    return bool(b & _RANK1) or not w


def play(state: dict, move: Move) -> str:
    side = state["turn"]
    other = "black" if side == "white" else "white"
    start, end = move
    white, black = int(state["w"]), int(state["b"])
    mine, theirs = (white, black) if side == "white" else (black, white)
    if not (mine >> start) & 1:
        raise ValueError(f"{_name(start)} holds no {side} pawn")
    captured = bool((theirs >> end) & 1)
    mine = (mine & ~(1 << start)) | (1 << end)
    if captured:
        theirs &= ~(1 << end)
    if side == "white":
        white, black = mine, theirs
    else:
        black, white = mine, theirs
    state["w"], state["b"] = white, black
    notes = []
    if captured:
        notes.append("Took a pawn.")
    if (side == "white" and (1 << end) & _RANK8) or (side == "black" and (1 << end) & _RANK1):
        state["status"] = "win"
        state["winner"] = side
        state["result_detail"] = "far_rank"
        notes.append(f"Reached the far rank. {side.capitalize()} wins.")
        return " ".join(notes)
    if not theirs:
        state["status"] = "win"
        state["winner"] = side
        state["result_detail"] = "no_pieces"
        notes.append(f"{other.capitalize()} has no pawns left.")
        return " ".join(notes)
    state["turn"] = other
    return " ".join(notes)


def _value(w: int, b: int, me: str) -> float:
    """How good the board is for ``me``.

    Material first, then the leading pawn, then how many pawns are across the
    half-way line. A full home rank counts too: an empty square on your own back
    rank is the lane the other side breaks through on.
    """
    if me == "white":
        if w & _RANK8 or not b:
            return _WIN
        if b & _RANK1 or not w:
            return -_WIN
    else:
        if b & _RANK1 or not w:
            return _WIN
        if w & _RANK8 or not b:
            return -_WIN
    lead_w = (w.bit_length() - 1) >> 3
    lead_b = _SIZE - 1 - (((b & -b).bit_length() - 1) >> 3)
    score = (100 * (w.bit_count() - b.bit_count())
             + 12 * (lead_w - lead_b)
             + 8 * ((w >> 32).bit_count() - (b & _LOW4).bit_count())
             + 6 * ((w & _ADV_W).bit_count() - (b & _ADV_B).bit_count())
             + 30 * ((w & _RANK1).bit_count() - (b & _RANK8).bit_count()))
    return score if me == "white" else -score


def _search(w: int, b: int, side: str, depth: int, alpha: float, beta: float, budget: list[int]) -> float:
    if side == "white":
        if w & _RANK8 or not b:
            return _WIN
        if b & _RANK1 or not w:
            return -_WIN
    else:
        if b & _RANK1 or not w:
            return _WIN
        if w & _RANK8 or not b:
            return -_WIN
    if depth <= 0 or budget[0] <= 0:
        return _value(w, b, side)
    budget[0] -= 1
    codes = _codes(w, b, side)
    if not codes:
        return -_WIN
    other = "black" if side == "white" else "white"
    best = float("-inf")
    for code in codes:
        nw, nb = _apply(w, b, side, code)
        score = -_search(nw, nb, other, depth - 1, -beta, -alpha, budget)
        if score > best:
            best = score
        alpha = max(alpha, score)
        if alpha >= beta or budget[0] <= 0:
            break
    return best


def bot(state: dict, depth: int | None = None) -> Move:
    side = state["turn"]
    other = "black" if side == "white" else "white"
    white, black = int(state["w"]), int(state["b"])
    codes = _codes(white, black, side)
    if len(codes) == 1:
        return codes[0] >> 6, codes[0] & 63
    for code in codes:  # a win this move is never missed
        if _won_by(*_apply(white, black, side, code), side):
            return code >> 6, code & 63
    deep = kit.level_depth(state, _LEVEL_DEPTH) if depth is None else max(1, min(int(depth), 6))
    nodes = _LEVEL_NODES[kit.level(state)] if depth is None else _NODES
    best_code, best_score = codes[0], float("-inf")
    alpha = float("-inf")
    share = max(600, nodes // len(codes))
    for code in codes:
        nw, nb = _apply(white, black, side, code)
        score = -_search(nw, nb, other, deep - 1, float("-inf"), -alpha, [share])
        if score > best_score:
            best_code, best_score = code, score
        alpha = max(alpha, score)
    move = (best_code >> 6, best_code & 63)
    return kit.level_pick(state, legal(state), move)


def _cells(state: dict) -> list[list[str]]:
    white, black = int(state["w"]), int(state["b"])
    rows = []
    for row in range(_SIZE - 1, -1, -1):
        line = []
        for col in range(_SIZE):
            bit = 1 << (row * _SIZE + col)
            line.append("x" if white & bit else "o" if black & bit else ".")
        rows.append(line)
    return rows


def draw(state: dict) -> list[str]:
    lines = ["  " + " ".join(_COLS)]
    for index, line in enumerate(_cells(state)):
        lines.append(f"{_SIZE - index} " + " ".join(line))
    return lines


def picture(state: dict) -> dict:
    last_to = None
    parts = [item for item in str(state.get("last") or "").replace("-", " ").split() if item]
    if parts:
        spot = _square(parts[-1])
        if spot is not None:
            row, col = divmod(spot, _SIZE)
            last_to = {"row": _SIZE - 1 - row, "col": col, "name": parts[-1]}
    return {
        "view": "checkers",  # a full board of round pieces: pick one, then its square
        "cells": _cells(state),
        "files": _COLS,
        "ranks": list(range(_SIZE, 0, -1)),
        "legal": [show(move) for move in legal(state)],
        "last_to": last_to,
    }
