"""Card bouts: two owners' locked strategy cards, played by the server's own engine.

A card is data: eight weights and a name. It cannot run code, reach the network, or name a
file. That is what makes a server-run bout safe to offer: the referee owns the whole game,
so two people can compare their cards without either machine being trusted.

Neither engine exists to be a chat model: ``doctrine`` is a deterministic turn engine and
``doctrine_arena`` is a fixed-timestep simulation. The same cards and the same seed always
give the same battle, which is what a replay needs.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

_SHELF = Path(__file__).resolve().parent.parent
if str(_SHELF) not in sys.path:
    sys.path.insert(0, str(_SHELF))

GAMES = ("doctrine", "doctrine_arena")
TITLES = {"doctrine": "Doctrine", "doctrine_arena": "Doctrine Arena"}


def _module(name: str):
    return importlib.import_module(name)


def validate(game: str, raw) -> tuple[dict | None, list[str]]:
    """Check one card for one game. Returns the stored card and any problems."""
    if game == "doctrine":
        return _module("doctrine.card").validate(raw)
    if game == "doctrine_arena":
        try:
            return dict(_module("doctrine_arena.card").validate(raw)), []
        except Exception as exc:  # CardError and anything a bad payload raises
            return None, [str(exc) or "That card could not be read."]
    return None, ["Only Doctrine and Doctrine Arena cards can be played on this server."]


def run(game: str, one: dict, two: dict, seed: int) -> dict:
    """Play one battle between two validated cards. Winner is "one", "two" or ""."""
    if game == "doctrine":
        replay = _module("doctrine.engine").replay([one, two], int(seed))
        winner = str(replay.get("winner") or "")
        side = "one" if winner == "white" else "two" if winner == "black" else ""
        frames = list(replay.get("frames") or [])
        return {"winner": side, "reason": str(replay.get("status") or "battle"),
                "plies": len(frames), "replay": replay}
    if game == "doctrine_arena":
        replay = _module("doctrine_arena.engine").simulate([one, two], int(seed))
        winner = int((replay.get("result") or {}).get("winner", -1))
        frames = list(replay.get("frames") or [])
        return {"winner": "one" if winner == 0 else "two" if winner == 1 else "",
                "reason": "battle", "plies": len(frames), "replay": replay}
    raise ValueError("No engine for that game.")


def describe(game: str, card: dict) -> str:
    """One plain line about a card, for a page that has no room for the JSON."""
    if game == "doctrine_arena":
        try:
            return str(_module("doctrine_arena.card").describe(card))
        except Exception:
            return str(card.get("name") or "Card")
    weights = card.get("weights") or {}
    orders = ", ".join(f"{key} {value}" for key, value in sorted(weights.items(), key=lambda item: -item[1])[:3])
    return f"{card.get('name') or 'Card'} · {orders}" if orders else str(card.get("name") or "Card")
