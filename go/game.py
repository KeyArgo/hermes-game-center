"""Go on a 9 by 9 board, a1 at the top left. Light stones (X) move first; dark stones get 7.5 points.

Area scoring (stones on the board plus empty points only you surround). No position may repeat.
Two passes in a row end the game, so capture dead stones before you pass.
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

ID = "go"
TITLE = "Go"
# Komi is a half point (7.5) and the score is whole points, so no score can tie.
DRAWS = False
MARKS = ("X", "O")
EXAMPLE = "move e5"
MAX_PLIES = 400
KOMI = 7.5
HELP = [
    "Place a stone: move e5. Pass: move pass. Stones with no empty point next to them are taken.",
    "Two passes end the game. Score = your stones + empty points only you surround; dark gets 7.5.",
    "A move may not repeat an earlier board. Take dead stones off before you pass.",
]

_SIZE = 9
_COLS = "abcdefghi"
# Each rung searches wider and deeper, and weighs the score it is building.
# Beginner: a narrow shortlist, raw capture/liberty value, plus seeded noise.
# Intermediate: a wider shortlist that also values the territory it makes.
# Advanced: two plies (our move, their best reply) over a shortlist.
# Expert: three plies over the same shortlist. The widths keep every move
# comfortably inside the two-second budget.
_LEVEL_DEPTH = {"beginner": 1, "intermediate": 1, "advanced": 2, "expert": 3}
_LEVEL_WIDTH = {"beginner": 6, "intermediate": 12, "advanced": 8, "expert": 8}
_LEVEL_GRASP = {"beginner": 0.0, "intermediate": 0.2, "advanced": 0.3, "expert": 0.3}
_LEVEL_TERRITORY = {"beginner": 0.0, "intermediate": 0.05, "advanced": 0.10, "expert": 0.10}


def create(root: Path, settings: dict | None = None):
    del settings
    return kit.Table(Path(root), kit.rules(globals()))


def fresh() -> dict:
    return {"board": [["." for _ in range(_SIZE)] for _ in range(_SIZE)], "passes": 0, "seen": [], "captured": {"X": 0, "O": 0}}


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


def _key(board: list[list[str]]) -> str:
    return "".join("".join(row) for row in board)


def _around(row: int, col: int):
    for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        r, c = row + dr, col + dc
        if 0 <= r < _SIZE and 0 <= c < _SIZE:
            yield r, c


def _group(board: list[list[str]], row: int, col: int) -> tuple[set, set]:
    """Stones joined to (row, col) and their empty neighbours."""
    mark = board[row][col]
    stones, liberties, todo = {(row, col)}, set(), [(row, col)]
    while todo:
        r, c = todo.pop()
        for nr, nc in _around(r, c):
            here = board[nr][nc]
            if here == ".":
                liberties.add((nr, nc))
            elif here == mark and (nr, nc) not in stones:
                stones.add((nr, nc))
                todo.append((nr, nc))
    return stones, liberties


def _place(board: list[list[str]], row: int, col: int, mark: str) -> tuple[list[list[str]], int] | None:
    """New board after placing, with stones taken; None if the move would be suicide."""
    other = "O" if mark == "X" else "X"
    trial = [line[:] for line in board]
    trial[row][col] = mark
    taken = 0
    for r, c in _around(row, col):
        if trial[r][c] == other:
            stones, liberties = _group(trial, r, c)
            if not liberties:
                for sr, sc in stones:
                    trial[sr][sc] = "."
                taken += len(stones)
    if not _group(trial, row, col)[1]:
        return None
    return trial, taken


def _seen(state: dict) -> set:
    return set(state.get("seen") or []) | {_key(state["board"])}


def parse(words: list[str]) -> str | None:
    if not words:
        return None
    if words[0].lower() == "pass":
        return "pass"
    spot = _square(words[0])
    return _name(*spot) if spot else None


def show(move: str) -> str:
    return move


def legal(state: dict) -> list[str]:
    board = state["board"]
    mark = _mark(state["turn"])
    seen = _seen(state)
    moves = []
    for row in range(_SIZE):
        for col in range(_SIZE):
            if board[row][col] != ".":
                continue
            placed = _place(board, row, col, mark)
            if placed and _key(placed[0]) not in seen:
                moves.append(_name(row, col))
    moves.append("pass")
    return moves


def refusal(state: dict, move) -> str:
    """A short, true reason the move was refused."""
    if not move:
        return "That isn't a point."
    if str(move).lower() == "pass":
        return "You can't pass right now."
    spot = _square(str(move))
    if spot is None:
        return "That isn't a point."
    row, col = spot
    if state["board"][row][col] != ".":
        return "That point is taken."
    placed = _place(state["board"], row, col, _mark(state["turn"]))
    if placed is None:
        return "That move would leave the stone with no liberties."
    if _key(placed[0]) in _seen(state):
        return "That would repeat an earlier position."
    return "That move isn't allowed."


def score(board: list[list[str]]) -> dict:
    """Area score: stones plus empty regions that touch only one colour. Komi goes to O."""
    totals = {"X": 0.0, "O": KOMI}
    done: set = set()
    for row in range(_SIZE):
        for col in range(_SIZE):
            mark = board[row][col]
            if mark != ".":
                totals[mark] += 1
                continue
            if (row, col) in done:
                continue
            region, borders, todo = {(row, col)}, set(), [(row, col)]
            while todo:
                r, c = todo.pop()
                for nr, nc in _around(r, c):
                    here = board[nr][nc]
                    if here == "." and (nr, nc) not in region:
                        region.add((nr, nc))
                        todo.append((nr, nc))
                    elif here != ".":
                        borders.add(here)
            done |= region
            if len(borders) == 1:
                totals[borders.pop()] += len(region)
    return totals


def play(state: dict, move: str) -> str:
    mark = _mark(state["turn"])
    note = ""
    if move == "pass":
        state["passes"] = int(state.get("passes") or 0) + 1
        if state["passes"] >= 2:
            totals = score(state["board"])
            state["status"] = "win"
            state["winner"] = "white" if totals["X"] > totals["O"] else "black"
            state["result_reason"] = "score"
            state["result_detail"] = "score"
            return f"Both passed. Light {totals['X']:g}, dark {totals['O']:g}."
        note = "Pass."
    else:
        row, col = _square(move) or (0, 0)
        placed = _place(state["board"], row, col, mark)
        if placed is None:
            return "Refused (suicide)."
        state["seen"] = [*(state.get("seen") or []), _key(state["board"])][-MAX_PLIES:]
        state["board"], taken = placed
        state["passes"] = 0
        if taken:
            captured = dict(state.get("captured") or {"X": 0, "O": 0})
            captured[mark] = captured.get(mark, 0) + taken
            state["captured"] = captured
            note = f"Took {taken}."
    state["turn"] = "black" if state["turn"] == "white" else "white"
    if int(state.get("plies") or 0) + 1 >= MAX_PLIES:
        totals = score(state["board"])
        state["status"] = "win"
        state["winner"] = "white" if totals["X"] > totals["O"] else "black"
        state["result_reason"] = "score"
        state["result_detail"] = "score"
        return f"{note} Move limit reached. Light {totals['X']:g}, dark {totals['O']:g}.".strip()
    return note


def _own_eye(board: list[list[str]], row: int, col: int, mark: str) -> bool:
    return all(board[r][c] == mark for r, c in _around(row, col))


def _settled(board: list[list[str]], mark: str) -> set:
    """Empty points in small regions that only touch ``mark``: already its own, no need to fill."""
    found: set = set()
    done: set = set()
    for row in range(_SIZE):
        for col in range(_SIZE):
            if board[row][col] != "." or (row, col) in done:
                continue
            region, borders, todo = {(row, col)}, set(), [(row, col)]
            while todo:
                r, c = todo.pop()
                for nr, nc in _around(r, c):
                    here = board[nr][nc]
                    if here == "." and (nr, nc) not in region:
                        region.add((nr, nc))
                        todo.append((nr, nc))
                    elif here != ".":
                        borders.add(here)
            done |= region
            if borders == {mark} and len(region) <= 12:
                found |= region
    return found


def _stone_value(base: list[list[str]], after: list[list[str]], row: int, col: int,
                 mark: str, other: str, taken: int) -> float:
    """How good placing one stone looks: captures, liberties, atari near misses."""
    liberties = len(_group(after, row, col)[1])
    value = 10.0 * taken + min(liberties, 4)
    if liberties == 1 and not taken:
        value -= 8
    for r, c in _around(row, col):
        if base[r][c] == mark and len(_group(base, r, c)[1]) == 1:
            value += 6
        if base[r][c] == other and len(_group(after, r, c)[1]) == 1:
            value += 2
    return value


def _territory(board: list[list[str]], mark: str) -> float:
    """The area score from ``mark``'s side: stones plus its own empty regions."""
    totals = score(board)
    other = "O" if mark == "X" else "X"
    return totals[mark] - totals[other]


