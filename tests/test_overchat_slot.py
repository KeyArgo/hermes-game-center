"""Review item 2: the see-through machines live in an SDK slot, not over the app's markup.

Nous's review (2026-11-12) found the Desktop over-chat machine reaching into the app: it scanned the
app's ``textarea`` elements and walked their ancestors to find a "chat column", appended a stylesheet to
``<head>`` and a full-screen overlay to ``<body>``. A plugin that does that can be broken by an app
update and can break the app.

Both machines — the original cabinet (19-jackpot-overlay.js) and Jackpot v2 (19-jackpot2-layer.js) — are
now contributed to ``COMPOSER_AREAS.underside`` and rendered by 78-overchat-slot.js in our own tree. The
slot owns the place and the width; nothing reads the document, the window or any element of the app's.

These tests are the gate, and they fail on the old shape:

- the registration is a composer-slot contribution (not a status-bar item hosting an overlay);
- the bundle never queries the document, never appends to ``<body>``/``<head>``, and never creates a
  style element for the document;
- the copy is sized from the width the slot hands it, not from ``window.innerWidth`` or a measured
  column;
- the two machines cannot overlap, because one flex row splits the slot between them.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "desktop" / "src"
BUNDLE = ROOT / "desktop" / "plugin.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _code_only(text: str) -> str:
    """The file with its comments removed, so prose *about* document.body is not a use of it."""
    without_blocks = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    lines = []
    for line in without_blocks.splitlines():
        # A whole-line comment goes; a trailing one goes too. A string that starts with // (a URL) keeps
        # its code before the marker, which is all this scan needs.
        stripped = line.strip()
        if stripped.startswith("//"):
            lines.append("")
        else:
            lines.append(re.sub(r"\s//(?![^\"]*\")[^\n]*$", "", line))
    return "\n".join(lines)


FORBIDDEN = {
    r"document\.body\s*\.": "the app's <body> is touched",
    r"document\.head\s*\.": "the app's <head> is touched",
    r"document\.querySelector": "the app's markup is queried",
    r"document\.getElementById": "the app's markup is looked up by id",
    r"window\.hermesDesktop": "a private app door is used",
    r"createElement\(\s*['\"]style": "a stylesheet element is created for the document",
}


def test_the_machines_are_a_composer_slot_contribution():
    plugin = _read(SRC / "80-plugin.js")
    assert "COMPOSER_AREAS.underside" in plugin, (
        "the see-through machines must be registered in the composer's underside slot: that is the SDK "
        "surface the review named, and it is what makes 'only over the conversation' structural."
    )
    assert re.search(r"id:\s*'overchat'", plugin), "the contribution has its own id"
    assert "OverChatStrip" in plugin, "and it renders the strip that owns both machines"
    assert "Jackpot2StatusItem" not in _code_only(plugin), (
        "no status-bar item is left hosting an overlay: the slot draws the machines now"
    )


def test_the_bundle_never_reaches_into_the_apps_markup():
    code = _code_only(_read(BUNDLE))
    offenders = [f"{pattern} ({why})" for pattern, why in FORBIDDEN.items() if re.search(pattern, code)]
    assert not offenders, "the built plugin.js still reaches into the app: " + "; ".join(offenders)


def test_every_part_of_the_source_obeys_the_same_rule():
    """The bundle is generated, so the parts are the file a reader edits — scan them too."""
    offenders = []
    for path in sorted(SRC.glob("*.js")):
        code = _code_only(_read(path))
        for pattern, why in FORBIDDEN.items():
            if re.search(pattern, code):
                offenders.append(f"{path.name}: {why}")
    assert not offenders, "these parts reach into the app: " + "; ".join(offenders)


def test_the_copy_is_sized_from_the_slot_not_the_window():
    strip = _read(SRC / "78-overchat-slot.js")
    assert "getBoundingClientRect" in strip, "the strip measures its OWN box"
    assert re.search(r"const share = both \? Math\.max\(0, width - OVERCHAT_GAP\) / 2 : width", strip), (
        "and splits that width between the machines: one gets the whole slot, two get half each"
    )
    overlay = _read(SRC / "19-jackpot-overlay.js")
    layer = _read(SRC / "19-jackpot2-layer.js")
    for name, text in (("19-jackpot-overlay.js", overlay), ("19-jackpot2-layer.js", layer)):
        code = _code_only(text)
        assert re.search(r"function SlotsOverChatCopy\(\{ ctx, width \}\)", code) or name != "19-jackpot-overlay.js"
        assert "window.innerWidth" not in code, f"{name} still measures the window"
        assert "location.hash" not in code, f"{name} still reads the route to decide where it is"
    assert "overchatFitScale" in overlay, "one fit rule, taking the width it was given"
    assert "overchatFitScale(JP2L_SIZE, width" in _code_only(layer), "and the v2 copy shares that same rule"


def _function_body(text: str, name: str) -> str:
    """The source of one top-level function, from its `function name(` to the next one."""
    start = text.index(f"function {name}(")
    rest = text[start:]
    end = rest.find("\nfunction ", 1)
    return rest if end < 0 else rest[:end]


def test_neither_copy_positions_itself_over_the_page():
    """A copy in a slot has no coordinates of its own; a fixed one is the defect coming back.

    Read from the copy's own body, not the whole file: the Slots panel the person opens from the status
    chip is a popup of its own business, and the cabinet's egg reveal is an animation inside the machine.
    """
    for name, copy in (("19-jackpot-overlay.js", "SlotsOverChatCopy"), ("19-jackpot2-layer.js", "jp2LOverChatCopy")):
        body = _function_body(_code_only(_read(SRC / name)), copy)
        assert not re.search(r"position:\s*'fixed'", body), f"{copy} still positions a copy fixed"
        assert not re.search(r"zIndex", body), f"{copy} still stacks itself over the page"
    # The cabinet's copy has to measure itself before it can be fitted, so its box is a containing block
    # (position: 'relative' on an in-flow element) — never a positioned one.
    body = _function_body(_code_only(_read(SRC / "19-jackpot-overlay.js")), "SlotsOverChatCopy")
    assert "position: 'relative'" in body, "the copy is an in-flow box the slot lays out"
    layer = _code_only(_read(SRC / "19-jackpot2-layer.js"))
    assert not re.search(r"zIndex:\s*\d{8,}", layer), "nothing in the copy half floats over the app at a huge z-index"


def test_every_machine_in_the_strip_has_its_own_place():
    strip = _read(SRC / "78-overchat-slot.js")
    assert "display: 'flex'" in strip, "the strip is one row"
    assert "'data-overchat': 'slots'" in strip and "'data-overchat': 'jackpot'" in strip, (
        "each machine has a distinct cell, so two of them cannot draw over each other"
    )
    assert "pointerEvents: 'none'" in strip, "and none of it takes a click meant for the conversation"
