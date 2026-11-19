"""The person's live lobby connection, kept open while online play is on.

Game Center keeps ONE socket to the lobby (``/api/lobby/socket``, contract A in
``online/presence.py``) for as long as online play is on - even with the dock
closed - so others can see the person is online, and so the play requests they
send or answer travel at once. This mirrors ``shelf/online_table.py``: a daemon
thread, a ``shelf/ws.py`` Socket, a lock, and a 1/2/4/8 s reconnect backoff with a
stop Event. The key is a credential: it is sent in the first frame and never
appears in the snapshot, an error, or a log.
"""
from __future__ import annotations

import copy
import logging
import queue
import threading
import time

from shelf import ws as wsmod

log = logging.getLogger(__name__)

# One sentence for every door while the socket is not live. The screen repeats it word for
# word beside a Retry, so a person who presses a chip on a cold Hall is told the truth and
# given the one control that fixes it, rather than being told their invites are off.
NOT_CONNECTED = "Not connected to the lobby yet — Retry"

# Games a person can be asked to play, mirrored from online/requests.py so the
# prefs the page sends are shaped the way the server expects.
REQUESTABLE = (
    "connect4", "reversi", "checkers", "gomoku", "chessboard",
    "go", "hex", "breakthrough", "seabattle", "blackjack",
)


def _blank_prefs() -> dict:
    return {"open": False, "games": {game: False for game in REQUESTABLE}, "until": {}}


def _blank_you() -> dict:
    return {"id": "", "name": "", "invisible": False, "looking": []}


def _is_rejected_upgrade(exc: Exception) -> bool:
    """True when the handshake was refused by an old server (no lobby socket).

    ``shelf/ws.py`` raises ``SocketError`` with the HTTP status line in the text
    when the upgrade is rejected; a server without the lobby socket answers 404.
    """
    return "404" in str(exc)


