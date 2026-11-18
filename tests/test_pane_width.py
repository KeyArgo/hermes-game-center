"""The pane beside the chat opens at the owner's width and can be dragged wider or narrower."""
import re
from pathlib import Path

PLUGIN = (Path(__file__).resolve().parent.parent / "desktop" / "plugin.js").read_text(encoding="utf-8")


def _px(pattern: str) -> int:
    found = re.search(pattern, PLUGIN)
    assert found, pattern
    return int(found.group(1))


def test_pane_opens_where_the_owner_left_it():
    # Owner, 2026-11-18: "the right pane for the game center should default where it is now" (368 px).
    assert _px(r"const PANE_WIDTH = '(\d+)px'") == 368


def test_pane_can_be_dragged_both_ways():
    width = _px(r"const PANE_WIDTH = '(\d+)px'")
    low = _px(r"minWidth: '(\d+)px',\s*maxWidth: '\d+px',\s*defaultCollapsed")
    high = _px(r"minWidth: '\d+px',\s*maxWidth: '(\d+)px',\s*defaultCollapsed")
    assert low < width < high
    assert high >= 1200
