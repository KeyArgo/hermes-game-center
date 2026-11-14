"""Write a Doctrine card with the person's own model, signed with a name they type.

A card carries an ``author`` field. That field is a SIGNATURE: the name the person typed, written into the
card as they asked, the way a drawing is signed. The model that writes the card is the one they already
have selected in Hermes, through ``ctx.llm.complete`` — the plugin LLM door, which returns text and cannot
run a tool, start a process, read a file or reach the network.

It is deliberately NOT "ask another Hermes profile to write this". Running ``hermes -p <profile> chat``
would hand a child process that profile's tools, and announcing the card as that profile's work would
claim authorship a name in a field cannot carry. So the input is a signature, every surface says
"signed", and nothing here claims a profile ran.
"""

from __future__ import annotations

import re
from typing import Any, Callable

# A signature a person types: up to 32 characters, letters, numbers, dots, dashes or underscores, starting
# with a letter or a number. One word on purpose: the command line is ``doctrine author <name> [flavour]``,
# so a space would make the name and the flavour impossible to tell apart. Anything else is refused before
# a model is asked, with the reason.
SIGNATURE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,31}\Z")
MAX_LENGTH = 32
# What one card is allowed to spend. A card is 2 KB of JSON; this is generous.
MAX_TOKENS = 900

PROMPT = """You are authoring one Doctrine battle bot card. A card is DATA, never code.
Reply with one JSON object and nothing else (no prose, no code fences).

Required shape:
{{"schema":"doctrine-card/1","name":"<1-40 chars>","author":"{signature}",
"personality":"<one short sentence>","weights":{{
"aggression":<0-100>,"safety":<0-100>,"objective":<0-100>,"focus":<0-100>,
"cohesion":<0-100>,"center":<0-100>,"mobility":<0-100>,"endurance":<0-100>}}}}

All eight weights are whole numbers from 0 to 100. Every field is required and no
other field is allowed. Aggression attacks, safety avoids being surrounded,
objective holds beacons, focus finishes weak enemies, cohesion stays near allies,
center moves toward the middle, mobility prefers open ground, endurance keeps
healthy units out of trouble. The card must be at most 2048 bytes.

The author field is the signature the person chose: write it exactly as "{signature}".

Flavour for this card: {flavour}
"""


def problem(signature: object) -> str | None:
    """Why this signature cannot be used, or None when it can."""
    text = clean(signature)
    if not text:
        return "Type the name to sign the card with."
    if len(text) > MAX_LENGTH:
        return f"A signature is at most {MAX_LENGTH} characters."
    if not SIGNATURE.fullmatch(text):
        return ("A signature is one word of up to 32 characters: letters, numbers, dots, dashes or "
                "underscores, starting with a letter or a number.")
    return None


def clean(signature: object) -> str:
    """The signature as typed, trimmed and with runs of space collapsed — never shortened.

    Silently cutting a long name to 32 characters would sign the card with a name the person did not
    type, so a long one is refused by ``problem()`` instead.
    """
    return " ".join(str(signature or "").split())


def prompt(signature: str = "you", flavour: str = "a balanced fighter") -> str:
    """The authoring prompt sent to the person's model, carrying their signature."""
    return PROMPT.format(
        signature=(clean(signature) or "you")[:MAX_LENGTH],
        flavour=" ".join(str(flavour or "a balanced fighter").split())[:120] or "a balanced fighter",
    )


def _reply_text(answer: Any) -> str:
    """The text of a model answer, in either shape a seat hands back."""
    if isinstance(answer, dict):
        return str(answer.get("move") or answer.get("text") or "")
    return str(answer or "")


def author(signature: str, text: str, complete: Callable[..., Any] | None = None) -> tuple[str | None, str]:
    """Write one card with the person's own model, or return a friendly error.

    ``complete`` is the plugin's model door (``ctx.llm.complete`` behind a small adapter): one prompt in,
    text out. Nothing here starts a program, so there is no environment, no flag and no tool set to get
    wrong. ``None`` means this surface has no model at all — the browser page, for instance — and the
    person is told so instead of being asked to check a profile that was never going to run.
    """
    name = clean(signature)
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
            return None, "The model did not answer. Try again in a moment."
    except Exception:
        return None, "The model did not answer. Try again in a moment."
    reply = _reply_text(answer).strip()
    if not reply:
        return None, "The model returned nothing."
    return reply, ""