class Hall:
    """One account's lobby presence, as the plugin page sees it."""

    # Redial backoff, in seconds: the first wait, then doubling up to the most.
    retry_first = 1
    retry_most = 8
    # The Hall pings every 20 s and the lobby answers every ping. Nothing at all heard for this
    # long means the server is gone without closing the socket (a crashed host), so dial again.
    quiet_limit = 50
    # After this many failed dials in a row, say in words that the server is not answering.
    unreachable_after = 2
    UNREACHABLE = ("The online server is not answering right now. Game Center keeps trying "
                   "and reconnects by itself when it is back.")

    def __init__(self, online):
        self.online = online
        self._lock = threading.RLock()
        self._lifecycle = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._socket = None
        self._out: queue.Queue = queue.Queue()
        self._pending: dict = {}
        self._ref = 0
        self._delay = self.retry_first
        self._misses = 0
        # The view the page reads.
        self._state = "off"
        self._error = ""
        self._you: dict = _blank_you()
        self._prefs: dict = _blank_prefs()
        self._roster: dict = {}
        self._requests: dict = {}
        self._seated = None
        # The last thing said about why the socket is not live, so a dial that keeps failing
        # is one log line and not one every second.
        self._said = ""

    # Logging -----------------------------------------------------------------

    def _unsaid(self) -> None:
        """Clear the "already logged" flag: something changed worth saying again."""
        self._said = ""

    def _say(self, text: str, *, exc_info: bool = False) -> None:
        """Log the reason the socket is not live, once, until it changes.

        A Hall that cannot connect used to say nothing at all, which left a person with
        "invites are off" and no line in any log to look at.
        """
        if text == self._said:
            return
        self._said = text
        log.info("lobby socket: %s", text, exc_info=exc_info)

    # Lifecycle ---------------------------------------------------------------

    def start(self) -> None:
        """Open the lobby socket if it is not already open. Idempotent.

        Does nothing unless online play is on and there is a key to sign in with,
        so a GET that calls this before sign-in is a harmless no-op.
        """
        with self._lifecycle:
            if not self.online.on:
                self._say("not opened: online play is off")
                return
            if not self.online.key():
                self._say("not opened: this computer has no sign-in key")
                return
            if self._thread is not None and self._thread.is_alive():
                return
            with self._lock:
                self._stop = threading.Event()
                self._out = queue.Queue()
                self._pending = {}
                self._ref = 0
                self._delay = self.retry_first
                self._misses = 0
                self._error = ""
                if self._state in ("off", "old-server"):
                    self._state = "connecting"
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Close the socket, join the thread (<=12 s), and clear the view."""
        with self._lifecycle:
            with self._lock:
                self._stop.set()
                sock, thread = self._socket, self._thread
                self._fail_pending("The lobby connection closed.")
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
            if thread and thread is not threading.current_thread():
                thread.join(timeout=12)
            with self._lock:
                self._state = "off"
                self._error = ""
                self._you = _blank_you()
                self._prefs = _blank_prefs()
                self._roster = {}
                self._requests = {}
                self._seated = None
            self._thread = None

    # The view ----------------------------------------------------------------

    def retry(self) -> dict:
        """Dial the lobby again now, and hand back the view as it stands.

        The screen's one Retry. A live socket is left alone; anything else is closed and
        opened again with a fresh backoff, so a person is never told to wait out a delay
        they did not ask for. Never raises: a dial that fails is a state, not an error.
        """
        if self._thread is not None and self._thread.is_alive():
            with self._lock:
                if self._state == "live":
                    return self.snapshot()
        self.stop()
        self._unsaid()
        self.start()
        log.info("the person asked to reconnect to the lobby (state %s)", self._state)
        return self.snapshot()

    def snapshot(self) -> dict:
        """Exactly the contract-D GET shape. Never carries the key or token."""
        with self._lock:
            roster = sorted(
                self._roster.values(),
                key=lambda row: (str(row.get("name") or "").casefold(), str(row.get("id") or "")),
            )
            data = {
                "state": self._state,
                "you": copy.deepcopy(self._you),
                # Counted at the moment it is read: a twenty-minute accept that has run out is
                # off here, so no screen ever draws a stale on - or posts one back.
                "prefs": self._drop_run_out(copy.deepcopy(self._prefs), time.time()),
                "roster": [copy.deepcopy(row) for row in roster],
                "requests": [copy.deepcopy(req) for req in self._requests.values()],
                "seated": copy.deepcopy(self._seated),
            }
            if self._error:
                data["error"] = self._error
            return data

    # Client frames -----------------------------------------------------------

    def send(self, frame: dict) -> dict:
        """Send a client frame, wait <=5 s for its matching ack, return {ok,text}.

        Whatever else the server put on the ack rides along untouched: a looking ack carries
        ``ask_always`` when that press added a temporary accept, and the screen that pressed
        has to be told.
        """
        with self._lock:
            if self._state != "live":
                return {"ok": False, "text": NOT_CONNECTED}
            self._ref += 1
            op = f"h{self._ref}"
            event = threading.Event()
            pending = {"event": event, "answer": None}
            self._pending[op] = pending
            outbound = dict(frame)
            outbound["op"] = op
            self._out.put(outbound)
        event.wait(5)
        with self._lock:
            self._pending.pop(op, None)
            answer = pending["answer"] or {"ok": False, "text": "No answer from the lobby."}
            out = dict(answer)
            out["ok"] = bool(answer.get("ok"))
            out["text"] = str(answer.get("text") or "")
            return out

    def prefs(self, open=None, games=None, invisible=None, always=None) -> dict:
        frame: dict = {"t": "prefs"}
        if open is not None:
            if not isinstance(open, bool):
                return {"ok": False, "text": "Open must be yes or no."}
            frame["open"] = open
        if invisible is not None:
            if not isinstance(invisible, bool):
                return {"ok": False, "text": "Say whether you appear offline."}
            frame["invisible"] = invisible
        if games is not None:
            if not isinstance(games, dict) or not all(
                isinstance(game, str) and len(game) <= 100 and isinstance(enabled, bool)
                for game, enabled in games.items()
            ):
                return {"ok": False, "text": "Name the games to turn on or off."}
            frame["games"] = {game: enabled for game, enabled in games.items()}
        if always is not None:
            # "Yes, always" after a twenty-minute accept: the same game, kept for good.
            if not isinstance(always, dict) or not all(
                isinstance(game, str) and len(game) <= 100 and isinstance(enabled, bool)
                for game, enabled in always.items()
            ):
                return {"ok": False, "text": "Name the games to keep on your list."}
            frame["always"] = {game: enabled for game, enabled in always.items()}
        if "open" not in frame and "games" not in frame and "invisible" not in frame and "always" not in frame:
            return {"ok": False, "text": "Nothing to change."}
        answer = self.send(frame)
        if answer.get("ok"):
            # The server does not push a prefs frame back, so reflect the change
            # locally for exactly the fields that were set.
            with self._lock:
                if "open" in frame:
                    self._prefs["open"] = frame["open"]
                for game, enabled in frame.get("games", {}).items():
                    self._prefs.setdefault("games", {})[game] = enabled
                    if enabled:
                        # Turning on a game whose twenty minutes are over is a plain choice:
                        # the server keeps no window for it, so the lapsed stamp goes too.
                        stamps = self._prefs.setdefault("until", {})
                        if game in stamps and float(stamps.get(game) or 0) <= time.time():
                            stamps.pop(game, None)
                if "open" not in frame and any(frame.get("games", {}).values()):
                    # A chip turned on turns the master switch on with it, as the server does:
                    # a chip shown on really accepts.
                    self._prefs["open"] = True
                for game, enabled in frame.get("always", {}).items():
                    # Keeping a game for good turns the master switch on, clears any window it
                    # was on for, and leaves the game itself on.
                    self._prefs.setdefault("games", {})[game] = enabled
                    self._prefs.setdefault("until", {}).pop(game, None)
                    if enabled:
                        self._prefs["open"] = True
                if "invisible" in frame:
                    self._you["invisible"] = frame["invisible"]
                    if frame["invisible"]:
                        # Appearing offline ends find match: nothing is looking for you.
                        self._you["looking"] = []
        return answer

    def looking(self, games=None, *, all_games=False, on=True) -> dict:
        """Find match: <games> to start (or 'all'), on=False to stop.

        The server keeps it until the person stops it or is seated, and pairs them
        with anyone else looking for (or open to) the same game right now. The ack
        carries the server's own prefs, because a Play opens a twenty-minute accept
        that nothing else would show until the next reconnect.
        """
        if not isinstance(on, bool):
            return {"ok": False, "text": "Say whether to look for a match."}
        if not on:
            frame: dict = {"t": "looking", "on": False}
        elif all_games is True:
            frame = {"t": "looking", "all": True}
        elif isinstance(games, list) and games and all(
                isinstance(game, str) and 0 < len(game) <= 100 for game in games):
            frame = {"t": "looking", "games": list(dict.fromkeys(games))}
        else:
            return {"ok": False, "text": "Pick the games to look for."}
        answer = self.send(frame)
        if answer.get("ok"):
            with self._lock:
                if not on:
                    self._you["looking"] = []
                elif all_games is True:
                    self._you["looking"] = list(REQUESTABLE)
                else:
                    self._you["looking"] = [game for game in REQUESTABLE if game in set(frame["games"])]
                if isinstance(answer.get("prefs"), dict):
                    # Only a server that knows these sends them; an older one sends none and
                    # what the press changed above is all there is to show.
                    self._prefs = self._clean_prefs(answer["prefs"])
        return answer

    def request(self, to, game) -> dict:
        if not isinstance(to, str) or not to or len(to) > 100:
            return {"ok": False, "text": "Name who to ask."}
        if not isinstance(game, str) or not game or len(game) > 100:
            return {"ok": False, "text": "Name a game."}
        return self.send({"t": "request", "to": to, "game": game})

    def respond(self, id, accept) -> dict:
        if not isinstance(id, str) or not id or len(id) > 100:
            return {"ok": False, "text": "No such request."}
        if not isinstance(accept, bool):
            return {"ok": False, "text": "Say whether you accept."}
        return self.send({"t": "respond", "id": id, "accept": accept})

    def cancel(self, id) -> dict:
        if not isinstance(id, str) or not id or len(id) > 100:
            return {"ok": False, "text": "No such request."}
        return self.send({"t": "cancel", "id": id})

    # The worker --------------------------------------------------------------

    def _fail_pending(self, text: str) -> None:
        for pending in self._pending.values():
            pending["answer"] = {"ok": False, "text": text}
            pending["event"].set()

    def _run(self) -> None:
        while not self._stop.is_set():
            key = self.online.key()
            if not key:
                with self._lock:
                    self._state = "off"
                break
            with self._lock:
                # We are about to connect, so the honest state is "connecting". This matters: a
                # stale "live" left over from a dropped socket lets a page queue a request that
                # then replays seconds later, and seats two people nobody asked to seat.
                self._state = "connecting"
            sock = None
            try:
                sock = wsmod.Socket(wsmod.socket_url(self.online.url, "/api/lobby/socket"), timeout=5)
            except wsmod.SocketError as exc:
                slow = _is_rejected_upgrade(exc)
                with self._lock:
                    self._socket = None
                    self._state = "old-server" if slow else "connecting"
                    if not slow:
                        self._missed()
                if slow:
                    self._say(f"this server has no lobby socket ({self.online.url})")
                else:
                    self._say(f"could not open the socket at {self.online.url}: {exc}")
                if self._stop.wait(60 if slow else self._delay):
                    break
                if not slow:
                    self._delay = min(self._delay * 2, self.retry_most)
                continue
            except OSError as exc:
                with self._lock:
                    self._socket = None
                    self._state = "connecting"
                    self._missed()
                self._say(f"could not reach {self.online.url}: {exc}")
                if self._stop.wait(self._delay):
                    break
                self._delay = min(self._delay * 2, self.retry_most)
                continue
            outcome = self._session(sock, key)
            with self._lock:
                self._socket = None
                if not self._stop.is_set() and outcome == "":
                    # Never carry "live" across a drop: nothing may be queued while we are away.
                    # ("auth" keeps its own quiet "off" state; "stop" is leaving anyway.)
                    self._state = "connecting"
                self._fail_pending("The lobby connection dropped.")
                self._drain_out()
            if outcome == "" and not self._stop.is_set():
                self._say("the lobby connection dropped; dialling again")
            try:
                sock.close()
            except Exception:
                pass
            if outcome == "stop":
                break
            if outcome == "auth":
                # A refused sign-in will not change by trying again fast; wait.
                self._say("the lobby refused this computer's sign-in key")
                if self._stop.wait(60):
                    break
                continue
            # A plain drop: reconnect with backoff.
            if self._stop.wait(self._delay):
                break
            self._delay = min(self._delay * 2, self.retry_most)

    def _missed(self) -> None:
        """One more failed dial (caller holds the lock); past a couple, say the server is down."""
        self._misses += 1
        if self._misses >= self.unreachable_after:
            self._error = self.UNREACHABLE

    def _session(self, sock, key: str) -> str:
        """One connected session. Returns 'stop', 'auth', or '' (dropped)."""
        with self._lock:
            if self._stop.is_set():
                return "stop"
            self._socket = sock
        try:
            sock.send_json({"t": "auth", "token": key, "client": "hermes"})
        except (OSError, wsmod.SocketError):
            return ""
        next_ping = time.monotonic() + 20
        heard = time.monotonic()
        while not self._stop.is_set():
            try:
                while True:
                    sock.send_json(self._out.get_nowait())
            except queue.Empty:
                pass
            except (OSError, wsmod.SocketError):
                return ""
            now = time.monotonic()
            if now >= next_ping:
                try:
                    sock.send_json({"t": "ping"})
                except (OSError, wsmod.SocketError):
                    return ""
                next_ping = now + 20
            try:
                message = sock.receive(timeout=0.15)
            except (OSError, wsmod.SocketError):
                return ""
            if not message:
                if time.monotonic() - heard > self.quiet_limit:
                    return ""   # not even a pong: the server is gone, so dial again
                continue
            heard = time.monotonic()
            if message.get("t") == "error" and message.get("code") == "auth":
                with self._lock:
                    self._state = "off"
                    self._error = "The lobby did not accept your sign-in."
                    self._you = _blank_you()
                    self._prefs = _blank_prefs()
                    self._roster = {}
                    self._requests = {}
                    self._seated = None
                return "auth"
            self._apply(message)
        return "stop"

    def _drain_out(self) -> None:
        while True:
            try:
                self._out.get_nowait()
            except queue.Empty:
                break

    def _apply(self, message: dict) -> None:
        kind = message.get("t")
        with self._lock:
            if kind == "hello":
                you = message.get("you") or {}
                self._you = {
                    "id": str(you.get("id") or ""),
                    "name": str(you.get("name") or ""),
                    "invisible": bool(you.get("invisible")),
                    "looking": [str(game) for game in (you.get("looking") or []) if isinstance(game, str)],
                }
                self._prefs = self._clean_prefs(message.get("prefs"))
                self._roster = {row["id"]: row for row in (message.get("roster") or [])
                                if isinstance(row, dict) and row.get("id")}
                self._requests = {req["id"]: req for req in (message.get("requests") or [])
                                  if isinstance(req, dict) and req.get("id")}
                self._state = "live"
                self._error = ""
                self._misses = 0
                self._delay = self.retry_first
                self._unsaid()
                log.info("lobby socket live as %s", self._you.get("name") or "this account")
            elif kind == "presence":
                row = message.get("row") or {}
                if isinstance(row, dict) and row.get("id"):
                    self._roster[row["id"]] = row
            elif kind == "gone":
                self._roster.pop(message.get("id"), None)
            elif kind in ("request", "request_update"):
                req = message.get("request") or {}
                if isinstance(req, dict) and req.get("id"):
                    self._requests[req["id"]] = req
            elif kind == "seated":
                # A seat is the end of find match: the person is at a table now.
                self._you["looking"] = []
                self._seated = {
                    "room_id": message.get("room_id"),
                    "game": message.get("game"),
                    "side": message.get("side"),
                    "opponent": message.get("opponent"),
                    "request_id": message.get("request_id"),
                }
            elif kind == "ack":
                pending = self._pending.get(message.get("op"))
                if pending:
                    # The whole ack, so a looking ack's ask_always reaches the screen that
                    # pressed. ok and text are normalised by send().
                    pending["answer"] = dict(message)
                    pending["event"].set()
            # pong and anything unknown: nothing to do.

    @staticmethod
    def _drop_run_out(prefs: dict, now: float) -> dict:
        """A twenty-minute window that has passed is off: game false, no window left.

        The server counts a lapsed window as off the moment it passes, so the screen has to
        as well; a stale on is one the page would draw pressed and post straight back.
        """
        until_in = prefs.get("until") if isinstance(prefs, dict) else None
        until_in = until_in if isinstance(until_in, dict) else {}
        games = dict(prefs.get("games") or {}) if isinstance(prefs, dict) else {}
        until = {game: at for game, at in until_in.items() if float(at or 0) > now}
        for game in until_in:
            if game not in until:
                games[game] = False
        out = dict(prefs) if isinstance(prefs, dict) else {}
        out["games"] = games
        out["until"] = until
        return out

    @staticmethod
    def _clean_prefs(prefs) -> dict:
        if not isinstance(prefs, dict):
            return _blank_prefs()
        games_in = prefs.get("games") if isinstance(prefs.get("games"), dict) else {}
        games = {game: bool(games_in.get(game, False)) for game in REQUESTABLE}
        for game, enabled in games_in.items():
            if isinstance(game, str):
                games[game] = bool(enabled)
        # A temporary accept carries the moment it lapses; 0 or absent means standing. The
        # screen says "for 20 min" from this, so it is passed through rather than dropped.
        until_in = prefs.get("until")
        if not isinstance(until_in, dict):
            until_in = {}
        until = {}
        for game, at in until_in.items():
            if isinstance(game, str):
                try:
                    stamp = float(at or 0)
                except (TypeError, ValueError):
                    stamp = 0.0
                if stamp > 0:
                    until[game] = stamp
        return {"open": bool(prefs.get("open")), "games": games, "until": until}
