"""Positions spoken for by Stockfish when it is on PATH, else by our own search.

Whichever engine answered, the review carries its name. Stockfish is only ever
a separate process found on PATH -- never bundled, never downloaded by us -- and
a missing or broken binary costs nothing: the built-in search takes over.

The cp figures are always from the side-to-move's point of view, so a swing is
simply ``before - after`` on the same side.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time
from pathlib import Path

log = logging.getLogger(__name__)

_DEPTH = 12  # plenty for "which move was worse", quick even in the middlegame


def _game():
    """The chess rules, imported late: game imports coach imports us."""
    import sys

    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    import game

    return game


def sf_path() -> str:
    return shutil.which("stockfish") or ""


def label() -> str:
    return "Stockfish (from PATH)" if sf_path() else "the built-in search"


def _mate_to_cp(words: list[str]) -> int:
    """`score mate 3` for the mover is a win in 3: worth more than any cp."""
    value = int(words[words.index("mate") + 1])
    return 10_000 - abs(value) * 10 if value > 0 else -10_000 + abs(value) * 10


class _Engine:
    """One stockfish process, spoken to over UCI, kept for the whole review."""

    def __init__(self, path: str) -> None:
        self.proc = subprocess.Popen(
            [path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
        )
        self._send("uci")
        self._until("uciok", [])

    def _send(self, line: str) -> None:
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def _until(self, token: str, lines: list[str], timeout: float = 60) -> list[str]:
        seen: list[str] = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline() if self.proc.stdout else ""
            if not line:
                break
            seen.append(line.strip())
            if token in line:
                return seen
        return seen

    def eval_moves(self, moves: list[str], depth: int = _DEPTH) -> tuple[int, str] | None:
        """cp for the side to move, and its best move, after these moves."""
        if not self.proc.stdin or not self.proc.stdout:
            return None
        self._send("position startpos moves " + " ".join(moves))
        self._send(f"go depth {depth}")
        echo = self._until("bestmove", [])
        cp = None
        best = ""
        for line in echo:
            if " score " in line and " pv " in line:
                words = line.split()
                if "cp" in words:
                    cp = int(words[words.index("cp") + 1])
                elif "mate" in words:
                    cp = _mate_to_cp(words)
            if line.startswith("bestmove"):
                words = line.split()
                best = words[1] if len(words) > 1 else ""
        return (cp, best) if cp is not None and best else None

    def go_best(self, moves: list[str], depth: int, time_ms: int) -> str:
        """Just the bestmove for this position; '' if the engine never answers."""
        if not self.proc.stdin or not self.proc.stdout:
            return ""
        self._send("position startpos moves " + " ".join(moves))
        self._send(f"go depth {depth} movetime {time_ms}")
        for line in self._until("bestmove", [], timeout=8):
            if line.startswith("bestmove"):
                words = line.split()
                return words[1] if len(words) > 1 else ""
        return ""

    def close(self) -> None:
        try:
            self._send("quit")
        except Exception:
            log.debug("the engine did not accept quit", exc_info=True)
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

    def __enter__(self) -> "_Engine":
        return self

    def __exit__(self, *_) -> None:
        self.close()


def sf_eval(moves: list[str], depth: int = _DEPTH) -> tuple[int, str] | None:
    """One fresh engine, one position. None whenever stockfish is not there."""
    path = sf_path()
    if not path:
        return None
    try:
        with _Engine(path) as engine:
            return engine.eval_moves(moves, depth)
    except Exception:  # a broken binary must never break the review
        return None


def sf_best_move(moves: list[str], depth: int = 14, time_ms: int = 3000) -> str:
    """Stockfish's choice for the position after these UCI moves, '' if absent.

    Expert play asks this first. The caller must still validate the move: a
    foreign engine's answer is an outside voice, not an authority.
    """
    path = sf_path()
    if not path:
        return ""
    try:
        with _Engine(path) as engine:
            return engine.go_best(moves, depth, time_ms)
    except Exception:  # a missing or broken binary costs nothing
        return ""


def open_engine() -> "_Engine | None":
    """One engine for the whole review, or None without stockfish."""
    path = sf_path()
    if not path:
        return None
    try:
        return _Engine(path)
    except Exception:
        return None


def own_eval(state: dict) -> tuple[int, str]:
    """The game's own search, shallow: cp for the side to move and its move."""
    game = _game()
    deadline = time.monotonic() + 1.0
    try:
        value, move = game._root(game._Pos(state), 2, deadline)
    except game._TimeUp:
        value, move = None, None
    except Exception:
        value, move = None, None
    if move is None:
        legal = game.legal(state)
        move = game._spot_to_move(legal[0]) if legal else None
        value = None if move is None else 0
    return (int(value or 0), game._text(move) if move else "")


def eval_position(moves: list[str], state: dict) -> tuple[int, str]:
    """cp and best move for the side to move: Stockfish, else our search."""
    found = sf_eval(moves)
    if found is not None:
        return found
    return own_eval(state)