def _rank_moves(board: list[list[str]], mark: str, grasp: float, territory: float,
                centre: float, seen: list[str]) -> list[tuple[float, str, list[list[str]]]]:
    """Legal stones, best first, with the value this rung weighs."""
    other = "O" if mark == "X" else "X"
    side = "white" if mark == "X" else "black"
    settled = _settled(board, mark)
    ranked = []
    for move in legal({"board": board, "turn": side, "seen": list(seen)}):
        if move == "pass":
            continue
        row, col = _square(move) or (0, 0)
        if _own_eye(board, row, col, mark) or (row, col) in settled:
            continue
        placed = _place(board, row, col, mark)
        if placed is None:
            continue
        after, taken = placed
        value = _stone_value(board, after, row, col, mark, other, taken)
        if grasp:
            value += grasp * min(len(_group(after, row, col)[1]), 4)
        value += (0.8 + 0.4 * grasp) * (1.5 - 0.3 * (abs(row - centre) + abs(col - centre)))
        if territory:
            value += territory * _territory(after, mark)
        value += ((row * 7 + col * 3 + len(seen)) % (3 + grasp * 4)) * 0.05
        ranked.append((value, move, after))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return ranked


def _search(board: list[list[str]], mover: str, root: str, depth: int, width: int,
            grasp: float, territory: float, centre: float, seen: list[str]) -> float:
    """Best/worst play from ``root``'s side: our moves are maximised, theirs minimised."""
    if depth <= 0:
        return _territory(board, root)
    ranked = _rank_moves(board, mover, grasp, territory, centre, seen)[:width]
    if not ranked:
        return _territory(board, root)
    other = "O" if mover == "X" else "X"
    values = [_search(after, other, root, depth - 1, width, grasp, territory, centre, seen)
              for _value, _move, after in ranked]
    return max(values) if mover == root else min(values)


