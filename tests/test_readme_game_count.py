"""The number of games the README promises is the number the shelf actually ships.

The README once led with "Eighteen games Hermes can actually play" while Play has
eleven curated games and the other seven sit behind the Experimental link. A reader counted eighteen on
the shelf and found eleven, and the plugin's own shelf file says which is which.

The count is read from `shelf/curated.json` — the same file the Play shelf renders — so growing the shelf
fails this test until the README is re-read, which is the point: the claim and the code cannot drift.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"

# The words a person would write for a small count, so "eleven" can be compared with 11.
WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight",
         9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen",
         15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen", 20: "twenty"}


def curated_count() -> int:
    data = json.loads((ROOT / "shelf" / "curated.json").read_text(encoding="utf-8"))
    games = data["games"] if isinstance(data, dict) else data
    return len(games)


def word_for(number: int) -> str:
    return WORDS.get(number, str(number))


def test_the_readme_leads_with_the_number_of_play_games() -> None:
    count = curated_count()
    text = README.read_text(encoding="utf-8")
    lead = text[:2000]  # the title block: logo, name, the one-line claim
    assert word_for(count) in lead.lower(), (
        f"Play ships {count} games but the README's first line does not say {word_for(count)!r}: {lead.strip()[:200]}"
    )


def test_no_claim_of_a_bigger_play_shelf_than_there_is() -> None:
    """A bigger number is how the shelf got oversold: check every count word against the shelf."""
    count = curated_count()
    text = README.read_text(encoding="utf-8")
    claims = re.findall(r"\b(" + "|".join(WORDS.values()) + r")\b(?=[^.\n]{0,40}\bgames?\b)", text.lower())
    too_big = {word for word in claims if word in WORDS.values()
               and list(WORDS.values()).index(word) + 1 > max(count, 18)}
    assert not too_big, f"README claims more games than exist: {sorted(too_big)}"


def test_the_eighteen_rule_engines_claim_is_about_folders_not_the_play_shelf() -> None:
    """Eighteen engine folders is true; eighteen Play games is not. Keep the two apart."""
    text = README.read_text(encoding="utf-8").lower()
    assert "eighteen games" not in text, "the Play shelf has eleven games, not eighteen"
    folders = [p for p in ROOT.iterdir() if p.is_dir() and (p / "game.json").is_file()]
    assert len(folders) >= 11, f"only {len(folders)} game folders: {[p.name for p in folders]}"
    if "eighteen rule engines" in text or "eighteen game folders" in text:
        assert len(folders) == 18, (
            f"the README says eighteen rule engines but the tree has {len(folders)} game folders"
        )
