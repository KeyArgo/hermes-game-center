"""No default player name, and a **Suggest a name** button instead (owner, 2026-11-18).

The boxes used to open pre-filled with a name the shelf had derived from the local player id, which
is "local" on every computer - so every PC offered the same name, and the welcome asked a question
whose answer was already written in. The boxes open empty now, in the welcome, in Settings and in the
online sign-in, and each one carries the button that fills it from ``GET /name/suggest`` with a fresh
name on every press (``tests/test_name_generator.py`` pins the names themselves).

Asserted on the parts the plugin is written in: the built ``desktop/plugin.js`` is rebuilt once, on
the merged tree.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = ROOT / "desktop" / "src" / "60-settings-and-alerts.js"
PANE = ROOT / "desktop" / "src" / "65-wait-pane.js"


def test_the_welcome_and_settings_open_with_an_empty_name_box() -> None:
    source = SETTINGS.read_text(encoding="utf-8")
    assert source.count("useState(setup.name || '')") == 2, \
        "the welcome and Settings must open on the person's own saved name, or on nothing at all"
    assert "suggested_name" not in source, "something is still pre-filling the box from the shelf"


def test_both_boxes_carry_the_suggest_button() -> None:
    source = SETTINGS.read_text(encoding="utf-8")
    assert "function suggestNameButton(" in source
    # One call in the welcome, one in Settings.
    assert source.count("suggestNameButton(") >= 3, "a name box is missing its Suggest a name button"
    assert "'Suggest a name'" in source, "the button has to say what it does"


def test_the_button_asks_the_shelf_for_a_fresh_name() -> None:
    source = SETTINGS.read_text(encoding="utf-8")
    assert "ctx.rest('/name/suggest')" in source, "the button does not call the shelf's own generator"
    # A failure leaves the box alone: a name can always be typed.
    assert "name can still be typed" in source or "keeps what it had" in source


def test_the_online_sign_in_offers_it_too() -> None:
    source = PANE.read_text(encoding="utf-8")
    assert "suggestNameButton(setOnlineName, ctx)" in source, \
        "the online sign-in still asks the person to invent a name from nothing"
