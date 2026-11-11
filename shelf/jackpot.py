"""Jackpot Mode: Earn rule, pull tracking, and economy.

A pull is earned when:
- A turn completed with ≥1 successful tool call
- The tool+args hash is new in the session (no repeat farming)
- <10 pulls earned in the last hour
"""
import hashlib
import time
from typing import Dict, Optional, Tuple


class EarnTracker:
    """Track pulls earned in a session, enforce rate limits and dedup."""

    def __init__(self, player_id: str):
        self.player_id = player_id
        self.session_start = time.time()
        self.pulls_earned = []  # List of (timestamp, pull_id)
        self.seen_hashes = set()  # Tool+args hashes seen in session
        self.tool_calls_this_turn = []  # Calls in current turn

    def add_tool_call(self, tool_name: str, args: Dict, success: bool) -> None:
        """Record a tool call."""
        if success:
            # Hash tool name + args to detect repeats
            arg_str = str(sorted(args.items()))
            call_hash = hashlib.sha256(f"{tool_name}{arg_str}".encode()).hexdigest()
            self.tool_calls_this_turn.append((tool_name, call_hash, success))

    def complete_turn(self) -> Tuple[bool, Optional[str]]:
        """
        Call at end of turn. Returns (earned_pull, pull_id).

        A pull is earned if:
        - ≥1 successful tool call in turn
        - ≥1 new (unseen) tool+args hash
        - <10 pulls in last hour
        """
        if not self.tool_calls_this_turn:
            self.tool_calls_this_turn = []
            return (False, None)

        # Check if any call is new (not in session history)
        new_call = False
        for tool_name, call_hash, success in self.tool_calls_this_turn:
            if success and call_hash not in self.seen_hashes:
                new_call = True
                self.seen_hashes.add(call_hash)

        self.tool_calls_this_turn = []

        if not new_call:
            return (False, None)

        # Check rate limit: <10 pulls in last hour
        now = time.time()
        one_hour_ago = now - 3600
        recent_pulls = [ts for ts, _ in self.pulls_earned if ts > one_hour_ago]

        if len(recent_pulls) >= 10:
            return (False, None)

        # Grant pull
        import secrets
        pull_id = secrets.token_hex(8)
        self.pulls_earned.append((now, pull_id))

        return (True, pull_id)

    def get_pulls_available(self) -> int:
        """Return number of unspent pulls."""
        # In simple MVP, pulls are spent immediately on spin.
        # Return earned - spent (simplified: always 1 or 0)
        now = time.time()
        recent = sum(1 for ts, _ in self.pulls_earned if ts > now - 3600)
        return min(1, max(0, 10 - recent))  # 0 or 1 based on hour limit

    def get_hour_pulls(self) -> int:
        """Pulls earned in last hour."""
        now = time.time()
        one_hour_ago = now - 3600
        return sum(1 for ts, _ in self.pulls_earned if ts > one_hour_ago)


class Ledger:
    """Atomic chip ledger with no negatives."""

    def __init__(self, db):
        self.db = db
        self._init_tables()

    def _init_tables(self):
        """Create chips and pulls tables if not exist."""
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS chips (
                player TEXT PRIMARY KEY,
                balance INTEGER NOT NULL DEFAULT 0,
                won INTEGER NOT NULL DEFAULT 0,
                lost INTEGER NOT NULL DEFAULT 0,
                updated REAL NOT NULL
            )
        """)
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS pulls (
                id TEXT PRIMARY KEY,
                player TEXT NOT NULL,
                seed TEXT NOT NULL,
                reels TEXT NOT NULL,
                payout INTEGER NOT NULL,
                ts REAL NOT NULL
            )
        """)

    def get_balance(self, player_id: str) -> int:
        """Get player's chip balance."""
        row = self.db.execute(
            "SELECT balance FROM chips WHERE player = ?",
            (player_id,)
        ).fetchone()
        return row[0] if row else 0

    def init_player(self, player_id: str, initial_balance: int = 100) -> None:
        """Initialize player with starting balance (idempotent)."""
        now = time.time()
        self.db.execute(
            "INSERT OR IGNORE INTO chips (player, balance, won, lost, updated) VALUES (?, ?, ?, ?, ?)",
            (player_id, initial_balance, 0, 0, now)
        )

    def record_pull(self, player_id: str, seed: str, reels: str, payout: int) -> None:
        """Record a pull and update balance."""
        import secrets
        now = time.time()
        pull_id = secrets.token_hex(8)

        # Record pull
        self.db.execute(
            "INSERT INTO pulls (id, player, seed, reels, payout, ts) VALUES (?, ?, ?, ?, ?, ?)",
            (pull_id, player_id, seed, reels, payout, now)
        )

        # Ensure the player's chip row exists. The online path never calls
        # init_player, so without this the UPDATE below would match zero rows,
        # the payout would be lost, and the player would never appear on the
        # jackpot leaderboard (which selects FROM chips).
        self.db.execute(
            "INSERT OR IGNORE INTO chips (player, balance, won, lost, updated) VALUES (?, 0, 0, 0, ?)",
            (player_id, now)
        )

        # Update balance and won
        current = self.get_balance(player_id)
        new_balance = current + payout
        self.db.execute(
            "UPDATE chips SET balance = ?, won = won + ?, updated = ? WHERE player = ?",
            (new_balance, payout, now, player_id)
        )

    def deduct_bet(self, player_id: str, bet_amount: int) -> Tuple[bool, str]:
        """Deduct a bet from balance. Returns (success, reason)."""
        now = time.time()
        try:
            current = self.get_balance(player_id)
            if current < bet_amount:
                return (False, f"Balance {current} < bet {bet_amount}")

            new_balance = current - bet_amount
            self.db.execute(
                "UPDATE chips SET balance = ?, updated = ? WHERE player = ?",
                (new_balance, now, player_id)
            )
            return (True, "")
        except Exception as e:
            return (False, str(e))

    def add_winnings(self, player_id: str, amount: int) -> None:
        """Add winnings to balance."""
        now = time.time()
        current = self.get_balance(player_id)
        new_balance = current + amount
        self.db.execute(
            "UPDATE chips SET balance = ?, won = won + ?, updated = ? WHERE player = ?",
            (new_balance, amount, now, player_id)
        )

    def record_loss(self, player_id: str, amount: int) -> None:
        """Record a loss (already deducted from balance)."""
        now = time.time()
        self.db.execute(
            "UPDATE chips SET lost = lost + ?, updated = ? WHERE player = ?",
            (amount, now, player_id)
        )

    def get_leaderboard(self, limit: int = 50) -> list:
        """Get leaderboard: rank by net (won - lost), show pulls."""
        rows = self.db.execute("""
            SELECT player, balance, won, lost, (won - lost) as net,
                   (SELECT COUNT(*) FROM pulls WHERE player = chips.player) as pulls
            FROM chips
            WHERE (SELECT COUNT(*) FROM pulls WHERE player = chips.player) > 0
            ORDER BY net DESC, won DESC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(row) for row in rows]
