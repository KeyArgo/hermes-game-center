"""Shared rule: a person plays, or they type yes before an AI takes a seat."""

from __future__ import annotations

import shlex


def seat_kind(token: str) -> str:
    text = token.strip().lower()
    if text == "human" or text.startswith("human:"):
        return "human"
    return "ai"


def _pairs(parts: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for part in parts:
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        found[key.lower()] = value
    return found


def _seats_an_ai(head: str, parts: list[str]) -> bool:
    if head in {"allow-ai", "allow_ai", "solo", "step"}:
        return True
    if head != "new":
        return False
    seats = _pairs(parts[1:])
    named = [seats.get("white", ""), seats.get("black", "")]
    return any(token and seat_kind(token) == "ai" for token in named)


def blocked(raw: str, source: str, *, allow_ai: bool = True) -> str | None:
    """Return the refusal text, or None when this line may reach the game.

    A typed slash command is a person. A tool call is a model and cannot
    consent. ``allow_ai`` false is the profile floor and blocks every AI seat.
    """
    try:
        parts = shlex.split(raw or "")
    except ValueError:
        # A line the gate cannot read cannot be checked against the AI rule. A typed
        # line has already been split by /games, so this only reaches a model call.
        if source == "command":
            return None
        return (
            "That line could not be read as words, so it cannot be checked against "
            "the AI rule. A person can type it directly."
        )
    if not parts:
        return None
    head = parts[0].lower()
    if not allow_ai and _seats_an_ai(head, parts):
        return (
            "AI is off for this profile. People can still play. "
            "Type /games <game> new white=human black=human"
        )
    if source == "command":
        return None
    if head in {"allow-ai", "allow_ai"}:
        return (
            "A person has to agree before an AI sits opposite a human. "
            "They type /games allow-ai <game> black=@name"
        )
    if head != "new":
        return None
    seats = _pairs(parts[1:])
    white = seats.get("white", "")
    black = seats.get("black", "")
    if not white or not black:
        return None
    kinds = {seat_kind(white), seat_kind(black)}
    if kinds == {"human", "ai"}:
        ai = black if seat_kind(black) == "ai" else white
        return (
            "That would put an AI opposite a human. "
            f"The person types /games allow-ai <game> black={ai}"
        )
    return None
