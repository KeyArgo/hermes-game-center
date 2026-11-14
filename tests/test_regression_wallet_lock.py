"""The wallet is one file behind one lock: no double payout, no unbounded wait.

Two defects this pins:
- `topup()` read the balance without the lock and then credited the gap, so two
  top-ups could both see an empty wallet and both deal a fresh stack.
- every change waited on `flock(LOCK_EX)` with no deadline, so a live process
  holding the lock wedged every bet and payout in the plugin, with no error.
"""
from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest

# Windows has no advisory file locks, and the wallet is written to say so: `shelf/wallet.py` imports fcntl
# behind a guard and simply proceeds unlocked there (pinned by tests/test_windows_import.py). This module
# proves the LOCK works, so it needs a platform that has one — skips with that reason instead of failing
# to import.
fcntl = pytest.importorskip("fcntl", reason="advisory file locks are POSIX-only; the wallet is guarded")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf import wallet as wallet_module  # noqa: E402
from shelf.wallet import Wallet  # noqa: E402


def _broke(tmp_path: Path) -> Wallet:
    path = tmp_path / "wallet.json"
    path.write_text(json.dumps({"chips": 0}), encoding="utf-8")
    return Wallet(path)


def test_a_stale_read_does_not_deal_two_fresh_stacks(tmp_path: Path, monkeypatch) -> None:
    held = _broke(tmp_path)
    # The unlocked snapshot `topup` used to trust: always says the wallet is empty.
    monkeypatch.setattr(Wallet, "read", lambda self: {"chips": 0})
    held.topup(wallet_module.MIN_BET)
    held.topup(wallet_module.MIN_BET)
    on_disk = json.loads((tmp_path / "wallet.json").read_text(encoding="utf-8"))
    assert on_disk["chips"] == wallet_module.START_CHIPS, "topup paid twice from one stale read"


def test_a_wallet_below_the_floor_still_gets_one_fresh_stack(tmp_path: Path) -> None:
    held = _broke(tmp_path)
    assert held.topup(wallet_module.MIN_BET) == wallet_module.START_CHIPS
    assert held.topup(wallet_module.MIN_BET) == 0


def test_a_held_lock_times_out_instead_of_hanging(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(wallet_module, "LOCK_TIMEOUT_SECONDS", 0.2)
    held = Wallet(tmp_path / "wallet.json")
    holder = open(tmp_path / "wallet.lock", "a+", encoding="utf-8")
    fcntl.flock(holder, fcntl.LOCK_EX)
    seen: dict[str, str] = {}

    def call() -> None:
        try:
            held.debit(25)
        except TimeoutError as exc:
            seen["error"] = str(exc)

    thread = threading.Thread(target=call, daemon=True)
    thread.start()
    thread.join(5)
    fcntl.flock(holder, fcntl.LOCK_UN)
    holder.close()
    assert not thread.is_alive(), "the wallet waited forever on a lock another process held"
    assert "wallet" in seen.get("error", "").lower(), seen
