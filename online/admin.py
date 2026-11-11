"""Staff administration: the offline bootstrap CLI and the /api/admin surface.

Two rules shape this file.

1. The owner is bootstrapped only on the server, by the person who runs it
   (``python -m online.admin grant-owner <name>``). No HTTP request can create,
   remove or edit an owner.
2. Every staff action is checked here, in one place, against the stored role and
   the target's role. A staff key alone proves nothing: it must belong to the
   signed-in account.

The CLI must work without aiohttp, so the store is imported and aiohttp only
inside the request handler.
"""

from __future__ import annotations

import argparse
import hmac
import json
import secrets
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .store import Store, token_hash

if TYPE_CHECKING:  # the CLI must stay usable without aiohttp installed
    from aiohttp import web

ROLES = ("owner", "admin", "moderator")
MODERATOR_ACTIONS = {
    "delete-message", "silence", "suspend", "unsilence", "unsuspend",
    "close-report", "lookup", "audit", "undo",
}
STAFF_ACTIONS = MODERATOR_ACTIONS | {
    "force-rename", "bot-remove", "bot-reset", "close-table", "appoint", "revoke",
}


def powers(role: str) -> list[str]:
    """What the admin screen may offer. The server still checks every call."""
    if role == "owner":
        return sorted(STAFF_ACTIONS)
    if role == "admin":
        return sorted(STAFF_ACTIONS - {"appoint-admin"})
    if role == "moderator":
        return sorted(MODERATOR_ACTIONS)
    return []


def allowed(role: str, action: str, target_role: str = "", *, minutes: int = 0,
            address_block: bool = False, new_role: str = "", target_is_self: bool = False) -> str:
    """Return an explanation when the action is refused, or '' when it may run."""
    if role not in ROLES:
        return "Staff sign-in required."
    if target_role == "owner" and not target_is_self:
        return "The owner cannot be changed."
    if target_role == "admin" and role != "owner" and not target_is_self:
        # An admin may not demote, ban or rename another admin: that would be
        # privilege escalation dressed up as moderation.
        return "Only the owner can act on an admin."
    if action in {"appoint", "revoke"}:
        if new_role == "owner" or target_role == "owner":
            return "The owner cannot be changed."
        if new_role == "admin" and role != "owner":
            return "Only the owner appoints admins."
        if target_role == "admin" and role != "owner":
            return "Only the owner removes an admin."
    if role == "moderator":
        if action not in MODERATOR_ACTIONS:
            return "Moderators cannot do that."
        if action == "undo":
            return "Only an owner or an admin can undo an action."
        if action == "silence" and minutes not in {10, 60, 1440}:
            return "Moderators can silence for 10 minutes, 1 hour or 24 hours."
        if action == "suspend" and (minutes <= 0 or minutes > 7 * 1440 or address_block):
            return "Moderators can suspend for up to 7 days, and cannot block an address."
    if action in {"silence", "suspend"} and minutes < 0:
        return "Pick a duration."
    return ""


