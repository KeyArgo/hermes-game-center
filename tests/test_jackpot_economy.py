"""Tests for Jackpot Mode economy: earn rule, rate limits, atomicity."""
from shelf.jackpot import EarnTracker, Ledger
import sqlite3
import time


def test_earn_20_identical_calls():
    """20 identical calls should earn only 1 pull (dedup)."""
    tracker = EarnTracker("p1")
    for i in range(20):
        tracker.add_tool_call("tool_a", {"x": "1"}, success=True)
        earned, _ = tracker.complete_turn()
        if i == 0:
            assert earned == True
        else:
            assert earned == False


def test_earn_20_failed_calls():
    """20 failed calls should earn 0 pulls."""
    tracker = EarnTracker("p1")
    for i in range(20):
        tracker.add_tool_call("tool_b", {"x": str(i)}, success=False)
        earned, _ = tracker.complete_turn()
        assert earned == False


def test_rate_limit_10_per_hour():
    """More than 10 pulls in an hour should be rejected."""
    tracker = EarnTracker("p1")
    for i in range(10):
        tracker.add_tool_call(f"tool_{i}", {"x": str(i)}, success=True)
        earned, _ = tracker.complete_turn()
        assert earned == True
    tracker.add_tool_call("tool_11", {"x": "11"}, success=True)
    earned, _ = tracker.complete_turn()
    assert earned == False


def test_ledger_no_negative_balance():
    """Bet refusing when balance < bet prevents negatives."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    ledger = Ledger(db)
    ledger.init_player("p1", 30)
    success, _ = ledger.deduct_bet("p1", 50)
    assert success == False
    assert ledger.get_balance("p1") == 30


def test_ledger_atomic_deduct():
    """Successful bet deduction updates balance atomically."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    ledger = Ledger(db)
    ledger.init_player("p1", 100)
    success, _ = ledger.deduct_bet("p1", 40)
    assert success == True
    assert ledger.get_balance("p1") == 60
