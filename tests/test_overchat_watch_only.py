"""Over the chat the slot machines are to watch: only the X and the sound switch take a click (owner, 2026-11-22)."""
import pathlib
import re

SRC = pathlib.Path(__file__).resolve().parents[1] / "desktop" / "src"


def test_x_and_sound_opt_back_in_over_the_chat():
    slot = (SRC / "78-overchat-slot.js").read_text(encoding="utf-8")
    names = re.search(r"const OVERCHAT_CLICKABLE = \[([^\]]*)\]", slot)
    assert names, "the backdrop names the controls that still take a click"
    assert sorted(re.findall(r"'([^']+)'", names.group(1))) == [
        "data-jp2-close", "data-jp2-sound", "data-sm-close", "data-sm-sound"]
    assert "${OVERCHAT_NO_CLICKS}\\n${OVERCHAT_CLICKABLE}" in slot, "the exception comes after the block"


def test_the_classic_machine_x_and_sound_carry_their_names():
    machine = (SRC / "18-slot-machine.js").read_text(encoding="utf-8")
    assert "'data-sm-close': '1'" in machine
    assert "'data-sm-sound': soundOn ? 'on' : 'off'" in machine
    assert "chat ? soundButton : null" in machine
