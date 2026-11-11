"""Regression: a Jackpot pull must create the player's chip row (A51 bug hunt).

In production (``online/server.py`` ``handle``), a player earns a pull and the
server calls ``self.ledger.record_pull(...)`` **without** ever calling
``init_player`` first -- players are never seeded with a starting chip row on
the online path. ``record_pull`` then did::

    current = self.get_balance(player_id)        # 0 when no row exists
    self.db.execute("UPDATE chips SET ... WHERE player = ?", ...)

The ``UPDATE`` matches zero rows, so no ``chips`` row is ever written. Because
``get_leaderboard`` selects ``FROM chips``, the Jackpot leaderboard is
permanently empty no matter how many pulls are recorded.

The fix ensures the chip row exists before the balance update.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.jackpot import Ledger  # noqa: E402


class _MemDB:
    """Minimal sqlite wrapper matching what Ledger expects (row factory, execute)."""

    def __init__(self):
        import sqlite3

        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row

    def execute(self, sql, params=()):
        return self.conn.execute(sql, params)


def test_pull_without_init_creates_chip_row_and_shows_on_leaderboard():
    ledger = Ledger(_MemDB())
    # Production path: NO init_player call before the first pull.
    ledger.record_pull("solo", "seed", "AAA", 250)

    assert ledger.get_balance("solo") == 250, "pull payout was lost -- no chip row written"

    board = ledger.get_leaderboard()
    players = [row["player"] for row in board]
    assert "solo" in players, f"player missing from jackpot leaderboard: {board}"
