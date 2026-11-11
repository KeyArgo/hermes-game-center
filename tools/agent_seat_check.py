#!/usr/bin/env python3
"""Agent seats: does 'Play my agent' actually run, and does it fall back cleanly when the model is bad?

This is the one mode the dashboard API cannot reach — the page has no model callback, so a
Desktop agent seat is refused there by design. Inside Hermes, __init__ passes `complete`.
Here we pass our own: a stub that answers with a legal move (good model) or garbage (bad model).

Run:  python3 -u tools/agent_seat_check.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402

GAMES = ["connect4", "reversi", "checkers", "breakthrough", "gomoku", "kalah", "chessboard", "go", "hex"]


def legal_from_prompt(prompt: str) -> list[str]:
    for line in prompt.splitlines():
        if line.startswith("Legal moves:"):
            return [item.strip() for item in line.split(":", 1)[1].split(",") if item.strip()]
    return []


def good_model(prompt: str) -> dict:
    moves = legal_from_prompt(prompt)
    return {"move": moves[0] if moves else "", "remark": "", "tokens": 12}


def bad_model(prompt: str) -> dict:
    del prompt
    return {"move": "nonsense-move", "remark": "", "tokens": 7}


def play(catalog: Catalog, game: str, complete) -> tuple[str, int]:
    run(catalog, f"{game} abandon", source="command")
    run(catalog, f"install {game}", source="command")
    started = run(catalog, f"allow-ai {game} black=agent", source="command", complete=complete)
    if "move" not in started.lower():
        return f"START FAILED: {started[:50]}", 0
    for ply in range(300):
        picture = catalog.picture(game) or {}
        status = picture.get("status")
        if status in {"win", "draw"}:
            return status, ply
        legal = picture.get("legal") or []
        if not legal:
            return f"STUCK ({status})", ply
        answer = run(catalog, f"{game} move {legal[0]}", source="command", complete=complete)
        if answer.startswith(("Refused", "Could not read")):
            return f"REFUSED: {answer[:50]}", ply
    return "DID NOT END", 300


def main() -> int:
    total_failures = 0
    for label, complete in (("good model", good_model), ("bad model", bad_model)):
        print(f"\n== agent seat, {label}", flush=True)
        failures = 0
        for game in GAMES:
            catalog = Catalog([ROOT], Path(tempfile.mkdtemp(prefix="agent-seat-")),
                              {"allow_ai": True}, enabled=lambda name: name == "hermes-gameshelf")
            status, plies = play(catalog, game, complete)
            failures += status not in {"win", "draw"}
            print(f"  {game:11s} {status:26s} plies={plies}", flush=True)
        print(f"  -> {len(GAMES) - failures}/{len(GAMES)} finished", flush=True)
        total_failures += failures
    return 0 if total_failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