# CLI -------------------------------------------------------------------------


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m online.admin",
        description="Game Center staff: the owner is granted here, on the server.")
    parser.add_argument("--data", default="./online-data", help="the lobby's data folder")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("grant-owner", help="make one account the owner and print its staff key once").add_argument("name")
    appoint = commands.add_parser("appoint", help="make an account admin or moderator")
    appoint.add_argument("name")
    appoint.add_argument("role", choices=("admin", "moderator"))
    commands.add_parser("revoke", help="remove a staff role").add_argument("name")
    commands.add_parser("roles", help="list staff (never keys)")
    audit = commands.add_parser("audit", help="show the audit log")
    audit.add_argument("--limit", type=int, default=50)
    args = parser.parse_args(argv)

    store = Store(Path(args.data) / "online.sqlite3")
    try:
        if args.command == "roles":
            rows = store.staff_list()
            if not rows:
                print("No staff yet. Run: python -m online.admin grant-owner <name>")
            for row in rows:
                print(f"{row['name']}\t{row['role']}\t{time.strftime('%Y-%m-%d %H:%M', time.gmtime(row['created']))}")
            return 0
        if args.command == "audit":
            rows = store.db.execute(
                "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (max(1, args.limit),)).fetchall()
            if not rows:
                print("No staff actions yet.")
            for row in rows:
                print(f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(row['at']))}\t"
                      f"{row['actor_name']} ({row['actor_role']})\t{row['action']}\t"
                      f"{row['target_name']}\t{row['reason']}" + ("\tundone" if row["undone"] else ""))
            return 0

        player = store.player_by_name_any(args.name)
        if args.command == "grant-owner":
            owner = next((row for row in store.staff_list() if row["role"] == "owner"), None)
            if owner:
                print(f"An owner already exists: {owner['name']}.")
                return 1
            if not player:
                player, recovery = store.create_player(args.name)
                print(f"New account {player['name']} ({player['id']}).")
                print(f"Recovery key (shown once, sign in with it): {recovery}")
            elif store.staff_role(player["id"]):
                print(f"{player['name']} already has a staff role: {store.staff_role(player['id'])}.")
                return 1
            key = secrets.token_urlsafe(24)
            store.set_staff(player["id"], "owner", token_hash(key), "cli")
            print(f"Owner: {player['name']} ({player['id']})")
            print(f"Staff key (shown once, keep it out of chat and the repo): {key}")
            return 0

        if not player:
            print(f"No account called {args.name!r}. They sign up in the lobby first.")
            return 1
        current = store.staff_role(player["id"])
        if current == "owner":
            print("The owner cannot be changed here.")
            return 1
        if args.command == "revoke":
            if not current:
                print(f"{player['name']} is not staff.")
                return 1
            store.drop_staff(player["id"])
            print(f"Revoked: {player['name']} ({current})")
            return 0
        key = secrets.token_urlsafe(24)
        store.set_staff(player["id"], args.role, token_hash(key), "cli")
        print(f"{args.role.title()}: {player['name']} ({player['id']})")
        print(f"Staff key (shown once, keep it out of chat and the repo): {key}")
        return 0
    finally:
        store.close()


# HTTP ------------------------------------------------------------------------


