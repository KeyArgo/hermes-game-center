"""A person's live online table, independent of local game state."""
from __future__ import annotations

import copy
import queue
import re
import threading
import time

from shelf import ws as wsmod

_ACTIONS = {"new", "join", "sit", "move", "draw", "leave", "resign", "rematch", "step", "hint", "lesson"}

# The table's chat, as the socket carries it: the hello frame lists the last messages and every
# later one arrives on its own. The panel shows the last _CHAT_KEEP of them, and a message is
# capped at _CHAT_MAX, the server's own limit (guard.CHAT_MAX), so nothing is sent that it refuses.
# A refusal comes back on the same socket as a result with no command waiting on it, and is kept
# for the panel: a message the table would not take is never swallowed silently.
_CHAT_KEEP = 50
_CHAT_MAX = 300


class OnlineTable:
    def __init__(self, online):
        self.online = online
        self._lock = threading.RLock()
        self._lifecycle = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._socket = None
        self._out = queue.Queue()
        self._pending = {}
        self._ref = 0
        self._data = {}
        self.presence = []
        self.result = None
        self._me = ""
        self._saying = ""
        # The frames that only add to what the panel keeps — who is here, and what was said — one
        # entry each, so the next such feed is a line here rather than another branch in the loop.
        self._feeds = {"presence": self._keep_presence, "chat": self._keep_chat}

    def open(self, room_id):
        with self._lifecycle:
            if not self.online.on:
                return {"ok": False, "text": "Online play is off."}
            room_id = str(room_id or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", room_id):
                return {"ok": False, "text": "Invalid room ID."}
            key = self.online.key()
            if not key:
                return {"ok": False, "text": "Sign in to online play first."}
            self.close()
            with self._lock:
                self._data = {"room_id": room_id, "state": "connecting", "picture": None,
                              "room": None, "side": "", "opponent": None, "error": "", "finished": None,
                              "chat": [], "chat_error": None}
                self.presence, self.result, self._me, self._saying = [], None, "", ""
                self._out = queue.Queue()
                self._stop = threading.Event()
                self._thread = threading.Thread(target=self._run, args=(room_id, key), daemon=True)
                self._thread.start()
            return {"ok": True, "table": self.snapshot()}

    def snapshot(self):
        with self._lock:
            return copy.deepcopy(self._data)

    def command(self, action, args):
        if not isinstance(action, str) or action not in _ACTIONS or not isinstance(args, list):
            return {"ok": False, "text": "Invalid table command.", "picture": self.snapshot().get("picture")}
        with self._lock:
            if self._data.get("state") != "live":
                return {"ok": False, "text": "The table is not connected.", "picture": copy.deepcopy(self._data.get("picture"))}
            self._ref += 1
            ref = self._ref
            event = threading.Event()
            pending = {"event": event, "answer": None}
            self._pending[ref] = pending
            self._out.put({"t": "cmd", "action": action, "args": args, "ref": ref})
        event.wait(5)
        with self._lock:
            self._pending.pop(ref, None)
            answer = pending["answer"] or {"ok": False, "text": "No answer from the table."}
            return {"ok": bool(answer.get("ok")), "text": str(answer.get("text") or ""),
                    "picture": copy.deepcopy(self._data.get("picture"))}

    def say(self, text):
        """Say something at this table, the way a person's own message goes out.

        The text is capped at the server's own 300 characters, so what is sent is what it
        accepts. Nothing is added to the panel here: the message comes back on the table's
        feed like anybody else's, so a line is never drawn before the table has taken it.
        """
        if not isinstance(text, str):
            return {"ok": False, "text": "Type a message."}
        text = text.strip()[:_CHAT_MAX]
        if not text:
            return {"ok": False, "text": "Type a message."}
        with self._lock:
            if self._data.get("state") != "live":
                return {"ok": False, "text": "The table is not connected."}
            self._saying = text
            self._data["chat_error"] = None
            self._out.put({"t": "chat", "text": text})
        return {"ok": True, "text": ""}

    def close(self):
        with self._lifecycle:
            with self._lock:
                self._stop.set()
                sock, thread = self._socket, self._thread
                if self._data:
                    self._data["state"] = "closed"
                self._fail_pending("The table was closed.")
            if sock:
                sock.close()
            if thread and thread is not threading.current_thread():
                thread.join(timeout=12)

    def _fail_pending(self, text):
        for pending in self._pending.values():
            pending["answer"] = {"ok": False, "text": text}
            pending["event"].set()

    def _keep_chat(self, message):
        """Add one chat line from a chat frame, keeping the last _CHAT_KEEP — what the panel draws."""
        line = message.get("message")
        if not isinstance(line, dict):
            return
        chat = self._data.get("chat")
        if not isinstance(chat, list):
            chat = []
        self._data["chat"] = [*chat, line][-_CHAT_KEEP:]

    def _keep_presence(self, message):
        """Who is at the table, from a presence frame."""
        self.presence = message.get("people") or []

    def _run(self, room_id, key):
        delay = 1
        while not self._stop.is_set():
            sock = None
            try:
                sock = wsmod.Socket(wsmod.socket_url(self.online.url, f"/ws/{room_id}"), timeout=5)
                with self._lock:
                    if self._stop.is_set():
                        sock.close()
                        break
                    self._socket = sock
                sock.send_json({"t": "auth", "token": key})
                while not self._stop.is_set():
                    try:
                        while True:
                            sock.send_json(self._out.get_nowait())
                    except queue.Empty:
                        pass
                    message = sock.receive(timeout=0.15)
                    if not message:
                        continue
                    kind = message.get("t")
                    with self._lock:
                        # close() has already marked the table closed. A frame that was
                        # already on the wire must not put it back to live after that.
                        if self._stop.is_set():
                            break
                        if kind == "hello":
                            self._me = (message.get("me") or {}).get("id", "")
                            self._data.update(state="live", room=message.get("room"), error="")
                            # The table opens with the last messages it kept for this seat.
                            self._data["chat"] = [m for m in (message.get("chat") or []) if isinstance(m, dict)][-_CHAT_KEEP:]
                            delay = 1
                        elif kind == "state":
                            picture = message.get("picture") or {}
                            self._data.update(picture=picture, room=message.get("room"))
                            seats = picture.get("seats") or []
                            own = next((s for s in seats if s.get("id") == self._me), {})
                            other = next((s for s in seats if s.get("id") and s.get("id") != self._me), {})
                            self._data["side"] = own.get("side", "")
                            self._data["opponent"] = {"name": other.get("name", "")} if other else None
                            if picture.get("status") in {"win", "draw", "resigned", "abandoned"}:
                                self._data["finished"] = self._data["finished"] or {"status": picture["status"]}
                        elif kind in self._feeds:
                            self._feeds[kind](message)
                        elif kind == "result":
                            self.result = message
                            if message.get("finished"):
                                self._data["finished"] = message["finished"]
                            pending = self._pending.get(message.get("ref"))
                            if pending:
                                pending["answer"] = message
                                pending["event"].set()
                            elif message.get("ok") is False and message.get("ref") is None:
                                # A command always carries a ref; a chat message is the only frame
                                # this seat sends without one. So a refusal with no ref is the server
                                # turning that message down - muted, silenced or too fast. A command
                                # result whose waiter has already moved on still has its ref, and must
                                # not be shown as a chat error. The last text this seat sent is what
                                # there is: a chat frame carries no id.
                                self._data["chat_error"] = {
                                    "text": str(message.get("text") or "The table did not take that message."),
                                    "sent": self._saying, "at": time.time()}
                        elif kind in {"error", "closed"}:
                            self._data.update(state="error" if kind == "error" else "closed",
                                              error=str(message.get("text") or "The table closed."))
                            return
            except (OSError, wsmod.SocketError):
                with self._lock:
                    if not self._stop.is_set():
                        self._data.update(state="reconnecting", error="Connection lost; reconnecting.")
            finally:
                if sock:
                    sock.close()
                with self._lock:
                    self._socket = None
                    self._fail_pending("Connection lost before the table answered.")
                    while True:
                        try:
                            self._out.get_nowait()
                        except queue.Empty:
                            break
            if self._stop.wait(delay):
                break
            delay = min(delay * 2, 8)
