"""One switch draws every table, and both tables come through it.

The local pane and the online table used to carry a view switch each, which is how an online
blackjack table came to be drawn as a chess grid: only one of the two switches knew the game. The
switch now lives in one part (64b-table-stage.js) and both call it, so a renderer added there shows
up in both places at once.

The behaviour is driven through the built bundle in tests/table_ui_harness.cjs (onlineStageContract).
This is the source contract behind it: the one definition, no second copy, and the pane really
draws its board through it.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "desktop" / "src"


def text(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8")


def test_the_view_switch_is_defined_once() -> None:
    defining = [path.name for path in SRC.glob("*.js") if "function tableStage(" in path.read_text(encoding="utf-8")]
    assert defining == ["64b-table-stage.js"], defining


def test_the_local_pane_draws_through_the_shared_switch() -> None:
    pane = text("65-wait-pane.js")
    assert "tableStage({" in pane, "the pane does not draw its board through tableStage"
    for moved in ("BlackjackTable", "SeaBattleTable", "Jackpot2Full"):
        assert moved not in pane, f"{moved} is still chosen in the pane instead of in the stage"


def test_the_online_table_draws_through_the_shared_switch() -> None:
    online = text("73-online-table.js")
    assert "tableStage({" in online, "the online table does not draw through tableStage"
    assert "BackgammonSvg : BoardSvg" not in online, "the online table keeps its own half a switch"
    # The two things only an online table says, because only it has a person on a server.
    assert "Side-by-side Slots online is coming; this is your own machine." in online
    assert "This game can't be drawn online yet" in online
