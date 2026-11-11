"""Two rescue taps at once must not both pay. The broke and cooldown checks lived outside the lock."""

from __future__ import annotations

import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from shelf.wallet import Wallet, wallet_path  # noqa: E402

DAY = 86_400


def test_two_bailouts_at_once_pay_once(tmp_path: Path) -> None:
    wallet = Wallet(wallet_path(tmp_path))
    with wallet._held() as data:
        data["chips"] = 10
    barrier = threading.Barrier(2)
    original = wallet.read
    racers: set[threading.Thread] = set()

    def paused_read():
        data = original()
        if threading.current_thread() in racers:
            barrier.wait(timeout=2)
        return data

    wallet.read = paused_read  # type: ignore[method-assign]
    results: list[dict] = []
    errors: list[BaseException] = []

    def go() -> None:
        try:
            results.append(wallet.bailout("perfect", now=DAY * 20_000))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=go) for _ in range(2)]
    racers.update(threads)
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)

    assert not errors, errors
    assert all(not thread.is_alive() for thread in threads)
    assert sorted(row["given"] for row in results) == [0, 4000]
    assert original()["chips"] == 10 + 4000
