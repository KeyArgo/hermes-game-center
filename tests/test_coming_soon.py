"""Nothing half-built is shown as working: matchmaking extras and unready modes say Coming soon."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.catalog import Catalog  # noqa: E402
from shelf.commands import run  # noqa: E402


def catalog(tmp_path: Path) -> Catalog:
    return Catalog([ROOT.parent], tmp_path / "data", {"allow_ai": True})


def test_games_match_says_coming_soon_and_changes_nothing(tmp_path: Path) -> None:
    shelf = catalog(tmp_path)
    for line in ("match blackjack", "match blackjack off", "match off", "match"):
        answer = run(shelf, line, source="command")
        assert "Coming soon" in answer, (line, answer)
    assert not (tmp_path / "data" / "lobby").exists() or not any((tmp_path / "data" / "lobby").iterdir())


def test_desktop_marks_unready_features_coming_soon() -> None:
    # The lobby placeholders (Who's online, Invisible, Quick join, Turn timer) were replaced by the
    # real Hall in 2.0, so they must not linger as "Coming soon" cards; what is still unbuilt keeps
    # its marker.
    bundle = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    for gone in ("Who's online", "Quick join", "Turn timer"):
        assert gone not in bundle, gone
    assert "Coming soon" in bundle
    assert "data-coming-soon" in bundle
