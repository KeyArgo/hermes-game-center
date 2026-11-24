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

import contextvars
import copy
import logging
import queue
import threading
import time

from shelf import ws as wsmod
from shelf import diagnostics

log = logging.getLogger(__name__)

# One sentence for every door while the socket is not live. The screen repeats it word for
# word beside a Retry, so a person who presses a chip on a cold Hall is told the truth and
# given the one control that fixes it, rather than being told their invites are off.
NOT_CONNECTED = "Not connected to the lobby yet — Retry"

# Said beside Retry while a dial that was just asked for is still running. Joining is not a
# failure: the card under it must not read "not connected" for a socket that is coming up.
JOINING = "Joining the lobby now — one moment."

# Games a person can be asked to play, mirrored from online/requests.py so the
# prefs the page sends are shaped the way the server expects.
REQUESTABLE = (
    "connect4", "reversi", "checkers", "gomoku", "chessboard",
    "go", "hex", "breakthrough", "seabattle", "blackjack",
)

# A `seated` frame is a one-shot handoff. It is not a room that stays open.
SEAT_TTL_SECONDS = 120.0


def _blank_prefs() -> dict:
    return {"open": False, "games": {game: False for game in REQUESTABLE}, "until": {}}


def _blank_you() -> dict:
    return {"id": "", "name": "", "invisible": False, "looking": [], "looking_text": ""}


def _is_rejected_upgrade(exc: Exception) -> bool:
    """True when the handshake was refused by an old server (no lobby socket).

    ``shelf/ws.py`` raises ``SocketError`` with the HTTP status line in the text
    when the upgrade is rejected; a server without the lobby socket answers 404.
    """
    return "404" in str(exc)


