"""The see-through machines are anchored in the composer's slot, and drawn at the top of the conversation.

Two things are pinned here that the older bundle-scan does not cover:

- 78-overchat-slot.js stays inside its own elements. It may look at the SLOT (the area the Desktop SDK
  hands a contribution) and at its own box, and at nothing else on the page: no ``document.body``, no
  ``document.head``, no ``querySelector`` at all, no ``textarea`` and no ``parentElement`` walk. Those are
  the four moves that reached into the app before, and the review that asked for the slot named them.

- both switches are off on a fresh install, so nothing is drawn until somebody asks for it.

The browser proof that the machines actually land at the top of the window lives in
tests/overchat_slot_live.mjs, which drives the built bundle in headless Chrome.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "desktop" / "src"
SLOT = SRC / "78-overchat-slot.js"


def _code_only(text: str) -> str:
    """The file with its comments removed, so prose *about* document.body is not a use of it."""
    without_blocks = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    lines = []
    for line in without_blocks.splitlines():
        stripped = line.strip()
        if stripped.startswith("//"):
            lines.append("")
        else:
            lines.append(re.sub(r"\s//(?![^\"]*\")(?:[^\n]*)$", "", line))
    return "\n".join(lines)


# Each of these is a way of reaching into the app's markup, and each of them was used by the overlay this
# part replaced. Bare ``querySelector`` is here too: the copy may look inside its own subtree, the document
# never comes into it.
NEVER = {
    "document.body": "the app's <body> is touched",
    "document.head": "the app's <head> is touched",
    "querySelector": "the page is queried",
    "textarea": "the app's composer is scanned",
    "parentElement": "the app's ancestors are walked",
}


def test_the_slot_file_never_reaches_into_the_page():
    code = _code_only(SLOT.read_text(encoding="utf-8"))
    offenders = [f"{token} ({why})" for token, why in NEVER.items() if token in code]
    assert not offenders, "78-overchat-slot.js still reaches into the page: " + "; ".join(offenders)


def test_the_bundle_carries_the_same_rule():
    """The bundle is generated, so the part is the file a reader edits — and the file that ships is scanned
    by test_overchat_slot.py. This is the same five words against the built copy of this one part."""
    bundle = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    start = bundle.find("// ---- 78-overchat-slot.js")
    assert start > 0, "the slot part is in the built bundle"
    after = bundle.find("\n// ---- ", start + 1)
    part = _code_only(bundle[start:] if after < 0 else bundle[start:after])
    offenders = [token for token in NEVER if token in part]
    assert not offenders, "the built plugin.js has the slot reaching into the page: " + ", ".join(offenders)


def test_the_anchor_is_zero_height_and_only_the_anchor_is_measured():
    text = _code_only(SLOT.read_text(encoding="utf-8"))
    assert "getBoundingClientRect" in text, "the anchor is measured from its own box"
    # One measurement function, taking the anchor's ref: no element of the app's is passed to it.
    assert re.search(r"function overchatAnchor\(ref\)", text), "the anchor's own box is the measurement"
    assert re.search(r"height: 0", text), "the anchor takes no height, so the composer keeps its own"
    # A window resize moves the top of the window under a fixed box without changing our width, so it has
    # to be listened to as well — and the listener has to be taken back off.
    assert "addEventListener('resize'" in text, "the window's own resize is watched"
    assert "removeEventListener('resize'" in text, "and unwatched when the machines go"
    assert "ResizeObserver" in text, "the slot's own box is still watched"


def test_the_machines_are_drawn_fixed_at_the_top_and_can_fall_back():
    text = _code_only(SLOT.read_text(encoding="utf-8"))
    assert re.search(r"const OVERCHAT_TOP = \d+", text), "the offset below the window's top is a named constant"
    assert "position: 'fixed'" in text, "the machines are drawn in a fixed box"
    assert re.search(r"const OVERCHAT_TOP_SLACK = \d+", text), "and how far off it may land is named too"
    # The check is against the FIXED BOX'S OWN rect, which is the only honest answer to "did it arrive?".
    assert "Math.abs(top - OVERCHAT_TOP) > OVERCHAT_TOP_SLACK" in text, (
        "the placement is verified from the fixed box's own rect, so a trapping ancestor is detected"
    )
    assert "setPlace('slot')" in text, "and a trapped host falls back to drawing in the slot"
    assert "'data-overchat-place'" in text, "which mode is in use is readable from the DOM"


def test_the_height_is_capped_by_the_window_and_the_machines_budget():
    text = _code_only(SLOT.read_text(encoding="utf-8"))
    assert re.search(r"const OVERCHAT_VIEW_SHARE = 0?\.\d+", text), "the stage takes a share of the window"
    assert re.search(r"Math\.min\(OVERCHAT_MAX_HEIGHT, share\)", text), (
        "and never more than the height budget a machine over a conversation is allowed"
    )
    # The copies are told the height to fit into; a machine that fits only the width would be taller than
    # the box it was put in, which is how a cabinet gets clipped.
    assert re.search(r"height: budget", text), "each machine is told the height it may use"
    overlay = _code_only((SRC / "19-jackpot-overlay.js").read_text(encoding="utf-8"))
    layer = _code_only((SRC / "19-jackpot2-layer.js").read_text(encoding="utf-8"))
    assert "overchatFitScale(natural, width, overchatScale, height)" in overlay, (
        "the cabinet's fit honours the height it was given"
    )
    assert "overchatFitScale(JP2L_SIZE, width, jp2LClampSize(size), height)" in layer, (
        "and so does Jackpot v2's"
    )


def test_both_switches_are_off_by_default():
    """The defaults are read, not assumed: a fresh install, an empty store, a store that answers with
    nothing and a store that throws all have to leave both machines off."""
    machine = _code_only((SRC / "18-slot-machine.js").read_text(encoding="utf-8"))
    layer = _code_only((SRC / "19-jackpot2-layer.js").read_text(encoding="utf-8"))
    # The cabinet's own switch: only the stored '1' is on, and a storage error reads as off.
    assert "window.localStorage.getItem(SM_OVERCHAT_KEY) === '1'" in machine, (
        "the cabinet's switch is on only when the store says '1'"
    )
    assert re.search(r"function SM_readOverchat\(\) \{\s*try \{", machine), "and a store that throws is handled"
    assert "catch {\n    return false\n  }" in machine, "a storage error reads as off"
    # Jackpot v2's: the stored value defaults to false and is coerced, never trusted raw.
    assert "const JP2L_STORE = {\n  ctx: null,\n  overchat: false," in layer, "the v2 store starts off"
    assert "jp2LStored(ctx, JP2L_OVERCHAT_KEY, false)" in layer, "and its stored default is false"


def test_the_fixed_stage_is_drawn_from_the_status_bar_not_the_composer_dock():
    """The Desktop centres its composer dock with a CSS transform (`-translate-x-1/2`), and a transform
    traps a fixed child: a stage drawn from the composer slot always landed under the composer (owner's
    screenshot, 2026-11-14). The stage is drawn from a status-bar item instead; the slot keeps the anchor."""
    text = _code_only(SLOT.read_text(encoding="utf-8"))
    strip = text[text.index("function OverChatStrip("):text.index("function OverChatStage(")]
    stage = text[text.index("function OverChatStage("):]
    assert "position: 'fixed'" not in strip, "the composer slot must not draw the fixed stage: the dock traps it"
    assert "position: 'fixed'" in stage, "the status-bar stage draws the fixed box"
    plugin = _code_only((SRC / "80-plugin.js").read_text(encoding="utf-8"))
    entry = plugin[plugin.index("id: 'overchat-stage'"):][:200]
    assert "area: STATUSBAR_AREAS.right" in entry, "the stage is a status-bar contribution"
    assert "OverChatStage" in entry, "and it renders the stage"


def test_a_window_without_a_status_bar_still_draws_the_machines_at_the_top():
    """Simple mode rests the Desktop's status bar hidden (store/statusbar-prefs.ts), so the status-bar stage
    never mounts and the machines fell back under the composer - "make sure the overlay for the slots is at
    the top not the bottom" (owner, 2026-11-15). A stand-in stage lives in the titlebar's right cluster, which
    the main window always draws; it draws only while the status-bar stage cannot, so there is one copy."""
    plugin = _code_only((SRC / "80-plugin.js").read_text(encoding="utf-8"))
    entry = plugin[plugin.index("id: 'overchat-stage-titlebar'"):][:300]
    assert "area: TITLEBAR_AREAS.right" in entry, "the stand-in is a titlebar contribution"
    assert "jsx(OverChatStage, { ctx, where: 'titlebar' })" in entry, "and it renders the stage as the titlebar one"
    status = plugin[plugin.index("id: 'overchat-stage',"):][:300]
    assert "where: 'statusbar'" in status, "the status-bar stage names itself"
    text = _code_only(SLOT.read_text(encoding="utf-8"))
    assert "const OVERCHAT_STAGE_ORDER = ['statusbar', 'titlebar']" in text, \
        "the status bar draws first: the titlebar cluster sits above the app's dialogs"
    stage = text[text.index("function OverChatStage("):]
    assert "overchatStageTurn(where)" in stage, "a stage draws only on its turn, so never two copies"
    assert "OVERCHAT_SPOT.drawer === where" in stage, "only the drawing stage may clear the shared 'top'"
    header = (SRC / "00-header.js").read_text(encoding="utf-8")
    assert "TITLEBAR_AREAS" in header, "the titlebar area comes from the SDK, not a hand-typed string"
