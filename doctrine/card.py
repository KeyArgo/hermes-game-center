"""Validation and serialization for Doctrine's data-only bot cards."""
from __future__ import annotations

import json
import re
from pathlib import Path

SCHEMA = "doctrine-card/1"
WEIGHTS = ("aggression", "safety", "objective", "focus", "cohesion", "center", "mobility", "endurance")
_NAME = re.compile(r"[A-Za-z0-9 ._'-]{1,40}\Z", re.ASCII)


def validate(raw: object) -> tuple[dict | None, list[str]]:
    """Validate a card supplied as a mapping or JSON text."""
    try:
        if isinstance(raw, (str, bytes)):
            if len(raw.encode("utf-8") if isinstance(raw, str) else raw) > 2048:
                return None, ["Card must be at most 2048 bytes."]
            raw = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        else:
            encoded = json.dumps(raw, allow_nan=False, ensure_ascii=True).encode("utf-8")
            if len(encoded) > 2048:
                return None, ["Card must be at most 2048 bytes."]
        if not isinstance(raw, dict):
            return None, ["Card must be an object."]
        problems = []
        for key in raw:
            if key not in {"schema", "name", "author", "personality", "weights"}:
                problems.append(f"unknown field: {str(key)[:40]}")
        if raw.get("schema") != SCHEMA:
            problems.append("schema must be doctrine-card/1.")
        for key in ("name", "author"):
            value = raw.get(key)
            if not isinstance(value, str) or not _NAME.fullmatch(value):
                problems.append(f"{key} must be 1 to 40 characters using letters, numbers, spaces or .-_'.")
        personality = raw.get("personality")
        if not isinstance(personality, str) or len(personality) > 120 or any(not c.isprintable() for c in personality):
            problems.append("personality must be plain text of at most 120 characters.")
        weights = raw.get("weights")
        if not isinstance(weights, dict):
            problems.append("weights must be an object.")
        else:
            for key in WEIGHTS:
                value = weights.get(key)
                if type(value) is not int or not 0 <= value <= 100:
                    problems.append(f"weights.{key} must be a whole number from 0 to 100.")
            for key in weights:
                if key not in WEIGHTS:
                    problems.append(f"unknown weight: {str(key)[:40]}")
        return (None, problems[:8]) if problems else (json.loads(json.dumps(raw, allow_nan=False)), [])
    except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
        return None, ["Card must be valid JSON."]


def loads(text: str) -> tuple[dict | None, list[str]]:
    """Validate a card encoded as a JSON string."""
    if not isinstance(text, str):
        return None, ["Card must be a JSON string."]
    return validate(text)


def house_cards() -> list[dict]:
    """Load the bundled cards in filename order."""
    cards = []
    for path in sorted(Path(__file__).with_name("cards").glob("*.json")):
        card, problems = validate(path.read_bytes())
        if problems:
            raise ValueError(f"Invalid house card {path.name}: {', '.join(problems)}")
        cards.append(card)
    return cards


def to_json(card: dict) -> str:
    """Serialize a card as compact, sorted JSON."""
    return json.dumps(card, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"


def from_payload(text: str) -> tuple[dict | None, list[str]]:
    """Read a bare card or a Doctrine card share envelope."""
    try:
        if not isinstance(text, (str, bytes)) or len(text.encode("utf-8") if isinstance(text, str) else text) > 2048:
            return None, ["Payload must be JSON of at most 2048 bytes."]
        data = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if isinstance(data, dict) and data.get("kind") == "doctrine-card":
            data = data.get("card", data.get("data"))
        return validate(data)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return None, ["Payload must be valid JSON."]


def envelope(kind: str, data: dict) -> dict:
    """Wrap data in a Doctrine share envelope."""
    return {"schema": "doctrine-share/1", "kind": kind, "data": data}
