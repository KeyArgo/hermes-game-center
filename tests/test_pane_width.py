"""The pane beside the chat opens wide and can be dragged wider or narrower."""
import re
from pathlib import Path

PLUGIN = (Path(__file__).resolve().parent.parent / "desktop" / "plugin.js").read_text(encoding="utf-8")


def _px(pattern: str) -> int:
    found = re.search(pattern, PLUGIN)
    assert found, pattern
    return int(found.group(1))


def test_pane_opens_twice_the_old_width():
    assert _px(r"const PANE_WIDTH = '(\d+)px'") == 720


def test_pane_can_be_dragged_both_ways():
    width = _px(r"const PANE_WIDTH = '(\d+)px'")
    low = _px(r"minWidth: '(\d+)px',\s*maxWidth: '\d+px',\s*defaultCollapsed")
    high = _px(r"minWidth: '\d+px',\s*maxWidth: '(\d+)px',\s*defaultCollapsed")
    assert low < width < high
    assert high >= 1200
