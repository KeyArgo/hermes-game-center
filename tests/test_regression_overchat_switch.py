"""The over-chat switch survives a reload, because it is stored with the other slot settings.

On/off used to live only in the app's browser storage. Every rebuild of the plugin started with a
fresh bundle, the switch came back off, and the owner reported the see-through machine as "it still
will not show on the chat screen" after a restart while the code was drawing it correctly. Opacity
and size were already kept on the shelf for the same reason; the switch was the one part left behind.

The defect these tests pin: a preference the person set has to still be true after the process that
set it is gone.
"""

from __future__ import annotations

import json
from pathlib import Path

from shelf.wallet import Wallet


def test_turning_the_over_chat_machine_on_is_stored(tmp_path: Path) -> None:
    path = tmp_path / "wallet.json"
    wallet = Wallet(path)
    wallet.set_overchat(True)

    stored = json.loads(path.read_text(encoding="utf-8"))
    assert bool(stored.get("overchat")) is True, stored


def test_turning_it_off_again_is_stored_too(tmp_path: Path) -> None:
    path = tmp_path / "wallet.json"
    wallet = Wallet(path)
    wallet.set_overchat(True)
    wallet.set_overchat(False)

    assert bool(json.loads(path.read_text(encoding="utf-8")).get("overchat")) is False


def test_the_switch_and_the_drawing_preferences_are_written_together(tmp_path: Path) -> None:
    """One call carries all three, which is what the browser sends on every change."""
    path = tmp_path / "wallet.json"
    wallet = Wallet(path)
    wallet.set_overchat(True, 0.25, 1.5)

    held = wallet.set_overchat(None, None, None)
    assert bool(held["overchat"]) is True
    assert held["overchat_alpha"] == 0.25
    assert held["overchat_scale"] == 1.5


def test_a_fresh_wallet_starts_with_the_copy_off(tmp_path: Path) -> None:
    """A see-through machine nobody asked for must not appear on its own."""
    held = Wallet(tmp_path / "wallet.json").set_overchat(None, None, None)
    assert bool(held["overchat"]) is False
