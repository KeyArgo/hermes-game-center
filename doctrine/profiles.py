"""Ask for a Doctrine card in the voice of one named Hermes profile.

A person types the profile name; this module refuses ``private``, refuses anything that is not a plain
profile name, and then writes the card with the model that person already has selected in Hermes —
``ctx.llm.complete``, the plugin LLM door, which only ever returns text and cannot run a tool, start a
process, read a file or reach the network. There is no child process here at all (review, 2026-11-12).

The profile name is kept for two reasons: it is validated (a name that cannot be a profile is refused
before any model is asked), and it is written into the card as its author, so a card says whose voice
wrote it.
"""

from __future__ import annotations

import re
from typing import Any, Callable

NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,31}\Z")
REFUSED = "That profile cannot author a card."
# What the card author is allowed to spend on one card. A card is 2 KB of JSON; this is generous.
MAX_TOKENS = 900

PROMPT = """You are authoring one Doctrine battle bot card. A card is DATA, never code.
Reply with one JSON object and nothing else (no prose, no code fences).

Required shape:
{{"schema":"doctrine-card/1","name":"<1-40 chars>","author":"<profile name>",
"personality":"<one short sentence>","weights":{{
"aggression":<0-100>,"safety":<0-100>,"objective":<0-100>,"focus":<0-100>,
"cohesion":<0-100>,"center":<0-100>,"mobility":<0-100>,"endurance":<0-100>}}}}

All eight weights are whole numbers from 0 to 100. Every field is required and no
other field is allowed. Aggression attacks, safety avoids being surrounded,
objective holds beacons, focus finishes weak enemies, cohesion stays near allies,
center moves toward the middle, mobility prefers open ground, endurance keeps
healthy units out of trouble. The card must be at most 2048 bytes.

Flavour for this card: {flavour}
"""


def problem(profile: object) -> str | None:
    """Why this profile name cannot be used, or None when it can."""
    text = str(profile or "").strip().lower()
    if text == "private":
        return "The private profile can never author a card."
    if not NAME.fullmatch(text):
        return "Profile names are lowercase letters, numbers and dashes."
    return None


def prompt(flavour: str = "a balanced fighter") -> str:
    """The authoring prompt sent to the person's model."""
    return PROMPT.format(flavour=str(flavour or "a balanced fighter")[:120])


def _reply_text(answer: Any) -> str:
    """The text of a model answer, in either shape a seat hands back."""
    if isinstance(answer, dict):
        return str(answer.get("move") or answer.get("text") or "")
    return str(answer or "")


def author(profile: str, text: str, complete: Callable[..., Any] | None = None) -> tuple[str | None, str]:
    """Write one card with the person's own model, or return a friendly error.

    ``complete`` is the plugin's model door (``ctx.llm.complete`` behind a small adapter): one prompt in,
    text out. Nothing here starts a program, so there is no environment, no flag and no tool set to get
    wrong. ``None`` means this surface has no model at all — the browser page, for instance — and the
    person is told so instead of being asked to check a profile that was never going to run.
    """
    name = str(profile or "").strip().lower()
    why = problem(name)
    if why:
        return None, why
    if not callable(complete):
        return None, ("Writing a card needs one model, and none is reachable from here. "
                      "Pick one in Settings → Models → \"Game Shelf opponent\". Everything else still works.")
    try:
        answer = complete(text, max_tokens=MAX_TOKENS)
    except TypeError:
        # A seat that takes only the prompt (kit's older shape).
        try:
            answer = complete(text)
        except Exception:  # a broken or slow model must cost a card, not the game
            return None, "That profile did not answer. Try again in a moment."
    except Exception:
        return None, "That profile did not answer. Try again in a moment."
    clean = _reply_text(answer).strip()
    if not clean:
        return None, "That profile returned nothing."
    return clean, ""
