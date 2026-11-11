"""Tic-Tac-Toe: the smallest plugin game that meets the Play contract.

Play asks for seats, turns, a clear winner, a replay and a computer opponent. This
file shows what that looks like without any code from Game Center: a fresh table, a
move read from its own text, a bot that always finds a legal move, and a plain answer
for anything it cannot read. Run it through the checker with:

    python3 tools/check_game.py examples/match-ready-game
"""

from __future__ import annotations

import json
import types
from pathlib import Path

ID = "tic-tac-toe"
TITLE = "Tic-Tac-Toe"
MARKS = ("X", "O")
EXAMPLE = "move 5"
MAX_PLIES = 9
HELP = ["Three in a row on a 3 by 3 board. Squares are numbered 1 to 9, left to right."]

# Every line that wins: three rows, three columns, two diagonals.
_LINES = (
    (0, 1, 2), (3, 4, 5), (6, 7, 8),
    (0, 3, 6), (1, 4, 7), (2, 5, 8),
    (0, 4, 8), (2, 4, 6),
)
_STATE = "state.json"


def fresh() -> dict:
    return {"board": ["."] * 9}


def parse(words: list[str]) -> int | None:
    """One square number, 1 to 9. Anything else is not a move."""
    if not words or not words[0].isdigit():
        return None
    square = int(words[0])
    return square if 1 <= square <= 9 else None


def show(move: int) -> str:
    return str(move)


def legal(state: dict) -> list[int]:
    return [index + 1 for index, mark in enumerate(state["board"]) if mark == "."]


def _mark(side: str) -> str:
    return MARKS[0] if side == "white" else MARKS[1]


def play(state: dict, move: int) -> str:
    """Place the mark, then say whether the game ended."""
    board = state["board"]
    board[move - 1] = _mark(state["turn"])
    for line in _LINES:
        marks = {board[index] for index in line}
        if len(marks) == 1 and "." not in marks:
            state["status"] = "win"
            state["winner"] = state["turn"]
            return f"{state['winner'].title()} has three in a row."
    if "." not in board:
        state["status"] = "draw"
        state["winner"] = ""
        return "The board is full: a draw."
    state["turn"] = "black" if state["turn"] == "white" else "white"
    return ""


def _would_win(state: dict, square: int, side: str) -> bool:
    board = list(state["board"])
    board[square - 1] = _mark(side)
    return any(len({board[index] for index in line}) == 1 and "." not in {board[index] for index in line} for line in _LINES)


def bot(state: dict) -> int:
    """Win if it can, block if it must, then take the middle, a corner, anything."""
    side = state["turn"]
    other = "black" if side == "white" else "white"
    choices = legal(state)
    for square in choices:
        if _would_win(state, square, side):
            return square
    for square in choices:
        if _would_win(state, square, other):
            return square
    for square in (5, 1, 3, 7, 9, 2, 4, 6, 8):
        if square in choices:
            return square
    return choices[0]


def draw(state: dict) -> list[str]:
    board = state["board"]
    return [" ".join(board[row * 3:(row + 1) * 3]) for row in range(3)]


_RULES = types.SimpleNamespace(
    ID=ID,
    TITLE=TITLE,
    MARKS=MARKS,
    EXAMPLE=EXAMPLE,
    MAX_PLIES=MAX_PLIES,
    HELP=HELP,
    fresh=fresh,
    parse=parse,
    show=show,
    legal=legal,
    play=play,
    bot=bot,
    draw=draw,
)


class Game:
    """One stored match, answered in the same plain words every Game Center game uses."""

    rules = _RULES

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.path = self.root / _STATE

    def _load(self) -> dict | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _save(self, state: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(state), encoding="utf-8")

    def _text(self, state: dict) -> str:
        lines = [TITLE, *draw(state)]
        if state.get("status") == "active":
            lines.append(f"{state['turn'].title()} to move.")
        elif state.get("winner"):
            lines.append(f"Game over: {state['winner']} wins.")
        else:
            lines.append("Game over: a draw.")
        return "\n".join(lines)

    def command(self, raw: str, *, source: str = "command", complete=None) -> str:
        del complete
        words = str(raw or "").split()
        head = words[0].lower() if words else "help"
        state = self._load()
        if head == "new":
            state = {"turn": "white", "status": "active", "winner": "", "plies": 0, **fresh()}
            self._save(state)
            return self._text(state)
        if head == "move":
            if not state or state.get("status") != "active":
                return f"No game in progress. /games {ID} new"
            move = parse(words[1:])
            choices = legal(state)
            if move is None or move not in choices:
                return "Refused (illegal). Try: " + ", ".join(show(item) for item in choices)
            note = play(state, move)
            state["plies"] = int(state.get("plies") or 0) + 1
            self._save(state)
            return ("Played " + show(move) + "." + (f" {note}" if note else "") + "\n" + self._text(state))
        if state is None:
            return f"{ID} has no game yet. /games {ID} new"
        return self._text(state)

    def picture(self) -> dict:
        state = self._load() or {"turn": "white", "status": "idle", "winner": "", "plies": 0, **fresh()}
        return {
            "game": ID,
            "view": "tictactoe",
            "turn": state["turn"],
            "status": state["status"],
            "winner": state.get("winner") or "",
            "cells": [state["board"][row * 3:(row + 1) * 3] for row in range(3)],
            "legal": [] if state["status"] != "active" else [show(item) for item in legal(state)],
        }


def create(root: Path, settings: dict | None = None) -> Game:
    del settings
    return Game(root)