class AdminAPI:
    """One endpoint per read, one shared action endpoint, all behind two keys."""

    def __init__(self, app) -> None:
        from .guard import Limiter

        self.app = app
        self.store = app.store
        self.limiter = Limiter(60, 60.0)

    # -- helpers ---------------------------------------------------------------

    def _who(self, request):
        """(player, staff_row, refusal). The staff key must match this account."""
        player = self.app.me(request)
        if not player:
            return None, None, web_json({"error": "Staff sign-in required."}, 401)
        row = self.store.staff_row(player["id"])
        key = request.headers.get("X-Staff-Key", "")
        if not row or not key or not hmac.compare_digest(str(row["key_hash"]), token_hash(key)):
            return None, None, web_json({"error": "Staff sign-in required."}, 401)
        if not self.limiter.allow(player["id"]):
            return None, None, web_json({"error": "Too many requests."}, 429)
        return player, row, None

    def _audit(self, actor, row, action, target, reason, detail) -> int:
        cursor = self.store.db.execute(
            "INSERT INTO audit (at, actor_id, actor_name, actor_role, action, target_id, target_name,"
            " reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (time.time(), actor["id"], actor["name"], row["role"], action,
             (target or {}).get("id", ""), (target or {}).get("name", ""), reason, json.dumps(detail)))
        return int(cursor.lastrowid)

    def _target(self, body: dict) -> dict | None:
        raw_id = str(body.get("target_id") or "")
        if raw_id:
            found = self.store.player(raw_id)
            if found:
                return found
        name = str(body.get("target") or "").strip()
        return self.store.player_by_name_any(name) if name else None

    # -- reads -----------------------------------------------------------------

    def me(self, player, row) -> dict:
        return {"role": row["role"], "name": player["name"], "powers": powers(row["role"])}

    def overview(self) -> dict:
        count = lambda sql, args=(): self.store.db.execute(sql, args).fetchone()[0]
        now = time.time()
        return {
            "reports_open": count("SELECT COUNT(*) FROM reports WHERE state='open'"),
            "players": count("SELECT COUNT(*) FROM players WHERE bot=0"),
            "suspended": count("SELECT COUNT(*) FROM players WHERE suspended=1"),
            "silenced": count("SELECT COUNT(DISTINCT player_id) FROM punishments "
                              "WHERE kind='silence' AND lifted=0 AND (until=0 OR until>?)", (now,)),
            "staff": [{"name": item["name"], "role": item["role"]} for item in self.store.staff_list()],
        }

    def reports(self, state: str) -> dict:
        state = state if state in {"open", "closed", "all"} else "open"
        sql = "SELECT * FROM reports" + ("" if state == "all" else " WHERE state=?")
        args = () if state == "all" else (state,)
        rows = [dict(row) for row in self.store.db.execute(sql + " ORDER BY id DESC LIMIT 200", args)]
        return {"reports": rows}

    def user(self, name: str) -> dict | None:
        player = self.store.player_by_name_any(name) if name else None
        if not player:
            return None
        stats = self.store.stats(player["id"])
        rated = stats.get("rated") or []
        graded = stats.get("bots") or []
        totals = {"wins": 0, "losses": 0, "draws": 0, "games": 0}
        for row in list(rated) + list(graded):
            for key in totals:
                if key in row:
                    totals[key] += int(row.get(key) or 0)
        totals["games"] = totals["wins"] + totals["losses"] + totals["draws"]
        silence = self.store.punishment(player["id"], "silence")
        suspend = self.store.punishment(player["id"], "suspend")
        owner = {}
        if player.get("owner_id"):
            owner = self.store.player(player["owner_id"]) or {}
        reports_against = self.store.db.execute(
            "SELECT COUNT(*) FROM reports WHERE target_id=?", (player["id"],)).fetchone()[0]
        open_reports = self.store.db.execute(
            "SELECT COUNT(*) FROM reports WHERE target_id=? AND state='open'", (player["id"],)).fetchone()[0]
        actions = [dict(row) for row in self.store.db.execute(
            "SELECT id, at, actor_name, actor_role, action, reason, undone FROM audit "
            "WHERE target_id=? ORDER BY id DESC LIMIT 20", (player["id"],))]
        return {
            "player": {
                "id": player["id"], "name": player["name"], "joined": player["created"],
                "bot": bool(player.get("bot")), "owner": owner.get("name", ""),
                "staff_role": self.store.staff_role(player["id"]),
                "silenced_until": 0 if not silence else (silence["until"] or -1),
                "suspended_until": 0 if not suspend else (suspend["until"] or -1),
                "games": totals["games"], "wins": totals["wins"],
                "losses": totals["losses"], "draws": totals["draws"],
                "reports_against": reports_against, "open_reports": open_reports,
                "actions": actions,
            }
        }

    def audit(self, limit: int) -> dict:
        rows = [dict(row) for row in self.store.db.execute(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))]
        return {"entries": rows}

    # -- actions ---------------------------------------------------------------

    def act(self, player: dict, row: dict, body: dict) -> dict:
        action = str(body.get("action") or "").strip().lower()
        reason = str(body.get("reason") or "").strip()[:200]
        minutes = int(body.get("minutes") or 0)
        role = row["role"]
        if action not in STAFF_ACTIONS and action not in {"close-report"}:
            return {"ok": False, "text": "Unknown action."}

        if action == "close-report":
            report = self.store.db.execute(
                "SELECT * FROM reports WHERE id=?", (int(body.get("report_id") or 0),)).fetchone()
            if not report:
                return {"ok": False, "text": "No such report."}
            if report["state"] == "closed":
                return {"ok": False, "text": "That report is already handled."}
            self.store.db.execute(
                "UPDATE reports SET state='closed', resolution=?, handled_by=?, handled_at=? WHERE id=?",
                (str(body.get("resolution") or "Handled.")[:200], player["name"], time.time(), report["id"]))
            audit_id = self._audit(player, row, "close-report",
                                   {"id": report["target_id"], "name": report["target_name"]},
                                   reason, {"report_id": report["id"]})
            return {"ok": True, "text": "Report marked handled.", "audit_id": audit_id}

        if action == "close-table":
            denial = allowed(role, action)
            if denial:
                return {"ok": False, "text": denial}
            room = self.store.room(str(body.get("room_id") or ""))
            if not room or room["closed"]:
                return {"ok": False, "text": "No such open table."}
            self.store.close_room(room["id"])
            audit_id = self._audit(player, row, action, {"id": room["id"], "name": room["game"]}, reason,
                                   {"room_id": room["id"]})
            return {"ok": True, "text": "Table closed.", "audit_id": audit_id, "room_id": room["id"]}

        if action == "delete-message":
            message_id = int(body.get("message_id") or 0)
            chat = self.store.db.execute("SELECT * FROM chat WHERE id=?", (message_id,)).fetchone()
            if not chat:
                return {"ok": False, "text": "No such message."}
            target = self.store.player(chat["player_id"]) or {"id": chat["player_id"], "name": chat["name"]}
            denial = allowed(role, action, self.store.staff_role(target["id"]))
            if denial:
                return {"ok": False, "text": denial}
            if chat["removed"]:
                return {"ok": False, "text": "That message is already removed."}
            self.store.db.execute(
                "UPDATE chat SET removed=1, removed_by=?, removed_at=? WHERE id=?",
                (player["name"], time.time(), message_id))
            audit_id = self._audit(player, row, action, target, reason,
                                   {"message_id": message_id, "text": chat["text"],
                                    "room_id": chat["room_id"]})
            return {"ok": True, "text": "Message removed.", "audit_id": audit_id}

        if action == "undo":
            denial = allowed(role, action)
            if denial:
                return {"ok": False, "text": denial}
            return self.undo(player, row, int(body.get("audit_id") or 0))

        target = self._target(body)
        if not target:
            return {"ok": False, "text": "Pick someone first."}
        target_role = self.store.staff_role(target["id"])
        denial = allowed(role, action, target_role, minutes=minutes,
                         address_block=bool(body.get("address_block")),
                         new_role=str(body.get("role") or ""),
                         target_is_self=target["id"] == player["id"])
        if denial:
            return {"ok": False, "text": denial}
        if target.get("bot") and action not in {"bot-remove", "bot-reset"}:
            return {"ok": False, "text": "That account is a bot. Use the bot actions."}

        if action in {"silence", "suspend"}:
            if action == "silence" and minutes not in {0, 10, 60, 1440}:
                return {"ok": False, "text": "Pick 10 minutes, 1 hour, 24 hours or forever."}
            if action == "suspend" and minutes < 0:
                return {"ok": False, "text": "Pick a duration."}
            if minutes and minutes > 365 * 1440:
                return {"ok": False, "text": "That is longer than a year."}
            until = 0 if minutes == 0 else time.time() + minutes * 60
            punishment_id = self.store.punish(target["id"], action, until, reason, player["id"], player["name"])
            detail = {"punishment_id": punishment_id, "kind": action, "minutes": minutes}
            if action == "suspend":
                self.app.queue.remove(target["id"])
                if body.get("address_block") and minutes == 0 and role in {"owner", "admin"}:
                    blocked = self.store.block_address(target["id"], reason)
                    if blocked:
                        detail["address_block"] = True
            audit_id = self._audit(player, row, action, target, reason, detail)
            return {"ok": True, "text": f"{target['name']} {'suspended' if action == 'suspend' else 'silenced'}.", "audit_id": audit_id}

        if action in {"unsilence", "unsuspend"}:
            kind = "silence" if action == "unsilence" else "suspend"
            punishment = self.store.punishment(target["id"], kind)
            if not punishment:
                return {"ok": False, "text": "No active " + kind + "."}
            self.store.lift_punishment(punishment["id"], player["name"])
            audit_id = self._audit(player, row, action, target, reason,
                                   {"punishment_id": punishment["id"], "kind": kind})
            return {"ok": True, "text": f"{target['name']} is free again.", "audit_id": audit_id}

        if action == "force-rename":
            from . import guard

            name, why = guard.clean_name(body.get("name"))
            if not name:
                return {"ok": False, "text": why}
            if self.store.name_taken(name, except_id=target["id"]):
                return {"ok": False, "text": "That name is too close to one already taken."}
            old_name = target["name"]
            self.store.update_player(target["id"], name=name)
            self._renamed(target["id"], old_name, name)
            audit_id = self._audit(player, row, action, target, reason,
                                   {"old_name": old_name, "new_name": name})
            return {"ok": True, "text": f"Renamed to {name}.", "audit_id": audit_id}

        if action == "bot-remove":
            old_hash = self.store.db.execute(
                "SELECT token_hash FROM players WHERE id=?", (target["id"],)).fetchone()
            self.store.db.execute(
                "UPDATE players SET suspended=1, token_hash=? WHERE id=?",
                ("off:" + secrets.token_hex(16), target["id"]))
            self.app.queue.remove(target["id"])
            audit_id = self._audit(player, row, action, target, reason,
                                   {"token_hash": old_hash[0] if old_hash else ""})
            return {"ok": True, "text": f"{target['name']} is off the ladder.", "audit_id": audit_id}

        if action == "bot-reset":
            game = str(body.get("game") or "")
            rows = [dict(item) for item in self.store.db.execute(
                "SELECT * FROM bot_ratings WHERE player_id=?" + (" AND game=?" if game else ""),
                (target["id"], game) if game else (target["id"],))]
            records = [dict(item) for item in self.store.db.execute(
                "SELECT * FROM bot_records WHERE player_id=?" + (" AND game=?" if game else ""),
                (target["id"], game) if game else (target["id"],))]
            self.store.db.execute("DELETE FROM bot_ratings WHERE player_id=?" + (" AND game=?" if game else ""),
                                  (target["id"], game) if game else (target["id"],))
            self.store.db.execute("DELETE FROM bot_records WHERE player_id=?" + (" AND game=?" if game else ""),
                                  (target["id"], game) if game else (target["id"],))
            audit_id = self._audit(player, row, action, target, reason,
                                   {"ratings": rows, "records": records})
            return {"ok": True, "text": f"{target['name']} starts again at 1200.", "audit_id": audit_id}

        if action in {"appoint", "revoke"}:
            new_role = str(body.get("role") or "").strip().lower()
            if action == "appoint" and new_role not in {"admin", "moderator"}:
                return {"ok": False, "text": "Pick admin or moderator."}
            previous = self.store.staff_row(target["id"])
            if action == "revoke":
                if not previous:
                    return {"ok": False, "text": f"{target['name']} is not staff."}
                self.store.drop_staff(target["id"])
                audit_id = self._audit(player, row, action, target, reason,
                                       {"role": previous["role"], "key_hash": previous["key_hash"]})
                return {"ok": True, "text": f"{target['name']} is no longer staff.", "audit_id": audit_id}
            key = secrets.token_urlsafe(24)
            self.store.set_staff(target["id"], new_role, token_hash(key), player["name"])
            audit_id = self._audit(player, row, action, target, reason,
                                   {"role": new_role, "previous": previous["role"] if previous else ""})
            return {"ok": True, "text": f"{target['name']} is now {new_role}.", "audit_id": audit_id,
                    "staff_key": key, "staff_name": target["name"], "staff_role": new_role}

        return {"ok": False, "text": "Unknown action."}

    def undo(self, player: dict, row: dict, audit_id: int) -> dict:
        entry = self.store.db.execute("SELECT * FROM audit WHERE id=?", (audit_id,)).fetchone()
        if not entry:
            return {"ok": False, "text": "No such audit entry."}
        if entry["undone"] or entry["undo_of"]:
            return {"ok": False, "text": "That was already undone."}
        detail = json.loads(entry["detail"] or "{}")
        action = entry["action"]
        done = True
        text = "Undone."
        if action == "delete-message":
            self.store.db.execute(
                "UPDATE chat SET removed=0, removed_by='', removed_at=0 WHERE id=?",
                (int(detail.get("message_id") or 0),))
        elif action in {"silence", "suspend"}:
            if detail.get("punishment_id"):
                self.store.lift_punishment(int(detail["punishment_id"]), player["name"])
            if detail.get("address_block"):
                self.store.db.execute("DELETE FROM address_blocks WHERE at >= ?", (entry["at"],))
        elif action in {"unsilence", "unsuspend"}:
            kind = detail.get("kind") or ("silence" if action == "unsilence" else "suspend")
            target = self.store.player(entry["target_id"])
            if target:
                self.store.punish(target["id"], kind, 0, "Restored by undo", player["id"], player["name"])
        elif action == "force-rename":
            target = self.store.player(entry["target_id"])
            old = str(detail.get("old_name") or "")
            if target and old:
                from .guard import skeleton

                self.store.db.execute(
                    "UPDATE players SET name=?, name_key=? WHERE id=?",
                    (old, skeleton(old), target["id"]))
                self._renamed(target["id"], target["name"], old)
            else:
                done = False
        elif action == "bot-remove":
            self.store.db.execute(
                "UPDATE players SET suspended=0, token_hash=? WHERE id=?",
                (str(detail.get("token_hash") or ""), entry["target_id"]))
        elif action == "bot-reset":
            for item in detail.get("ratings") or []:
                self.store.db.execute(
                    "INSERT OR REPLACE INTO bot_ratings (player_id, game, rating, games, wins, losses, draws)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (item["player_id"], item["game"], item["rating"], item["games"],
                     item["wins"], item["losses"], item["draws"]))
            for item in detail.get("records") or []:
                self.store.db.execute(
                    "INSERT OR REPLACE INTO bot_records (player_id, game, wins, losses, draws)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (item["player_id"], item["game"], item["wins"], item["losses"], item["draws"]))
        elif action in {"appoint", "revoke"}:
            target = self.store.player(entry["target_id"])
            if action == "appoint":
                previous = str(detail.get("previous") or "")
                if previous:
                    self.store.db.execute("UPDATE staff SET role=? WHERE player_id=?", (previous, entry["target_id"]))
                else:
                    self.store.drop_staff(entry["target_id"])
            elif target:
                self.store.set_staff(entry["target_id"], str(detail.get("role") or "moderator"),
                                     str(detail.get("key_hash") or ""), player["name"])
        elif action == "close-report":
            self.store.db.execute(
                "UPDATE reports SET state='open', resolution='', handled_by='', handled_at=0 WHERE id=?",
                (int(detail.get("report_id") or 0),))
        else:
            done = False
            text = "That one cannot be undone."
        if not done:
            return {"ok": False, "text": text}
        self.store.db.execute("UPDATE audit SET undone=1 WHERE id=?", (audit_id,))
        undo_id = self._audit(player, row, "undo:" + action,
                              {"id": entry["target_id"], "name": entry["target_name"]},
                              "Undo of #" + str(audit_id), {"audit_id": audit_id})
        self.store.db.execute("UPDATE audit SET undo_of=? WHERE id=?", (audit_id, undo_id))
        return {"ok": True, "text": text, "audit_id": undo_id}

    def _renamed(self, player_id: str, old: str, new: str) -> None:
        """A forced rename must not leave the old name free to be claimed."""
        if old and old.lower() != new.lower():
            self.store.db.execute(
                "INSERT OR REPLACE INTO old_names (name, player_id, until) VALUES (?, ?, ?)",
                (old, player_id, time.time() + 30 * 86400))

    # -- one door --------------------------------------------------------------

    async def handle(self, request) -> "web.Response":
        player, row, refusal = self._who(request)
        if refusal is not None:
            return refusal
        path = request.match_info.get("path", "").strip("/")
        parts = [part for part in path.split("/") if part]
        try:
            if not parts:
                return web_json({"error": "Not found."}, 404)
            head = parts[0]
            if head == "me" and len(parts) == 1:
                return web_json(self.me(player, row))
            if head == "overview" and len(parts) == 1:
                return web_json(self.overview())
            if head == "reports" and len(parts) == 1:
                return web_json(self.reports(request.query.get("state", "open")))
            if head == "reports" and len(parts) == 3 and parts[2] == "close":
                body = await read_body(request)
                body["action"] = "close-report"
                body["report_id"] = parts[1]
                return web_json(self.act(player, row, body))
            if head == "user" and len(parts) == 1:
                found = self.user(request.query.get("name", "").strip())
                return web_json(found or {"ok": False, "error": "No such name."},
                                200 if found else 404)
            if head == "users" and len(parts) == 1:
                q = request.query.get("q", "").strip()
                rows = self.store.db.execute(
                    "SELECT id, name, bot FROM players WHERE name LIKE ? ORDER BY name LIMIT 20",
                    (q + "%",)).fetchall()
                return web_json({"users": [dict(item) for item in rows]})
            if head == "audit" and len(parts) == 1:
                try:
                    limit = max(1, min(500, int(request.query.get("limit", "100"))))
                except ValueError:
                    limit = 100
                return web_json(self.audit(limit))
            if head == "action" and len(parts) == 1 and request.method == "POST":
                body = await read_body(request)
                verdict = self.act(player, row, body)
                return web_json(verdict, 200 if verdict.get("ok") else 400)
        except (ValueError, TypeError, KeyError) as exc:
            return web_json({"ok": False, "text": str(exc) or "Invalid request."}, 400)
        return web_json({"error": "Not found."}, 404)


def web_json(payload: dict, status: int = 200):
    from aiohttp import web

    return web.json_response(payload, status=status)


async def read_body(request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


if __name__ == "__main__":
    raise SystemExit(main())
