"""Ask one named Hermes profile for a Doctrine card, only when a person names it.

This is the one place Doctrine starts another program. It is never used by the
battle engine. A person types the profile name; this module refuses ``private``,
refuses anything that is not a plain profile name, and runs that profile's own
Hermes with tools disabled so the only thing that can come back is text.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,31}\Z")
REFUSED = "That profile cannot author a card."

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
    """The authoring prompt sent to the named profile."""
    return PROMPT.format(flavour=str(flavour or "a balanced fighter")[:120])


def author(profile: str, text: str, home: Path | None = None, runner=None) -> tuple[str | None, str]:
    """Run one named profile and return its reply text, or a friendly error.

    ``runner`` is injectable so tests never start a real Hermes process.
    """
    name = str(profile or "").strip().lower()
    why = problem(name)
    if why:
        return None, why
    run = runner or _run
    try:
        reply, error = run(name, text, home)
    except Exception:  # a missing CLI, a timeout, a killed process
        return None, "That profile did not answer. Check that Hermes can run it."
    if error:
        return None, str(error)[:300]
    clean = str(reply or "").strip()
    if not clean:
        return None, "That profile returned nothing."
    return clean, ""


def _run(profile: str, text: str, home: Path | None) -> tuple[str | None, str]:
    """The real runner: one headless turn of that profile, tools disabled."""
    env = dict(os.environ)
    if home is not None:
        env["HERMES_HOME"] = str(home)
    command = [
        "hermes", "-p", profile, "chat",
        "--query-file", "-", "--oneshot", "-Q", "--no-restore-cwd",
        "--toolsets", "",
    ]
    done = subprocess.run(
        command, input=text, capture_output=True, text=True, timeout=240, env=env, check=False,
    )
    if done.returncode != 0:
        return None, (done.stderr or done.stdout or "the profile exited with an error").strip()
    return done.stdout, ""
