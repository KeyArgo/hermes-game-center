"""A champion's (or the person's own agent's) bot on the public ladder.

The bot runs **here**, on the person's machine, and speaks the bot protocol in
``docs/BOT-API.md``: connect, sign in with the bot key, wait for the table's
picture, and send one move for each turn. The model is called on this computer,
the board and the legal moves are all it is given, and the only thing that
leaves is the move it picked - exactly the move a person's own move would be.

Entering the ladder is a press, not a habit: :meth:`Ladder.estimate` says how
many model calls one game is likely to take, and nothing runs until
:meth:`Ladder.start` is called.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

from . import ws as wsmod

log = logging.getLogger(__name__)

MAX_CALLS = 42                # a generous ceiling for one game: one per move
MOVE_SECONDS = 12.0           # under the table's 15-second clock
QUEUE_SECONDS = 600.0         # waiting for another bot in the queue
POLL_SECONDS = 5.0
ASK_TRIES = 2


def estimate_text(calls: int, title: str = "a game") -> str:
    """Plain words about what pressing Enter ladder will use."""
    minutes = max(2, int(round(calls * MOVE_SECONDS / 60.0)))
    return (
        f"One rated ladder game of {title} is up to about {calls} model calls on this computer, "
        f"one per move, each a short text answer. The table allows 15 seconds a move, and most "
        f"games end in about {minutes} minutes. Your model sees the board and the legal moves; "
        f"only the move it picks is sent to the ladder."
    )


def board_text(picture: dict) -> str:
    """A small drawn board from the table's own picture, or its moves."""
    cells = picture.get("cells")
    if isinstance(cells, list) and cells and all(isinstance(row, list) for row in cells):
        return "\n".join(" ".join(str(cell) for cell in row) for row in cells)
    lines = picture.get("draw")
    if isinstance(lines, list) and all(isinstance(line, str) for line in lines):
        return "\n".join(lines)
    moves = picture.get("moves")
    if isinstance(moves, list) and moves:
        return "Moves so far: " + " ".join(str(move) for move in moves[-20:])
    return "Moves so far: none"


def move_prompt(picture: dict, side: str, title: str) -> tuple[str, dict]:
    """The one prompt a climb of the ladder asks, and the legal moves it may name."""
    legal = [str(move) for move in (picture.get("legal") or []) if str(move)]
    names = {move.lower(): move for move in legal}
    prompt = "\n".join([
        f"You are playing {title} as {side} in a rated ladder game against another bot.",
        "Your opponent is another program, not a person.",
        "",
        "Board:",
        board_text(picture),
        "",
        f"Moves so far: {' '.join(str(move) for move in (picture.get('moves') or [])[-20:]) or 'none'}",
        "Legal moves: " + ", ".join(legal),
        "Reply with exactly one legal move from that list and nothing else.",
    ])
    return prompt, names


def choose(text: Any, names: dict, legal: list[str]) -> tuple[str, bool]:
    """The move the model named, or the first legal move when it named none."""
    clean = str(text or "").strip().strip(".!,:;\"'").lower()
    for token in (clean, clean.split()[0] if clean else ""):
        if token and token in names:
            return names[token], True
    return (legal[0] if legal else ""), False


