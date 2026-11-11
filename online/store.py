"""SQLite records for Game Center Online: players, rooms, invites, chat, matches, ratings.

Board state itself stays in each room's state.json, written by kit.Table. This file only
holds what the referee does not: who people are, which rooms exist, and finished results.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from pathlib import Path

try:  # store is also imported by small scripts that put the shelf root first
    from . import guard
except ImportError:  # pragma: no cover
    import guard  # type: ignore

SCHEMA = """
CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 0,
    created REAL NOT NULL,
    seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    host_id TEXT NOT NULL,
    public INTEGER NOT NULL DEFAULT 0,
    created REAL NOT NULL,
    active REAL NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    matches INTEGER NOT NULL DEFAULT 0,
    ladder INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    side TEXT NOT NULL,
    created REAL NOT NULL,
    used_by TEXT,
    used_at REAL
);
CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_room ON chat (room_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS players_name ON players (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS moderation (
    room_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    action TEXT NOT NULL,
    PRIMARY KEY (room_id, player_id, action)
);
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    match_no INTEGER NOT NULL,
    game TEXT NOT NULL,
    white_id TEXT NOT NULL,
    black_id TEXT NOT NULL,
    white_name TEXT NOT NULL,
    black_name TEXT NOT NULL,
    white_kind TEXT NOT NULL,
    black_kind TEXT NOT NULL,
    winner TEXT NOT NULL,
    reason TEXT NOT NULL,
    plies INTEGER NOT NULL,
    moves TEXT NOT NULL,
    rated INTEGER NOT NULL,
    finished REAL NOT NULL,
    UNIQUE (room_id, match_no)
);
CREATE TABLE IF NOT EXISTS ratings (
    player_id TEXT NOT NULL,
    game TEXT NOT NULL,
    rating REAL NOT NULL,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, game)
);
CREATE TABLE IF NOT EXISTS bot_records (
    player_id TEXT NOT NULL,
    game TEXT NOT NULL,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, game)
);
CREATE TABLE IF NOT EXISTS old_names (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    player_id TEXT NOT NULL,
    until REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_prefs (player_id TEXT NOT NULL, game TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL, PRIMARY KEY (player_id, game));
CREATE TABLE IF NOT EXISTS alert_sent (player_id TEXT NOT NULL, game TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (player_id, game));
CREATE TABLE IF NOT EXISTS bot_ratings (player_id TEXT NOT NULL, game TEXT NOT NULL, rating REAL NOT NULL, games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (player_id, game));
CREATE TABLE IF NOT EXISTS rating_history (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, game TEXT NOT NULL, rating REAL NOT NULL, match_no INTEGER NOT NULL, room_id TEXT NOT NULL, at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS rating_history_bot ON rating_history (player_id, id);
CREATE TABLE IF NOT EXISTS arcade_removals (
    tile_id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    created REAL NOT NULL,
    proven INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairs (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    seed INTEGER NOT NULL,
    room_a TEXT NOT NULL,
    room_b TEXT NOT NULL,
    one_id TEXT NOT NULL,
    two_id TEXT NOT NULL,
    created REAL NOT NULL,
    finished REAL NOT NULL DEFAULT 0,
    score_one INTEGER NOT NULL DEFAULT 0,
    score_two INTEGER NOT NULL DEFAULT 0,
    legs_done INTEGER NOT NULL DEFAULT 0,
    leg_a_done INTEGER NOT NULL DEFAULT 0,
    leg_b_done INTEGER NOT NULL DEFAULT 0,
    rated INTEGER NOT NULL DEFAULT 0,
    winner TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS pairs_rooms ON pairs (room_a, room_b);
CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    game TEXT NOT NULL,
    challenger_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    invite TEXT NOT NULL,
    created REAL NOT NULL,
    expires REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS challenges_bot ON challenges (bot_id, state);
CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    game TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    created REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_owner ON cards (owner_id, game);
CREATE TABLE IF NOT EXISTS bouts (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    seed INTEGER NOT NULL,
    one_card TEXT NOT NULL,
    two_card TEXT NOT NULL,
    one_owner TEXT NOT NULL,
    two_owner TEXT NOT NULL,
    winner TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    plies INTEGER NOT NULL DEFAULT 0,
    rated INTEGER NOT NULL DEFAULT 0,
    replay TEXT NOT NULL DEFAULT '',
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS card_ratings (
    card_id TEXT NOT NULL,
    game TEXT NOT NULL,
    rating REAL NOT NULL,
    games INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (card_id, game)
);
CREATE TABLE IF NOT EXISTS inference_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    inference_cost REAL,
    reel1 TEXT,
    reel2 TEXT,
    reel3 TEXT,
    multiplier REAL,
    winnings REAL,
    created_at REAL NOT NULL,
    FOREIGN KEY(user_id) REFERENCES players(id)
);
CREATE INDEX IF NOT EXISTS idx_slots_user ON inference_slots(user_id, created_at);
CREATE TABLE IF NOT EXISTS balances (
    player_id TEXT PRIMARY KEY,
    chips INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS balance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    chips INTEGER NOT NULL,
    points INTEGER NOT NULL,
    at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS balance_log_player ON balance_log (player_id, id);
"""

# Columns added after the first release; created on old databases at startup.
LATER_COLUMNS = (
    ("players", "name_key", "TEXT NOT NULL DEFAULT ''"),
    ("players", "suspended_until", "REAL NOT NULL DEFAULT 0"),
    ("players", "suspended_reason", "TEXT NOT NULL DEFAULT ''"),
    ("chat", "bot", "INTEGER NOT NULL DEFAULT 0"),
    ("chat", "staff", "TEXT NOT NULL DEFAULT ''"),
    ("chat", "removed", "INTEGER NOT NULL DEFAULT 0"),
    ("chat", "removed_by", "TEXT NOT NULL DEFAULT ''"),
    ("chat", "removed_at", "REAL NOT NULL DEFAULT 0"),
    ("players", "addr_hash", "TEXT NOT NULL DEFAULT ''"),
    ("players", "bot", "INTEGER NOT NULL DEFAULT 0"),
    ("players", "owner_id", "TEXT NOT NULL DEFAULT ''"),
    ("players", "suspended", "INTEGER NOT NULL DEFAULT 0"),
    ("rooms", "bots_ok", "INTEGER NOT NULL DEFAULT 0"),
    ("rooms", "ladder", "INTEGER NOT NULL DEFAULT 0"),
    ("players", "renamed", "REAL NOT NULL DEFAULT 0"),
    ("rooms", "pair_id", "TEXT NOT NULL DEFAULT ''"),
    ("rooms", "pair_leg", "INTEGER NOT NULL DEFAULT 0"),
    ("rooms", "seed", "INTEGER NOT NULL DEFAULT 0"),
    ("rooms", "open_league", "INTEGER NOT NULL DEFAULT 0"),
)
# Columns on the tables the second script creates, added after the first release of
# that script; applied once those tables exist, old database or new.
LATE_COLUMNS = (
    # Appear offline (invisible): the account is not in anyone else's roster and takes no
    # requests. Saved per account, not per connection, so a reload does not reveal them.
    ("availability", "invisible", "INTEGER NOT NULL DEFAULT 0"),
    # A match offer is a request neither side asked for: find match made it, and either
    # person may join it. The flag is what lets the other side answer it.
    ("play_requests", "offer", "INTEGER NOT NULL DEFAULT 0"),
)
BOTS_PER_OWNER = 3
PLAYER_COLUMNS = "id, name, public, created, bot, owner_id, renamed"
# A name sticks: one rename per RENAME_DAYS, and the old name stays held for its owner as long.
RENAME_DAYS = 30
OLD_NAME_DAYS = 30

START_RATING = 1200.0
K_FACTOR = 32.0
# Two accounts can farm each other; only the first few games a day between the same pair count.
PAIR_RATED_PER_DAY = 3


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_id(prefix: str = "", nbytes: int = 9) -> str:
    return prefix + secrets.token_urlsafe(nbytes).replace("-", "x").replace("_", "y")


def expected(rating: float, other: float) -> float:
    return 1.0 / (1.0 + 10 ** ((other - rating) / 400.0))


class Store:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        for table, column, kind in LATER_COLUMNS:
            have = {row[1] for row in self.db.execute(f"PRAGMA table_info({table})")}
            if column not in have:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")

        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS staff (player_id TEXT PRIMARY KEY, role TEXT NOT NULL, key_hash TEXT NOT NULL, created REAL NOT NULL, created_by TEXT NOT NULL DEFAULT '');
        CREATE UNIQUE INDEX IF NOT EXISTS staff_one_owner ON staff(role) WHERE role = 'owner';
        CREATE TABLE IF NOT EXISTS punishments (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, kind TEXT NOT NULL, until REAL NOT NULL, reason TEXT NOT NULL DEFAULT '', by_id TEXT NOT NULL, by_name TEXT NOT NULL, at REAL NOT NULL, lifted REAL NOT NULL DEFAULT 0, lifted_by TEXT NOT NULL DEFAULT '');
        CREATE INDEX IF NOT EXISTS punishments_player ON punishments(player_id, lifted);
        CREATE TABLE IF NOT EXISTS address_blocks (hash TEXT PRIMARY KEY, until REAL NOT NULL, reason TEXT NOT NULL DEFAULT '', at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT NOT NULL, message_id INTEGER NOT NULL DEFAULT 0, room_id TEXT NOT NULL DEFAULT '', reporter_id TEXT NOT NULL, reporter_name TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', at REAL NOT NULL, state TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '', handled_by TEXT NOT NULL DEFAULT '', handled_at REAL NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS reports_state ON reports(state, id);
        CREATE TABLE IF NOT EXISTS blocks (player_id TEXT NOT NULL, blocked_id TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(player_id, blocked_id));
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', target_name TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', undone INTEGER NOT NULL DEFAULT 0, undo_of INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS availability (
            player_id TEXT PRIMARY KEY,
            open INTEGER NOT NULL,
            updated REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS availability_games (
            player_id TEXT NOT NULL,
            game TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            PRIMARY KEY (player_id, game)
        );
        CREATE TABLE IF NOT EXISTS play_requests (
            id TEXT PRIMARY KEY,
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            game TEXT NOT NULL,
            state TEXT NOT NULL,
            created REAL NOT NULL,
            expires REAL NOT NULL,
            room_id TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS play_requests_from ON play_requests (from_id, created);
        CREATE INDEX IF NOT EXISTS play_requests_to ON play_requests (to_id, state);
        CREATE INDEX IF NOT EXISTS play_requests_due ON play_requests (state, expires);
        -- Find match: the games one account is actively looking for. It lasts until the person
        -- stops it or is seated, so it is kept here rather than in a socket.
        CREATE TABLE IF NOT EXISTS looking (
            player_id TEXT NOT NULL,
            game TEXT NOT NULL,
            created REAL NOT NULL,
            PRIMARY KEY (player_id, game)
        );
        """)
        for table, column, kind in LATE_COLUMNS:
            have = {row[1] for row in self.db.execute(f"PRAGMA table_info({table})")}
            if column not in have:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
        used = {r[0] for r in self.db.execute("SELECT name_key FROM players WHERE name_key != ''")}
        for row in self.db.execute("SELECT id, name FROM players WHERE name_key = '' ORDER BY rowid").fetchall():
            key = guard.skeleton(row['name'])
            if key in used:
                key = 'dup:' + row['id']
            used.add(key)
            self.db.execute("UPDATE players SET name_key = ? WHERE id = ?", (key, row['id']))
        try:
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS players_name_key ON players(name_key)")
        except sqlite3.IntegrityError:
            pass

    def staff_row(self, player_id):
        row = self.db.execute("SELECT * FROM staff WHERE player_id = ?", (player_id,)).fetchone()
        return dict(row) if row else None

    def staff_by_key_hash(self, key_hash):
        row = self.db.execute("SELECT * FROM staff WHERE key_hash = ?", (key_hash,)).fetchone()
        return dict(row) if row else None

    def set_staff(self, player_id, role, key_hash, by):
        self.db.execute("INSERT OR REPLACE INTO staff VALUES (?, ?, ?, ?, ?)", (player_id, role, key_hash, time.time(), by))

    def drop_staff(self, player_id):
        self.db.execute("DELETE FROM staff WHERE player_id = ?", (player_id,))

    def staff_list(self):
        return [dict(r) for r in self.db.execute("SELECT staff.*, players.name FROM staff JOIN players ON players.id = staff.player_id ORDER BY staff.created")]

    def staff_role(self, player_id):
        row = self.staff_row(player_id)
        return row['role'] if row else ''

    def punishment(self, player_id, kind):
        row = self.db.execute("SELECT * FROM punishments WHERE player_id = ? AND kind = ? AND lifted = 0 AND (until = 0 OR until > ?) ORDER BY id DESC LIMIT 1", (player_id, kind, time.time())).fetchone()
        return dict(row) if row else None

    def punish(self, player_id, kind, until, reason, by_id, by_name):
        cur = self.db.execute("INSERT INTO punishments(player_id, kind, until, reason, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?)", (player_id, kind, until, reason, by_id, by_name, time.time()))
        if kind == 'suspend':
            self.db.execute("UPDATE players SET suspended=1, suspended_until=?, suspended_reason=? WHERE id=?", (until, reason, player_id))
        return cur.lastrowid

    def lift_punishment(self, punishment_id, by_name):
        row = self.db.execute("SELECT player_id FROM punishments WHERE id=? AND lifted=0", (punishment_id,)).fetchone()
        if row:
            self.db.execute("UPDATE punishments SET lifted=?, lifted_by=? WHERE id=?", (time.time(), by_name, punishment_id))
            self._refresh_suspend(row['player_id'])

    def _refresh_suspend(self, player_id):
        active = self.punishment(player_id, 'suspend')
        if active:
            self.db.execute("UPDATE players SET suspended=1, suspended_until=?, suspended_reason=? WHERE id=?", (active['until'], active['reason'], player_id))
        else:
            self.db.execute("UPDATE players SET suspended=0, suspended_until=0, suspended_reason='' WHERE id=? AND token_hash NOT LIKE 'off:%'", (player_id,))

    def expire_punishments(self, now):
        rows = self.db.execute("SELECT DISTINCT player_id FROM punishments WHERE lifted=0 AND until != 0 AND until <= ?", (now,)).fetchall()
        self.db.execute("UPDATE punishments SET lifted=? WHERE lifted=0 AND until != 0 AND until <= ?", (now, now))
        for row in rows:
            self._refresh_suspend(row['player_id'])

    def silenced(self, player_id):
        return bool(self.punishment(player_id, "silence"))

    def suspended(self, player_id):
        return bool(self.punishment(player_id, "suspend"))

    def note_address(self, player_id: str, address: str) -> None:
        """Remember only a hash of where this account signs in from.

        A permanent ban can then keep new accounts off that address without the
        server ever holding a plain address.
        """
        if not player_id or not address:
            return
        self.db.execute("UPDATE players SET addr_hash = ? WHERE id = ?",
                        (token_hash("addr:" + address), player_id))

    def block_address(self, player_id: str, reason: str = "", until: float = 0.0) -> str:
        """Block new sign-ups from this account's last address, by hash only."""
        row = self.db.execute("SELECT addr_hash FROM players WHERE id = ?", (player_id,)).fetchone()
        hashed = str((row["addr_hash"] if row else "") or "")
        if not hashed:
            return ""
        self.db.execute(
            "INSERT OR REPLACE INTO address_blocks (hash, until, reason, at) VALUES (?, ?, ?, ?)",
            (hashed, until, reason[:200], time.time()))
        return hashed

    def address_blocked(self, address: str, now: float | None = None) -> bool:
        hashed = token_hash("addr:" + str(address or ""))
        return self.db.execute(
            "SELECT 1 FROM address_blocks WHERE hash = ? AND (until = 0 OR until > ?)",
            (hashed, time.time() if now is None else now)).fetchone() is not None

    def close(self) -> None:
        self.db.close()

    # Players -----------------------------------------------------------------

    def name_taken(self, name: str, except_id: str = "") -> bool:
        """Names are unique ignoring case, so nobody can pass as someone else in chat.
        A name given up in a rename stays held for its old owner for OLD_NAME_DAYS."""
        if self.db.execute(
            "SELECT 1 FROM players WHERE (name = ? COLLATE NOCASE OR name_key = ?) AND id != ?", (name, guard.skeleton(name), except_id)
        ).fetchone() is not None:
            return True
        return self.db.execute(
            "SELECT 1 FROM old_names WHERE name = ? AND player_id != ? AND until > ?", (name, except_id, time.time())
        ).fetchone() is not None

    def rename_wait(self, player: dict, now: float | None = None) -> float:
        """Seconds until this player may rename again (0 = now). The first rename is free."""
        renamed = float(player.get("renamed") or 0)
        if not renamed:
            return 0.0
        return max(0.0, renamed + RENAME_DAYS * 86400 - (time.time() if now is None else now))

    def create_player(self, name: str) -> tuple[dict, str]:
        token = secrets.token_urlsafe(32)
        now = time.time()
        player_id = new_id("web:", 12)
        self.db.execute(
            "INSERT INTO players (id, token_hash, name, public, created, seen, name_key) VALUES (?, ?, ?, 0, ?, ?, ?)",
            (player_id, token_hash(token), name, now, now, guard.skeleton(name)),
        )
        return self.player(player_id), token

    def player(self, player_id: str) -> dict | None:
        row = self.db.execute(f"SELECT {PLAYER_COLUMNS} FROM players WHERE id = ?", (player_id,)).fetchone()
        return _player(row)

    def player_by_name(self, name: str) -> dict | None:
        return _player(self.db.execute(f"SELECT {PLAYER_COLUMNS} FROM players WHERE name = ? COLLATE NOCASE AND suspended = 0", (name,)).fetchone())

    def player_by_name_any(self, name: str) -> dict | None:
        """Name lookup including suspended accounts — staff must be able to see and
        lift a ban they themselves applied."""
        return _player(self.db.execute(f"SELECT {PLAYER_COLUMNS} FROM players WHERE name = ? COLLATE NOCASE", (name,)).fetchone())

    def is_active(self, player_id: str) -> bool:
        """A real, non-suspended account (a deleted bot's key stops working)."""
        return self.db.execute(
            "SELECT 1 FROM players WHERE id = ? AND suspended = 0", (player_id,)
        ).fetchone() is not None

    def verify_secret(self, player_id: str, secret: str) -> bool:
        if not isinstance(secret, str) or len(secret) > 200:
            return False
        row = self.db.execute("SELECT token_hash FROM players WHERE id = ? AND suspended = 0", (player_id,)).fetchone()
        return bool(row and hmac.compare_digest(row[0], token_hash(secret)))

    def rating_info(self, player_id: str, game: str) -> tuple[int, int]:
        # Use whitelist to prevent SQL injection via table names
        table = "bot_ratings" if player_id.startswith("bot:") else "ratings"
        if table not in ("ratings", "bot_ratings"):
            raise ValueError(f"Invalid table: {table}")
        row = self.db.execute(f"SELECT rating, games FROM {table} WHERE player_id = ? AND game = ?", (player_id, game)).fetchone()
        return (round(row[0]), row[1]) if row else (1200, 0)

    def player_by_token(self, token: str) -> dict | None:
        if not token or len(token) > 200:
            return None
        row = self.db.execute(
            f"SELECT {PLAYER_COLUMNS} FROM players WHERE token_hash = ? AND suspended = 0", (token_hash(token),)
        ).fetchone()
        if not row:
            return None
        self.db.execute("UPDATE players SET seen = ? WHERE id = ?", (time.time(), row["id"]))
        return _player(row)

    # Bots --------------------------------------------------------------------

    def create_bot(self, owner_id: str, name: str) -> tuple[dict, str]:
        """A registered bot: its own name and secret key, tied to the person who owns it."""
        token = secrets.token_urlsafe(32)
        now = time.time()
        bot_id = new_id("bot:", 12)
        self.db.execute(
            "INSERT INTO players (id, token_hash, name, public, created, seen, bot, owner_id, name_key) VALUES (?, ?, ?, 0, ?, ?, 1, ?, ?)",
            (bot_id, token_hash(token), name, now, now, owner_id, guard.skeleton(name)),
        )
        return self.player(bot_id), token

    def bots_of(self, owner_id: str) -> list[dict]:
        rows = self.db.execute(
            f"SELECT {PLAYER_COLUMNS}, seen FROM players WHERE owner_id = ? AND bot = 1 AND suspended = 0 ORDER BY created",
            (owner_id,),
        ).fetchall()
        return [{**_player(row), "seen": row["seen"]} for row in rows]

    def remove_bot(self, owner_id: str, bot_id: str) -> bool:
        """Switch the bot off for good: its key stops working. Its finished games stay."""
        return self.db.execute(
            "UPDATE players SET suspended = 1, token_hash = ? WHERE id = ? AND owner_id = ? AND bot = 1",
            ("off:" + secrets.token_hex(16), bot_id, owner_id),
        ).rowcount == 1

    def update_player(self, player_id: str, *, name: str | None = None, public: bool | None = None) -> dict | None:
        if name is not None:
            old = self.player(player_id)
            if old and old["name"] != name:
                now = time.time()
                renamed = old["name"].lower() != name.lower()  # a change of capitals only is free
                self.db.execute("BEGIN IMMEDIATE")
                try:
                    if renamed:
                        self.db.execute("INSERT OR REPLACE INTO old_names (name, player_id, until) VALUES (?, ?, ?)",
                                        (old["name"], player_id, now + OLD_NAME_DAYS * 86400))
                    self.db.execute("DELETE FROM old_names WHERE name = ? AND player_id = ?", (name, player_id))
                    self.db.execute("UPDATE players SET name = ?, renamed = ?, name_key = ? WHERE id = ?",
                                    (name, now if renamed else old["renamed"], guard.skeleton(name), player_id))
                except BaseException:
                    self.db.execute("ROLLBACK")
                    raise
                self.db.execute("COMMIT")
        if public is not None:
            self.db.execute("UPDATE players SET public = ? WHERE id = ?", (1 if public else 0, player_id))
        return self.player(player_id)

    # Rooms -------------------------------------------------------------------

    def create_room(self, game: str, host_id: str, public: bool, bots_ok: bool = False) -> dict:
        room_id = new_id("", 9)
        now = time.time()
        self.db.execute(
            "INSERT INTO rooms (id, game, host_id, public, created, active, bots_ok) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room_id, game, host_id, 1 if public else 0, now, now, 1 if bots_ok else 0),
        )
        return self.room(room_id)

    def room(self, room_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        return dict(row) if row else None

    def touch_room(self, room_id: str) -> None:
        self.db.execute("UPDATE rooms SET active = ? WHERE id = ?", (time.time(), room_id))

    def close_room(self, room_id: str) -> None:
        self.db.execute("UPDATE rooms SET closed = 1 WHERE id = ?", (room_id,))
        self.db.execute("UPDATE invites SET used_at = COALESCE(used_at, ?) WHERE room_id = ?", (time.time(), room_id))

    def open_rooms(self, *, public_only: bool = True, since: float = 0.0) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM rooms WHERE closed = 0 AND active >= ? AND (public = 1 OR ? = 0) ORDER BY active DESC LIMIT 200",
            (since, 1 if public_only else 0),
        ).fetchall()
        return [dict(row) for row in rows]

    def open_room_count(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM rooms WHERE closed = 0").fetchone()[0])

    def rooms_hosted_since(self, host_id: str, since: float) -> int:
        return int(self.db.execute(
            "SELECT COUNT(*) FROM rooms WHERE host_id = ? AND created >= ?", (host_id, since)
        ).fetchone()[0])

    def stale_rooms(self, before: float) -> list[str]:
        rows = self.db.execute("SELECT id FROM rooms WHERE closed = 0 AND active < ?", (before,)).fetchall()
        return [row["id"] for row in rows]

    def mark_ladder(self, room_id: str, on: bool = True) -> None:
        """Remember which open rooms are bot-versus-bot ladder games, so their move clocks
        are checked without scanning every room."""
        self.db.execute("UPDATE rooms SET ladder = ? WHERE id = ?", (1 if on else 0, room_id))

    def active_ladder_rooms(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM rooms WHERE closed = 0 AND ladder = 1 ORDER BY active DESC"
        ).fetchall()
        return [dict(row) for row in rows]

    # Invites -----------------------------------------------------------------

    def create_invite(self, room_id: str, side: str) -> str:
        # One live invite per seat: a fresh link replaces the old one.
        now = time.time()
        self.db.execute(
            "UPDATE invites SET used_at = ? WHERE room_id = ? AND side = ? AND used_at IS NULL",
            (now, room_id, side),
        )
        code = secrets.token_urlsafe(12)
        self.db.execute(
            "INSERT INTO invites (code, room_id, side, created) VALUES (?, ?, ?, ?)",
            (code, room_id, side, now),
        )
        return code

    def invite(self, code: str) -> dict | None:
        if not code or len(code) > 64:
            return None
        row = self.db.execute("SELECT * FROM invites WHERE code = ?", (code,)).fetchone()
        return dict(row) if row else None

    def unuse_invite(self, code: str, player_id: str) -> None:
        """Give an invite back when the seat could not be taken after all."""
        self.db.execute(
            "UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ? AND used_by = ?", (code, player_id)
        )

    def use_invite(self, code: str, player_id: str) -> bool:
        cursor = self.db.execute(
            "UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL",
            (player_id, time.time(), code),
        )
        return cursor.rowcount == 1

    def live_invites(self, room_id: str) -> dict[str, str]:
        rows = self.db.execute(
            "SELECT side, code FROM invites WHERE room_id = ? AND used_at IS NULL", (room_id,)
        ).fetchall()
        return {row["side"]: row["code"] for row in rows}

    # Chat and moderation -----------------------------------------------------

    def add_chat(self, room_id: str, player_id: str, name: str, role: str, text: str) -> dict:
        now = time.time()
        self.db.execute(
            "INSERT INTO chat (room_id, player_id, name, role, text, at, bot, staff) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (room_id, player_id, (self.player(player_id) or {}).get("name", name), role, text, now, int((self.player(player_id) or {}).get("bot", 0)), self.staff_role(player_id)),
        )
        return self.recent_chat(room_id, 1)[0]

    def recent_chat(self, room_id: str, limit: int = 50, since: float | None = None) -> list[dict]:
        """The newest lines of a room, oldest first. `since` drops anything older."""
        if since is None:
            rows = self.db.execute(
                "SELECT id, player_id, name, role, text, at, bot, staff, removed FROM chat WHERE room_id = ? ORDER BY id DESC LIMIT ?",
                (room_id, limit),
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT id, player_id, name, role, text, at, bot, staff, removed FROM chat WHERE room_id = ? AND at >= ? ORDER BY id DESC LIMIT ?",
                (room_id, float(since), limit),
            ).fetchall()
        return [{**dict(row), "bot": bool(row["bot"]), "removed": bool(row["removed"]), "text": "removed by a moderator" if row["removed"] else row["text"]} for row in reversed(rows)]

    def purge_chat(self, before: float) -> int:
        return self.db.execute("DELETE FROM chat WHERE at < ?", (before,)).rowcount

    def purge_lobby_posts(self, before: float) -> int:
        """Lobby posts older than `before` are gone, not just hidden. Room chat is not touched."""
        return self.db.execute(
            "DELETE FROM chat WHERE room_id = ? AND at < ?", ("__lobby__", float(before))).rowcount

    def moderate(self, room_id: str, player_id: str, action: str, on: bool = True) -> None:
        if on:
            self.db.execute(
                "INSERT OR IGNORE INTO moderation (room_id, player_id, action) VALUES (?, ?, ?)",
                (room_id, player_id, action),
            )
        else:
            self.db.execute(
                "DELETE FROM moderation WHERE room_id = ? AND player_id = ? AND action = ?",
                (room_id, player_id, action),
            )

    def moderated(self, room_id: str, player_id: str, action: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM moderation WHERE room_id = ? AND player_id = ? AND action = ?",
            (room_id, player_id, action),
        ).fetchone() is not None

    # Matches and ratings -----------------------------------------------------

    def next_match_no(self, room_id: str) -> int:
        """Number a match when it starts, so its result has one durable identity."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("UPDATE rooms SET matches = matches + 1 WHERE id = ?", (room_id,))
            row = self.db.execute("SELECT matches FROM rooms WHERE id = ?", (room_id,)).fetchone()
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return int(row["matches"]) if row else 0

    def record_match(self, room_id: str, match_no: int, state: dict) -> dict | None:
        """Store one finished match as a replay and a scoreline. Safe to repeat: a second
        call for the same (room, match_no) changes nothing and returns None.

        No rating is applied here. A rated game is a *pair*: the same deal twice with the
        seats swapped, and the one rating change follows both legs
        (``settle_pair_leg``). A single table — casual, private, a lesson or one leg —
        is a game people played, not a rated result.
        """
        room = self.room(room_id)
        if room is None:
            return None
        kinds = {side: _kind(state.get(side)) for side in ("white", "black")}
        ids = {side: str(state.get(f"{side}_id") or "") for side in ("white", "black")}
        rated = False
        winner = str(state.get("winner") or "")
        reason = str(state.get("result_reason") or state.get("status") or "")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            inserted = self.db.execute(
                "INSERT OR IGNORE INTO matches (room_id, match_no, game, white_id, black_id, white_name, black_name, "
                "white_kind, black_kind, winner, reason, plies, moves, rated, finished) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (room_id, match_no, room["game"], ids["white"], ids["black"],
                 str(state.get("white_name") or ""), str(state.get("black_name") or ""),
                 kinds["white"], kinds["black"], winner, reason, int(state.get("plies") or 0),
                 json.dumps(list(state.get("moves") or [])), 1 if rated else 0, time.time()),
            ).rowcount == 1
            if inserted:
                self._bot_record(room["game"], ids, kinds, winner)
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        if not inserted:
            return None
        return {"match_no": match_no, "rated": rated, "winner": winner, "reason": reason}

    def pair_rated_today(self, game: str, one: str, two: str) -> int:
        """Rated games between the same pair in the last day. A finished pair counts once,
        so the daily cap is about games played, not about legs."""
        single = int(self.db.execute(
            "SELECT COUNT(*) FROM matches WHERE game = ? AND rated = 1 AND match_no > 0 AND finished >= ? AND "
            "((white_id = ? AND black_id = ?) OR (white_id = ? AND black_id = ?))",
            (game, time.time() - 86400, one, two, two, one),
        ).fetchone()[0])
        pairs = int(self.db.execute(
            "SELECT COUNT(*) FROM pairs WHERE game = ? AND rated = 1 AND finished >= ? AND "
            "((one_id = ? AND two_id = ?) OR (one_id = ? AND two_id = ?))",
            (game, time.time() - 86400, one, two, two, one),
        ).fetchone()[0])
        return single + pairs

    # Ranked pairs ------------------------------------------------------------

    def set_room_pair(self, room_id: str, pair_id: str, leg: int, seed: int, *, open_league: bool = False) -> None:
        self.db.execute(
            "UPDATE rooms SET pair_id = ?, pair_leg = ?, seed = ?, ladder = ?, open_league = ? WHERE id = ?",
            (pair_id, int(leg), int(seed), 1, 1 if open_league else 0, room_id),
        )

    def create_pair(self, game: str, seed: int, room_a: str, room_b: str, one_id: str, two_id: str,
                    *, open_league: bool = False) -> dict:
        pair_id = new_id("pair:", 9)
        self.db.execute(
            "INSERT INTO pairs (id, game, seed, room_a, room_b, one_id, two_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (pair_id, game, int(seed), room_a, room_b, one_id, two_id, time.time()),
        )
        self.set_room_pair(room_a, pair_id, 1, seed, open_league=open_league)
        self.set_room_pair(room_b, pair_id, 2, seed, open_league=open_league)
        return self.pair(pair_id) or {}

    def pair(self, pair_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM pairs WHERE id = ?", (pair_id,)).fetchone()
        return dict(row) if row else None

    def pair_for_room(self, room_id: str) -> dict | None:
        row = self.db.execute(
            "SELECT * FROM pairs WHERE room_a = ? OR room_b = ?", (room_id, room_id)
        ).fetchone()
        return dict(row) if row else None

    def open_pairs(self) -> list[dict]:
        return [dict(row) for row in self.db.execute(
            "SELECT * FROM pairs WHERE rated = 0 AND finished = 0 AND legs_done < 2 ORDER BY created"
        )]

    def settle_pair_leg(self, room_id: str, winner: str, reason: str = "") -> dict | None:
        """Count one finished leg. When both legs are in, one rating change is applied.

        ``winner`` is the finished leg's side (white/black/""), not the pair's. Leg 1 has
        ``one_id`` in white, leg 2 has ``one_id`` in black, so a seat cannot decide the pair.
        Safe to repeat: a second call for the same room changes nothing.
        """
        pair = self.pair_for_room(room_id)
        if not pair or pair["rated"] or pair["finished"]:
            return None
        leg = 1 if room_id == pair["room_a"] else 2
        if (leg == 1 and pair["leg_a_done"]) or (leg == 2 and pair["leg_b_done"]):
            return None
        winner_id = pair["one_id"] if winner == ("white" if leg == 1 else "black") else pair["two_id"] if winner in ("white", "black") else ""
        score_one = 1 if winner_id == pair["one_id"] else 0
        score_two = 1 if winner_id == pair["two_id"] else 0
        self.db.execute(
            f"UPDATE pairs SET score_one = score_one + ?, score_two = score_two + ?, legs_done = legs_done + 1, "
            f"leg_{'a' if leg == 1 else 'b'}_done = 1 WHERE id = ?",
            (score_one, score_two, pair["id"]),
        )
        pair = self.pair(pair["id"]) or pair
        if pair["legs_done"] < 2:
            return {"pair": pair, "rated": False, "waiting": True, "leg": leg}
        # Both legs are in: the pair is won by the player with more leg wins.
        one, two = pair["score_one"], pair["score_two"]
        pair_winner = "white" if one > two else "black" if two > one else ""
        rated = self.pair_rated_today(pair["game"], pair["one_id"], pair["two_id"]) < PAIR_RATED_PER_DAY
        names = {}
        for side, player_id in (("white", pair["one_id"]), ("black", pair["two_id"])):
            player = self.player(player_id) or {}
            names[side] = str(player.get("name") or player_id)
        kinds = {side: ("bot" if str(pid).startswith("bot:") else "human")
                 for side, pid in (("white", pair["one_id"]), ("black", pair["two_id"]))}
        bots = all(kind == "bot" for kind in kinds.values())
        self.db.execute(
            "UPDATE pairs SET finished = ?, rated = ?, winner = ? WHERE id = ?",
            (time.time(), 1 if rated else 0, pair_winner, pair["id"]),
        )
        if rated:
            self._rate(pair["game"], pair["one_id"], pair["two_id"], pair_winner,
                       bot=bots, room_id=pair["room_a"], match_no=0)
        self.db.execute(
            "INSERT OR IGNORE INTO matches (room_id, match_no, game, white_id, black_id, white_name, black_name, "
            "white_kind, black_kind, winner, reason, plies, moves, rated, finished) "
            "VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (pair["room_a"], pair["game"], pair["one_id"], pair["two_id"], names["white"], names["black"],
             kinds["white"], kinds["black"], pair_winner,
             f"pair {one}-{two}" + (f" · {reason}" if reason else ""), pair["legs_done"], "[]",
             1 if rated else 0, time.time()),
        )
        return {"pair": self.pair(pair["id"]), "rated": rated, "waiting": False,
                "winner": pair_winner, "score": f"{one}-{two}"}

    # Challenges --------------------------------------------------------------

    def add_challenge(self, bot_id: str, game: str, challenger_id: str, room_id: str, invite: str,
                      seconds: float) -> dict:
        challenge_id = new_id("cha:", 9)
        now = time.time()
        self.db.execute(
            "INSERT INTO challenges (id, bot_id, game, challenger_id, room_id, invite, created, expires) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (challenge_id, bot_id, game, challenger_id, room_id, invite, now, now + seconds),
        )
        return self.challenge(challenge_id) or {}

    def challenge(self, challenge_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM challenges WHERE id = ?", (challenge_id,)).fetchone()
        return dict(row) if row else None

    def challenges_for(self, bot_ids) -> list[dict]:
        wanted = [str(bot) for bot in bot_ids if bot]
        if not wanted:
            return []
        marks = ",".join("?" for _ in wanted)
        rows = self.db.execute(
            f"SELECT * FROM challenges WHERE state = 'pending' AND expires > ? AND bot_id IN ({marks}) "
            "ORDER BY created",
            (time.time(), *wanted),
        ).fetchall()
        found = []
        for row in rows:
            item = dict(row)
            bot = self.player(item["bot_id"]) or {}
            challenger = self.player(item["challenger_id"]) or {}
            item["bot_name"] = str(bot.get("name") or item["bot_id"])
            item["challenger"] = str(challenger.get("name") or item["challenger_id"])
            found.append(item)
        return found

    def pending_challenges(self, bot_id: str) -> int:
        return int(self.db.execute(
            "SELECT COUNT(*) FROM challenges WHERE bot_id = ? AND state = 'pending' AND expires > ?",
            (bot_id, time.time()),
        ).fetchone()[0])

    def take_challenge(self, challenge_id: str, bot_id: str = "") -> dict | None:
        row = self.challenge(challenge_id)
        if not row or row["state"] != "pending" or (bot_id and row["bot_id"] != bot_id):
            return None
        self.db.execute("UPDATE challenges SET state = 'accepted' WHERE id = ?", (challenge_id,))
        return row

    def decline_challenge(self, challenge_id: str) -> dict | None:
        row = self.challenge(challenge_id)
        if not row or row["state"] != "pending":
            return None
        self.db.execute("UPDATE challenges SET state = 'declined' WHERE id = ?", (challenge_id,))
        return row

    def expire_challenges(self, before: float | None = None) -> list[dict]:
        """Mark late challenges declined and hand back the rooms to close."""
        now = time.time() if before is None else before
        rows = self.db.execute(
            "SELECT * FROM challenges WHERE state = 'pending' AND expires <= ?", (now,)
        ).fetchall()
        for row in rows:
            self.db.execute("UPDATE challenges SET state = 'expired' WHERE id = ?", (row["id"],))
        return [dict(row) for row in rows]

    # Strategy cards and server-run bouts -------------------------------------

    def add_card(self, owner_id: str, game: str, name: str, payload: str) -> dict:
        card_id = new_id("card:", 9)
        self.db.execute(
            "INSERT INTO cards (id, owner_id, game, name, payload, created) VALUES (?, ?, ?, ?, ?, ?)",
            (card_id, owner_id, game, name, payload, time.time()),
        )
        return self.card(card_id) or {}

    def card(self, card_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM cards WHERE id = ?", (card_id,)).fetchone()
        return dict(row) if row else None

    def cards_of(self, owner_id: str, game: str = "") -> list[dict]:
        if game:
            rows = self.db.execute(
                "SELECT * FROM cards WHERE owner_id = ? AND game = ? ORDER BY created", (owner_id, game)
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT * FROM cards WHERE owner_id = ? ORDER BY created", (owner_id,)
            ).fetchall()
        return [dict(row) for row in rows]

    def card_count(self, owner_id: str, game: str) -> int:
        return int(self.db.execute(
            "SELECT COUNT(*) FROM cards WHERE owner_id = ? AND game = ?", (owner_id, game)
        ).fetchone()[0])

    def create_bout(self, game: str, seed: int, one_card: dict, two_card: dict, winner: str,
                    reason: str, plies: int, rated: bool, replay: dict) -> dict:
        bout_id = new_id("bout:", 9)
        self.db.execute(
            "INSERT INTO bouts (id, game, seed, one_card, two_card, one_owner, two_owner, winner, reason, plies, rated, replay, created) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (bout_id, game, int(seed), one_card["id"], two_card["id"], one_card["owner_id"],
             two_card["owner_id"], winner, reason, int(plies), 1 if rated else 0,
             json.dumps(replay), time.time()),
        )
        if rated:
            self._rate_card(game, one_card["id"], two_card["id"], winner)
        return self.bout(bout_id) or {}

    def _rate_card(self, game: str, one: str, two: str, winner: str) -> None:
        old = {}
        for card_id in (one, two):
            row = self.db.execute(
                "SELECT rating FROM card_ratings WHERE card_id = ? AND game = ?", (card_id, game)
            ).fetchone()
            old[card_id] = float(row[0]) if row else START_RATING
        result = {one: 1.0 if winner == "one" else 0.0 if winner == "two" else 0.5}
        result[two] = 1.0 - result[one]
        for card_id in (one, two):
            other = two if card_id == one else one
            rating = old[card_id] + K_FACTOR * (result[card_id] - expected(old[card_id], old[other]))
            column = "wins" if result[card_id] == 1.0 else "losses" if result[card_id] == 0.0 else "draws"
            self.db.execute(
                f"INSERT INTO card_ratings (card_id, game, rating, games, {column}) VALUES (?, ?, ?, 1, 1) "
                f"ON CONFLICT (card_id, game) DO UPDATE SET rating = excluded.rating, games = games + 1, "
                f"{column} = {column} + 1",
                (card_id, game, rating),
            )

    def card_rating(self, card_id: str, game: str) -> dict:
        row = self.db.execute(
            "SELECT rating, games, wins, losses, draws FROM card_ratings WHERE card_id = ? AND game = ?",
            (card_id, game),
        ).fetchone()
        found = dict(row) if row else {"rating": START_RATING, "games": 0, "wins": 0, "losses": 0, "draws": 0}
        found["rating"] = round(found["rating"])
        found["provisional"] = found["games"] < 10
        return found

    def bout(self, bout_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM bouts WHERE id = ?", (bout_id,)).fetchone()
        if not row:
            return None
        found = dict(row)
        for key in ("one_card", "two_card"):
            card = self.card(found[key]) or {}
            found[key.replace("_card", "_name")] = str(card.get("name") or "")
        return found

    def recent_bouts(self, limit: int = 20, owner_id: str = "") -> list[dict]:
        if owner_id:
            rows = self.db.execute(
                "SELECT b.* FROM bouts b JOIN cards c ON c.id = b.one_card OR c.id = b.two_card "
                "WHERE c.owner_id = ? GROUP BY b.id ORDER BY b.created DESC LIMIT ?",
                (owner_id, limit),
            ).fetchall()
        else:
            rows = self.db.execute("SELECT * FROM bouts ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        return [dict(row) for row in rows]


    def _rating(self, player_id: str, game: str) -> float:
        row = self.db.execute(
            "SELECT rating FROM ratings WHERE player_id = ? AND game = ?", (player_id, game)
        ).fetchone()
        return float(row["rating"]) if row else START_RATING

    def _rate(self, game: str, white: str, black: str, winner: str, *, bot=False, room_id="", match_no=0) -> None:
        # Whitelist table to prevent SQL injection
        table = "bot_ratings" if bot else "ratings"
        if table not in ("ratings", "bot_ratings"):
            raise ValueError(f"Invalid table: {table}")

        old = {side: (self.db.execute(f"SELECT rating FROM {table} WHERE player_id = ? AND game = ?", (pid, game)).fetchone() or [START_RATING])[0] for side, pid in (("white", white), ("black", black))}
        result = {"white": 1.0 if winner == "white" else 0.0 if winner == "black" else 0.5}
        result["black"] = 1.0 - result["white"]
        for side, player_id in (("white", white), ("black", black)):
            other = "black" if side == "white" else "white"
            rating = old[side] + K_FACTOR * (result[side] - expected(old[side], old[other]))
            column = "wins" if result[side] == 1.0 else "losses" if result[side] == 0.0 else "draws"
            # Validate column name to prevent SQL injection
            if column not in ("wins", "losses", "draws"):
                raise ValueError(f"Invalid column: {column}")

            self.db.execute(
                f"INSERT INTO {table} (player_id, game, rating, games, {column}) VALUES (?, ?, ?, 1, 1) "
                f"ON CONFLICT (player_id, game) DO UPDATE SET rating = excluded.rating, games = games + 1, "
                f"{column} = {column} + 1",
                (player_id, game, rating),
            )
            if bot:
                self.db.execute("INSERT INTO rating_history (player_id, game, rating, match_no, room_id, at) VALUES (?, ?, ?, ?, ?, ?)", (player_id, game, rating, match_no, room_id, time.time()))

    def _bot_record(self, game: str, ids: dict, kinds: dict, winner: str) -> None:
        for side in ("white", "black"):
            other = "black" if side == "white" else "white"
            if kinds[side] != "human" or kinds[other] != "local" or not ids[side].startswith("web:"):
                continue
            column = "draws" if not winner else "wins" if winner == side else "losses"
            self.db.execute(
                f"INSERT INTO bot_records (player_id, game, {column}) VALUES (?, ?, 1) "
                f"ON CONFLICT (player_id, game) DO UPDATE SET {column} = {column} + 1",
                (ids[side], game),
            )

    def leaderboard(self, game: str, pool: str = "humans", limit: int = 50) -> list[dict]:
        # Whitelist table and condition to prevent SQL injection
        if pool == "bots":
            table = "bot_ratings"
            condition = "p.bot = 1 AND p.suspended = 0"
        elif pool == "humans":
            table = "ratings"
            condition = "p.public = 1 AND p.bot = 0"
        else:
            raise ValueError(f"Invalid pool: {pool}")

        rows = self.db.execute(f"SELECT p.id, p.name, r.rating, r.games, r.wins, r.losses, r.draws FROM {table} r JOIN players p ON p.id = r.player_id WHERE r.game = ? AND {condition} ORDER BY r.rating DESC, r.games DESC LIMIT ?", (game, limit)).fetchall()
        return [{**dict(row), "rating": round(row["rating"]), "bot": pool == "bots"} for row in rows]

    def bot_career(self, bot_id: str) -> dict | None:
        bot = self.db.execute("SELECT id, name, created FROM players WHERE id = ? AND bot = 1", (bot_id,)).fetchone()
        if not bot:
            return None
        games = [{**dict(r), "rating": round(r["rating"]), "provisional": r["games"] < 10} for r in self.db.execute("SELECT game, rating, games, wins, losses, draws FROM bot_ratings WHERE player_id = ? ORDER BY game", (bot_id,))]
        history = [{**dict(r), "rating": round(r["rating"])} for r in self.db.execute("SELECT game, rating, at, match_no FROM rating_history WHERE player_id = ? ORDER BY id DESC LIMIT 50", (bot_id,))]
        opponents = []
        for r in self.db.execute("SELECT * FROM matches WHERE rated = 1 AND (white_id = ? OR black_id = ?) ORDER BY id DESC LIMIT 20", (bot_id, bot_id)):
            side = "white" if r["white_id"] == bot_id else "black"
            other = "black" if side == "white" else "white"
            opponents.append({"id": r[f"{other}_id"], "name": r[f"{other}_name"], "game": r["game"], "result": "draw" if not r["winner"] else "win" if r["winner"] == side else "loss", "at": r["finished"], "rated": bool(r["rated"])})
        return {"bot": {**dict(bot), "provisional": not games or all(g["provisional"] for g in games), "rating": {g["game"]: g["rating"] for g in games}}, "games": games, "history": history, "opponents": opponents}

    def stats(self, player_id: str) -> dict:
        rated = self.db.execute(
            "SELECT game, rating, games, wins, losses, draws FROM ratings WHERE player_id = ?", (player_id,)
        ).fetchall()
        bots = self.db.execute(
            "SELECT game, wins, losses, draws FROM bot_records WHERE player_id = ?", (player_id,)
        ).fetchall()
        return {
            "rated": [{**dict(row), "rating": round(row["rating"])} for row in rated],
            "bots": [dict(row) for row in bots],
        }

    # Arcade removals ---------------------------------------------------------

    def removal(self, tile_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM arcade_removals WHERE tile_id = ?", (tile_id,)).fetchone()
        return dict(row) if row else None

    def add_removal(self, tile_id: str, code: str) -> dict:
        """Hide a tile; a second request keeps the first code and its 14-day clock."""
        self.db.execute("INSERT OR IGNORE INTO arcade_removals (tile_id, code, created) VALUES (?, ?, ?)",
                        (tile_id, code, time.time()))
        return self.removal(tile_id) or {}

    def prove_removal(self, tile_id: str, code: str) -> None:
        """Only the code that was checked: a lapsed and re-made request has a new one."""
        self.db.execute("UPDATE arcade_removals SET proven = 1 WHERE tile_id = ? AND code = ?", (tile_id, code))

    def hidden_tiles(self) -> set[str]:
        return {row[0] for row in self.db.execute("SELECT tile_id FROM arcade_removals")}

    def expire_removals(self, before: float) -> int:
        return self.db.execute("DELETE FROM arcade_removals WHERE proven = 0 AND created < ?", (before,)).rowcount

    def match(self, room_id: str, match_no: int) -> dict | None:
        row = self.db.execute(
            "SELECT * FROM matches WHERE room_id = ? AND match_no = ?", (room_id, int(match_no))
        ).fetchone()
        return dict(row) if row else None

    def recent_matches(self, room_id: str, limit: int = 10) -> list[dict]:
        rows = self.db.execute(
            "SELECT match_no, white_name, black_name, white_kind, black_kind, winner, reason, plies, rated, finished "
            "FROM matches WHERE room_id = ? ORDER BY match_no DESC LIMIT ?",
            (room_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # Jackpot Mode: Slot machine tracking
    def store_slot_spin(self, user_id: str, cost: float, result: dict) -> int:
        """Store a slot spin result and return the spin ID."""
        cur = self.db.execute(
            "INSERT INTO inference_slots (user_id, inference_cost, reel1, reel2, reel3, multiplier, winnings, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, cost, result["reel1"], result["reel2"], result["reel3"], result["multiplier"], result["winnings"], time.time()),
        )
        return cur.lastrowid

    def get_user_slot_balance(self, user_id: str) -> float:
        """Get total slot winnings for a user."""
        row = self.db.execute("SELECT COALESCE(SUM(winnings), 0) as total FROM inference_slots WHERE user_id = ?", (user_id,)).fetchone()
        return float(row["total"]) if row else 0.0

    def get_slot_leaderboard(self, limit: int = 50) -> list[dict]:
        """Get top slot machine earners."""
        rows = self.db.execute(
            "SELECT user_id, SUM(winnings) as total_winnings, COUNT(*) as spins "
            "FROM inference_slots "
            "GROUP BY user_id "
            "ORDER BY total_winnings DESC "
            "LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_recent_spins(self, user_id: str, limit: int = 10) -> list[dict]:
        """Get recent slot spins for a user."""
        rows = self.db.execute(
            "SELECT reel1, reel2, reel3, multiplier, winnings, created_at "
            "FROM inference_slots "
            "WHERE user_id = ? "
            "ORDER BY created_at DESC "
            "LIMIT ?",
            (user_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    # Self-reported balances ---------------------------------------------------
    #
    # What an account holds *on its own computer*: chips and points, sent by that
    # computer so a future migration can move them. Self-reported, so this is not a
    # leaderboard and decides nothing: the server keeps the latest pair, a short
    # history of how it moved, and nothing else.

    # The history kept per account. Older rows are dropped as new ones arrive, so one
    # account cannot grow this table without bound.
    BALANCE_LOG_ROWS = 100

    def set_balance(self, player_id: str, chips: int, points: int, now: float | None = None) -> dict:
        """Record one account's own chips and points, keeping the last 100 changes.

        Returns the row as stored. Both numbers are clamped to whole and non-negative
        here as well as at the endpoint, so a bad value can never reach the table.
        """
        chips = max(0, int(chips))
        points = max(0, int(points))
        at = time.time() if now is None else float(now)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute(
                "INSERT INTO balances (player_id, chips, points, updated) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(player_id) DO UPDATE SET chips = excluded.chips, points = excluded.points, "
                "updated = excluded.updated",
                (player_id, chips, points, at),
            )
            self.db.execute(
                "INSERT INTO balance_log (player_id, chips, points, at) VALUES (?, ?, ?, ?)",
                (player_id, chips, points, at),
            )
            # One account's history, newest kept: everything past the cap goes in the
            # same change as the row that pushed it out.
            self.db.execute(
                "DELETE FROM balance_log WHERE player_id = ? AND id NOT IN "
                "(SELECT id FROM balance_log WHERE player_id = ? ORDER BY id DESC LIMIT ?)",
                (player_id, player_id, self.BALANCE_LOG_ROWS),
            )
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        return self.balance(player_id) or {}

    def balance(self, player_id: str) -> dict | None:
        """The stored row for one account, or None when it has never sent one."""
        row = self.db.execute(
            "SELECT player_id, chips, points, updated FROM balances WHERE player_id = ?", (player_id,)
        ).fetchone()
        return dict(row) if row else None

    def balance_log(self, player_id: str, limit: int = 100) -> list[dict]:
        """One account's recorded changes, newest first, at most ``BALANCE_LOG_ROWS``."""
        try:
            wanted = max(1, min(int(limit), self.BALANCE_LOG_ROWS))
        except (TypeError, ValueError):
            wanted = self.BALANCE_LOG_ROWS
        rows = self.db.execute(
            "SELECT id, chips, points, at FROM balance_log WHERE player_id = ? ORDER BY id DESC LIMIT ?",
            (player_id, wanted),
        ).fetchall()
        return [dict(row) for row in rows]

    # Availability and play requests ------------------------------------------

    def availability(self, player_id: str) -> tuple[bool, dict[str, bool]]:
        """(open, {game: enabled}). No row means closed, and missing games are off."""
        row = self.db.execute("SELECT open FROM availability WHERE player_id = ?", (player_id,)).fetchone()
        games = {
            item["game"]: bool(item["enabled"])
            for item in self.db.execute(
                "SELECT game, enabled FROM availability_games WHERE player_id = ?", (player_id,))
        }
        return (bool(row["open"]) if row else False), games

    def save_availability(self, player_id: str, open_flag: bool, games: dict[str, bool], now: float) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute(
                "INSERT INTO availability (player_id, open, updated) VALUES (?, ?, ?) "
                "ON CONFLICT(player_id) DO UPDATE SET open = excluded.open, updated = excluded.updated",
                (player_id, 1 if open_flag else 0, now),
            )
            for game, enabled in games.items():
                self.db.execute(
                    "INSERT INTO availability_games (player_id, game, enabled) VALUES (?, ?, ?) "
                    "ON CONFLICT(player_id, game) DO UPDATE SET enabled = excluded.enabled",
                    (player_id, game, 1 if enabled else 0),
                )
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def invisible(self, player_id: str) -> bool:
        """True when the account is appearing offline. No row means visible."""
        row = self.db.execute(
            "SELECT invisible FROM availability WHERE player_id = ?", (player_id,)).fetchone()
        return bool(row["invisible"]) if row else False

    def invisible_ids(self, player_ids) -> set[str]:
        """The appearing-offline accounts out of a set of ids, in one query."""
        wanted = [str(pid) for pid in player_ids if pid]
        if not wanted:
            return set()
        marks = ",".join("?" for _ in wanted)
        return {row["player_id"] for row in self.db.execute(
            f"SELECT player_id FROM availability WHERE invisible = 1 AND player_id IN ({marks})",
            wanted)}

    def save_invisible(self, player_id: str, flag: bool, now: float) -> None:
        """Save appear-offline. The open flag and the game choices are left alone."""
        self.db.execute(
            "INSERT INTO availability (player_id, open, updated, invisible) VALUES (?, 0, ?, ?) "
            "ON CONFLICT(player_id) DO UPDATE SET invisible = excluded.invisible, updated = excluded.updated",
            (player_id, now, 1 if flag else 0),
        )

    # Find match --------------------------------------------------------------

    def looking_games(self, player_id: str) -> list[str]:
        """The games this account is actively looking for. Empty means not looking."""
        return [str(row["game"]) for row in self.db.execute(
            "SELECT game FROM looking WHERE player_id = ? ORDER BY game", (player_id,))]

    def set_looking(self, player_id: str, games, now: float) -> None:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("DELETE FROM looking WHERE player_id = ?", (player_id,))
            for game in games:
                self.db.execute(
                    "INSERT OR REPLACE INTO looking (player_id, game, created) VALUES (?, ?, ?)",
                    (player_id, game, now),
                )
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def clear_looking(self, player_id: str) -> int:
        return self.db.execute("DELETE FROM looking WHERE player_id = ?", (player_id,)).rowcount

    def all_looking(self) -> list[dict]:
        """Every account still looking, with the game and when it started."""
        return [dict(row) for row in self.db.execute(
            "SELECT player_id, game, created FROM looking ORDER BY created, player_id, game")]

    def clear_looking_outside(self, keep) -> int:
        """Drop find-match rows for anyone who is not in the lobby any more."""
        wanted = [str(pid) for pid in keep if pid]
        if not wanted:
            return self.db.execute("DELETE FROM looking").rowcount
        marks = ",".join("?" for _ in wanted)
        return self.db.execute(f"DELETE FROM looking WHERE player_id NOT IN ({marks})", wanted).rowcount

    def pending_offer_players(self) -> set[str]:
        """Both sides of every open match offer: they are mid-offer and get no second one."""
        return {str(row[0]) for row in self.db.execute(
            "SELECT from_id FROM play_requests WHERE state = 'pending' AND offer = 1 "
            "UNION SELECT to_id FROM play_requests WHERE state = 'pending' AND offer = 1")}

    def blocked_pair(self, a: str, b: str) -> bool:
        """True when either person has blocked the other. Callers must not say which."""
        return self.db.execute(
            "SELECT 1 FROM blocks WHERE (player_id = ? AND blocked_id = ?) "
            "OR (player_id = ? AND blocked_id = ?) LIMIT 1",
            (a, b, b, a),
        ).fetchone() is not None

    def create_play_request(self, from_id: str, to_id: str, game: str, now: float, seconds: float = 90,
                            offer: bool = False) -> dict:
        request_id = new_id("", 9)
        self.db.execute(
            "INSERT INTO play_requests (id, from_id, to_id, game, state, created, expires, room_id, offer) "
            "VALUES (?, ?, ?, ?, 'pending', ?, ?, '', ?)",
            (request_id, from_id, to_id, game, now, now + seconds, 1 if offer else 0),
        )
        return self.play_request(request_id) or {}

    def play_request(self, request_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM play_requests WHERE id = ?", (request_id,)).fetchone()
        return dict(row) if row else None

    def pending_play_requests(self, player_id: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM play_requests WHERE state = 'pending' AND (from_id = ? OR to_id = ?) "
            "ORDER BY created, id",
            (player_id, player_id),
        ).fetchall()
        return [dict(row) for row in rows]

    def requests_sent_since(self, player_id: str, since: float) -> int:
        return int(self.db.execute(
            "SELECT COUNT(*) FROM play_requests WHERE from_id = ? AND created > ?",
            (player_id, since),
        ).fetchone()[0])

    def inbound_pending_count(self, player_id: str) -> int:
        return int(self.db.execute(
            "SELECT COUNT(*) FROM play_requests WHERE to_id = ? AND state = 'pending'",
            (player_id,),
        ).fetchone()[0])

    def pair_pending(self, a: str, b: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM play_requests WHERE state = 'pending' AND "
            "((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) LIMIT 1",
            (a, b, b, a),
        ).fetchone() is not None

    def declined_recently(self, a: str, b: str, game: str, since: float) -> bool:
        """A decline for this pair and game newer than `since`.

        There is no declined-at column. The request is created and answered inside
        its 90s life, so the window is measured from `created`.
        """
        return self.db.execute(
            "SELECT 1 FROM play_requests WHERE state = 'declined' AND game = ? AND created > ? AND "
            "((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) LIMIT 1",
            (game, since, a, b, b, a),
        ).fetchone() is not None

    def set_play_state(self, request_id: str, state: str, room_id: str | None = None) -> dict | None:
        if room_id is None:
            self.db.execute("UPDATE play_requests SET state = ? WHERE id = ?", (state, request_id))
        else:
            self.db.execute(
                "UPDATE play_requests SET state = ?, room_id = ? WHERE id = ?",
                (state, room_id, request_id),
            )
        return self.play_request(request_id)

    def expire_play_requests(self, now: float) -> list[dict]:
        rows = [dict(row) for row in self.db.execute(
            "SELECT * FROM play_requests WHERE state = 'pending' AND expires <= ?", (now,))]
        if rows:
            self.db.execute(
                "UPDATE play_requests SET state = 'expired' WHERE state = 'pending' AND expires <= ?",
                (now,),
            )
            for row in rows:
                row["state"] = "expired"
        return rows

    def release_other_pending(self, a: str, b: str, keep_id: str) -> list[dict]:
        """Other pending requests that touch either player become unavailable."""
        rows = [dict(row) for row in self.db.execute(
            "SELECT * FROM play_requests WHERE state = 'pending' AND id != ? "
            "AND (from_id IN (?, ?) OR to_id IN (?, ?))",
            (keep_id, a, b, a, b),
        )]
        if not rows:
            return []
        marks = ",".join("?" for _ in rows)
        self.db.execute(
            f"UPDATE play_requests SET state = 'unavailable' WHERE id IN ({marks})",
            [row["id"] for row in rows],
        )
        for row in rows:
            row["state"] = "unavailable"
        return rows

    def keep_room_private(self, room_id: str) -> None:
        """A matched request table is private, unrated, and has no invite link."""
        self.db.execute("UPDATE rooms SET public = 0, ladder = 0 WHERE id = ?", (room_id,))
        self.db.execute("DELETE FROM invites WHERE room_id = ?", (room_id,))


def _player(row) -> dict | None:
    if not row:
        return None
    found = dict(row)
    found["bot"] = bool(found.get("bot"))
    return found


def _kind(token) -> str:
    text = str(token or "").strip().lower()
    if text in {"", "human"} or text.startswith("human:"):
        return "human"
    if text == "local":
        return "local"
    return "profile"
