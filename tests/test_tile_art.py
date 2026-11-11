"""The Play tiles draw to one stage: no game's cover art is bigger than its neighbours'.

The owner reported the Slots tile reading larger than the others (2026-11-09). The cause was
the slots and blackjack scenes being drawn 160 wide and stretched across the whole tile while
every board sat inside the same 130 px stage. These pin the two numbers that keep them equal.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "desktop" / "plugin.js"
LIBRARY = ROOT / "desktop" / "src" / "20-library.js"
ART = ROOT / "desktop" / "src" / "14-board-svg.js"


def test_every_play_tile_uses_one_stage_height() -> None:
    source = LIBRARY.read_text(encoding="utf-8")
    assert "height: 130" in source, "the Play tile stage is 130 px"
    assert "function playTile(" in source


def test_the_slot_and_card_scenes_are_drawn_square_in_that_stage() -> None:
    source = ART.read_text(encoding="utf-8")
    branch = source.split("id === 'blackjack' || id === 'slots'", 1)[1].split("\n  }", 1)[0]
    assert "const side = height" in branch, "the scene is sized from the stage height"
    assert "width: side" in branch and "height: side" in branch, "drawn square, not stretched"
    assert "worldScene(id, side, side)" in branch, "the scene gets the stage's height as its width"


def test_the_built_bundle_carries_the_same_rule() -> None:
    bundle = BUNDLE.read_text(encoding="utf-8")
    assert "worldScene(id, side, side)" in bundle or "worldScene(p, side, side)" in bundle, (
        "the shipped bundle must contain the squared cover art, not just the source"
    )