class Ladder:
    """One ladder game at a time, run in a thread so the page never waits."""

    def __init__(
        self,
        online,
        *,
        ask: Callable[[dict, str, str], Any] | None = None,
        clock: Callable[[], float] = time.time,
        socket_factory: Callable[..., Any] | None = None,
        games: Callable[[str], Any] | None = None,
    ) -> None:
        self.online = online
        self.ask = ask
        self.clock = clock
        self._socket = socket_factory or wsmod.Socket
        self._games = games
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state: dict = {"state": "idle", "text": "", "game": "", "plies": 0, "calls": 0,
                             "result": "", "rating": "", "room": "", "opponent": "", "bot": ""}

    # What the person sees before pressing anything -------------------------

    def estimate(self, game: str, title: str = "") -> dict:
        calls = MAX_CALLS // 2 + 1
        rules = self._games(game) if self._games else None
        plies = int(getattr(rules, "MAX_PLIES", 0) or 0) if rules is not None else 0
        if plies:
            calls = plies // 2 + 1
        return {"ok": True, "calls": calls, "game": game,
                "text": estimate_text(calls, title or game)}

    # Running ---------------------------------------------------------------

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def _set(self, **changes: Any) -> None:
        with self._lock:
            self._state.update(changes)
            self.online.set_ladder(dict(self._state))

    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, *, game: str, title: str = "", champion: dict | None = None, opponent: str = "",
              open_league: bool = False) -> dict:
        if not self.online.on:
            return {"ok": False, "text": "Turn online play on first."}
        if self.running():
            return {"ok": False, "text": "A ladder game is already running."}
        if self.ask is None:
            return {"ok": False, "text": "This Hermes has no model to play with, so the ladder needs one picked first."}
        who = champion or {"id": "agent", "kind": "champion", "name": "Your agent", "motto": "",
                           "brief": "Play to win. Answer with one legal move and nothing else."}
        bot = self.online.ensure_bot(str(who.get("name") or "Champion bot"))
        if not bot.get("ok"):
            return bot
        self._stop.clear()
        self._set(state="starting", text="Entering the ladder...", game=game, plies=0, calls=0,
                  result="", rating="", room="", opponent="", bot=str(bot.get("name") or ""),
                  started=self.clock())
        self._thread = threading.Thread(
            target=self._run, name="gameshelf-ladder", daemon=True,
            args=(game, title or game, who, bot, opponent, open_league),
        )
        self._thread.start()
        return {"ok": True, "text": "Entering the ladder. Your model plays the moves on this computer.",
                "ladder": self.status()}

    def stop(self) -> dict:
        self._stop.set()
        bot = self.online.bot_key()
        if bot:
            self.online.bot_queue_stop(bot)
        self._set(state="stopped", text="Ladder game stopped.")
        return {"ok": True, "text": "Stopped.", "ladder": self.status()}

    # The game --------------------------------------------------------------

    def _run(self, game: str, title: str, who: dict, bot: dict, opponent: str, open_league: bool = False) -> None:
        room = ""
        try:
            room, side = self._find_game(game, title, bot, opponent, open_league)
            if not room:
                return
            finished = self._play(game, title, who, bot, room, side)
            # A ranked match is a pair: the same deal twice with the seats swapped.
            # The first leg's answer carries the second table, so play it now rather
            # than leave a half-played pair behind.
            pair = finished.get("pair") if isinstance(finished, dict) else None
            if isinstance(pair, dict) and pair.get("other_room") and int(pair.get("leg") or 0) == 1 and not self._stop.is_set():
                other = str(pair["other_room"])
                swapped = "black" if side == "white" else "white"
                self._set(state="playing", result="", rating="",
                          text=f"Leg 1 of 2 is in. Playing leg 2 on the same deal, seats swapped, as {swapped}.",
                          room=other)
                self._play(game, title, who, bot, other, swapped)
        except Exception:
            self._set(state="error", text="The ladder game stopped unexpectedly. Nothing was rated.")
        finally:
            if self._state.get("state") not in {"done", "error", "stopped"}:
                self._set(state="done", text=self._state.get("text") or "The ladder game is over.")

    def _find_game(self, game: str, title: str, bot: dict, opponent: str, open_league: bool = False) -> tuple[str, str]:
        if opponent:
            answer = self.online.ladder_challenge(game, str(bot["id"]), opponent, open_league=open_league)
            if not answer.get("ok"):
                self._set(state="error", text=str(answer.get("text") or "The ladder said no."))
                return "", ""
            room = answer.get("room") or {}
            self._set(state="playing", text=f"Table ready against {self._opponent_name(room)}.",
                      room=str(room.get("id") or ""), opponent=self._opponent_name(room))
            return str(room.get("id") or ""), str(answer.get("side") or "white")

        queued = self.online.bot_queue(game, str(bot["key"]), open_league=open_league)
        if not queued.get("ok"):
            self._set(state="error", text=str(queued.get("text") or "The ladder queue did not answer."))
            return "", ""
        self._set(state="waiting", text="Waiting for another bot to enter the ladder.")
        started = self.clock()
        matched = queued.get("matched")
        while not matched and not self._stop.is_set():
            if self.clock() - started > QUEUE_SECONDS:
                self.online.bot_queue_stop(str(bot["key"]))
                self._set(state="done", text="No other bot came to the ladder, so nothing was played "
                                             "and nothing was used up. Try again later.")
                return "", ""
            self._stop.wait(POLL_SECONDS)
            if self._stop.is_set():
                break
            answer = self.online.bot_queue_state(str(bot["key"]))
            if not answer.get("ok"):
                self._set(state="error", text=str(answer.get("text") or "The queue did not answer."))
                return "", ""
            matched = answer.get("matched")
        if self._stop.is_set() or not matched:
            self.online.bot_queue_stop(str(bot["key"]))
            self._set(state="stopped", text="Ladder game stopped before a table was found.")
            return "", ""
        room = matched.get("room") or {}
        self._set(state="playing", text=f"Table ready against {self._opponent_name(room)}.",
                  room=str(room.get("id") or ""), opponent=self._opponent_name(room))
        return str(room.get("id") or ""), str(matched.get("side") or "white")

    @staticmethod
    def _opponent_name(room: dict) -> str:
        for seat in room.get("seats") or []:
            if isinstance(seat, dict) and seat.get("bot") and seat.get("name"):
                return str(seat["name"])
        return "another bot"

    def _play(self, game: str, title: str, who: dict, bot: dict, room: str, side: str) -> dict:
        address = wsmod.socket_url(self.online.url, f"/ws/{room}")
        sock = self._socket(address, timeout=10.0)
        last_ply = -1
        ref = 0
        finished: dict = {}
        picture: dict = {}
        try:
            sock.send_json({"t": "auth", "token": str(bot["key"])})
            self._set(state="playing", text=f"Playing {title} as {side}.", room=room)
            while not self._stop.is_set():
                message = sock.receive(timeout=3.0)
                if not isinstance(message, dict):
                    if finished:
                        break
                    continue
                kind = message.get("t")
                if kind == "closed":
                    break
                if kind == "error":
                    self._set(state="error", text=str(message.get("text") or "The table refused the bot."))
                    return finished
                if kind == "result":
                    if message.get("finished"):
                        finished = message["finished"] if isinstance(message["finished"], dict) else {}
                    if message.get("ok") is False:
                        # Refused (a stale turn, a slow command): the table sends the
                        # next picture anyway, so nothing to undo here.
                        continue
                if kind != "state":
                    continue
                fresh = message.get("picture")
                if isinstance(fresh, dict):
                    picture = fresh
                plies = int(picture.get("plies") or 0)
                self._set(plies=plies)
                permissions = picture.get("permissions") or {}
                legal = picture.get("legal") or []
                if not permissions.get("can_move") or not legal or plies == last_ply:
                    if str(picture.get("status") or "") in {"win", "draw", "resigned", "abandoned"}:
                        break
                    continue
                last_ply = plies
                token, calls = self._pick(who, picture, side, title)
                ref += 1
                self._set(calls=int(self._state.get("calls") or 0) + calls)
                if not token:
                    break
                sock.send_json({"t": "cmd", "action": "move", "args": [token], "ref": ref})
        finally:
            try:
                sock.close()
            except Exception:
                log.debug("the lobby socket did not close cleanly", exc_info=True)
            # A leg can end on the clock, with no "finished" on the wire: the table's
            # own summary is the durable answer, and it carries the pair block.
            row = self.online.room(room)
            if isinstance(row.get("pair"), dict) and row["pair"]:
                finished["pair"] = row["pair"]
            self._finish(game, title, who, bot, room, side, finished, picture)
        return finished

    def _pick(self, who: dict, picture: dict, side: str, title: str) -> tuple[str, int]:
        """Ask the model, inside one budget that fits the table's clock."""
        prompt, names = move_prompt(picture, side, title)
        legal = [str(move) for move in (picture.get("legal") or [])]
        system = _persona(who)
        # One deadline for every try together: the table forfeits a silent bot at
        # 15 seconds, so two 12-second attempts could lose the game on time.
        deadline = time.monotonic() + MOVE_SECONDS
        for _ in range(ASK_TRIES):
            if self._stop.is_set():
                return "", 0
            left = deadline - time.monotonic()
            if left <= 0.5:
                break
            answer = _ask_with_deadline(self.ask, who, system, prompt, left)
            if answer is None:
                continue
            text = answer.get("move") if isinstance(answer, dict) else answer
            token, named = choose(text, names, legal)
            if named:
                return token, 1
        # The clock is 15 seconds and the table forfeits a silent bot. A legal move
        # now is better than a loss on time; the page says it was picked for you.
        return (legal[0] if legal else ""), ASK_TRIES

    def _finish(self, game: str, title: str, who: dict, bot: dict, room: str, side: str,
                finished: dict, picture: dict | None = None) -> None:
        if self._stop.is_set():
            self._set(state="stopped", text="Ladder game stopped.")
            return
        picture = picture or {}
        career = self.online.bot_career(str(bot["id"])) if bot.get("id") else {}
        rating = ""
        rows = career.get("games") if isinstance(career.get("games"), list) else []
        for row in rows:
            if isinstance(row, dict) and row.get("game") == game and row.get("rating"):
                rating = f"{int(row['rating'])}"
        started = float(self._state.get("started") or 0)
        history = career.get("history") if isinstance(career.get("history"), list) else []
        changed = any(isinstance(row, dict) and row.get("game") == game
                      and float(row.get("at") or 0) >= started for row in history)
        # Only the bot that made the last move is told "finished" by the table, so
        # the result also comes from the last picture and from the career record.
        won = str(finished.get("winner") or picture.get("winner") or "")
        if won == side:
            result = "You won"
        elif won:
            result = "You lost"
        else:
            ended = str(finished.get("reason") or picture.get("status") or "")
            result = "A draw" if ended in {"draw", "repetition", "limit"} else "Finished"
        pair = finished.get("pair") if isinstance(finished.get("pair"), dict) else {}
        if pair:
            # A ranked game is a pair: its two legs are rated together, once.
            rated = bool(pair.get("rated"))
        elif "rated" in finished:
            rated = bool(finished["rated"])
        else:
            rated = changed
        line = f"{result} on the ladder, {'rated' if rated else 'not rated'}."
        if rating:
            line += f" Your bot's {title} rating is now {rating}."
        self._set(state="done", text=line, result=result, rating=rating)


def _persona(who: dict) -> str:
    """The champion's own brief, so the ladder sees the same bot as its owner's table."""
    try:
        from .champions import persona

        return persona(who)
    except Exception:
        return str(who.get("brief") or "Play to win. Answer with one legal move and nothing else.")


def _ask_with_deadline(ask, who: dict, system: str, prompt: str, seconds: float) -> Any:
    """One model call, dropped when it runs past the table's clock."""
    box: dict = {}

    def work() -> None:
        try:
            box["answer"] = ask(who, system, prompt)
        except Exception:
            box["answer"] = None

    worker = threading.Thread(target=work, name="gameshelf-ladder-ask", daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        return None
    return box.get("answer")
