"""Play requests: who is open to a game, and the ask that seats both of them.

Presence delivers the frames. This module never imports it. The server sets
``service`` and passes a hub with ``status(id)`` and ``await send_to(id, frame)``.
Until that hub exists, ``status`` is missing and nobody is online.

Find match lives here too. A person looking for one or more games is kept in the
``looking`` table; a pass over it pairs two people who want the same game right
now and writes one *offer* - a request neither side asked for, which either side
may join.
"""

from __future__ import annotations

import asyncio
import time

# Games a person can ask another person to play. Blackjack and slots are not.
REQUESTABLE = (
    "connect4", "reversi", "checkers", "gomoku", "chessboard",
    "go", "hex", "breakthrough", "seabattle",
)
REQUEST_SECONDS = 90
HOUR = 3600.0
MAX_PER_HOUR = 8
MAX_INBOUND = 5
DECLINE_SECONDS = 600.0

# Appear offline: the account is in nobody's roster and takes no requests. One
# sentence either way, so it never says which of the two is behind it.
APPEAR_OFFLINE = "You are appearing offline. Turn that off to ask for a game."

# One sentence for a block in either direction. It must not say that a block exists.
NOT_AVAILABLE = "They are not available."

# Filled by App so presence can call requests.service without holding the App.
service: "Service | None" = None


class AppHub:
    """The presence hub once that lane has attached it, otherwise nobody is online."""

    def __init__(self, app: object) -> None:
        self.app = app

    def _live(self):
        presence = getattr(self.app, "presence", None)
        if presence is None:
            return None
        hub = presence.hub if getattr(presence, "hub", None) is not None else presence
        if callable(getattr(hub, "status", None)) and callable(getattr(hub, "send_to", None)):
            return hub
        return None

    def status(self, player_id: str):
        hub = self._live()
        if hub is None:
            return None
        return hub.status(player_id)

    def online_players(self):
        """Ids with a live lobby connection, or None when presence is not attached.

        None means "not known", which is not the same as "nobody": a hub that cannot
        say who is connected still answers status() per person.
        """
        hub = self._live()
        if hub is None:
            return None
        getter = getattr(hub, "online_players", None)
        if callable(getter):
            return set(getter())
        players = getattr(hub, "players", None)
        return set(players) if players is not None else None

    async def send_to(self, player_id: str, frame: dict):
        hub = self._live()
        if hub is None:
            return None
        return await hub.send_to(player_id, frame)


