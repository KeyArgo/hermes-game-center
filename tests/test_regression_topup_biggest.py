"""A fresh stack is not a win. topup was paying through credit(), which records biggest."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.wallet import MIN_BET, START_CHIPS, Wallet, wallet_path  # noqa: E402


def test_a_refill_does_not_become_the_biggest_payout(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    wallet.record_spin({"payout": 40, "machine": "fruit9", "at": 1})
    held = wallet.read()
    assert held["biggest"] == 40
    wallet.debit(held["chips"] - 10)
    assert wallet.read()["chips"] == 10

    given = wallet.topup(MIN_BET)
    assert given == START_CHIPS - 10
    after = wallet.read()
    assert after["chips"] == START_CHIPS
    assert after["biggest"] == 40
