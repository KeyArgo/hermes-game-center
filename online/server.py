"""Game Center Online: rooms, invites, spectators, chat and a leaderboard over one WebSocket.

Run: python -m online.server --data DIR [--host 127.0.0.1] [--port 8790] [--trust-proxy]
(from plugins/hermes-gameshelf). Put nginx in front for TLS.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import datetime
import hashlib
import json
import logging
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeGuard

from aiohttp import ClientSession, ClientTimeout, WSCloseCode, WSMsgType, web

_HERE = Path(__file__).resolve().parent
_SHELF = _HERE.parent
if str(_SHELF) not in sys.path:
    sys.path.insert(0, str(_SHELF))

from online import admin, arcade, bouts, guard, league, stock  # noqa: E402
from online.rooms import Rooms, game_cards, CURATED
from online.matchqueue import MatchQueue
from online.presence import Hub
import kit  # noqa: E402
from online.store import BOTS_PER_OWNER, RENAME_DAYS, Store, token_hash  # noqa: E402
from online import requests as play_requests  # noqa: E402
from online.slots import spin as slot_spin, PAYOUTS_3OAK  # noqa: E402
from shelf.jackpot import EarnTracker, Ledger  # noqa: E402

log = logging.getLogger("gameshelf.online")

# The slot machine's top prize: three NOUS stamps. A pull that pays this much is
# announced in the room chat. Derived from the live payout table rather than a
# hardcoded number, which drifted (it was once 260, a value no spin can pay).
JACKPOT_ANNOUNCE = PAYOUTS_3OAK["NOUS"]

WEB = _HERE / "web"
BOARD_JS = _SHELF / "desktop" / "plugin.js"
MAX_ROOM_CONNECTIONS = 100
MAX_CONNECTIONS = 2000
MAX_ROOMS_PER_HOUR = 10
MAX_PENDING_PER_IP = 20
MAX_PENDING = 500
REMOVED_IP_SECONDS = 86400
MAX_OPEN_ROOMS = 2000
# A self-reported chip or point total has to fit a SQLite integer and be sane: a
# number past this is a client bug, not a wallet, and is refused rather than stored.
BALANCE_MAX = 10 ** 15
LOBBY_CACHE_SECONDS = 2.0
CHAT_DAYS = 7
LOBBY_HOURS = 24
JANITOR = web.AppKey("janitor", asyncio.Task)
IMPORTMAP = json.dumps({"imports": {
    "react": "/vendor/react.mjs",
    "react/jsx-runtime": "/vendor/jsx-runtime.mjs",
    "react-dom/client": "/vendor/client.mjs",
    "@hermes/plugin-sdk": "/sdk-shim.js",
}})


@dataclass(eq=False)
class Conn:
    ws: web.WebSocketResponse
    room_id: str
    player: dict
    ip: str
    sent_state: str = ""
    tags: set = field(default_factory=set)


class App:
    def __init__(self, data_root: Path, *, trust_proxy: bool = False, games=None, clock=time.time,
                 signups_per_hour: int = 20, api_per_minute: int = 120, arcade_tiles=None, proof_fetcher=None) -> None:
        self.data_root = Path(data_root)
        self.store = Store(self.data_root / "online.sqlite3")
        self.admin = admin.AdminAPI(self)
        self.rooms = Rooms(self.store, self.data_root, games=games, clock=clock)
        self.cards = game_cards(self.rooms.games)
        self.clock = clock
        self.queue = MatchQueue()
        self.hub = Hub(self, clock=clock)
        self.presence = self.hub
        self.login_limit = guard.Limiter(10, 600.0)
        self.queue_limit = guard.Limiter(30, 60.0)
        self.alert_limit = guard.Limiter(60, 60.0)
        self.ladder_limit = guard.Limiter(10, 60.0)
        self.trust_proxy = trust_proxy
        self.conns: dict[str, set[Conn]] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.cmd_limit = guard.Limiter(12, 5.0)
        self.chat_limit = guard.Limiter(5, 10.0)
        self.lobby_chat_limit = guard.Limiter(5, 10.0)
        self.session_limit = guard.Limiter(signups_per_hour, 3600.0)
        self.api_limit = guard.Limiter(api_per_minute, 60.0)
        # One balance write every ten seconds per account. The dock sends only when its
        # wallet changed and at most every thirty, so this is slack, not a pace it lives at.
        self.balance_limit = guard.Limiter(1, 10.0)
        self.lobby_cache: tuple[float, dict] = (0.0, {})
        self.arcade = arcade.load() if arcade_tiles is None else arcade_tiles
        self.removal_limit = guard.Limiter(10, 3600.0)
        # Reads a repo's proof files; tests pass a fake. The real one makes an HTTP session lazily.
        self.proof_fetcher = proof_fetcher
        self.http: ClientSession | None = None
        # Sockets that have not signed in yet, per address. They are cheap but not free.
        self.pending: dict[str, int] = {}
        # A removed person can sign up again under a new name; their address stays out of
        # that table for a day. Shared addresses (one household) are blocked together.
        self.blocked: dict[str, dict[str, float]] = {}
        # Jackpot Mode: per-player earn trackers and shared ledger
        self.earn_trackers: dict[str, EarnTracker] = {}
        jackpot_db = sqlite3.connect(self.data_root / "jackpot.sqlite3", isolation_level=None)
        jackpot_db.row_factory = sqlite3.Row
        self.ledger = Ledger(jackpot_db)
        self.importmap_hash = base64.b64encode(hashlib.sha256(IMPORTMAP.encode()).digest()).decode()
        # Lobby requests. Presence is not built yet; until it attaches, status() is None.
        self.requests = play_requests.Service(
            self.store, self.rooms, play_requests.AppHub(self), clock=self.clock)
        play_requests.service = self.requests

    # Helpers -----------------------------------------------------------------

    def ip(self, request: web.Request) -> str:
        if self.trust_proxy:
            forwarded = request.headers.get("X-Real-IP") or ""
            if forwarded:
                return forwarded.strip()[:64]
        return request.remote or "?"

    def lock(self, room_id: str) -> asyncio.Lock:
        return self.locks.setdefault(room_id, asyncio.Lock())

    def me(self, request: web.Request) -> dict | None:
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return None
        return self.store.player_by_token(header[7:].strip())

    def me_or_refusal(self, request: web.Request, text: str = "Sign in as a player."):
        """(player, refusal). A suspended account gets a clear 403, not a bare 401.

        Without this, a suspended player who is still holding a token is told to
        sign in — which they cannot do — instead of being told why.
        """
        player = self.me(request)
        if player:
            return player, None
        header = request.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            row = self.store.db.execute(
                "SELECT id, suspended FROM players WHERE token_hash=?",
                (token_hash(header[7:].strip()),)).fetchone()
            if row and row["suspended"]:
                punishment = self.store.punishment(row["id"], "suspend")
                until = ""
                if punishment and punishment["until"]:
                    until = " until " + time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(punishment["until"]))
                return None, web.json_response(
                    {"error": "This account is suspended" + until + ".", "suspended": True}, status=403)
        return None, web.json_response({"error": text}, status=401)

    def role(self, room: dict, player_id: str) -> str:
        state = self.rooms.state(room) or {}
        seated = [side for side in ("white", "black") if state.get(f"{side}_id") == player_id]
        if seated:
            return "player"
        return "host" if player_id == room["host_id"] else "watcher"

    def room_summary(self, room: dict) -> dict:
        state = self.rooms.state(room) or {}
        host = self.store.player(room["host_id"]) or {"name": ""}
        seats = []
        for side in ("white", "black"):
            kind = str(state.get(side) or "")
            pid = str(state.get(f"{side}_id") or "")
            rating, games = self.store.rating_info(pid, room["game"])
            seats.append({
                "side": side, "level": str(state.get("level") or "") if kind == "local" or pid.startswith("bot:") else "",
                "rating": rating, "provisional": games < 10,
                "name": str(state.get(f"{side}_name") or ""),
                "kind": "local" if kind == "local" else "human",
                "open": kind != "local" and not state.get(f"{side}_id"),
                "bot": str(state.get(f"{side}_id") or "").startswith("bot:"),
            })
        title = next((card["title"] for card in self.cards if card["id"] == room["game"]), room["game"])
        return {
            "id": room["id"], "game": room["game"], "title": title, "host": host["name"], "host_id": room["host_id"],
            "public": bool(room["public"]), "closed": bool(room["closed"]), "bots_ok": bool(room.get("bots_ok")),
            "status": str(state.get("status") or "idle"), "plies": int(state.get("plies") or 0),
            "seats": seats, "watchers": len(self.conns.get(room["id"], ())),
            "spectators": sum(self.role(room, c.player["id"]) == "watcher" for c in self.conns.get(room["id"], ())),
            "level": str(state.get("level") or "") if any(x["kind"] == "local" or x["bot"] for x in seats) else "",
            "seed": int(room.get("seed") or 0), "open_league": bool(room.get("open_league")),
            "labels": self.rooms.labels(room), "pair": self.pair_block(room),
        }

    def pair_block(self, room: dict) -> dict:
        """The two-leg block for a ranked table: leg, seed, score, the other room."""
        pair = self.store.pair_for_room(room["id"]) if room.get("pair_id") else None
        if not pair:
            return {}
        return {"id": pair["id"], "leg": int(room.get("pair_leg") or 0), "legs": league.PAIR_LEGS,
                "seed": int(pair["seed"]), "rated": bool(pair["rated"]),
                "score": f"{pair['score_one']}-{pair['score_two']}",
                "other_room": pair["room_b"] if room["id"] == pair["room_a"] else pair["room_a"]}

    def start_pair(self, one: dict, two: dict, game: str, bots: bool, *, open_league: bool = False) -> dict | None:
        """One ranked match: two rooms, the same deal, the seats swapped.

        A single rating change follows both legs (``Store.settle_pair_leg``), so the pair
        is the rated game and a lucky seat cannot decide a rating on its own.

        ``open_league`` says the decision comes from an owner's own computer and the
        server only referees, so the seats get a longer clock and the unverified label.
        """
        open_league = open_league or league.talking(game)
        first = self.make_match(one, two, game, bots)
        second = self.make_match(two, one, game, bots) if first else None
        if not first or not second:
            for room in (first, second):
                if room:
                    self.store.close_room(room["id"])
            return None
        seed = int.from_bytes(hashlib.sha256(f"{first['id']}:{time.time_ns()}".encode()).digest()[:4], "big")
        pair = self.store.create_pair(game, seed, first["id"], second["id"], one["id"], two["id"],
                                      open_league=open_league)
        # A seated bot gets its clock when it connects, not when the table was made.
        self.rooms.turn_since.pop(first["id"], None)
        self.rooms.turn_since.pop(second["id"], None)
        return {"pair": pair, "first": first, "second": second}

    # HTTP --------------------------------------------------------------------

    async def index(self, request: web.Request) -> web.Response:
        page = (WEB / "index.html").read_text(encoding="utf-8").replace("__IMPORTMAP__", IMPORTMAP)
        return web.Response(text=page, content_type="text/html", headers=self.page_headers())

    def page_headers(self) -> dict:
        return {
            "Content-Security-Policy": (
                "default-src 'self'; "
                f"script-src 'self' 'sha256-{self.importmap_hash}'; "
                "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
            ),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-cache",
        }

    async def board_js(self, request: web.Request) -> web.Response:
        return web.FileResponse(BOARD_JS, headers={"Content-Type": "text/javascript", "Cache-Control": "no-cache"})

    async def health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "games": list(self.rooms.games), "connections": sum(map(len, self.conns.values()))})

    async def session(self, request: web.Request) -> web.Response:
        body = await _json(request)
        name, reason = guard.clean_name(body.get("name"))
        if not name:
            return web.json_response({"error": reason}, status=400)
        has_key = "key" in body
        self.store.expire_punishments(time.time())
        player = self.store.player_by_name(name)
        suspended = self.store.db.execute("SELECT id FROM players WHERE name = ? COLLATE NOCASE AND suspended = 1", (name,)).fetchone()
        if suspended:
            punishment = self.store.punishment(suspended['id'], 'suspend')
            if punishment:
                until = punishment['until']
                text = ('until ' + datetime.datetime.fromtimestamp(until, datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')) if until else 'permanently'
                return web.json_response({'error': f'This name is suspended {text}.', 'suspended': True}, status=403)
        if has_key:
            if not self.login_limit.allow(self.ip(request) + "|" + name.lower()):
                return web.json_response({"error": "Too many sign-in attempts."}, status=429)
            key = body.get("key")
            if not player or not self.store.verify_secret(player["id"], key):
                return web.json_response({"error": "That name and recovery key do not match.", "needs_key": True}, status=401)
            self.store.note_address(player["id"], self.ip(request))
            return web.json_response({"player": player, "token": key, "created": False})
        if player:
            return web.json_response({"error": "That name is taken. Enter its recovery key to sign in.", "needs_key": True}, status=409)
        if self.store.name_taken(name):
            return web.json_response({"error": "That name is too close to one already taken. Pick another."}, status=409)
        if self.store.address_blocked(self.ip(request)):
            return web.json_response({'error': 'New accounts cannot be made from here right now.'}, status=403)
        if not self.session_limit.allow(self.ip(request)):
            return web.json_response({"error": "Too many new players from here. Try later."}, status=429)
        try:
            player, token = self.store.create_player(name)
        except sqlite3.IntegrityError:
            return web.json_response({"error": "That name is taken. Enter its recovery key to sign in.", "needs_key": True}, status=409)
        self.store.note_address(player["id"], self.ip(request))
        return web.json_response({"player": player, "token": token, "created": True})

    async def get_me(self, request: web.Request) -> web.Response:
        player = self.me(request)
        if not player:
            return web.json_response({"error": "Not signed in."}, status=401)
        return web.json_response({"player": player, "stats": self.store.stats(player["id"]), "recovery": True})

    async def post_me(self, request: web.Request) -> web.Response:
        player = self.me(request)
        if not player:
            return web.json_response({"error": "Not signed in."}, status=401)
        body = await _json(request)
        name = None
        if "name" in body:
            name, reason = guard.clean_name(body.get("name"))
            if not name:
                return web.json_response({"error": reason}, status=400)
            if self.store.name_taken(name, except_id=player["id"]):
                return web.json_response({"error": "That name is too close to one already taken. Pick another."}, status=409)
            wait = self.store.rename_wait(player) if name.lower() != player["name"].lower() else 0
            if wait:
                days = max(1, int(-(-wait // 86400)))
                return web.json_response({"error": f"Names stick for {RENAME_DAYS} days. "
                                                   f"You can rename again in {days} day{'s' if days != 1 else ''}."}, status=429)
        public = bool(body["public"]) if "public" in body else None
        try:
            updated = self.store.update_player(player["id"], name=name, public=public)
        except sqlite3.IntegrityError:
            return web.json_response({"error": "Someone already has that name. Pick another."}, status=409)
        return web.json_response({"player": updated})

    async def games(self, request: web.Request) -> web.Response:
        return web.json_response({"games": self.cards})

    # Reports and personal blocks ---------------------------------------------

    async def report(self, request: web.Request) -> web.Response:
        """A player flags a message, a name or a bot. Anyone signed in may report."""
        player, refusal = self.me_or_refusal(request, "Sign in as a player to report.")
        if refusal:
            return refusal
        if player.get("bot"):
            return web.json_response({"error": "Sign in as a player to report."}, status=401)
        body = await _json(request)
        kind = str(body.get("kind") or "").strip().lower()
        if kind not in {"message", "name", "bot"}:
            return web.json_response({"error": "Pick what you are reporting."}, status=400)
        reason = " ".join(str(body.get("reason") or "").split())[:60]
        room_id = str(body.get("room_id") or "")[:32]
        try:
            message_id = int(body.get("message_id") or 0)
        except (TypeError, ValueError):
            return web.json_response({"error": "Bad message id."}, status=400)
        target_id = str(body.get("target_id") or "")[:64]
        target_name = " ".join(str(body.get("target_name") or "").split())[:40]
        text = ""
        if kind == "message":
            row = self.store.db.execute("SELECT * FROM chat WHERE id = ?", (message_id,)).fetchone()
            if not row:
                return web.json_response({"error": "No such message."}, status=404)
            target_id, target_name = row["player_id"], row["name"]
            room_id = row["room_id"]
            text = "removed by a moderator" if row["removed"] else row["text"]
        elif target_id:
            target = self.store.player(target_id)
            if not target:
                return web.json_response({"error": "No such account."}, status=404)
            target_name = target_name or target["name"]
        if not target_id:
            return web.json_response({"error": "Pick what you are reporting."}, status=400)
        if target_id == player["id"]:
            return web.json_response({"error": "That one is yours."}, status=400)
        already = self.store.db.execute(
            "SELECT 1 FROM reports WHERE reporter_id = ? AND target_id = ? AND message_id = ? AND state = 'open'",
            (player["id"], target_id, message_id)).fetchone()
        if already:
            return web.json_response({"ok": True, "text": "You already reported that. A moderator will look."})
        cursor = self.store.db.execute(
            "INSERT INTO reports (kind, target_id, target_name, message_id, room_id, reporter_id,"
            " reporter_name, text, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (kind, target_id, target_name, message_id, room_id, player["id"], player["name"],
             text[:300], reason, time.time()))
        log.info("report %s: %s by %s", kind, target_id, player["id"])
        return web.json_response({"ok": True, "text": "Reported. A moderator will look at it.",
                                  "id": cursor.lastrowid})

    async def blocks(self, request: web.Request) -> web.Response:
        """The player's own block list. Hides that person's chat and invites here."""
        player = self.me(request)
        if not player or player.get("bot"):
            return web.json_response({"error": "Sign in as a player."}, status=401)
        if request.method == "GET":
            rows = self.store.db.execute(
                "SELECT p.id, p.name FROM blocks b JOIN players p ON p.id = b.blocked_id"
                " WHERE b.player_id = ? ORDER BY p.name", (player["id"],)).fetchall()
            return web.json_response({"blocked": [dict(row) for row in rows]})
        if request.method == "DELETE":
            target = request.match_info.get("player", "")
            self.store.db.execute("DELETE FROM blocks WHERE player_id = ? AND blocked_id = ?",
                                  (player["id"], target))
            return web.json_response({"ok": True, "text": "Unblocked."})
        body = await _json(request)
        target = self.store.player(str(body.get("player_id") or "")) or \
            self.store.player_by_name(str(body.get("name") or "").strip())
        if not target:
            return web.json_response({"error": "No such name."}, status=404)
        if target["id"] == player["id"]:
            return web.json_response({"error": "You cannot block yourself."}, status=400)
        self.store.db.execute(
            "INSERT OR IGNORE INTO blocks (player_id, blocked_id, at) VALUES (?, ?, ?)",
            (player["id"], target["id"], time.time()))
        return web.json_response({"ok": True, "text": f"{target['name']} is blocked."})

    # Bots --------------------------------------------------------------------

    def bot_owner(self, request: web.Request) -> tuple[dict | None, web.Response | None]:
        player = self.me(request)
        if not player:
            return None, web.json_response({"error": "Not signed in."}, status=401)
        if player.get("bot"):
            return None, web.json_response({"error": "A bot cannot own bots."}, status=403)
        return player, None

    async def list_bots(self, request: web.Request) -> web.Response:
        owner, refused = self.bot_owner(request)
        if refused:
            return refused
        return web.json_response({"bots": self.store.bots_of(owner["id"]), "limit": BOTS_PER_OWNER})

    async def create_bot(self, request: web.Request) -> web.Response:
        owner, refused = self.bot_owner(request)
        if refused:
            return refused
        if self.store.address_blocked(self.ip(request)):
            return web.json_response({"error": "New accounts cannot be made from here right now."}, status=403)
        if not self.session_limit.allow(self.ip(request)):
            return web.json_response({"error": "Too many new accounts from here. Try later."}, status=429)
        body = await _json(request)
        # No await between this count and the insert, so parallel requests cannot pass it together.
        if len(self.store.bots_of(owner["id"])) >= BOTS_PER_OWNER:
            return web.json_response({"error": f"You can have {BOTS_PER_OWNER} bots. Remove one first."}, status=400)
        name, reason = guard.clean_name(body.get("name"))
        if not name:
            return web.json_response({"error": reason}, status=400)
        if self.store.name_taken(name):
            return web.json_response({"error": "Someone already has that name. Pick another."}, status=409)
        try:
            bot, key = self.store.create_bot(owner["id"], name)
        except sqlite3.IntegrityError:
            return web.json_response({"error": "Someone already has that name. Pick another."}, status=409)
        log.info("bot created: %s by %s", bot["id"], owner["id"])
        return web.json_response({"bot": bot, "key": key})

    async def delete_bot(self, request: web.Request) -> web.Response:
        owner, refused = self.bot_owner(request)
        if refused:
            return refused
        if not self.store.remove_bot(owner["id"], request.match_info["bot"]):
            return web.json_response({"error": "No such bot of yours."}, status=404)
        bot_id = request.match_info["bot"]
        self.queue.remove(bot_id)
        for conns in list(self.conns.values()):
            for conn in list(conns):
                if conn.player["id"] == bot_id:
                    await _send(conn.ws, {"t": "closed", "text": "This bot was switched off by its owner."})
                    await conn.ws.close()
        return web.json_response({"ok": True})

    # Arcade ------------------------------------------------------------------

    def arcade_tile(self, tile_id: object, repo: object = None) -> dict | None:
        """By id, or (to finish a removal after the tile is hidden) by its repo name."""
        for tile in self.arcade:
            if tile["listed"] and (tile["id"] == tile_id or (not tile_id and arcade.same_repo(repo, tile["repo"]))):
                return tile
        return None

    async def arcade_list(self, request: web.Request) -> web.Response:
        hidden = self.store.hidden_tiles()
        tiles = [{key: value for key, value in tile.items() if key != "listed"}
                 for tile in self.arcade if tile["listed"] and tile["id"] not in hidden]
        return web.json_response({"tiles": tiles, "removal_days": arcade.REMOVAL_DAYS})

    async def arcade_remove(self, request: web.Request) -> web.Response:
        if not self.removal_limit.allow(self.ip(request)):
            return web.json_response({"error": "Too many removal requests from here. Try later."}, status=429)
        body = await _json(request)
        tile = self.arcade_tile(body.get("id"), body.get("repo"))
        if not tile:
            return web.json_response({"error": "No game on the shelf has that repo." if not body.get("id") else "No such game on the shelf."}, status=404)
        if not tile["repo"]:
            return web.json_response({"error": "This one has no GitHub repo to check. Contact the Game Center admins."}, status=400)
        if not arcade.same_repo(body.get("repo"), tile["repo"]):
            return web.json_response({"error": "That is not this game's repo. Type it exactly, like owner/name."}, status=400)
        removal = self.store.add_removal(tile["id"], arcade.new_code())
        log.info("arcade removal requested: %s (%s)", tile["id"], tile["repo"])
        return web.json_response({"id": tile["id"], "repo": tile["repo"], "code": removal["code"], "proven": bool(removal["proven"]),
                                  "days": arcade.REMOVAL_DAYS})

    async def arcade_check(self, request: web.Request) -> web.Response:
        if not self.removal_limit.allow(self.ip(request)):
            return web.json_response({"error": "Too many checks from here. Try later."}, status=429)
        body = await _json(request)
        tile = self.arcade_tile(body.get("id"))
        removal = self.store.removal(tile["id"]) if tile else None
        if not tile or not removal:
            return web.json_response({"error": "No removal request for that game."}, status=404)
        if not removal["proven"]:
            texts = await self.fetch_proof(tile["repo"])
            if not any(removal["code"] in text for text in texts):
                return web.json_response({"proven": False, "text": "Code not found yet. GitHub can take a few minutes to show a change; try again soon."})
            self.store.prove_removal(tile["id"], removal["code"])
            log.info("arcade removal proven: %s (%s)", tile["id"], tile["repo"])
        return web.json_response({"proven": True, "text": "Ownership confirmed. The game stays off the shelf. You can delete the code now."})

    async def fetch_proof(self, repo: str) -> list[str]:
        if self.proof_fetcher:
            return await self.proof_fetcher(repo)
        if self.http is None:
            self.http = ClientSession(timeout=ClientTimeout(total=10))
        return await arcade.fetch_proof(self.http, repo)

    def queue_lists(self):
        now = self.clock()
        self.queue.prune(now)
        humans = {game: [] for game in CURATED}
        bots = {game: [] for game in CURATED}
        for e in sorted(self.queue.entries.values(), key=lambda x: (x["joined"], x["player_id"])):
            target = bots if e["pool"] == "bot" else humans
            target[e["game"]].append({"id": e["player_id"], "name": e["name"], "kind": e["pool"], "level": e["level"], "rating": e["rating"], "provisional": e["games"] < 10, "since": max(0, int(now - e["joined"]))})
        return humans, bots

    async def lobby(self, request: web.Request) -> web.Response:
        humans, bots = self.queue_lists()
        open_rooms = self.store.open_rooms(public_only=True, since=time.time() - LOBBY_HOURS * 3600)
        viewer = self.me(request)
        if viewer:
            blocked = {row[0] for row in self.store.db.execute(
                "SELECT blocked_id FROM blocks WHERE player_id = ?", (viewer["id"],))}
            if blocked:
                # A blocked person's tables and invites stay out of the blocker's lobby.
                open_rooms = [room for room in open_rooms if room["host_id"] not in blocked]
        rooms = [self.room_summary(room) for room in open_rooms]
        # Who is playing is for people who signed in. A visitor still gets the tables,
        # the counts and the ladder, never a roster of names.
        presence = {}
        if viewer:
            for kind, queues in (("human", humans), ("bot", bots)):
                for game, entries in queues.items():
                    for entry in entries:
                        presence.setdefault(entry["id"], {**{k: entry[k] for k in ("id", "name", "level", "rating", "provisional")}, "game": game, "kind": kind})
            for room, summary in zip(open_rooms, rooms):
                state = self.rooms.state(room) or {}
                for seat in summary["seats"]:
                    pid = str(state.get(f"{seat['side']}_id") or "")
                    if pid and seat["name"]:
                        presence.setdefault(pid, {"id": pid, "name": seat["name"], "game": room["game"],
                                                  "kind": "bot" if seat["bot"] or seat["kind"] == "bot" else "human",
                                                  "level": seat["level"], "rating": seat["rating"],
                                                  "provisional": seat["provisional"]})
                host_id = room["host_id"]
                if host_id and summary["host"] and host_id not in presence:
                    host = self.store.player(host_id) or {}
                    rating, count = self.store.rating_info(host_id, room["game"])
                    presence[host_id] = {"id": host_id, "name": summary["host"], "game": room["game"],
                                         "kind": "bot" if host.get("bot") or host_id.startswith("bot:") else "human",
                                         "level": "", "rating": rating, "provisional": count < 10}
            # Appearing offline is off this list too: a person who is not in the lobby is
            # not in it here either, whether or not they are queued or sitting at a table.
            for pid in self.store.invisible_ids(presence):
                presence.pop(pid, None)
        roster = {kind + "s": sorted((p for p in presence.values() if p["kind"] == kind),
                                       key=lambda p: (p["name"].casefold(), p["name"], p["id"]))[:40]
                  for kind in ("human", "bot")}
        ladder = {}
        for card in self.cards:
            rows = self.store.leaderboard(card["id"], "bots")[:8]
            ladder[card["id"]] = [{**{k: row[k] for k in ("id", "name", "rating", "wins", "losses", "draws")},
                                    "provisional": row["games"] < 10} for row in rows]
        games = []
        for card in self.cards:
            matching = [r for r in rooms if r["game"] == card["id"]]
            games.append({"id": card["id"], "title": card["title"], "open_tables": sum(any(s["open"] for s in r["seats"]) for r in matching), "playing": sum(r["status"] == "active" and not any(s["open"] for s in r["seats"]) for r in matching), "waiting": len(humans[card["id"]]), "bots_waiting": len(bots[card["id"]])})
        return web.json_response({"rooms": rooms, "games": games, "looking": {g: len(humans[g]) for g in CURATED}, "looking_bots": {g: len(bots[g]) for g in CURATED}, "waiting": humans if viewer else {}, "bots_waiting": bots if viewer else {}, "presence": roster if viewer else {"humans": [], "bots": []}, "ladder": ladder})

    async def lobby_chat(self, request: web.Request) -> web.Response:
        if request.method == "GET":
            # Nothing older than the day the lobby keeps: the janitor deletes it, and
            # the answer never carries it even in the moment before the sweep.
            messages = self.store.recent_chat("__lobby__", 50, since=time.time() - LOBBY_HOURS * 3600)
            player = self.me(request)
            if player:
                blocked = {r[0] for r in self.store.db.execute("SELECT blocked_id FROM blocks WHERE player_id=?", (player["id"],))}
                messages = [m for m in messages if m["player_id"] not in blocked]
            return web.json_response({"messages": messages})
        player, refusal = self.me_or_refusal(request, "Sign in as a player to chat.")
        if refusal:
            return refusal
        if player.get("bot"):
            return web.json_response({"error": "Sign in as a player to chat."}, status=401)
        if self.store.silenced(player["id"]):
            return web.json_response({"error": "You are silenced."}, status=403)
        if not self.lobby_chat_limit.allow(player["id"]):
            return web.json_response({"error": "You are sending messages too fast."}, status=429)
        body = await _json(request)
        text, reason = guard.clean_chat(body.get("text"))
        if not text:
            return web.json_response({"error": reason}, status=400)
        message = self.store.add_chat("__lobby__", player["id"], player["name"], "player", text)
        return web.json_response({"message": {k: message[k] for k in ("id", "name", "role", "text", "at")}})

    async def leaderboard(self, request: web.Request) -> web.Response:
        game = request.query.get("game", "connect4")
        pool = request.query.get("pool", "humans")
        if game not in self.rooms.games or pool not in ("humans", "bots"):
            return web.json_response({"error": "Unknown game or pool."}, status=400)
        return web.json_response({"game": game, "rows": self.store.leaderboard(game, pool)})

    async def jackpot_leaderboard(self, request: web.Request) -> web.Response:
        try:
            wanted = int(request.query.get("limit", "50"))
        except (TypeError, ValueError):
            wanted = 50
        # Clamp in both directions: a negative LIMIT is SQLite's "no limit", so the
        # old `min(int(...), 500)` let a public caller read the whole ledger.
        limit = max(1, min(500, wanted))
        rows = self.ledger.get_leaderboard(limit=limit)
        return web.json_response({"rows": rows})

    async def bot_career(self, request):
        bot_id = request.match_info["bot"]
        career = self.store.bot_career(bot_id) if len(bot_id) <= 80 else None
        return web.json_response({"career": career}) if career else web.json_response({"error": "No such bot."}, status=404)

    async def passports(self, request: web.Request) -> web.Response:
        """Public bot passports: a name, an owner, and the ratings it has earned.

        No key material and no owner contact, so challenging a bot cannot turn into
        pestering its owner. One row per bot, with its games sorted by rating.
        """
        rows = self.store.db.execute(
            "SELECT p.id, p.name, p.created, o.name AS owner FROM players p "
            "LEFT JOIN players o ON o.id = p.owner_id "
            "WHERE p.bot = 1 AND p.suspended = 0 ORDER BY p.name"
        ).fetchall()
        found = []
        for row in rows:
            games = [{"game": rating["game"], "rating": round(rating["rating"]), "games": rating["games"],
                      "wins": rating["wins"], "losses": rating["losses"], "draws": rating["draws"],
                      "provisional": rating["games"] < 10}
                     for rating in self.store.db.execute(
                         "SELECT game, rating, games, wins, losses, draws FROM bot_ratings "
                         "WHERE player_id = ? ORDER BY rating DESC", (row["id"],))]
            found.append({"id": row["id"], "name": row["name"], "owner": row["owner"] or "",
                          "created": row["created"], "games": games,
                          "rated_games": sum(game["games"] for game in games)})
        found.sort(key=lambda bot: (-max([game["rating"] for game in bot["games"]] or [0]), bot["name"].lower()))
        return web.json_response({"passports": found[:60]})

    def make_match(self, white, black, game, bots):
        if self.store.open_room_count() >= MAX_OPEN_ROOMS:
            return None
        host = self.store.player(white["owner_id"]) if bots else white
        if host and self.store.rooms_hosted_since(host["id"], time.time() - 3600) >= MAX_ROOMS_PER_HOUR:
            return None
        room, reason = self.rooms.create(game, host, True, "two", bots_ok=bots) if host else (None, "No owner.")
        if not room:
            return None
        if bots:
            ok = self.rooms.run(room, host, "leave", [])["ok"] and self.rooms.run(room, white, "sit", ["white"])["ok"] and self.rooms.run(room, black, "sit", ["black"])["ok"]
            if ok:
                # Only ladder-created games are rated and clocked; a casual bots table is not.
                # The move clock starts when a seated bot actually connects, so a slow
                # connection is not mistaken for a slow move.
                self.store.mark_ladder(room["id"], True)
                # settle() stamped the room when it was created; the ladder clock waits for
                # the first seated bot to connect.
                self.rooms.turn_since.pop(room["id"], None)
        else:
            ok = self.rooms.run(room, black, "join", [])["ok"]
        if not ok:
            self.store.close_room(room["id"])
            return None
        return room

    def match_queue(self, game, pool):
        now = self.clock()
        for key, item in list(self.queue.entries.items()):
            if item["game"] == game and item["pool"] == pool and not self.store.is_active(item["player_id"]):
                self.queue.entries.pop(key, None)
                self.queue.reports.pop(item["player_id"], None)
        for a, b in self.queue.match(game, pool, now):
            white, black = self.store.player(a["player_id"]), self.store.player(b["player_id"])
            if not white or not black:
                room = None
            elif league.ranked(game, self.rooms.games):
                # A ranked match is a pair: the same deal twice, the seats swapped.
                made = self.start_pair(white, black, game, pool == "bot",
                                       open_league=bool(a.get("open_league") or b.get("open_league")))
                room = made["first"] if made else None
            else:
                room = self.make_match(white, black, game, pool == "bot")
            if room:
                for e, side in ((a, "white"), (b, "black")):
                    self.queue.reports[e["player_id"]] = (now, {"room": self.room_summary(room), "side": side})
            else:
                for e in (a, b):
                    self.queue.entries[(pool, game, e["player_id"])] = e

    async def queue_endpoint(self, request):
        player, refusal = self.me_or_refusal(request, "Not signed in.")
        if refusal:
            return refusal
        if not self.queue_limit.allow(player["id"]):
            return web.json_response({"error": "Too many requests."}, status=429)
        now = self.clock()
        self.queue.prune(now)
        if request.method == "DELETE":
            self.queue.remove(player["id"])
            return web.json_response({"queued": False})
        if request.method == "POST":
            body = await _json(request)
            game, level = body.get("game"), body.get("level", kit.DEFAULT_LEVEL)
            practice = body.get("practice_room", "")
            if not isinstance(game, str) or game not in self.rooms.games or game not in CURATED or not isinstance(level, str) or level not in kit.LEVELS or not isinstance(practice, str) or len(practice) > 80:
                return web.json_response({"error": "Invalid game, level or room."}, status=400)
            room = self.store.room(practice) if practice else None
            if practice and (not room or room["closed"] or room["host_id"] != player["id"]):
                return web.json_response({"error": "Invalid practice room."}, status=400)
            pool = "bot" if player.get("bot") else "human"
            key = (pool, game, player["id"])
            old = self.queue.entries.get(key)
            if not old:
                self.queue.remove(player["id"])
            rating, games = self.store.rating_info(player["id"], game)
            self.queue.entries[key] = {"player_id": player["id"], "name": player["name"], "pool": pool, "game": game, "level": level, "rating": rating, "games": games, "joined": old["joined"] if old else now, "seen": now, "practice_room": practice, "owner_id": player.get("owner_id", ""), "open_league": bool(body.get("open_league"))}
            waiting = sum(e["game"] == game and e["pool"] == pool for e in self.queue.entries.values())
            self.match_queue(game, pool)
            report = self.queue.reports.get(player["id"])
            if report:
                return web.json_response({"queued": False, "matched": report[1]})
            return web.json_response({"queued": True, "game": game, "since": max(0, int(now - self.queue.entries[key]["joined"])), "waiting": waiting, "matched": None})
        entry = next((e for e in self.queue.entries.values() if e["player_id"] == player["id"]), None)
        waiting = 0
        if entry:
            entry["seen"] = now
            waiting = sum(e["game"] == entry["game"] and e["pool"] == entry["pool"] for e in self.queue.entries.values())
            self.match_queue(entry["game"], entry["pool"])
            if (entry["pool"], entry["game"], player["id"]) not in self.queue.entries:
                entry = None
        report = self.queue.reports.get(player["id"])
        return web.json_response({"queued": bool(entry), "game": entry["game"] if entry else "", "since": max(0, int(now - entry["joined"])) if entry else 0, "waiting": waiting, "matched": report[1] if report else None, "practice_room": entry["practice_room"] if entry else ""})

    async def alerts(self, request):
        player = self.me(request)
        if not player:
            return web.json_response({"error": "Not signed in."}, status=401)
        if not self.alert_limit.allow(player["id"]):
            return web.json_response({"error": "Too many requests."}, status=429)
        if request.method == "POST":
            if player.get("bot"):
                return web.json_response({"error": "Bots cannot set alerts."}, status=403)
            body = await _json(request)
            prefs = body.get("prefs") if "prefs" in body else {body.get("game"): body.get("enabled")}
            if not isinstance(prefs, dict) or any(g not in CURATED or not isinstance(v, bool) for g, v in prefs.items()):
                return web.json_response({"error": "Invalid preferences."}, status=400)
            for game, enabled in prefs.items():
                self.store.db.execute("INSERT INTO alert_prefs VALUES (?, ?, ?, ?) ON CONFLICT(player_id, game) DO UPDATE SET enabled=excluded.enabled, updated=excluded.updated", (player["id"], game, int(enabled), self.clock()))
        prefs = {g: False for g in CURATED}
        prefs.update({r["game"]: bool(r["enabled"]) for r in self.store.db.execute("SELECT game, enabled FROM alert_prefs WHERE player_id = ?", (player["id"],)) if r["game"] in prefs})
        if request.method == "POST":
            return web.json_response({"prefs": prefs})
        humans, _ = self.queue_lists()
        alerts = []
        for game, enabled in prefs.items():
            if not enabled or not humans[game]:
                continue
            row = self.store.db.execute("SELECT at FROM alert_sent WHERE player_id = ? AND game = ?", (player["id"], game)).fetchone()
            now = self.clock()
            if row and now - row[0] < 600:
                continue
            self.store.db.execute("INSERT INTO alert_sent VALUES (?, ?, ?) ON CONFLICT(player_id, game) DO UPDATE SET at=excluded.at", (player["id"], game, now))
            alerts.append({"game": game, "waiting": len(humans[game]), "at": now})
        return web.json_response({"prefs": prefs, "games": list(CURATED), "cooldown_seconds": 600, "alerts": alerts})

    async def balance(self, request: web.Request) -> web.Response:
        """This account's own chips and points, as its own computer reports them.

        Self-reported play money for a later migration: the server stores the latest
        pair and a short history of how it moved, and nothing here is ever a
        leaderboard, a rating or a match result. ``GET`` returns the account's own row;
        ``POST`` writes it, at most once every ten seconds per account. A refused write
        (bad values) does not spend that budget, so a fixed client can retry at once.
        """
        player, refusal = self.me_or_refusal(request, "Sign in to record a balance.")
        if refusal:
            return refusal
        if request.method == "GET":
            row = self.store.balance(player["id"])
            if not row:
                row = {"player_id": player["id"], "chips": 0, "points": 0, "updated": 0.0}
            return web.json_response({"balance": row})
        body = await _json(request)
        chips, points = body.get("chips"), body.get("points")
        if not _count(chips) or not _count(points):
            return web.json_response(
                {"error": "Chips and points must be whole numbers of 0 or more."}, status=400)
        if not self.balance_limit.allow(player["id"]):
            return web.json_response({"error": "Too many balance updates. Try again in a moment."}, status=429)
        row = self.store.set_balance(player["id"], int(chips), int(points), self.clock())
        return web.json_response({"ok": True, "balance": row})

    async def ladder(self, request):
        caller = self.me(request)
        if not caller:
            header = request.headers.get("Authorization", "")
            if header.startswith("Bearer "):
                row = self.store.db.execute("SELECT id FROM players WHERE token_hash=? AND suspended=1", (token_hash(header[7:].strip()),)).fetchone()
                if row:
                    return web.json_response({"error": "This account is suspended."}, status=403)
            return web.json_response({"error": "Not signed in."}, status=401)
        if not self.ladder_limit.allow(caller["id"]):
            return web.json_response({"error": "Too many ladder challenges. Try again in a minute."}, status=429)
        body = await _json(request)
        game, opponent = body.get("game"), body.get("opponent")
        white_id = caller["id"] if caller.get("bot") else body.get("white")
        if not isinstance(game, str) or game not in self.rooms.games or not all(isinstance(x, str) and len(x) <= 80 for x in (opponent, white_id)):
            return web.json_response({"error": "Invalid game or bot."}, status=400)
        if not league.ranked(game, self.rooms.games):
            return web.json_response({"error": f"{game} is casual only. Rated games are Go, Hex, Breakthrough, Reversi, Chess, Liar's Dice, Mafia, Prisoner's Dilemma, Auction, Doctrine and Arena."}, status=400)
        white, black = self.store.player(white_id), self.store.player(opponent)
        active = {r["id"] for r in self.store.db.execute("SELECT id FROM players WHERE bot = 1 AND suspended = 0 AND id IN (?, ?)", (white_id, opponent))}
        if not white or not black or white_id not in active or opponent not in active or (not caller.get("bot") and white["owner_id"] != caller["id"]):
            return web.json_response({"error": "Invalid bot."}, status=400)
        if not white["owner_id"] or white["owner_id"] == black["owner_id"] or not black["owner_id"]:
            return web.json_response({"error": "Bots from the same owner cannot play a rated ladder game."}, status=400)
        if self.store.pair_rated_today(game, white_id, opponent) >= 3:
            return web.json_response({"error": "Daily pair limit reached."}, status=429)
        if self.store.open_room_count() >= MAX_OPEN_ROOMS:
            return web.json_response({"error": "Game Center is full right now. Try again soon."}, status=503)
        host = self.store.player(white["owner_id"])
        if host and self.store.rooms_hosted_since(host["id"], time.time() - 3600) >= MAX_ROOMS_PER_HOUR:
            return web.json_response({"error": "That is a lot of tables. Try again in a while."}, status=429)
        made = self.start_pair(white, black, game, True, open_league=bool(body.get("open_league")))
        if not made:
            return web.json_response({"error": "Could not seat bots."}, status=400)
        first = self.store.room(made["first"]["id"]) or made["first"]
        open_league = bool(body.get("open_league")) or league.talking(game)
        return web.json_response({"room": self.room_summary(first), "rated": True, "side": "white",
                                  "bot": white_id, "pair": self.pair_block(first),
                                  "legs": league.PAIR_LEGS, "open_league": open_league,
                                  "move_seconds": league.OPEN_LEAGUE_MOVE_SECONDS if open_league else league.RANKED_MOVE_SECONDS,
                                  "badge": league.OPEN_LEAGUE_BADGE if open_league else ""})

    async def create_room(self, request: web.Request) -> web.Response:
        player = self.me(request)
        if not player:
            return web.json_response({"error": "Pick a name first."}, status=401)
        if self.store.open_room_count() >= MAX_OPEN_ROOMS:
            return web.json_response({"error": "Game Center is full right now. Try again soon."}, status=503)
        if self.store.rooms_hosted_since(player["id"], time.time() - 3600) >= MAX_ROOMS_PER_HOUR:
            return web.json_response({"error": "That is a lot of tables. Try again in a while."}, status=429)
        body = await _json(request)
        level = str(body.get("level") or "")
        if level and level not in kit.LEVELS:
            level = kit.LEVEL_ALIASES.get(level, level)  # old easy/normal/hard still seat a table
        if level and level not in kit.LEVELS:
            return web.json_response({"error": "Pick a level: beginner, intermediate, advanced or expert."}, status=400)
        room, reason = self.rooms.create(str(body.get("game") or ""), player, bool(body.get("public")),
                                         str(body.get("mode") or "two"), bots_ok=bool(body.get("bots")), level=level)
        if not room:
            return web.json_response({"error": reason}, status=400)
        return web.json_response({"room": self.room_summary(room), "invites": self.store.live_invites(room["id"])})

    async def get_room(self, request: web.Request) -> web.Response:
        room = self.store.room(request.match_info["room"])
        if not room:
            return web.json_response({"error": "No such table."}, status=404)
        summary = self.room_summary(room)
        caller = self.me(request)
        seated = {str((self.rooms.state(room) or {}).get(f"{side}_id") or "") for side in ("white", "black")}
        summary["spectate"] = bool(caller and caller["id"] not in seated) or not caller
        return web.json_response({"room": summary})

    async def availability(self, request: web.Request) -> web.Response:
        """GET/POST /api/availability — the signed-in player's open flag and games."""
        player, refusal = self.me_or_refusal(request)
        if refusal:
            return refusal
        if request.method == "POST":
            body = await _json(request)
            frame: dict = {"t": "prefs"}
            if isinstance(body.get("op"), str):
                frame["op"] = body["op"]
            if "open" in body:
                frame["open"] = body["open"]
            if "games" in body:
                frame["games"] = body["games"]
            if "invisible" in body:
                frame["invisible"] = body["invisible"]
            if "open" in frame or "games" in frame or "invisible" in frame:
                ack = await self.requests.handle(player, frame)
                if not ack["ok"]:
                    return _ack_response(ack)
        return web.json_response(self.requests.prefs(player["id"]))

    async def play_requests(self, request: web.Request) -> web.Response:
        """GET /api/requests, or POST /api/requests {to, game}."""
        player, refusal = self.me_or_refusal(request)
        if refusal:
            return refusal
        if request.method == "GET":
            return web.json_response({"requests": self.requests.pending_for(player["id"])})
        body = await _json(request)
        frame = {"t": "request", "to": body.get("to"), "game": body.get("game")}
        if isinstance(body.get("op"), str):
            frame["op"] = body["op"]
        ack = await self.requests.handle(player, frame)
        if not ack["ok"]:
            return _ack_response(ack)
        made = next((item for item in reversed(self.requests.pending_for(player["id"]))
                     if item["from"]["id"] == player["id"] and item["to"]["id"] == body.get("to")
                     and item["game"] == body.get("game")), None)
        return web.json_response({"ok": True, "text": ack.get("text") or "", "request": made})

    async def play_request(self, request: web.Request) -> web.Response:
        """POST /api/requests/{id} {accept: bool} or {cancel: true}."""
        player, refusal = self.me_or_refusal(request)
        if refusal:
            return refusal
        body = await _json(request)
        rid = request.match_info["id"]
        op = body.get("op") if isinstance(body.get("op"), str) else ""
        if body.get("cancel") is True:
            frame = {"t": "cancel", "id": rid, "op": op}
        elif "accept" in body:
            frame = {"t": "respond", "id": rid, "accept": body.get("accept"), "op": op}
        else:
            return web.json_response(
                {"ok": False, "text": "Say whether you accept or cancel.",
                 "error": "Say whether you accept or cancel."}, status=400)
        ack = await self.requests.handle(player, frame)
        if not ack["ok"]:
            return _ack_response(ack)
        return web.json_response({"ok": True, "text": ack.get("text") or ""})

    # Leagues, pairings and watchers -----------------------------------------

    def live_bot_rooms(self, *, open_league: bool = False) -> list[dict]:
        """Rooms where two bots are mid-game. Never a room with a person in it."""
        found = []
        for room in self.store.open_rooms(public_only=True, since=time.time() - LOBBY_HOURS * 3600):
            if open_league and not room.get("open_league"):
                continue
            state = self.rooms.state(room) or {}
            if state.get("status") != "active":
                continue
            seats = [str(state.get(f"{side}_id") or "") for side in ("white", "black")]
            if not all(seat.startswith("bot:") for seat in seats):
                continue
            summary = self.room_summary(room)
            summary["watch_url"] = f"/t/{room['id']}"
            summary["turn"] = str(state.get("turn") or "")
            found.append(summary)
        return found[:20]

    def game_row(self, game: str) -> dict:
        return {"id": game, "title": self.title_of(game), "rated": league.ranked(game, self.rooms.games),
                "label": league.label(game, self.rooms.games), "move_seconds": league.move_seconds(game),
                "talking": league.talking(game)}

    def title_of(self, game: str) -> str:
        return next((card["title"] for card in self.cards if card["id"] == game), game)

    async def ladder_summary(self, request: web.Request) -> web.Response:
        split = league.split(tuple(self.rooms.games))
        return web.json_response({
            "ranked_games": [self.game_row(game) for game in split["ranked"]],
            "casual_games": [self.game_row(game) for game in split["casual"]],
            "other_games": [self.game_row(game) for game in split["other"]],
            "pair_legs": league.PAIR_LEGS,
            "future_ranked": list(league.FUTURE_RANKED),
            "open_league": {"badge": league.OPEN_LEAGUE_BADGE,
                            "move_seconds": league.OPEN_LEAGUE_MOVE_SECONDS,
                            "games": [self.game_row(game) for game in split["ranked"] if league.talking(game)]},
            "stock": stock.summary(),
            "live": self.live_bot_rooms(),
        })

    async def open_league(self, request: web.Request) -> web.Response:
        available = tuple(self.rooms.games)
        games = [self.game_row(game) for game in available if league.ranked(game, available)]
        for row in games:
            row["move_seconds"] = league.OPEN_LEAGUE_MOVE_SECONDS
        caller = self.me(request)
        mine = []
        if caller:
            ids = {caller["id"]}
            if not caller.get("bot"):
                ids.update(bot["id"] for bot in self.store.bots_of(caller["id"]))
            for room in self.store.open_rooms(public_only=True, since=time.time() - LOBBY_HOURS * 3600):
                if not room.get("open_league"):
                    continue
                state = self.rooms.state(room) or {}
                if ids & {str(state.get(f"{side}_id") or "") for side in ("white", "black")}:
                    mine.append(self.room_summary(room))
        return web.json_response({
            "badge": league.OPEN_LEAGUE_BADGE,
            "move_seconds": league.OPEN_LEAGUE_MOVE_SECONDS,
            "text": ("Everyone here plays from their own computer. The server only referees and "
                     "keeps the clock, so a seat cannot be checked: self-hosted, unverified."),
            "how": "Ask for a rated game with open_league true, or enter the ladder from your own Hermes.",
            "games": games,
            "live": self.live_bot_rooms(open_league=True),
            "my_matches": mine,
            "talking_games": {
                "state": "design-only",
                "text": ("Liar's Dice, Mafia, Prisoner's Dilemma and Auction are talking games: they "
                         "run on a person's machine, and the server has no referee for them yet. They "
                         "join this league when the server can referee every decision itself."),
                "games": [{"id": game, "title": game.replace("-", " ").title()} for game in league.TALKING_GAMES],
            },
        })

    async def spectate(self, request: web.Request) -> web.Response:
        game = str(request.query.get("game") or "").strip().lower()
        live = self.live_bot_rooms()
        if game:
            live = [room for room in live if room["game"] == game]
        return web.json_response({"live": live, "count": len(live)})

    async def match_replay(self, request: web.Request) -> web.Response:
        room_id = str(request.match_info["room"])
        try:
            match_no = int(request.match_info["no"])
        except (TypeError, ValueError):
            return web.json_response({"error": "No such match."}, status=404)
        row = self.store.match(room_id, match_no)
        if not row:
            return web.json_response({"error": "No such match."}, status=404)
        moves = json.loads(row["moves"] or "[]")
        return web.json_response({
            "match": {"room": room_id, "match_no": match_no, "game": row["game"],
                      "white": row["white_name"], "black": row["black_name"],
                      "white_kind": row["white_kind"], "black_kind": row["black_kind"],
                      "winner": row["winner"], "reason": row["reason"], "plies": row["plies"],
                      "rated": bool(row["rated"]), "finished": row["finished"]},
            "replay": {"kind": "moves", "moves": moves},
        })

    async def stock_league(self, request: web.Request) -> web.Response:
        return web.json_response(stock.summary())

    async def challenges(self, request: web.Request) -> web.Response:
        caller = self.me(request)
        if not caller:
            return web.json_response({"error": "Not signed in."}, status=401)
        bots = [caller["id"]] if caller.get("bot") else [bot["id"] for bot in self.store.bots_of(caller["id"])]
        self.expire_challenges()
        return web.json_response({"challenges": self.store.challenges_for(bots)})

    async def challenge_bot(self, request: web.Request) -> web.Response:
        caller = self.me(request)
        if not caller:
            return web.json_response({"error": "Not signed in."}, status=401)
        if caller.get("bot"):
            return web.json_response({"error": "A bot cannot challenge another bot."}, status=403)
        if not self.ladder_limit.allow(caller["id"]):
            return web.json_response({"error": "Too many challenges. Try again in a minute."}, status=429)
        bot = self.store.player(request.match_info["bot"])
        if not bot or not bot.get("bot") or bot.get("suspended"):
            return web.json_response({"error": "No such bot."}, status=404)
        if bot.get("owner_id") == caller["id"]:
            return web.json_response({"error": "That bot is yours. Ask someone else's bot to a table."}, status=400)
        body = await _json(request)
        game = str(body.get("game") or "").strip().lower()
        if game not in self.rooms.games:
            return web.json_response({"error": "Invalid game."}, status=400)
        if self.store.pending_challenges(bot["id"]) >= league.CHALLENGES_PER_BOT:
            return web.json_response({"error": "That bot has enough invitations waiting."}, status=429)
        if self.store.open_room_count() >= MAX_OPEN_ROOMS:
            return web.json_response({"error": "Game Center is full right now. Try again soon."}, status=503)
        room, reason = self.rooms.create(game, caller, True, "two", bots_ok=True)
        if not room:
            return web.json_response({"error": reason or "Could not open the table."}, status=400)
        invite = self.store.create_invite(room["id"], "black")
        challenge = self.store.add_challenge(bot["id"], game, caller["id"], room["id"], invite,
                                             league.CHALLENGE_SECONDS)
        return web.json_response({"ok": True, "challenge": challenge, "room": self.room_summary(room),
                                  "invite": invite, "expires_in": league.CHALLENGE_SECONDS,
                                  "text": (f"Invitation sent to {bot['name']}. It waits ten minutes; "
                                           "their owner brings the bot to the table.")})

    async def decline_challenge(self, request: web.Request) -> web.Response:
        caller = self.me(request)
        if not caller:
            return web.json_response({"error": "Not signed in."}, status=401)
        challenge = self.store.challenge(request.match_info["challenge"])
        if not challenge:
            return web.json_response({"error": "No such invitation."}, status=404)
        bot = self.store.player(challenge["bot_id"]) or {}
        if caller["id"] not in {challenge["bot_id"], str(bot.get("owner_id") or "")}:
            return web.json_response({"error": "That invitation is not yours."}, status=403)
        taken = self.store.decline_challenge(challenge["id"])
        if not taken:
            return web.json_response({"error": "That invitation is already answered."}, status=409)
        self.store.close_room(challenge["room_id"])
        return web.json_response({"ok": True, "text": "Invitation declined."})

    def expire_challenges(self) -> None:
        for challenge in self.store.expire_challenges(self.clock()):
            self.store.close_room(challenge["room_id"])

    # Strategy cards ----------------------------------------------------------

    async def strategy_cards(self, request: web.Request) -> web.Response:
        caller = self.me(request)
        if not caller:
            return web.json_response({"error": "Not signed in."}, status=401)
        if request.method == "GET":
            rows = []
            for card in self.store.cards_of(caller["id"]):
                rows.append({"id": card["id"], "game": card["game"], "name": card["name"],
                             "created": card["created"], "card": json.loads(card["payload"]),
                             "rating": self.store.card_rating(card["id"], card["game"])})
            return web.json_response({"cards": rows, "games": list(bouts.GAMES), "limit": 6})
        body = await _json(request)
        game = str(body.get("game") or "").strip().lower()
        if game not in bouts.GAMES:
            return web.json_response({"error": "Only Doctrine and Doctrine Arena cards can be saved."}, status=400)
        if self.store.card_count(caller["id"], game) >= 6:
            return web.json_response({"error": "Six cards is the limit for one game. Remove one first."}, status=400)
        card, problems = bouts.validate(game, body.get("card"))
        if not card:
            return web.json_response({"error": " ".join(problems[:3]) or "That card could not be read."}, status=400)
        row = self.store.add_card(caller["id"], game, str(card.get("name") or "Card")[:40],
                                  json.dumps(card, ensure_ascii=False))
        return web.json_response({"ok": True, "card": {"id": row["id"], "game": game, "name": row["name"],
                                                       "card": card},
                                  "text": f"{row['name']} is saved and locked. It can only be played, not edited."})

    async def card_arena(self, request: web.Request) -> web.Response:
        caller = self.me(request)
        if not caller:
            return web.json_response({"error": "Not signed in."}, status=401)
        if not self.ladder_limit.allow(caller["id"]):
            return web.json_response({"error": "Too many bouts. Try again in a minute."}, status=429)
        body = await _json(request)
        game = str(body.get("game") or "").strip().lower()
        if game not in bouts.GAMES:
            return web.json_response({"error": "Only Doctrine and Doctrine Arena bouts run here."}, status=400)
        mine = self.store.card(str(body.get("mine") or ""))
        theirs = self.store.card(str(body.get("theirs") or ""))
        if not mine or mine["owner_id"] != caller["id"] or not theirs:
            return web.json_response({"error": "Pick one of your cards and another person's card."}, status=400)
        if mine["game"] != game or theirs["game"] != game:
            return web.json_response({"error": "Both cards must be for the same game."}, status=400)
        if mine["owner_id"] == theirs["owner_id"]:
            return web.json_response({"error": "A bout needs two owners. Ask someone else for their card."}, status=400)
        seed = int.from_bytes(hashlib.sha256(f"{mine['id']}:{theirs['id']}:{time.time_ns()}".encode()).digest()[:4], "big")
        try:
            played = bouts.run(game, json.loads(mine["payload"]), json.loads(theirs["payload"]), seed)
        except Exception as exc:  # an engine that refuses is a 400, never a 500 with a traceback
            log.warning("card bout failed: %s", exc)
            return web.json_response({"error": "That bout could not be played."}, status=400)
        rated = True
        bout = self.store.create_bout(game, seed, mine, theirs, played["winner"], played["reason"],
                                      played["plies"], rated, played["replay"])
        winner_name = mine["name"] if played["winner"] == "one" else theirs["name"] if played["winner"] == "two" else ""
        return web.json_response({"ok": True, "bout": {"id": bout["id"], "game": game, "seed": seed,
                                                       "one": mine["name"], "two": theirs["name"],
                                                       "winner": played["winner"], "winner_name": winner_name,
                                                       "radio": True,
                                                       "reason": played["reason"], "plies": played["plies"],
                                                       "rated": rated, "replay_url": f"/api/card-arena/{bout['id']}",
                                                       "one_rating": self.store.card_rating(mine["id"], game),
                                                       "two_rating": self.store.card_rating(theirs["id"], game)},
                                  "text": (f"{winner_name} won." if winner_name else "A draw.")})

    async def public_cards(self, request: web.Request) -> web.Response:
        """Other people's locked cards, by name only: enough to pick an opponent."""
        game = str(request.query.get("game") or "").strip().lower()
        if game not in bouts.GAMES:
            return web.json_response({"error": "Only Doctrine and Doctrine Arena cards are listed."}, status=400)
        caller = self.me(request)
        rows = self.store.db.execute(
            "SELECT c.id, c.name, c.game, c.created, p.name AS owner FROM cards c "
            "JOIN players p ON p.id = c.owner_id WHERE c.game = ? "
            "AND (c.owner_id != ? OR ? = '') ORDER BY c.created DESC LIMIT 40",
            (game, caller["id"] if caller else "", caller["id"] if caller else ""),
        ).fetchall()
        return web.json_response({"cards": [{"id": row["id"], "name": row["name"], "game": row["game"],
                                             "owner": row["owner"] or ""} for row in rows]})

    async def card_bout(self, request: web.Request) -> web.Response:
        bout = self.store.bout(request.match_info["bout"])
        if not bout:
            return web.json_response({"error": "No such bout."}, status=404)
        return web.json_response({"bout": {key: bout[key] for key in
                                           ("id", "game", "seed", "one_name", "two_name", "winner",
                                            "reason", "plies", "rated", "created")},
                                  "replay": json.loads(bout["replay"] or "{}")})

    # WebSocket ---------------------------------------------------------------

    async def socket(self, request: web.Request) -> web.StreamResponse:
        ip = self.ip(request)
        if self.pending.get(ip, 0) >= MAX_PENDING_PER_IP or sum(self.pending.values()) >= MAX_PENDING:
            return web.json_response({"error": "Too many connections."}, status=429)
        self.pending[ip] = self.pending.get(ip, 0) + 1
        try:
            ws = web.WebSocketResponse(heartbeat=25, max_msg_size=4096)
            await ws.prepare(request)
            room = self.store.room(request.match_info["room"])
            if not room or room["closed"]:
                await _send(ws, {"t": "closed", "text": "This table is closed or does not exist."})
                await ws.close()
                return ws
            try:
                first = await asyncio.wait_for(ws.receive(), timeout=10)
            except asyncio.TimeoutError:
                await ws.close()
                return ws
        finally:
            self.pending[ip] -= 1
            if not self.pending[ip]:
                del self.pending[ip]
        message = _decode(first)
        player = self.store.player_by_token(str(message.get("token") or "")) if message.get("t") == "auth" else None
        if not player:
            await _send(ws, {"t": "error", "text": "Pick a name first.", "code": "auth"})
            await ws.close()
            return ws
        self.store.note_address(player["id"], ip)
        # A suspended account cannot sit, watch or chat anywhere.
        if self.store.suspended(player["id"]):
            await _send(ws, {"t": "closed", "text": "This account is suspended."})
            await ws.close()
            return ws
        if self.store.db.execute("SELECT 1 FROM blocks WHERE player_id = ? AND blocked_id = ?",
                                 (player["id"], room["host_id"])).fetchone():
            await _send(ws, {"t": "closed", "text": "You blocked the person who runs this table."})
            await ws.close()
            return ws
        blocked_until = self.blocked.get(room["id"], {}).get(ip, 0.0)
        if self.store.moderated(room["id"], player["id"], "removed") or (
                blocked_until > time.time() and player["id"] != room["host_id"]):
            await _send(ws, {"t": "closed", "text": "The host removed you from this table."})
            await ws.close()
            return ws
        total = sum(map(len, self.conns.values()))
        if total >= MAX_CONNECTIONS or len(self.conns.get(room["id"], ())) >= MAX_ROOM_CONNECTIONS:
            await _send(ws, {"t": "closed", "text": "This table is full right now."})
            await ws.close()
            return ws
        conn = Conn(ws=ws, room_id=room["id"], player=player, ip=ip)
        self.conns.setdefault(room["id"], set()).add(conn)
        self.rooms.connected(room["id"], player["id"])
        try:
            await _send(ws, {"t": "hello", "me": player, "room": self.room_summary(room),
                             "chat": [m for m in self.store.recent_chat(room["id"]) if not self.store.db.execute("SELECT 1 FROM blocks WHERE player_id=? AND blocked_id=?", (player["id"], m["player_id"])).fetchone()]})
            if player["id"] == room["host_id"]:
                await _send(ws, {"t": "invites", "invites": self.store.live_invites(room["id"])})
            await self.broadcast(room["id"])
            code = str(message.get("invite") or "")
            if code:
                await self.handle(conn, {"t": "redeem", "code": code, "ref": "invite"})
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    if raw.type in {WSMsgType.ERROR, WSMsgType.CLOSE}:
                        break
                    continue
                await self.handle(conn, _decode(raw))
        finally:
            self.conns.get(room["id"], set()).discard(conn)
            if not any(other.player["id"] == player["id"] for other in self.conns.get(room["id"], ())):
                self.rooms.disconnected(room["id"], player["id"])
            if not self.conns.get(room["id"]):
                self.conns.pop(room["id"], None)
            else:
                with contextlib.suppress(Exception):
                    await self.broadcast(room["id"])
        return ws

    async def handle(self, conn: Conn, message: dict) -> None:
        kind = message.get("t")
        ref = message.get("ref")
        if not self.cmd_limit.allow(conn.player["id"]):
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": False, "text": "Slow down a little."})
            return
        if kind == "ping":
            await _send(conn.ws, {"t": "pong"})
            return
        async with self.lock(conn.room_id):
            room = self.store.room(conn.room_id)
            if not room or room["closed"]:
                await _send(conn.ws, {"t": "closed", "text": "This table is closed."})
                return
            player = self.store.player(conn.player["id"]) or conn.player
            conn.player = player
            if kind == "cmd":
                args = message.get("args") if isinstance(message.get("args"), list) else []
                action = str(message.get("action") or "")
                answer = self.rooms.run(room, player, action, args)
                # Jackpot Mode: track tool calls and award pulls
                if answer["ok"]:
                    player_id = player["id"]
                    if player_id not in self.earn_trackers:
                        self.earn_trackers[player_id] = EarnTracker(player_id)
                    tracker = self.earn_trackers[player_id]
                    tracker.add_tool_call(action, {"args": args}, success=True)
                    earned_pull, pull_id = tracker.complete_turn()
                    if earned_pull:
                        spin_result = slot_spin()
                        self.ledger.record_pull(player_id, spin_result["seed"],
                                               f"{spin_result['reel1']}{spin_result['reel2']}{spin_result['reel3']}",
                                               spin_result["payout"])
                        # Broadcast slot result
                        await _send(conn.ws, {"t": "slot_spin", "result": spin_result})
                        # Broadcast jackpot message if big win
                        if spin_result["payout"] == JACKPOT_ANNOUNCE:
                            msg = f"🎰 {player['name']} hit JACKPOT! {JACKPOT_ANNOUNCE} chips!"
                            self.store.add_chat(room["id"], player["id"], player["name"],
                                              self.role(room, player["id"]), msg)
                            for other in list(self.conns.get(room["id"], ())):
                                await _send(other.ws, {"t": "chat", "message": {"text": msg, "player_id": player["id"],
                                                                               "player_name": player["name"]}})
            elif kind == "redeem":
                answer = self.rooms.redeem(room, player, str(message.get("code") or ""))
            elif kind == "claim":
                answer = self.rooms.claim(room, player)
            elif kind == "invite":
                code, reason = self.rooms.invite(room, player, str(message.get("side") or ""))
                if code:
                    await _send(conn.ws, {"t": "invites", "invites": self.store.live_invites(room["id"])})
                answer = {"ok": bool(code), "text": "New invite link ready." if code else reason}
            elif kind == "close":
                answer = self.rooms.close(room, player)
            elif kind == "chat":
                await self.chat(conn, room, message, ref)
                return
            elif kind in {"mute", "unmute", "remove"}:
                await self.moderate(conn, room, kind, str(message.get("player_id") or ""), ref)
                return
            else:
                answer = {"ok": False, "text": "Unknown message."}
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": answer["ok"], "text": answer["text"],
                                  "finished": answer.get("finished")})
            if kind == "close" and answer["ok"]:
                for other in list(self.conns.get(room["id"], ())):
                    await _send(other.ws, {"t": "closed", "text": "The host closed this table."})
                    await other.ws.close()
                return
        await self.broadcast(conn.room_id)

    async def chat(self, conn: Conn, room: dict, message: dict, ref) -> None:
        player = conn.player
        if player.get("bot"):
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": False, "text": "Bots play; they do not chat."})
            return
        if self.store.silenced(player["id"]):
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": False, "text": "You are silenced."})
            return
        if self.store.moderated(room["id"], player["id"], "muted"):
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": False, "text": "The host muted you at this table."})
            return
        if not self.chat_limit.allow(player["id"]):
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": False, "text": "You are sending messages too fast."})
            return
        text, reason = guard.clean_chat(message.get("text"))
        if not text:
            await _send(conn.ws, {"t": "result", "ref": ref, "ok": False, "text": reason})
            return
        saved = self.store.add_chat(room["id"], player["id"], player["name"], self.role(room, player["id"]), text)
        await _send(conn.ws, {"t": "result", "ref": ref, "ok": True, "text": ""})
        for other in list(self.conns.get(room["id"], ())):
            if not self.store.db.execute("SELECT 1 FROM blocks WHERE player_id=? AND blocked_id=?", (other.player["id"], player["id"])).fetchone():
                await _send(other.ws, {"t": "chat", "message": saved})

    async def moderate(self, conn: Conn, room: dict, kind: str, target: str, ref) -> None:
        if kind == "remove":
            ok, reason = self.rooms.remove(room, conn.player, target)
        else:
            ok, reason = self.rooms.mute(room, conn.player, target, kind == "mute")
        await _send(conn.ws, {"t": "result", "ref": ref, "ok": ok, "text": reason or "Done."})
        if ok and kind == "remove":
            until = time.time() + REMOVED_IP_SECONDS
            blocked = self.blocked.setdefault(room["id"], {})
            for other in list(self.conns.get(room["id"], ())):
                if other.player["id"] == target and other.ip != conn.ip:
                    blocked[other.ip] = until
            for other in list(self.conns.get(room["id"], ())):
                if other.player["id"] == target:
                    await _send(other.ws, {"t": "closed", "text": "The host removed you from this table."})
                    await other.ws.close()
        if ok:
            await self.broadcast(room["id"])

    async def broadcast(self, room_id: str) -> None:
        room = self.store.room(room_id)
        if not room:
            return
        conns = list(self.conns.get(room_id, ()))
        people: dict[str, dict] = {}
        for conn in conns:
            pid = conn.player["id"]
            people.setdefault(pid, {
                "id": pid, "name": conn.player["name"], "role": self.role(room, pid), "bot": bool(conn.player.get("bot")),
                "staff": self.store.staff_role(pid),
                "muted": self.store.moderated(room_id, pid, "muted"), "host": pid == room["host_id"],
            })
        presence = {"t": "presence", "people": list(people.values())}
        summary = self.room_summary(room)
        matches = self.store.recent_matches(room_id)
        for conn in conns:
            picture = self.rooms.picture(room, conn.player["id"])
            payload = {"t": "state", "room": summary, "picture": picture, "matches": matches}
            encoded = json.dumps(payload, sort_keys=True)
            if encoded != conn.sent_state:
                conn.sent_state = encoded
                await _send_raw(conn.ws, encoded)
            await _send(conn.ws, presence)

    # Housekeeping ------------------------------------------------------------

    async def janitor(self, app: web.Application) -> None:
        last_housekeeping = 0.0
        while True:
            try:
                now = self.clock()
                self.queue.prune(now)
                await self.requests.expire(now)
                # Find match: someone who left the lobby is not looking any more, and
                # everyone still looking gets paired the moment a partner appears.
                self.store.clear_looking_outside(self.hub.online_players())
                await self.requests.pair_looking(now)
                for room_id in self.rooms.check_clocks(now):
                    await self.broadcast(room_id)
                if time.monotonic() - last_housekeeping >= 15:
                    last_housekeeping = time.monotonic()
                    self.rooms.expire()
                    self.expire_challenges()
                    self.store.expire_punishments(time.time())
                    self.store.purge_chat(time.time() - CHAT_DAYS * 86400)
                    # Lobby posts keep for one day, no longer.
                    self.store.purge_lobby_posts(time.time() - LOBBY_HOURS * 3600)
                    self.store.expire_removals(time.time() - arcade.REMOVAL_DAYS * 86400)
                    for limiter in (self.cmd_limit, self.chat_limit, self.lobby_chat_limit, self.session_limit, self.api_limit, self.removal_limit, self.login_limit, self.queue_limit, self.alert_limit, self.ladder_limit, self.balance_limit):
                        limiter.prune()
                    real_now = time.time()
                    for room_id in list(self.blocked):
                        self.blocked[room_id] = {ip: until for ip, until in self.blocked[room_id].items() if until > real_now}
                        if not self.blocked[room_id]:
                            del self.blocked[room_id]
                    for room_id in list(self.conns):
                        await self.broadcast(room_id)
            except Exception:
                log.exception("janitor")
            await asyncio.sleep(5)

    @web.middleware
    async def limits(self, request: web.Request, handler):
        if request.path.startswith("/api/") and not self.api_limit.allow(self.ip(request)):
            return web.json_response({"error": "Too many requests."}, status=429)
        response = await handler(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response

    def build(self) -> web.Application:
        app = web.Application(client_max_size=16 * 1024, middlewares=[self.limits])
        app.router.add_get("/", self.index)
        app.router.add_get("/t/{room}", self.index)
        app.router.add_get("/b/{bot}", self.index)
        app.router.add_get("/board.js", self.board_js)
        app.router.add_get("/api/health", self.health)
        app.router.add_route("*", "/api/admin/{path:.*}", self.admin.handle)
        app.router.add_post("/api/reports", self.report)
        app.router.add_get("/api/blocks", self.blocks)
        app.router.add_post("/api/blocks", self.blocks)
        app.router.add_delete("/api/blocks/{player}", self.blocks)
        app.router.add_get("/api/availability", self.availability)
        app.router.add_post("/api/availability", self.availability)
        app.router.add_get("/api/requests", self.play_requests)
        app.router.add_post("/api/requests", self.play_requests)
        app.router.add_post("/api/requests/{id}", self.play_request)
        app.router.add_post("/api/session", self.session)
        app.router.add_get("/api/me", self.get_me)
        app.router.add_post("/api/me", self.post_me)
        app.router.add_get("/api/games", self.games)
        app.router.add_get("/api/lobby", self.lobby)
        app.router.add_get("/api/lobby/socket", self.hub.socket)
        app.router.add_get("/api/lobby/chat", self.lobby_chat)
        app.router.add_post("/api/lobby/chat", self.lobby_chat)
        app.router.add_get("/api/leaderboard", self.leaderboard)
        app.router.add_get("/api/leaderboard/jackpot", self.jackpot_leaderboard)
        app.router.add_get("/api/bots", self.list_bots)
        app.router.add_get("/api/bots/{bot}", self.bot_career)
        app.router.add_get("/api/passports", self.passports)
        app.router.add_post("/api/ladder", self.ladder)
        app.router.add_get("/api/ladder", self.ladder_summary)
        app.router.add_get("/api/open-league", self.open_league)
        app.router.add_get("/api/spectate", self.spectate)
        app.router.add_get("/api/matches/{room}/{no}", self.match_replay)
        app.router.add_get("/api/stock-league", self.stock_league)
        app.router.add_get("/api/challenges", self.challenges)
        app.router.add_post("/api/bots/{bot}/challenge", self.challenge_bot)
        app.router.add_post("/api/challenges/{challenge}/decline", self.decline_challenge)
        app.router.add_get("/api/cards", self.strategy_cards)
        app.router.add_post("/api/cards", self.strategy_cards)
        app.router.add_post("/api/card-arena", self.card_arena)
        app.router.add_get("/api/card-arena/{bout}", self.card_bout)
        app.router.add_get("/api/cards/public", self.public_cards)
        app.router.add_get("/api/queue", self.queue_endpoint)
        app.router.add_post("/api/queue", self.queue_endpoint)
        app.router.add_delete("/api/queue", self.queue_endpoint)
        app.router.add_get("/api/alerts", self.alerts)
        app.router.add_post("/api/alerts", self.alerts)
        app.router.add_get("/api/balance", self.balance)
        app.router.add_post("/api/balance", self.balance)
        app.router.add_post("/api/bots", self.create_bot)
        app.router.add_delete("/api/bots/{bot}", self.delete_bot)
        app.router.add_get("/api/arcade", self.arcade_list)
        app.router.add_post("/api/arcade/remove", self.arcade_remove)
        app.router.add_post("/api/arcade/check", self.arcade_check)
        app.router.add_post("/api/rooms", self.create_room)
        app.router.add_get("/api/rooms/{room}", self.get_room)
        app.router.add_get("/ws/{room}", self.socket)
        app.router.add_static("/vendor/", WEB / "vendor", show_index=False)
        app.router.add_get("/app.js", _static("app.js"))
        app.router.add_get("/sdk-shim.js", _static("sdk-shim.js"))
        app.router.add_get("/style.css", _static("style.css"))
        app.router.add_get("/hall.css", _static("hall.css"))
        app.router.add_get("/icon.svg", _static("icon.svg"))
        app.router.add_get("/favicon.ico", _static("icon.svg"))

        async def start(app: web.Application) -> None:
            app[JANITOR] = asyncio.create_task(self.janitor(app))

        async def going_away(app: web.Application) -> None:
            # Runs before aiohttp waits on open handlers. Without it a restart leaves pages
            # attached to the old process for up to a minute, where nothing answers.
            await self.hub.close()
            app[JANITOR].cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await app[JANITOR]
            for conns in list(self.conns.values()):
                for conn in list(conns):
                    with contextlib.suppress(Exception):
                        await conn.ws.close(code=WSCloseCode.GOING_AWAY, message=b"restarting")

        async def stop(app: web.Application) -> None:
            if self.http is not None:
                await self.http.close()
            self.store.close()

        app.on_startup.append(start)
        app.on_shutdown.append(going_away)
        app.on_cleanup.append(stop)
        return app


def _static(name: str):
    path = WEB / name
    types = {".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}

    async def serve(request: web.Request) -> web.FileResponse:
        return web.FileResponse(path, headers={"Content-Type": types[path.suffix], "Cache-Control": "no-cache"})

    return serve


def _ack_response(ack: dict) -> web.Response:
    text = str(ack.get("text") or "That did not work.")
    return web.json_response({"ok": False, "text": text, "error": text}, status=400)


async def _json(request: web.Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _count(value) -> TypeGuard[int]:
    """True for a whole number of chips or points: 0 or more, inside the stored range.

    ``True`` is not 1 and ``1.0`` is not 1 here: a JSON boolean or a fraction is a
    client mistake, and storing it as a count would hide it.
    """
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= BALANCE_MAX


def _decode(message) -> dict:
    if getattr(message, "type", None) != WSMsgType.TEXT:
        return {}
    try:
        body = json.loads(message.data)
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


async def _send(ws: web.WebSocketResponse, payload: dict) -> None:
    await _send_raw(ws, json.dumps(payload))


async def _send_raw(ws: web.WebSocketResponse, encoded: str) -> None:
    if ws.closed:
        return
    with contextlib.suppress(ConnectionError, RuntimeError):
        await ws.send_str(encoded)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Game Center Online server")
    parser.add_argument("--data", required=True, help="folder for online.sqlite3 and room tables")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--trust-proxy", action="store_true", help="read client IP from X-Real-IP (behind nginx)")
    parser.add_argument("--signups-per-hour", type=int, default=20, help="new players allowed per address per hour")
    parser.add_argument("--api-per-minute", type=int, default=120, help="HTTP API requests allowed per address per minute")
    options = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    server = App(Path(options.data), trust_proxy=options.trust_proxy, signups_per_hour=options.signups_per_hour,
                 api_per_minute=options.api_per_minute)
    web.run_app(server.build(), host=options.host, port=options.port, access_log=None)


if __name__ == "__main__":
    main()