def bot(state: dict, depth: int | None = None) -> str:
    """Takes stones, saves its own groups, avoids putting itself in atari, never fills its own eyes.

    The rungs climb by width, depth and how much score they weigh. Beginner takes
    the best of a narrow shortlist on captures and liberties, and now and then
    plays some other legal move (the kit's seeded noise). Intermediate widens the
    shortlist and values the territory it makes. Advanced searches two plies
    (our move, their best reply); Expert searches three. The widths keep every
    move comfortably inside the two-second budget.
    """
    board = state["board"]
    mark = _mark(state["turn"])
    other = "O" if mark == "X" else "X"
    if depth is None:
        said = kit.level(state)
        deep = kit.level_depth(state, _LEVEL_DEPTH)
        width = _LEVEL_WIDTH.get(said, 12)
        grasp = _LEVEL_GRASP.get(said, 0.0)
        territory = _LEVEL_TERRITORY.get(said, 0.0)
    else:
        said = ""
        deep = max(1, min(int(depth), 3))
        width = 12
        grasp = 0.2
        territory = 0.05
    centre = (_SIZE - 1) / 2
    seen = list(state.get("seen") or [])
    scored = []
    for value, move, after in _rank_moves(board, mark, grasp, territory, centre, seen)[:width]:
        if deep >= 2:
            value = _search(after, other, mark, deep - 1, width, grasp, territory, centre, seen)
        scored.append((value, move))
    best, best_value = "pass", -1e9 if deep >= 2 else 0.5
    for value, move in scored:
        if value > best_value:
            best, best_value = move, value
    return kit.level_pick(state, legal(state), best)


def draw(state: dict) -> list[str]:
    lines = [f"{row + 1} " + " ".join(state["board"][row]) for row in range(_SIZE)]
    lines.append("  " + " ".join(_COLS))
    totals = score(state["board"])
    lines.append(f"Score now: light {totals['X']:g}, dark {totals['O']:g} (dark includes {KOMI:g} komi).")
    return lines


def picture(state: dict) -> dict:
    spot = _square(str(state.get("last") or ""))
    last_to = {"row": spot[0], "col": spot[1], "name": str(state.get("last") or "")} if spot else None
    totals = score(state["board"])
    return {
        "view": "gomoku",
        "cells": [row[:] for row in state["board"]],
        "files": _COLS,
        "ranks": list(range(1, _SIZE + 1)),
        "legal": list(legal(state)),
        "last_to": last_to,
        "score_now": {"white": totals["X"], "black": totals["O"]},
        "komi": KOMI,
        "can_pass": True,
    }