class Service:
    def __init__(self, store, rooms, hub, clock=time.time) -> None:
        self.store = store
        self.rooms = rooms
        self.hub = hub
        self.clock = clock
        # One lock for the whole accept path, shared with the other writes so two
        # accepts cannot open two tables and a create cannot race an accept.
        self.accept_lock = asyncio.Lock()

    # Reading -----------------------------------------------------------------

    def prefs(self, player_id: str) -> dict:
        open_flag, stored = self.store.availability(player_id)
        return {"open": open_flag, "games": {game: bool(stored.get(game, False)) for game in REQUESTABLE}}

    def invisible(self, player_id: str) -> bool:
        """Appearing offline: in nobody's roster, and no requests either way."""
        return self.store.invisible(player_id)

    def looking(self, player_id: str) -> list[str]:
        """The games find match is on for. Empty means not looking."""
        return self.store.looking_games(player_id)

    def presence_prefs(self, player_id: str) -> dict:
        """prefs() plus what the roster needs: appearing offline and find match."""
        prefs = self.prefs(player_id)
        prefs["invisible"] = self.invisible(player_id)
        prefs["looking"] = self.looking(player_id)
        return prefs

    def pending_for(self, player_id: str) -> list[dict]:
        return [self._card(row) for row in self.store.pending_play_requests(player_id)]

    # Frames ------------------------------------------------------------------

    async def handle(self, player: dict, frame: dict) -> dict:
        kind = frame.get("t")
        if kind == "prefs":
            return await self._prefs(player, frame)
        if kind == "looking":
            return await self._looking(player, frame)
        if kind == "request":
            return await self._request(player, frame)
        if kind == "respond":
            return await self._respond(player, frame)
        if kind == "cancel":
            return await self._cancel(player, frame)
        return self._ack(frame, False, "Unknown request.")

    async def expire(self, now: float) -> int:
        async with self.accept_lock:
            rows = self.store.expire_play_requests(float(now))
            frames = [item for row in rows for item in self._updates(self._card(row))]
        await self._emit(frames)
        return len(rows)

    async def pair_looking(self, now: float | None = None) -> int:
        """One find-match pass. Returns how many frames it sent."""
        moment = float(self.clock() if now is None else now)
        async with self.accept_lock:
            frames = self._pair_locked(moment)
        await self._emit(frames)
        return len(frames)

    async def _prefs(self, player: dict, frame: dict) -> dict:
        async with self.accept_lock:
            text = self._apply_prefs(player["id"], frame)
            if text:
                return self._ack(frame, False, text)
            # Someone opening up can be the match a waiting person was looking for.
            frames = self._pair_locked(float(self.clock()))
        await self._emit(frames)
        return self._ack(frame, True, "Saved.")

    def _apply_prefs(self, player_id: str, frame: dict) -> str:
        if "open" in frame and not isinstance(frame.get("open"), bool):
            return "Open must be yes or no."
        if "invisible" in frame and not isinstance(frame.get("invisible"), bool):
            return "Say whether you appear offline."
        games_in = frame.get("games") if "games" in frame else None
        if games_in is not None:
            if not isinstance(games_in, dict):
                return "Name the games to turn on or off."
            for game, enabled in games_in.items():
                if not isinstance(game, str) or game not in REQUESTABLE or not isinstance(enabled, bool):
                    return "That game cannot be chosen."
        open_flag, stored = self.store.availability(player_id)
        merged = {game: bool(stored.get(game, False)) for game in REQUESTABLE}
        if games_in:
            for game, enabled in games_in.items():
                merged[game] = enabled
        if "open" in frame:
            open_flag = frame["open"]
        # Turning open on with nothing chosen turns every requestable game on.
        # Open off, and open on when a choice is already stored, leave the choices.
        if open_flag and not games_in and not any(merged.values()):
            merged = {game: True for game in REQUESTABLE}
        self.store.save_availability(player_id, open_flag, merged, float(self.clock()))
        if "invisible" in frame:
            self.store.save_invisible(player_id, bool(frame["invisible"]), float(self.clock()))
            if frame["invisible"]:
                # Somebody who is not in the lobby is not looking for a match in it.
                self.store.clear_looking(player_id)
        return ""

    # Find match ---------------------------------------------------------------

    async def _looking(self, player: dict, frame: dict) -> dict:
        async with self.accept_lock:
            text = self._apply_looking(player["id"], frame)
            if text:
                return self._ack(frame, False, text)
            frames = self._pair_locked(float(self.clock()))
            games = self.looking(player["id"])
        await self._emit(frames)
        return self._ack(frame, True, self._looking_text(games))

    def _apply_looking(self, player_id: str, frame: dict) -> str:
        if frame.get("on") is False or frame.get("stop") is True:
            self.store.clear_looking(player_id)
            return ""
        all_games = frame.get("all")
        if all_games is not None and not isinstance(all_games, bool):
            return "Say whether to look for every game."
        if all_games:
            games = list(REQUESTABLE)
        else:
            wanted = frame.get("games")
            if not isinstance(wanted, list) or not wanted:
                return "Name at least one game to look for."
            chosen = []
            for game in wanted:
                if not isinstance(game, str) or game not in REQUESTABLE:
                    return "That game cannot be chosen."
                if game not in chosen:
                    chosen.append(game)
            # Store in the one order the lobby lists games in.
            games = [game for game in REQUESTABLE if game in set(chosen)]
        if self.invisible(player_id):
            return APPEAR_OFFLINE
        self.store.set_looking(player_id, games, float(self.clock()))
        return ""

    @staticmethod
    def _looking_text(games: list[str]) -> str:
        if not games:
            return "Stopped looking."
        if len(games) == 1:
            return f"Looking for {games[0]}."
        return f"Looking for {len(games)} games."

    def _pair_locked(self, now: float) -> list[tuple[str, dict]]:
        """Pair people who want the same game right now, and offer it to both.

        Only someone online, visible and not already at a table is paired, and only
        one offer is out per person: a second one would be a second table waiting.
        """
        looking: dict[str, dict[str, float]] = {}
        for row in self.store.all_looking():
            looking.setdefault(str(row["player_id"]), {})[str(row["game"])] = float(row["created"])
        if not looking:
            return []
        connected = self.hub.online_players() if callable(getattr(self.hub, "online_players", None)) else None
        busy = self.store.pending_offer_players()
        # Whoever has waited longest is offered first.
        order = sorted(looking, key=lambda pid: (min(looking[pid].values()), pid))
        frames: list[tuple[str, dict]] = []
        for looker in order:
            if looker in busy or not self._may_be_offered(looker, connected):
                continue
            for game in REQUESTABLE:
                if game not in looking[looker]:
                    continue
                partner = self._partner_for(looker, game, looking, busy, connected, now)
                if partner is None:
                    continue
                row = self.store.create_play_request(
                    looker, partner, game, now, REQUEST_SECONDS, offer=True)
                busy = busy | {looker, partner}
                frames.extend(self._announce(self._card(row)))
                break
        return frames

    def _partner_for(self, looker, game, looking, busy, connected, now):
        """Someone else looking for this game first, then anyone open to it."""
        wanted = [pid for pid in sorted(looking, key=lambda pid: (min(looking[pid].values()), pid))
                  if pid != looker and game in looking[pid]]
        wanted += [pid for pid in sorted(self._open_to(game, connected))
                   if pid != looker and pid not in wanted]
        for partner in wanted:
            if partner in busy or not self._may_be_offered(partner, connected):
                continue
            if self._can_pair(looker, partner, game, now):
                return partner
        return None

    def _open_to(self, game, connected) -> list[str]:
        """People who are not looking, but accept this game right now."""
        rows = self.store.db.execute(
            "SELECT player_id FROM availability_games WHERE game = ? AND enabled = 1", (game,))
        out = []
        for row in rows:
            pid = str(row["player_id"])
            if self.invisible(pid) or (connected is not None and pid not in connected):
                continue
            prefs = self.prefs(pid)
            if prefs["open"] and prefs["games"].get(game):
                out.append(pid)
        return out

    def _may_be_offered(self, player_id, connected) -> bool:
        """Online, visible, and not already at a table."""
        if self.invisible(player_id):
            return False
        if connected is not None and player_id not in connected:
            return False
        return self.hub.status(player_id) == "online"

    def _can_pair(self, a: str, b: str, game: str, now: float) -> bool:
        if self.store.blocked_pair(a, b):
            return False
        if self.store.pair_pending(a, b):
            return False
        if self.store.inbound_pending_count(b) >= MAX_INBOUND:
            return False
        if self.store.declined_recently(a, b, game, now - DECLINE_SECONDS):
            return False
        return True

    async def _request(self, player: dict, frame: dict) -> dict:
        async with self.accept_lock:
            text = self._screen_new(player, frame)
            if text:
                return self._ack(frame, False, text)
            row = self.store.create_play_request(
                player["id"], frame["to"], frame["game"], float(self.clock()), REQUEST_SECONDS)
            frames = self._announce(self._card(row))
            ack = self._ack(frame, True, "Request sent.")
        await self._emit(frames)
        return ack

    async def _respond(self, player: dict, frame: dict) -> dict:
        if not isinstance(frame.get("accept"), bool):
            return self._ack(frame, False, "Say whether you accept.")
        async with self.accept_lock:
            if frame["accept"]:
                ack, frames = await self._accept_locked(player, frame)
            else:
                ack, frames = self._decline_locked(player, frame)
        await self._emit(frames)
        return ack

    async def _cancel(self, player: dict, frame: dict) -> dict:
        async with self.accept_lock:
            row = self._load(frame)
            if row is None:
                return self._ack(frame, False, "No such request.")
            if player["id"] != row["from_id"]:
                return self._ack(frame, False, "Only the sender can cancel.")
            if row["state"] != "pending":
                return self._ack(frame, False, "That request is no longer open.")
            saved = self.store.set_play_state(row["id"], "cancelled")
            frames = self._updates(self._card(saved or row))
            ack = self._ack(frame, True, "Cancelled.")
        await self._emit(frames)
        return ack

    def _decline_locked(self, player: dict, frame: dict) -> tuple[dict, list]:
        row = self._load(frame)
        if row is None:
            return self._ack(frame, False, "No such request."), []
        if not self._may_answer(player["id"], row):
            return self._ack(frame, False, "Only the other player can decline."), []
        if row["state"] != "pending":
            return self._ack(frame, False, "That request is no longer open."), []
        saved = self.store.set_play_state(row["id"], "declined")
        return self._ack(frame, True, "Declined."), self._updates(self._card(saved or row))

    @staticmethod
    def _may_answer(player_id: str, row: dict) -> bool:
        """Who may answer: the person asked. A match offer has no asker, so either side may."""
        if player_id == row["to_id"]:
            return True
        return bool(row.get("offer")) and player_id == row["from_id"]

    async def _accept_locked(self, player: dict, frame: dict) -> tuple[dict, list]:
        row = self._load(frame)
        if row is None:
            return self._ack(frame, False, "No such request."), []
        if not self._may_answer(player["id"], row):
            return self._ack(frame, False, "Only the other player can accept."), []
        # Let the other accept task reach this lock. The second one then finds
        # the row already accepted and returns the same room.
        await asyncio.sleep(0)
        row = self.store.play_request(row["id"]) or row
        if row["state"] == "accepted" and row.get("room_id"):
            return self._ack(frame, True, "You are seated."), self._seated_notice(row)
        if row["state"] != "pending":
            return self._ack(frame, False, "That request is no longer open."), []
        if row["expires"] <= float(self.clock()):
            saved = self.store.set_play_state(row["id"], "expired")
            return self._ack(frame, False, "That request is no longer open."), self._updates(self._card(saved or row))
        sender = self.store.player(row["from_id"]) or {"id": row["from_id"], "name": "", "bot": False}
        text = self._screen(sender, row["to_id"], row["game"], creating=False, offer=bool(row.get("offer")))
        if text:
            return self._ack(frame, False, text), []
        target = self.store.player(row["to_id"]) or player
        room = self._open_table(sender, target, row["game"])
        if not room:
            return self._ack(frame, False, "Could not open a table right now."), []
        saved = self.store.set_play_state(row["id"], "accepted", room["id"]) or row
        # Both are at a table now: find match has done its job for both of them.
        self.store.clear_looking(row["from_id"])
        self.store.clear_looking(row["to_id"])
        others = self.store.release_other_pending(row["from_id"], row["to_id"], row["id"])
        frames = self._seated_notice(saved)
        for other in others:
            frames.extend(self._updates(self._card(other)))
        return self._ack(frame, True, "You are seated."), frames

    def _screen_new(self, player: dict, frame: dict) -> str:
        target = frame.get("to")
        game = frame.get("game")
        if not isinstance(target, str) or not isinstance(game, str) or not target or not game:
            return "Name a player and a game."
        if len(target) > 80 or len(game) > 40:
            return "Name a player and a game."
        frame["to"] = target
        frame["game"] = game
        if self.invisible(player["id"]):
            return APPEAR_OFFLINE
        return self._screen(player, target, game, creating=True)

    def _screen(self, sender: dict, target_id: str, game: str, *, creating: bool, offer: bool = False) -> str:
        if sender.get("id") == target_id:
            return "Choose someone else."
        if sender.get("bot"):
            return "Bots cannot send or receive requests."
        target = self.store.player(target_id)
        if target is None:
            return "No such player."
        if target.get("bot"):
            return "Bots cannot send or receive requests."
        if game not in REQUESTABLE:
            return "That game cannot be requested."
        if self.invisible(target_id):
            # Appearing offline reads exactly like being unavailable, in either direction.
            return NOT_AVAILABLE
        text = self._presence(target_id)
        if text:
            return text
        if not creating:
            if self.invisible(sender["id"]):
                return NOT_AVAILABLE
            text = self._presence(sender["id"])
            if text:
                return text
        if offer:
            # A match offer was already screened against both people's switches when it
            # was made; what is left to check is that neither has gone since.
            return NOT_AVAILABLE if self.store.blocked_pair(sender["id"], target_id) else ""
        prefs = self.prefs(target_id)
        if not prefs["open"]:
            return "They are not taking requests."
        if not prefs["games"].get(game):
            return "They are not taking that game."
        if self.store.blocked_pair(sender["id"], target_id):
            return NOT_AVAILABLE
        if not creating:
            return ""
        now = float(self.clock())
        if self.store.requests_sent_since(sender["id"], now - HOUR) >= MAX_PER_HOUR:
            return "You have sent eight requests this hour. Try again later."
        if self.store.pair_pending(sender["id"], target_id):
            return "There is already a request open between you."
        if self.store.inbound_pending_count(target_id) >= MAX_INBOUND:
            return "They have too many requests waiting."
        if self.store.declined_recently(sender["id"], target_id, game, now - DECLINE_SECONDS):
            return "That game was declined. Try again in ten minutes."
        return ""

    def _presence(self, player_id: str) -> str:
        status = self.hub.status(player_id)
        if status == "online":
            return ""
        if status == "away":
            return "They are away."
        if status == "playing":
            return "They are in a game."
        return "They are offline."

    def _open_table(self, white: dict, black: dict, game: str) -> dict | None:
        """Seat both in one private unrated room and leave no invite behind.

        A private table will not sit the second person without an invite, and
        ``Rooms.create`` writes that invite itself. ``make_match`` avoids the
        invite by creating a public two-player table and joining the opponent.
        Do that, then mark the table private and unrated and delete any invite.
        """
        room, _reason = self.rooms.create(game, white, True, "two")
        if not room:
            return None
        joined = self.rooms.run(room, black, "join", [])
        if not joined.get("ok"):
            self.store.close_room(room["id"])
            return None
        self.store.keep_room_private(room["id"])
        fresh = self.store.room(room["id"]) or room
        state = self.rooms.state(fresh) or {}
        if state.get("white_id") != white["id"] or state.get("black_id") != black["id"]:
            self.store.close_room(room["id"])
            return None
        return fresh

    # Shapes ------------------------------------------------------------------

    def _load(self, frame: dict) -> dict | None:
        rid = frame.get("id")
        if not isinstance(rid, str) or not rid or len(rid) > 80:
            return None
        return self.store.play_request(rid)

    def _who(self, player_id: str) -> dict:
        player = self.store.player(player_id)
        return {"id": player_id, "name": str(player["name"]) if player else ""}

    def _card(self, row: dict) -> dict:
        return {
            "id": row["id"],
            "from": self._who(row["from_id"]),
            "to": self._who(row["to_id"]),
            "game": row["game"],
            "state": row["state"],
            "created": row["created"],
            "expires": row["expires"],
            # A match offer, not an ask: neither side sent it, so either may join it.
            "offer": bool(row.get("offer")),
        }

    def _announce(self, card: dict) -> list[tuple[str, dict]]:
        frame = {"t": "request", "request": card}
        return [(card["from"]["id"], frame), (card["to"]["id"], dict(frame))]

    def _updates(self, card: dict) -> list[tuple[str, dict]]:
        frame = {"t": "request_update", "request": card}
        return [(card["from"]["id"], frame), (card["to"]["id"], dict(frame))]

    def _seated_notice(self, row: dict) -> list[tuple[str, dict]]:
        card = self._card(row)
        room = self.store.room(row.get("room_id") or "")
        state = self.rooms.state(room) if room else {}
        state = state or {}
        frames = []
        for pid, who in ((row["from_id"], card["from"]), (row["to_id"], card["to"])):
            if state.get("white_id") == pid:
                side = "white"
            elif state.get("black_id") == pid:
                side = "black"
            else:
                side = ""
            other = card["to"] if pid == row["from_id"] else card["from"]
            frames.append((pid, {
                "t": "seated",
                "room_id": row.get("room_id") or "",
                "game": row["game"],
                "side": side,
                "opponent": {"id": other["id"], "name": other["name"]},
                "request_id": row["id"],
            }))
        # The accepted update rides with the seats so both clients leave "pending".
        return self._updates(card) + frames

    def _ack(self, frame: dict, ok: bool, text: str = "") -> dict:
        op = frame.get("op")
        ack = {"t": "ack", "op": op if isinstance(op, str) and len(op) <= 80 else "", "ok": bool(ok)}
        if text:
            ack["text"] = text
        return ack

    async def _emit(self, frames: list[tuple[str, dict]]) -> None:
        for player_id, frame in frames:
            await self.hub.send_to(player_id, frame)
