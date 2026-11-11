"""The dock's disclosure must match what the client actually posts.

The paragraph says online play sends a named list of things and "only" those. The
client also posts the person's own optional actions — a strategy card they publish,
a report they file, a block they set, a bot challenge they start — and those were
not in the list, which makes "sends ... only" a false claim a reader can prove.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import online_source  # noqa: E402

SOURCE = (ROOT / "shelf" / "online_source.py").read_text(encoding="utf-8")
API = (ROOT / "dashboard" / "plugin_api.py").read_text(encoding="utf-8")

# Each extra thing the client can post, and the word the disclosure must use for it.
EXTRAS = {
    "strategy": ("/api/cards", "/api/card-arena"),
    "report": ("/api/reports",),
    "block": ("/api/blocks",),
    "challenge": ("/challenge", "/api/challenges"),
}


def test_the_client_really_posts_each_extra() -> None:
    """Guard the premise: if a feature stops being sent, this list should shrink."""
    for name, paths in EXTRAS.items():
        assert any(path in SOURCE or path in API for path in paths), name


def test_the_disclosure_names_every_extra_the_client_posts() -> None:
    text = online_source.disclosure().lower()
    missing = [name for name in EXTRAS if name.split()[0] not in text]
    assert missing == [], f"the disclosure does not mention: {missing}"


def test_the_disclosure_still_names_the_ordinary_traffic() -> None:
    text = online_source.disclosure("https://games.example")
    assert "games.example" in text
    for word in ("display name", "recovery key", "waiting for", "moves you make"):
        assert word in text, word
    assert not re.search(r"\b(sends only|nothing else)\b", text)
