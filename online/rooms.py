"""Rooms for Game Center Online. Each room is one kit.Table in its own folder.

The kit is the referee: every move, seat, resignation and rematch goes through
Table.command as the identified web player, exactly like a typed /games line.
This module adds only the online rules the kit has no notion of: room hosts,
private-room invites, disconnect claims, and recording finished matches once.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import time
import types
from pathlib import Path

_SHELF = Path(__file__).resolve().parent.parent
if str(_SHELF) not in sys.path:
    sys.path.insert(0, str(_SHELF))

import kit  # noqa: E402
from . import league  # noqa: E402

# Listed first, in this order; any other table game found beside them follows by title.
CURATED = ("connect4", "reversi", "checkers", "gomoku", "chessboard",
           "go", "hex", "breakthrough", "seabattle", "blackjack", "slots")
FIRST = ("connect4", "reversi", "checkers", "gomoku", "chessboard")
MODES = {
    "two": "new",
    "bot": "allow-ai black=local",
    "bots": "allow-ai white=local black=local",
    "lesson": "lesson",
}
FINISHED = {"win", "draw", "resigned"}
DISCONNECT_GRACE = 120.0
# A ladder room with no seated bot connected yet is not clocked for this long, then the
# move clock starts. A bot that never arrives forfeits 15 s after that.
LADDER_CONNECT_GRACE = 60.0
ROOM_IDLE_DAYS = 3

# Same refusal heuristics the Desktop adapter uses; the kit returns text, not typed results.
_REFUSALS = (
    "Refused", "Could not read", "Usage:", "Only ", "Take a seat first",
    "That seat is taken", "Both seats are taken", "Both seats must be occupied",
    "AI is off", "A match is in progress", "Finish the current game",
    "A person ", "A bot cannot", "Join from your own chat", "No game in progress",
    "No opponent draw offer", "A human opponent must", "The opponent offered",
    "The AI here", "Name the AI seat", "A named table owner must", "It's ",
    "You already hold a seat", "You are ", "No lesson", "Lesson steps", "Hints are only",
)


def refused(text: str) -> bool:
    return not text or text.startswith(_REFUSALS) or "is in progress with" in text


def person(player: dict) -> types.SimpleNamespace:
    """A kit player. platform "web" is never a shared keyboard: one person, one seat."""
    return types.SimpleNamespace(id=player["id"], name=player["name"], platform="web", bot=False, named=True)


def table_games(root: Path = _SHELF) -> list[tuple[str, Path, dict]]:
    """Every folder beside the shelf with a game.json of kind "table": (id, folder, manifest)."""
    found = []
    for folder in sorted(root.iterdir()):
        try:
            meta = json.loads((folder / "game.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(meta, dict):
            continue
        game_id = str(meta.get("id") or "")
        entry = str(meta.get("entry") or "game.py")
        if (game_id not in CURATED or folder.name != game_id or meta.get("kind") != "table"
                or not game_id.replace("-", "").isalnum()
                or Path(entry).is_absolute() or ".." in Path(entry).parts
                or not (folder / entry).is_file()):
            continue
        found.append((game_id, folder, meta))
    rank = {game_id: index for index, game_id in enumerate(FIRST)}
    found.sort(key=lambda item: (rank.get(item[0], len(FIRST)), str(item[2].get("title") or item[0]).lower()))
    return found


def load_games(root: Path = _SHELF) -> dict[str, types.ModuleType]:
    found: dict[str, types.ModuleType] = {}
    for game_id, folder, meta in table_games(root):
        if game_id in found:
            continue
        path = folder / str(meta.get("entry") or "game.py")
        spec = importlib.util.spec_from_file_location(f"gameshelf_online_{game_id.replace('-', '_')}", path)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if callable(getattr(module, "create", None)) and callable(getattr(module, "picture", None)):
            module.MANIFEST = meta
            found[game_id] = module
    return found


GAMES = tuple(game_id for game_id, _folder, _meta in table_games())


def game_cards(games: dict[str, types.ModuleType], root: Path = _SHELF) -> list[dict]:
    del root
    cards = []
    for game_id, module in games.items():
        meta: dict = dict(getattr(module, "MANIFEST", {}) or {})
        cards.append({
            "id": game_id,
            "title": getattr(module, "TITLE", game_id),
            "help": list(getattr(module, "HELP", [])),
            "blurb": str(meta.get("summary") or ""),
            "bots": bool(meta.get("bots", True)),
            "lesson": bool(kit.lesson_steps(module)),
        })
    return cards


def permissions(picture: dict, player_id: str) -> dict[str, bool]:
    """Presentation hints for one viewer. Table.command remains the security boundary."""
    seats = picture.get("seats") or []
    mine = [seat for seat in seats if seat.get("kind") == "human" and seat.get("id") == player_id]
    active = picture.get("status") == "active"
    preview = bool(picture.get("preview"))
    owner = bool(player_id) and picture.get("owner_id") == player_id
    manager = bool(mine) or owner
    turn = next((seat for seat in seats if seat.get("side") == picture.get("turn")), {})
    return {
        "can_move": active and turn.get("kind") == "human" and turn.get("id") == player_id,
        "can_join": active and any(seat.get("open") for seat in seats) and not mine,
        "can_manage": owner or preview,
        "can_resign": active and bool(mine),
        "can_rematch": not active and not preview and manager,
        "can_draw": active and bool(mine),
        "can_step": active and owner and turn.get("kind") == "local",
        "can_hint": bool(picture.get("hint_ok")) and turn.get("kind") == "human" and turn.get("id") == player_id,
        "can_lesson": owner and bool(picture.get("has_lesson")),
    }


class Rooms:
    def __init__(self, store, data_root: Path, games: dict[str, types.ModuleType] | None = None, clock=time.time) -> None:
        self.store = store
        self.data_root = Path(data_root)
        self.games = games if games is not None else load_games()
        self.clock = clock
        self.turn_since: dict[str, float] = {}
        # (room_id, player_id) -> time their last connection closed. Absent means never connected
        # or connected now; the server keeps it current.
        self.left_at: dict[tuple[str, str], float] = {}
        self.online: dict[str, set[str]] = {}
        # Presence is not saved. After a restart, everyone seated counts as away from now,
        # so a player who never comes back can still be claimed against.
        self.started = clock()

    # Tables ------------------------------------------------------------------

    def folder(self, room_id: str) -> Path:
        """One folder per room, and never one that leaves the rooms tree.

        Room ids are minted here, so this can only be reached with a bad value from
        elsewhere; refusing is cheaper than discovering a room that writes into
        another room's folder, or out of the data root.
        """
        name = str(room_id or "")
        if not name or Path(name).is_absolute() or ".." in Path(name).parts or "/" in name or "\\" in name:
            raise ValueError("a room id is a plain folder name, not a path")
        folder = (self.data_root / "rooms" / name).resolve()
        base = (self.data_root / "rooms").resolve()
        if folder.parent != base or folder.name != name:
            # A symlink pointing at another room's folder keeps its parent but not its
            # name; writes would land in the other table's state.
            raise ValueError("a room id must stay inside the rooms folder")
        return folder

    def table(self, room: dict):
        module = self.games[room["game"]]
        folder = self.folder(room["id"])
        # Each online table keeps its own chips. Without this, every room at one data root
        # would share a single wallet file and spend the same balance.
        return module.create(folder, {
            "allow_ai": True,
            "data_root": str(self.data_root),
            "wallet": str(folder / "wallet.json"),
        })

    def state(self, room: dict) -> dict | None:
        try:
            return kit.load(self.folder(room["id"]))
        except ValueError:
            # A row whose id is not a folder name has no state. Reads are the path a
            # loop reaches for every open room, so one bad row must not take the lobby
            # (or the janitor pass) down; the strict check still refuses the write.
            return None

    def create(self, game: str, host: dict, public: bool, mode: str = "two", bots_ok: bool = False,
               level: str = "") -> tuple[dict | None, str]:
        if game not in self.games:
            return None, "Unknown game."
        if host.get("bot"):
            return None, "Bots join tables; a person hosts them."
        if mode not in MODES:
            return None, "Pick two players, play the bot, or watch bots."
        if mode != "two" and not (getattr(self.games[game], "MANIFEST", {}) or {}).get("bots", True):
            return None, "This game has no built-in player."
        room = self.store.create_room(game, host["id"], public, bots_ok=bots_ok and self.bots_allowed(game))
        line = MODES[mode]
        if mode in {"bot", "bots"} and level in kit.LEVELS:
            line += f" level={level}"
        answer = self.table(room).command(line, source="command", player=person(host))
        if refused(answer):
            self.store.close_room(room["id"])
            return None, answer
        self.settle(room)
        if mode == "two" and not public:
            self.store.create_invite(room["id"], "black")
        return room, ""

    def bots_allowed(self, game: str) -> bool:
        return bool((getattr(self.games.get(game), "MANIFEST", {}) or {}).get("bots", True))

    def bot_refusal(self, room: dict, player: dict, invited: bool = False) -> str:
        """Registered bots sit only where the host said yes: a bots-welcome table or an invite link."""
        if not player.get("bot"):
            return ""
        if not self.bots_allowed(room["game"]):
            return "This game does not take bots."
        if not invited and not room.get("bots_ok"):
            return "This table does not take bots. The host can send your bot an invite link."
        return ""

    def picture(self, room: dict, player_id: str) -> dict:
        try:
            pictured = self.table(room).picture() or {}
        except ValueError:
            # A room row whose id is not a folder name has no picture. Broadcast walks
            # every connection; one bad row must not end the pass.
            return {}
        for seat in pictured.get("seats") or []:
            seat["bot"] = str(seat.get("id") or "").startswith("bot:")
        pictured["viewer_id"] = player_id
        pictured["permissions"] = permissions(pictured, player_id)
        pictured["permissions"]["can_claim"] = bool(self.claimable(room, player_id))
        pictured["absent"] = self.absent_sides(room)
        pictured["pair"] = self.pair_info(room)
        pictured["open_league"] = bool(room.get("open_league"))
        pictured["labels"] = self.labels(room)
        return pictured

    def pair_info(self, room: dict) -> dict:
        """The two-leg block the page shows, or {} for a single unrated table."""
        pair = self.store.pair_for_room(room["id"]) if room.get("pair_id") else None
        if not pair:
            return {}
        return {"id": pair["id"], "leg": int(room.get("pair_leg") or 0), "legs": league.PAIR_LEGS,
                "seed": int(pair["seed"]), "rated": bool(pair["rated"]),
                "score": f"{pair['score_one']}-{pair['score_two']}",
                "other_room": pair["room_b"] if room["id"] == pair["room_a"] else pair["room_a"]}

    def labels(self, room: dict) -> list[dict]:
        """Small honest badges: what this table is, and how it is being played."""
        found = []
        available = tuple(self.games)
        if league.casual(room.get("game") or ""):
            found.append({"text": "Casual only", "kind": "casual"})
        elif league.ranked(room.get("game") or "", available):
            found.append({"text": "Ranked", "kind": "ranked"})
        if room.get("open_league"):
            found.append({"text": league.OPEN_LEAGUE_BADGE, "kind": "unverified"})
        return found


    # Commands ----------------------------------------------------------------

    def run(self, room: dict, player: dict, action: str, args: list[str] | None = None) -> dict:
        """One table action as this player. Returns {ok, text, finished}."""
        args = [str(item)[:16] for item in (args or [])][:3]
        if room.get("closed"):
            return {"ok": False, "text": "This table is closed.", "finished": None}
        host = player["id"] == room["host_id"]
        state = self.state(room)
        if action == "new":
            mode = args[0] if args else "two"
            if not host:
                return {"ok": False, "text": "Only the host starts a new match.", "finished": None}
            if mode not in MODES:
                return {"ok": False, "text": "Pick two players, play the bot, or watch bots.", "finished": None}
            line = MODES[mode]
        elif action in {"join", "sit"}:
            refusal = self.bot_refusal(room, player) if not self._seated(state, player["id"]) else ""
            if refusal:
                return {"ok": False, "text": refusal, "finished": None}
            if not room["public"] and not host and not self._seated(state, player["id"]):
                return {"ok": False, "text": "This is a private table. Use your invite link to take a seat.", "finished": None}
            if action == "sit":
                if not args or args[0] not in kit.SIDES:
                    return {"ok": False, "text": "Usage: sit white|black", "finished": None}
                line = f"sit {args[0]}"
            else:
                line = "join"
        elif action == "move":
            if not args:
                return {"ok": False, "text": "Pick a move.", "finished": None}
            line = "move " + " ".join(args)
        elif action == "draw":
            line = "draw accept" if args[:1] == ["accept"] else "draw"
        elif action == "leave" and self._seated(state, player["id"]) and state and state.get("status") == "active" \
                and int(state.get("plies") or 0):
            # The kit resigns and then clears the seat in one write, which would record the
            # result without the leaver. Resign on its own first so the record names them.
            resigned = self._command(room, player, "resign")
            left = self._command(room, player, "leave")
            return {"ok": left["ok"], "text": left["text"], "finished": resigned["finished"]}
        elif action == "lesson":
            if not host:
                return {"ok": False, "text": "Only the host starts a lesson.", "finished": None}
            step = args[0] if args else ""
            if step and step != "next" and not step.isdigit():
                return {"ok": False, "text": "Usage: lesson [next|step number]", "finished": None}
            line = f"lesson {step}".strip()
        elif action in {"leave", "resign", "rematch", "step", "hint"}:
            line = action
        else:
            return {"ok": False, "text": "Unknown action.", "finished": None}
        return self._command(room, player, line)

    def _command(self, room: dict, player: dict, line: str) -> dict:
        # A ladder bot that misses the move clock forfeits even if its move lands before
        # the next janitor pass.
        current = self.store.room(room["id"]) or room
        if current.get("ladder") and line.startswith("move "):
            # Only someone at the table may end it. Without this, a spectator could
            # trigger a timed-out forfeit and record the loss.
            seated = {str((self.state(room) or {}).get(f"{side}_id") or "") for side in kit.SIDES}
            if str(player.get("id") or "") not in seated:
                return {"ok": False, "text": "Take a seat first.", "finished": None}
            started = self.turn_since.get(room["id"])
            if started is not None and self.clock() - started > league.move_seconds(
                    current.get("game") or "", open_league=bool(current.get("open_league"))):
                side = (self.state(room) or {}).get("turn")
                recorded = self._forfeit(room, side)
                if recorded is not None:
                    return {"ok": False, "text": "Time ran out for that move.", "finished": recorded}
        self.settle(room)
        text = self.table(room).command(line, source="command", player=person(player))
        finished = self.settle(room)
        self.store.touch_room(room["id"])
        if not refused(text) and line.startswith("move "):
            # Only a move passes the turn; join/sit/draw offers must not buy a bot more clock.
            self.turn_since[room["id"]] = self.clock()
        return {"ok": not refused(text), "text": text, "finished": finished}

    def _forfeit(self, room: dict, side: str, reason: str = "timeout") -> dict | None:
        """Resign one side (a bot that ran out of time) and record the match once."""
        state = self.state(room) or {}
        if side not in kit.SIDES or not state.get(f"{side}_id"):
            return None
        loser = {"id": str(state.get(f"{side}_id")), "name": state.get(f"{side}_name") or side}
        text = self.table(room).command("resign", source="command", player=person(loser))
        if refused(text):
            return None
        root = self.folder(room["id"])
        with kit.locked(root):
            after = kit.load(root)
            if after and after.get("status") == "resigned":
                after["result_reason"] = reason
                kit.write(root, after)
        recorded = self.settle(room)
        self.turn_since.pop(room["id"], None)
        return recorded

    def settle(self, room: dict) -> dict | None:
        """Number a match when it starts; record it once when it ends.

        The match number is saved in the table's state and recording is idempotent, so a
        crash between the referee's write and the database write is repaired on the next
        command instead of losing the result.
        """
        root = self.folder(room["id"])
        with kit.locked(root):
            state = kit.load(root)
            if not state or state.get("lesson"):
                return None  # lessons are practice: never numbered, never recorded
            if state.get("status") == "active" and not state.get("online_open"):
                self.turn_since[room["id"]] = self.clock()
                state["online_match"] = self.store.next_match_no(room["id"])
                state["online_open"] = True
                kit.write(root, state)
                return None
            if state.get("status") in FINISHED and state.get("online_open"):
                pair = self.store.pair_for_room(room["id"])
                recorded = self.store.record_match(room["id"], int(state["online_match"]), state)
                state["online_open"] = False
                kit.write(root, state)
                self.store.mark_ladder(room["id"], False)
                if pair:
                    # A leg is a replay and a scoreline; the pair is the rated game.
                    settled = self.store.settle_pair_leg(room["id"], str(state.get("winner") or ""),
                                                         str(state.get("result_reason") or state.get("status") or ""))
                    if settled:
                        block = {**self.pair_info(self.store.room(room["id"]) or room),
                                 **{key: value for key, value in settled.items() if key != "pair"}}
                        recorded = {**(recorded or {"match_no": int(state["online_match"]), "winner": str(state.get("winner") or ""), "reason": str(state.get("result_reason") or "")}), "pair": block}
                return recorded
            if state.get("status") == "abandoned" and state.get("online_open"):
                state["online_open"] = False
                kit.write(root, state)
                self.store.mark_ladder(room["id"], False)
        return None

    @staticmethod
    def _seated(state: dict | None, player_id: str) -> list[str]:
        if not state:
            return []
        return [side for side in kit.SIDES
                if state.get(f"{side}_id") == player_id and kit.seat_kind(state.get(side, "")) == "human"]

    def check_clocks(self, now: float) -> list[str]:
        expired = []
        for room in self.store.active_ladder_rooms():
            state = self.state(room) or {}
            if state.get("status") != "active" or not all(str(state.get(f"{side}_id") or "").startswith("bot:") for side in kit.SIDES):
                continue
            started = self.turn_since.get(room["id"])
            if started is None:
                if now - float(room.get("created") or now) < LADDER_CONNECT_GRACE:
                    continue
                # Nobody connected in time: start the move clock; the next check forfeits.
                self.turn_since[room["id"]] = now
                continue
            if now - started <= league.move_seconds(room.get("game") or "", open_league=bool(room.get("open_league"))):
                continue
            side = state.get("turn")
            if side not in kit.SIDES:
                continue
            if self._forfeit(room, side) is not None:
                expired.append(room["id"])
        return expired

    # Invites -----------------------------------------------------------------

    def invite(self, room: dict, player: dict, side: str) -> tuple[str | None, str]:
        if player["id"] != room["host_id"]:
            return None, "Only the host makes invite links."
        if side not in kit.SIDES:
            return None, "Pick a seat."
        state = self.state(room)
        if not state or kit.seat_kind(state.get(side, "")) != "human" or state.get(f"{side}_id"):
            return None, "That seat is not open."
        return self.store.create_invite(room["id"], side), ""

    def redeem(self, room: dict, player: dict, code: str) -> dict:
        found = self.store.invite(code)
        if not found or found["room_id"] != room["id"]:
            return {"ok": False, "text": "That invite link is not for this table.", "finished": None}
        state = self.state(room)
        if self._seated(state, player["id"]):
            return {"ok": True, "text": "You already have a seat here.", "finished": None}
        if found["used_at"] is not None:
            return {"ok": False, "text": "That invite link was already used. Ask the host for a new one.", "finished": None}
        refusal = self.bot_refusal(room, player, invited=True)
        if refusal:
            return {"ok": False, "text": refusal, "finished": None}
        side = found["side"]
        root = self.folder(room["id"])
        if not state or kit.seat_kind(state.get(side, "")) != "human" or state.get(f"{side}_id"):
            # Someone else sat first; keep the link alive for when the seat opens again.
            return {"ok": False, "text": "That seat is taken right now.", "finished": None}
        # Claim the code first so two people redeeming at once cannot both sit.
        if not self.store.use_invite(code, player["id"]):
            return {"ok": False, "text": "That invite link was already used. Ask the host for a new one.", "finished": None}
        text = self.table(room).command(f"sit {side}", source="command", player=person(player))
        after = kit.load(root)
        if refused(text) or not after or after.get(f"{side}_id") != player["id"]:
            self.store.unuse_invite(code, player["id"])
            return {"ok": False, "text": text if refused(text) else "That seat is taken.", "finished": None}
        self.store.touch_room(room["id"])
        return {"ok": True, "text": text, "finished": None}

    # Presence and disconnect claims -----------------------------------------

    def connected(self, room_id: str, player_id: str) -> None:
        self.online.setdefault(room_id, set()).add(player_id)
        self.left_at.pop((room_id, player_id), None)
        room = self.store.room(room_id)
        if room and room.get("ladder") and room_id not in self.turn_since:
            state = self.state(room) or {}
            if state.get("status") == "active" and player_id in {
                    str(state.get("white_id") or ""), str(state.get("black_id") or "")}:
                # The first seated bot to arrive starts the move clock; a slow connection
                # is not a slow move.
                self.turn_since[room_id] = self.clock()

    def disconnected(self, room_id: str, player_id: str) -> None:
        self.online.get(room_id, set()).discard(player_id)
        self.left_at[(room_id, player_id)] = self.clock()

    def absent_sides(self, room: dict) -> dict[str, int]:
        """Seconds each seated human has been away, for seats whose person is gone."""
        state = self.state(room)
        if not state or state.get("status") != "active":
            return {}
        away: dict[str, int] = {}
        for side in kit.SIDES:
            seat_id = str(state.get(f"{side}_id") or "")
            if kit.seat_kind(state.get(side, "")) != "human" or not seat_id:
                continue
            if seat_id in self.online.get(room["id"], set()):
                continue
            left = self.left_at.get((room["id"], seat_id), max(self.started, float(room.get("active") or 0)))
            away[side] = int(self.clock() - left)
        return away

    def claimable(self, room: dict, player_id: str) -> str:
        """The opponent's side if this player may claim the win by disconnect, else ""."""
        state = self.state(room)
        mine = self._seated(state, player_id)
        if not state or state.get("status") != "active" or len(mine) != 1:
            return ""
        other = "black" if mine[0] == "white" else "white"
        if kit.seat_kind(state.get(other, "")) != "human" or not state.get(f"{other}_id"):
            return ""
        if not int(state.get("plies") or 0):
            return ""
        away = self.absent_sides(room).get(other)
        return other if away is not None and away >= DISCONNECT_GRACE else ""

    def claim(self, room: dict, player: dict) -> dict:
        side = self.claimable(room, player["id"])
        if not side:
            return {"ok": False, "text": f"You can claim the win after your opponent has been gone {int(DISCONNECT_GRACE)} seconds.", "finished": None}
        root = self.folder(room["id"])
        state = kit.load(root) or {}
        absent = {"id": str(state.get(f"{side}_id")), "name": str(state.get(f"{side}_name") or side)}
        self.settle(room)
        text = self.table(room).command("resign", source="command", player=person(absent))
        with kit.locked(root):
            after = kit.load(root)
            if after and after.get("status") == "resigned" and after.get("result_reason") == "resignation":
                after["result_reason"] = "disconnect"
                kit.write(root, after)
        finished = self.settle(room)
        self.store.touch_room(room["id"])
        return {"ok": not refused(text), "text": f"{absent['name']} left the table. You win by disconnect.", "finished": finished}

    # Host tools --------------------------------------------------------------

    def remove(self, room: dict, host: dict, target_id: str) -> tuple[bool, str]:
        if host["id"] != room["host_id"]:
            return False, "Only the host can remove people."
        if target_id == host["id"]:
            return False, "You cannot remove yourself."
        state = self.state(room)
        seated = self._seated(state, target_id)
        if seated and state and state.get("status") == "active" and int(state.get("plies") or 0):
            return False, "Players in a match cannot be removed. Mute them, or finish the game."
        if seated:
            target = self.store.player(target_id) or {"id": target_id, "name": ""}
            self.table(room).command("leave", source="command", player=person(target))
        self.store.moderate(room["id"], target_id, "removed")
        return True, ""

    def mute(self, room: dict, host: dict, target_id: str, on: bool) -> tuple[bool, str]:
        if host["id"] != room["host_id"]:
            return False, "Only the host can mute people."
        if target_id == host["id"]:
            return False, "You cannot mute yourself."
        self.store.moderate(room["id"], target_id, "muted", on)
        return True, ""

    def close(self, room: dict, host: dict) -> dict:
        if host["id"] != room["host_id"]:
            return {"ok": False, "text": "Only the host can close the table.", "finished": None}
        finished = None
        state = self.state(room)
        in_play = bool(state and state.get("status") == "active" and int(state.get("plies") or 0))
        if in_play and self._seated(state, host["id"]):
            # Closing mid-match is the host's resignation, never a free exit.
            finished = self._command(room, host, "resign")["finished"]
        elif in_play and all(kit.seat_kind(state.get(side, "")) == "human" and state.get(f"{side}_id") for side in kit.SIDES):
            return {"ok": False, "text": "Two other people are mid-match. Close the table after they finish.", "finished": None}
        self.store.close_room(room["id"])
        return {"ok": True, "text": "Table closed.", "finished": finished}

    def expire(self) -> list[str]:
        stale = self.store.stale_rooms(self.clock() - ROOM_IDLE_DAYS * 86400)
        for room_id in stale:
            self.store.close_room(room_id)
            try:
                folder = self.folder(room_id)
            except ValueError:
                # Closed in the database, but its id is not a folder name: nothing to
                # remove, and one bad row must not end the sweep.
                continue
            shutil.rmtree(folder, ignore_errors=True)
        return stale
