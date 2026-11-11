"""Winning a game is worth 100 bonus points; a draw is not a win.

Bonus points are the second currency the person asked for (2026-11-09): not chips, earned
by winning and by spending tokens, converting at 75% either way. These pin the award —
once per finished game, never for a draw, and never as chips.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def wallet_module():
    spec = importlib.util.spec_from_file_location("wallet_bonus_test", REPO / "shelf" / "wallet.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fresh_wallet():
    wallets = wallet_module()
    return wallets, wallets.Wallet(Path(tempfile.mkdtemp()) / "wallet.json")


def test_a_win_credits_one_hundred_bonus_points():
    wallets, wallet = fresh_wallet()
    assert int(wallet.read()["bonus"]) == 0

    wallet.award_bonus(100)

    assert int(wallet.read()["bonus"]) == 100
    assert int(wallet.read()["chips"]) == wallets.START_CHIPS, "bonus points are not chips"


def test_repeated_awards_accumulate():
    _wallets, wallet = fresh_wallet()
    for _ in range(3):
        wallet.award_bonus(100)
    assert int(wallet.read()["bonus"]) == 300


def test_a_nonsense_award_changes_nothing():
    _wallets, wallet = fresh_wallet()
    for bad in (0, -50, "many", None):
        wallet.award_bonus(bad)
    assert int(wallet.read()["bonus"]) == 0


def test_a_won_table_calls_the_bonus_sink_once_and_a_draw_never_does():
    sys.path.insert(0, str(REPO))
    import kit

    calls = []
    kit.set_bonus_sink(lambda state: calls.append(state.get("winner")))
    try:
        won = {"status": "win", "winner": "white", "score": {"white": 0, "black": 0, "draws": 0}}
        drawn = {"status": "draw", "winner": "", "score": {"white": 0, "black": 0, "draws": 0}}

        table = kit.Table.__new__(kit.Table)  # _score touches only the state it is given
        table._score(won)
        table._score(won)
        table._score(drawn)

        assert calls == ["white"], f"one award per won game, none for a draw: {calls}"
        assert won["score"]["white"] == 1 and won["result_recorded"] is True
        assert drawn["score"]["draws"] == 1
    finally:
        kit.set_bonus_sink(None)
