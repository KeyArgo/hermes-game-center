"""One name per slot machine, everywhere a person reads it.

Bug found walking the shelf (round-2 item 3): the second machine is called "Hermes Olympus" — that is the
name in `shelf/reels.py`, the name the machine carries on the table, and the name in docs/USAGE.md — but
`slots/game.json`'s summary and two lines of `slots/learn.json` still called it "Hermes Robots". A person
read the shelf, was told to pick "Hermes Robots", and then found a machine labelled "Hermes Olympus"; the
how-to lesson said the wrong one too.

This test asks the machine table what its machines are called and holds every user-facing mention to it, so
a rename cannot leave half the shelf behind again.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
pytest.importorskip("shelf.reels")
from shelf import slotplay  # noqa: E402


def machine_names() -> set[str]:
    """The names the machines actually carry, read from the same table the shelf draws."""
    names = set()
    for machine in slotplay.MACHINES.values():
        # slotplay publishes "title" for the shelf; reels.py keeps the same string as "name".
        name = str(machine.get("title") or machine.get("name") or "").strip()
        if name:
            names.add(name)
    return names


def user_facing_texts() -> dict[str, str]:
    texts = {
        "slots/game.json": (ROOT / "slots" / "game.json").read_text(encoding="utf-8"),
        "slots/learn.json": (ROOT / "slots" / "learn.json").read_text(encoding="utf-8"),
        "docs/USAGE.md": (ROOT / "docs" / "USAGE.md").read_text(encoding="utf-8"),
        "docs/CONFIGURATION.md": (ROOT / "docs" / "CONFIGURATION.md").read_text(encoding="utf-8"),
    }
    return texts


def test_every_machine_name_is_the_one_the_machine_carries() -> None:
    names = machine_names()
    assert names, "no machine names in the table"
    # Every capitalised "Hermes <something>" mention of a machine must be a real one.
    stale = []
    for where, text in user_facing_texts().items():
        for found in re.findall(r"Hermes (Olympus|Robots|Roboto|Android)\b", text):
            if f"Hermes {found}" not in names:
                stale.append(f"{where}: Hermes {found}")
    assert not stale, "renamed machine still under its old name: " + "; ".join(stale)


def test_the_slots_summary_names_every_machine() -> None:
    summary = json.loads((ROOT / "slots" / "game.json").read_text(encoding="utf-8"))["summary"]
    for name in machine_names():
        assert name in summary, f"the store summary never names {name!r}: {summary}"


def test_the_lesson_teaches_the_same_names_as_the_table() -> None:
    lesson = json.loads((ROOT / "slots" / "learn.json").read_text(encoding="utf-8"))
    taught = json.dumps(lesson, ensure_ascii=False)
    for name in machine_names():
        assert name in taught, f"the how-to never names {name!r}"
    assert "Hermes Robots" not in taught, "the lesson still teaches the old name"
