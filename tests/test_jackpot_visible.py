"""POST /jackpot/visible records that a machine is on screen and returns.

The route used to build the whole jackpot payload on every ping. That reads the spin
log and, on a cold cache, solves every machine's reels. A visibility ping does not
need any of that. A cold solve still happens somewhere — the first spin, the first
payload — and concurrent callers must not each run it.
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_visible_does_not_rebuild_the_jackpot(tmp_path, monkeypatch) -> None:
    from dashboard import plugin_api
    from shelf.wallet import Wallet, wallet_path

    monkeypatch.setattr(plugin_api, "_jackpot_wallet", lambda: Wallet(wallet_path(tmp_path)))

    def boom(*_args, **_kwargs):
        raise AssertionError("visible rebuilt the jackpot payload")

    monkeypatch.setattr(plugin_api, "_jackpot_payload", boom)
    answer = plugin_api.jackpot_visible({"on": True, "source": "jackpot2", "session_id": "chat-1"})
    assert answer == {"ok": True}
    held = Wallet(wallet_path(tmp_path)).read()
    assert held["visible_sources"]["jackpot2"] is True
    assert held["focus_session"] == "chat-1"


def test_concurrent_cold_loads_execute_once(tmp_path: Path) -> None:
    """A cold load_fresh is one execution. The others wait and reuse that module."""
    from shelf import fresh

    counter = tmp_path / "count.txt"
    counter.write_text("0", encoding="utf-8")
    path = tmp_path / "once.py"
    path.write_text(
        "import time\n"
        "from pathlib import Path\n"
        f"p = Path({str(counter)!r})\n"
        "n = int(p.read_text() or '0') + 1\n"
        "p.write_text(str(n))\n"
        "time.sleep(0.2)\n"
        "VALUE = n\n",
        encoding="utf-8",
    )
    name = "gameshelf_cold_once_under_test"
    sys.modules.pop(name, None)
    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(5)

    def work() -> None:
        try:
            barrier.wait(timeout=2)
            results.append(fresh.load_fresh(name, path).VALUE)
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    sys.modules.pop(name, None)
    assert errors == []
    assert counter.read_text(encoding="utf-8") == "1"
    assert results == [1, 1, 1, 1, 1]


def test_concurrent_cold_variants_compute_once(monkeypatch) -> None:
    """A cold reels.variant is one solve. Waiters reuse it instead of solving again."""
    from shelf import reels

    calls: list[str] = []

    def dilutions(spec_id, _target, _pays):
        calls.append(spec_id)
        time.sleep(0.2)
        return (0, 0, 0), {"hit": 0.5}

    def solved(_spec_id, _blanks, _spec):
        return {
            "pays": {"x": 1}, "jackpot_pay": 10, "floor_pay": 5,
            "everyday_rtp": 1.0, "top_pay": 10, "jackpot_is_top": True, "scale": 1.0,
        }

    def measure(_spec_id, _blanks, _pays):
        return {"hit": 0.51, "rtp": 1.1, "combos": 1, "lines": 1}

    monkeypatch.setattr(reels, "_dilutions", dilutions)
    monkeypatch.setattr(reels, "_solved_pays", solved)
    monkeypatch.setattr(reels, "measure", measure)
    reels.variant.cache_clear()
    errors: list[BaseException] = []
    barrier = threading.Barrier(6)

    def work() -> None:
        try:
            barrier.wait(timeout=2)
            reels.variant("fruit9")
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(6)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        assert errors == []
        assert calls == ["fruit9"]
    finally:
        reels.variant.cache_clear()
