"""The proof's player: one process, one JSON line per request.

stdin:  {"moves": ["e2e4", ...]}    -- the game so far, from-to strings
stdout: {"move": "e2e4"}            -- the move to click, or {"move": ""}

It is the person's judgement, computed with the game's own search at its
strongest: the proof still presses every square with the mouse.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chessboard import game  # noqa: E402

DEPTH = 5  # the deepest the search is allowed to go


def respond(line: str) -> str:
    ask = json.loads(line)
    state = game.fresh()
    for move in ask.get("moves") or []:
        if move in game.legal(state):
            state = game._child(state, move)
    depth = max(1, min(6, int(ask.get("depth") or DEPTH)))
    return json.dumps({"move": game.bot(state, depth)})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            print(respond(line), flush=True)
        except Exception as error:  # never hang the proof: an empty move is a pass
            print(json.dumps({"move": "", "error": str(error)[:200]}), flush=True)


if __name__ == "__main__":
    main()
