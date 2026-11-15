"""The copy over the chat is called a backdrop, in every word a person reads.

The owner asked for the slot machine's wording to be fixed: "Show over chat", "Over-chat opacity",
"Jackpot over chat: …" and "Close Slots over chat" became **Show as backdrop**, **Backdrop opacity**,
**Backdrop size**, **Jackpot backdrop: …** and **Close backdrop**, and the cabinet's auto-spin switch
is **Inference Auto Play (spin when Hermes thinks)**.

Only the words changed. Every storage key, data attribute and contribution id is exactly what it was,
so the switch a person already set is still read and nothing needs a migration — that is the second
test here, because a rename that quietly resets a stored choice is worse than the old wording.

``tests/inference_autoplay_harness.cjs`` presses the button; this module is the words.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "desktop" / "src"

# The labels a person used to read. None of them may come back: two names for one switch is how a
# person ends up with a setting they cannot find.
OLD_WORDS = (
    "Show over chat",
    "Over-chat opacity",
    "Over-chat size",
    "Jackpot over chat:",
    "Close Slots over chat",
    "Auto-spin on every message",
)

# And the backdrop wording that replaced them. (The button's own Start/Stop labels belong to the
# button, and are read off it by tests/inference_autoplay_harness.cjs.)
NEW_WORDS = (
    "Show as backdrop",
    "Backdrop opacity",
    "Backdrop size",
    "Jackpot backdrop:",
    "Close backdrop",
    "Inference Auto Play (spin when Hermes thinks)",
)


def _source_files() -> list[Path]:
    return sorted(SRC.glob("*.js"))


def test_no_old_wording_survives_in_the_parts():
    offenders = []
    for path in _source_files():
        text = path.read_text(encoding="utf-8")
        for old in OLD_WORDS:
            if old in text:
                offenders.append(f"{path.name}: {old!r}")
    assert not offenders, "the old over-chat wording is still on screen: " + "; ".join(offenders)


def test_the_new_wording_is_the_one_on_screen():
    """Renaming a label is only half a rename: the replacement must actually be drawn."""
    text = "\n".join(path.read_text(encoding="utf-8") for path in _source_files())
    missing = [word for word in NEW_WORDS if word not in text]
    assert not missing, f"these labels are not drawn anywhere in desktop/src: {missing}"


def test_the_stored_keys_are_untouched():
    """No storage migration: the switch a person already set must still be read."""
    overlay = (SRC / "18-slot-machine.js").read_text(encoding="utf-8")
    layer = (SRC / "19-jackpot2-layer.js").read_text(encoding="utf-8")
    assert "'gameshelf.slots.overchat'" in overlay, "the cabinet's switch keeps its stored key"
    assert "'gameshelf.slots.overchat_alpha'" in overlay, "and its opacity"
    assert "'gameshelf.slots.scale'" in overlay, "and its size"
    assert "'jackpot2.overchat'" in layer, "and Jackpot v2 keeps its own"
    assert "'jackpot2.size'" in layer and "'jackpot2.alpha'" in layer, "with its own size and opacity"
