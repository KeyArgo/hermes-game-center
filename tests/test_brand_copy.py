"""The README and brand images say Sea Battle, never the trademark, and the badges cannot go stale."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")


def test_the_readme_never_brands_the_game_as_battleship() -> None:
    # "battleship" the ship type inside Sea Battle is fine; the game's name in our copy is not.
    assert not re.search(r"Battleship (while|and)|gc-battleship", README), "the README brands Sea Battle as Battleship"
    assert (ROOT / "docs/media/gc-seabattle.gif").is_file()


def test_the_readme_has_no_hand_written_test_count() -> None:
    assert not re.search(r"badge/tests-\d+", README), "a typed test count goes stale; the CI badge is the live one"


def test_the_ci_badge_follows_the_release_branch() -> None:
    badge = re.search(r"tests\.yml/badge\.svg\?branch=([^\"&]+)", README)
    assert badge and badge.group(1) == "release/1.0.0", badge