class Hall:
    """One account's lobby presence, as the plugin page sees it."""

    SEAT_TTL_SECONDS = SEAT_TTL_SECONDS

    # Redial backoff, in seconds: the first wait, then doubling up to the most.
    retry_first = 1
    retry_most = 8
    # The Hall pings every 20 s and the lobby answers every ping. Nothing at all heard for this
    # long means the server is gone without closing the socket (a crashed host), so dial again.
    quiet_limit = 50
    # After this many failed dials in a row, say in words that the server is not answering.
    unreachable_after = 2
    # How long stop() waits for a worker to leave. A connect inside Socket() cannot be closed from
    # outside (a stalled DNS answer can outlast it), so a worker that is still there afterwards is
    # left holding its own stop event - see stop().
    stop_join = 12
    UNREACHABLE = ("The online server is not answering right now. Game Center keeps trying "
                   "and reconnects by itself when it is back.")

    def __init__(self, online):
        self.online = online
        self._lock = threading.RLock()
        self._lifecycle = threading.RLock()
        self._stop = threading.Event()
        # Set by start() when someone asks for a dial now - a sign-in, or Retry - so a worker that
        # is waiting out a backoff (or a refused sign-in's long pause) dials at once instead of
        # leaving the person on "Not connected". A read (a GET) never sets it, and a press that
        # lands while a connect attempt is already open is recorded too: the attempt finishes and
        # the wait after it returns at once, rather than the press being dropped on the floor.
        self._dial = threading.Event()
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
        self._seated_at = 0.0
        # True only while this computer's table socket is live for that room.
        # A Hall reconnect does not invent a seat, and it does not keep one
        # unless that socket is still at the table. The plugin sets this.
        self.table_live = lambda _room_id: False
        # Lobby HTTP (refresh, queue, the league's reads, one alert) runs here, not inside
        # /view. The worker is started from a request, in that request's context.
        self._refresh_stop = threading.Event()
        self._refresh_thread = None
        self._refresh_key = None
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

    def start(self, *, wake: bool = True) -> None:
        """Make sure the lobby socket is being dialled - and, for a press, dial now.

        Idempotent, and a no-op before online play is on and there is a key to sign in with,
        so a GET that calls this before sign-in is harmless.

        ``wake=False`` is the read path: ``GET /online/hall`` and ``GET /view`` run every three
        seconds while a page is open, so they only make sure the worker is running. Waking on a
        read turned the deliberate 60-second pause after a refused sign-in - or after a server
        with no lobby socket - into a dial every 1.5 s for as long as anyone was looking, with a
        log line for each one. A press keeps the wake: a sign-in, Retry and every action on the
        Hall are the doors a person asks through, and the worker dials at once for them.

        A worker that is already running used to make this return while doing nothing: a socket
        that had been refused (its state ``off``), a server with no lobby socket, or a dropped
        line left the person on "Not connected to the lobby" for the whole of a wait they never
        asked for. Now a press wakes that worker, which dials at once.
        """
        with self._lifecycle:
            if not self.online.on:
                self._say("not opened: online play is off")
                return
            key = self.online.key()
            url = self.online.url
            if self._thread and not self._stop.is_set() and (self._key != key or self._url != url):
                self.stop()
            if not key:
                self._say("not opened: this computer has no sign-in key")
                return
            # Hermes gives out a secret only inside the request's profile scope, and a thread does
            # not inherit it: keep the key this request could read for the worker to dial with.
            if self._thread is not None and self._thread.is_alive():
                with self._lock:
                    if wake and self._state != "live":
                        # Mid-dial included: the attempt in flight is left alone, and the wait
                        # after it returns at once instead of the press being lost.
                        self._dial.set()
                return
            with self._lock:
                self._key = key
                self._url = url
                self._stop = threading.Event()
                self._dial = threading.Event()
                self._out = queue.Queue()
                self._pending = {}
                self._ref = 0
                self._delay = self.retry_first
                self._misses = 0
                self._error = ""
                if self._state in ("off", "old-server"):
                    self._state = "connecting"
                # This worker's own pair, handed to it: a worker that outlives a stop() (see below)
                # keeps seeing its own stop event set, instead of reading the fresh one a later
                # start() installs for its successor and dialling beside it.
                stop, dial = self._stop, self._dial
            # The worker runs in a copy of this request's context, so a secret read inside it sees
            # the same profile scope the request did.
            self._thread = threading.Thread(
                target=contextvars.copy_context().run, args=(self._run, stop, dial), daemon=True
            )
            self._thread.start()

    def stop(self) -> None:
        """Close the socket, join the thread (<=stop_join s), and clear the view.

        A worker still inside its connect when the join gives up cannot be closed from outside, and
        it is not abandoned: its own stop event is already set, so it leaves as soon as the connect
        answers. The reference stays, so start() cannot install a second worker beside it.
        """
        with self._lifecycle:
            with self._lock:
                self._stop.set()
                self._key = ""  # a stopped Hall (signed out, turned off) never dials with an old key
                sock, thread = self._socket, self._thread
                self._fail_pending("The lobby connection closed.")
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
            still_holding = False
            if thread and thread is not threading.current_thread():
                thread.join(timeout=self.stop_join)
                still_holding = thread.is_alive()
            self._refresh_stop.set()
            with self._lock:
                self._state = "off"
                self._error = ""
                self._you = _blank_you()
                self._prefs = _blank_prefs()
                self._roster = {}
                self._requests = {}
                self._seated = None
                self._seated_at = 0.0
            if not still_holding:
                self._thread = None

    # The view ----------------------------------------------------------------

    def retry(self, *, settle: float = 2.0) -> dict:
        """Dial the lobby again now, and hand back the view once the dial has had its chance.

        The screen's one Retry. A live socket is left alone; a session that is open but not
        answering is let go; anything else is woken (or opened) at once with a fresh backoff,
        so a person is never told to wait out a delay they did not ask for. ``settle`` is how
        long the answer waits for the dial: the sentence beside Retry is read from the state
        that comes back, and a dial that has not had its moment yet would always read as a
        failure. Never raises: a dial that fails is a state, not an error.
        """
        with self._lock:
            live = self._state == "live"
            talking = self._socket is not None
        self._unsaid()
        if talking and not live:
            # A session that is not answering must be let go, not merely woken.
            self.stop()
        self.start()
        end = time.monotonic() + max(0.0, settle)
        while time.monotonic() < end:
            with self._lock:
                if self._state == "live":
                    break
            time.sleep(0.02)
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
                "seated": copy.deepcopy(self._seat_for_read()),
            }
            if self._error:
                data["error"] = self._error
            return data

    def drop_seat(self, room_id: str | None = None) -> None:
        """Forget a seat the person left, or a room whose game has finished.

        The lobby sends ``seated`` once, when the match is made, and nothing later
        takes it back. Leaving it in place meant Back threw the Hall away and the
        new Hall opened that same room again.
        """
        with self._lock:
            if not self._seated:
                return
            if room_id and str(self._seated.get("room_id") or "") != str(room_id):
                return
            self._seated = None
            self._seated_at = 0.0

    def _table_is_live(self, room_id: str) -> bool:
        checker = self.table_live
        if not room_id or not callable(checker):
            return False
        try:
            return bool(checker(room_id))
        except Exception:
            return False

    def _seat_for_read(self) -> dict | None:
        """The handoff, while it is still the one the Hall should open.

        Caller holds ``_lock``. A live table socket keeps the seat past the
        two-minute handoff and across a Hall reconnect. Anything else expires.
        """
        if not self._seated:
            return None
        room_id = str(self._seated.get("room_id") or "")
        if self._table_is_live(room_id):
            return self._seated
        started = float(self._seated_at or 0)
        if not started:
            self._seated_at = time.monotonic()
            return self._seated
        if time.monotonic() - started > SEAT_TTL_SECONDS:
            self._seated = None
            self._seated_at = 0.0
            return None
        return self._seated

    def ensure_refresh(self) -> None:
        """Keep the lobby snapshot warm on a worker, off the request that paints /view.

        The worker runs in a copy of this request's context. A thread does not inherit
        the profile scope, and without it the key the lobby calls need is empty.
        """
        try:
            key = str(self.online.key() or "")
        except Exception:
            key = ""
        with self._lifecycle:
            alive = self._refresh_thread is not None and self._refresh_thread.is_alive()
            if alive and key == self._refresh_key:
                return
            self._refresh_stop.set()
            self._refresh_key = key
            self._refresh_stop = threading.Event()
            stop = self._refresh_stop
            self._refresh_thread = threading.Thread(
                target=contextvars.copy_context().run,
                args=(self._refresh_loop, stop),
                daemon=True,
                name="lobby-refresh",
            )
            self._refresh_thread.start()

    def _refresh_loop(self, stop: threading.Event) -> None:
        """refresh, the queue, the league's reads and one alert. Not on the /view path."""
        while not stop.is_set():
            try:
                online = self.online
                if getattr(online, "on", False):
                    online.refresh()
                    check = getattr(online, "check_queue", None)
                    if check:
                        check()
                    league = getattr(online, "league", None)
                    if league:
                        league()
                    match = getattr(online, "match", None)
                    if not (match() if match else None):
                        poll = getattr(online, "poll_alert", None)
                        if poll:
                            poll()
            except Exception:
                log.warning("lobby refresh failed", exc_info=True)
            if stop.wait(2):
                break

    # Client frames -----------------------------------------------------------

    def send(self, frame: dict) -> dict:
        """Send a client frame, wait <=5 s for its matching ack, return {ok,text}.

        Whatever else the server put on the ack rides along untouched: a looking ack carries
        ``ask_always`` when that press added a temporary accept, and the screen that pressed
        has to be told.
        """
        with self._lock:
            if self._state != "live" or self._stop.is_set():
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
            with self._lock:
                if "invisible" in frame:
                    self._you["invisible"] = frame["invisible"]
                    if frame["invisible"]:
                        # Appearing offline ends find match: nothing is looking for you.
                        self._you["looking"] = []
                        self._you["looking_text"] = ""
                if isinstance(answer.get("prefs"), dict):
                    self._prefs = self._clean_prefs(answer["prefs"])
                    return answer
                # Older servers only acknowledge the edit.
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
                    self._you["looking_text"] = ""
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

    def _wait(self, seconds: float, stop: threading.Event, dial: threading.Event) -> str:
        """Wait up to ``seconds``: 'stop', 'dial' (someone asked to dial now) or 'timeout'.

        Every wait in the worker goes through here, so a sign-in or Retry reaches the worker that
        is sitting that wait out instead of leaving the person to sit it out too. The events are
        the worker's own, so a worker left behind by a stop() that could not join it still reads
        its own stop event, set.
        """
        end = time.monotonic() + seconds
        while not stop.is_set():
            left = end - time.monotonic()
            if left <= 0:
                return "timeout"
            if dial.wait(min(left, 0.2)):
                return "dial"
        return "stop"

    def _run(self, stop: threading.Event, dial: threading.Event) -> None:
        while not stop.is_set():
            key = self._key
            if not key:
                self._say("stopped: no sign-in key could be read")
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
                sock = wsmod.Socket(wsmod.socket_url(self._url, "/api/lobby/socket"), timeout=5)
            except wsmod.SocketError as exc:
                slow = _is_rejected_upgrade(exc)
                diagnostics.log.info("lobby connect failed: %s", exc)
                with self._lock:
                    self._socket = None
                    self._state = "old-server" if slow else "connecting"
                    if not slow:
                        self._missed()
                if slow:
                    self._say(f"this server has no lobby socket ({self.online.url})")
                else:
                    self._say(f"could not open the socket at {self.online.url}: {exc}")
                verdict = self._wait(60 if slow else self._delay, stop, dial)
                if verdict == "stop":
                    break
                if verdict == "dial":
                    dial.clear()
                    self._delay = self.retry_first
                    continue
                if not slow:
                    self._delay = min(self._delay * 2, self.retry_most)
                continue
            except OSError as exc:
                with self._lock:
                    self._socket = None
                    self._state = "connecting"
                    self._missed()
                self._say(f"could not reach {self.online.url}: {exc}")
                verdict = self._wait(self._delay, stop, dial)
                if verdict == "stop":
                    break
                if verdict == "dial":
                    dial.clear()
                    self._delay = self.retry_first
                    continue
                self._delay = min(self._delay * 2, self.retry_most)
                continue
            except Exception as exc:
                # Everything else the connect can raise is a dial that failed, not a worker that
                # dies: urlsplit's port check raises ValueError for "http://host:99999", and a
                # thread that dies here leaves the Hall on "Joining the Hall…" for good, with one
                # more doomed thread spawned by every poll. Say why, back off, try again.
                with self._lock:
                    self._socket = None
                    self._state = "connecting"
                    self._missed()
                self._say(f"could not open the socket at {self.online.url}: {exc}")
                verdict = self._wait(self._delay, stop, dial)
                if verdict == "stop":
                    break
                if verdict == "dial":
                    dial.clear()
                    self._delay = self.retry_first
                    continue
                self._delay = min(self._delay * 2, self.retry_most)
                continue
            diagnostics.log.info("lobby connect %s", self.online.url)
            diagnostics.lobby_opened(sock)
            outcome = self._session(sock, key, stop)
            diagnostics.lobby_closed(sock)
            with self._lock:
                self._socket = None
                if not stop.is_set() and outcome == "":
                    # Never carry "live" across a drop: nothing may be queued while we are away.
                    # ("auth" keeps its own quiet "off" state; "stop" is leaving anyway.)
                    self._state = "connecting"
                self._fail_pending("The lobby connection dropped.")
                self._drain_out()
            if outcome == "" and not stop.is_set():
                self._say("the lobby connection dropped; dialling again")
            try:
                sock.close()
            except Exception:
                pass
            if outcome == "":
                diagnostics.log.info("lobby disconnect (the connection dropped)")
            if outcome == "stop":
                break
            if outcome == "auth":
                # A refused sign-in will not change by trying again fast; wait - but a sign-in
                # with another key (or Retry) wakes it, because that is the one thing that
                # makes another dial worth trying.
                self._say("the lobby refused this computer's sign-in key")
                verdict = self._wait(60, stop, dial)
                if verdict == "stop":
                    break
                if verdict == "dial":
                    dial.clear()
                    self._delay = self.retry_first
                continue
            # A plain drop: reconnect with backoff.
            diagnostics.log.info("lobby reconnect in %ss", self._delay)
            verdict = self._wait(self._delay, stop, dial)
            if verdict == "stop":
                break
            if verdict == "dial":
                dial.clear()
                self._delay = self.retry_first
                continue
            self._delay = min(self._delay * 2, self.retry_most)

    def _missed(self) -> None:
        """One more failed dial (caller holds the lock); past a couple, say the server is down."""
        self._misses += 1
        if self._misses >= self.unreachable_after:
            self._error = self.UNREACHABLE

    def _session(self, sock, key: str, stop: threading.Event) -> str:
        """One connected session. Returns 'stop', 'auth', or '' (dropped).

        ``stop`` is this worker's own event: a session belongs to one worker, and a worker that a
        stop() could not join must see the stop it was given, not a later one.
        """
        with self._lock:
            if stop.is_set():
                return "stop"
            self._socket = sock
        try:
            sock.send_json({"t": "auth", "token": key, "client": "hermes"})
        except (OSError, wsmod.SocketError):
            return ""
        next_ping = time.monotonic() + 20
        heard = time.monotonic()
        while not stop.is_set():
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
                self._seated_at = 0.0
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
                    "looking_text": "",
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
                # hello carries no seat. A reconnect drops the old handoff unless
                # this computer is already at that table.
                room_id = str((self._seated or {}).get("room_id") or "")
                if not self._table_is_live(room_id):
                    self._seated = None
                    self._seated_at = 0.0
                log.info("lobby socket live as %s", self._you.get("name") or "this account")
                learn = getattr(self.online, "learn_name", None)
                if learn and self._you.get("name"):
                    try:
                        learn(self._you["name"])
                    except Exception:
                        log.warning("the lobby's name for this account could not be kept", exc_info=True)
            elif kind == "looking_status":
                self._you["looking_text"] = str(message.get("text") or "")
            elif kind == "looking_state":
                self._you["looking"] = list(message.get("looking") or [])
                if not self._you["looking"]:
                    self._you["looking_text"] = ""
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
                self._you["looking_text"] = ""
                self._seated = {
                    "room_id": message.get("room_id"),
                    "game": message.get("game"),
                    "side": message.get("side"),
                    "opponent": message.get("opponent"),
                    "request_id": message.get("request_id"),
                }
                self._seated_at = time.monotonic()
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
