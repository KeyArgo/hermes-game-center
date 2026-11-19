"""The plugin's lobby Hall against a real local lobby server.

Mirrors tests/test_online_table.py: the same in-process aiohttp server and the
same sign-in helpers, with the Hall's daemon thread driven from the test by
yielding to the event loop so the server can answer it.
"""
import asyncio
import json
import threading
import time

from shelf.online_source import Online
from shelf.online_hall import Hall
from test_online_server import started, sign_in, run


async def web_lobby(client, token, kind="web"):
    """A second client on the lobby socket, the way a browser tab connects."""
    ws = await client.ws_connect("/api/lobby/socket")
    await ws.send_json({"t": "auth", "token": token, "client": kind})
    return ws, await ws.receive_json(timeout=3)


async def until(ws, predicate, timeout=4):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        left = end - loop.time()
        assert left > 0, "timed out waiting on the web client"
        frame = await ws.receive_json(timeout=left)
        if predicate(frame):
            return frame


async def wait_snapshot(hall, predicate, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        snap = hall.snapshot()
        if predicate(snap):
            return snap
        await asyncio.sleep(0.03)
    raise AssertionError(f"timed out; snapshot was {hall.snapshot()}")


def _source(folder, base, token):
    source = Online(folder, url=base, secret=lambda _name: token)
    source.turn_on()
    return source


def test_hall_goes_live_prefs_request_accept_and_gone(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        server.hub.grace = 0.1  # so a closed hall is seen as 'gone' quickly
        hall = None
        web = None
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            base = str(client.make_url("/")).rstrip("/")
            source = _source(tmp_path / "plugin", base, ada_token)
            hall = Hall(source)
            hall.start()
            live = await wait_snapshot(hall, lambda s: s["state"] == "live")
            assert live["you"]["name"] == "Ada"
            assert ada_token not in json.dumps(live), "the key never reaches the snapshot"

            # A second (web) client sees Hermes in its roster, and Hermes sees it.
            web, hello = await web_lobby(client, bea_token)
            assert ada["id"] in [r["id"] for r in hello["roster"]]
            await wait_snapshot(hall, lambda s: bea["id"] in [r["id"] for r in s["roster"]])

            # Prefs round-trip: Ada opens up for connect4; the web roster reflects it.
            saved = await asyncio.to_thread(hall.prefs, True, {"connect4": True})
            assert saved["ok"], saved
            assert hall.snapshot()["prefs"]["open"] is True
            assert hall.snapshot()["prefs"]["games"]["connect4"] is True
            await until(web, lambda m: m.get("row", {}).get("id") == ada["id"]
                        and "connect4" in (m["row"].get("games") or []))

            # The web client asks Hermes for a game; the ask lands in the hall.
            await web.send_json({"t": "request", "to": ada["id"], "game": "connect4", "op": "ask"})
            ack = await until(web, lambda m: m.get("t") == "ack" and m.get("op") == "ask")
            assert ack["ok"], ack
            pending = await wait_snapshot(hall, lambda s: len(s["requests"]) >= 1)
            req = next(r for r in pending["requests"] if r.get("state") == "pending")
            assert req["from"]["id"] == bea["id"] and req["game"] == "connect4"

            # Hermes accepts; both sides are seated at a private table.
            accepted = await asyncio.to_thread(hall.respond, req["id"], True)
            assert accepted["ok"], accepted
            seated = await wait_snapshot(hall, lambda s: s["seated"] and s["seated"].get("room_id"))
            assert seated["seated"]["opponent"]["id"] == bea["id"]
            assert seated["seated"]["game"] == "connect4"
            await until(web, lambda m: m.get("t") == "seated" and m.get("room_id"))

            # Closing the hall takes Hermes out of the web client's roster.
            await asyncio.to_thread(hall.stop)
            assert hall.snapshot()["state"] == "off"
            assert hall.snapshot()["roster"] == [] and hall.snapshot()["requests"] == []
            await until(web, lambda m: m.get("t") == "gone" and m.get("id") == ada["id"])
        finally:
            if hall:
                await asyncio.to_thread(hall.stop)
            if web:
                await web.close()
            await client.close()
    run(scenario())


def test_hall_auth_failure_is_a_quiet_off_state(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        hall = None
        try:
            base = str(client.make_url("/")).rstrip("/")
            source = _source(tmp_path / "plugin", base, "not-a-real-token")
            hall = Hall(source)
            hall.start()
            snap = await wait_snapshot(hall, lambda s: s["state"] == "off" and s.get("error"))
            assert snap["error"]
            assert "not-a-real-token" not in json.dumps(snap), "the bad key never leaks"
            assert snap["roster"] == [] and snap["seated"] is None
        finally:
            if hall:
                await asyncio.to_thread(hall.stop)
            await client.close()
    run(scenario())


def test_hall_snapshot_shape_when_off(tmp_path):
    """Off and never started: the contract-D shape, and start() stays a no-op."""
    source = Online(tmp_path, url="http://127.0.0.1:1", secret=lambda _name: "")
    hall = Hall(source)
    snap = hall.snapshot()
    assert set(snap) == {"state", "you", "prefs", "roster", "requests", "seated"}
    assert snap["state"] == "off"
    assert snap["prefs"] == {
        "open": False,
        "games": {game: False for game in ("connect4", "reversi", "checkers", "gomoku",
                                           "chessboard", "go", "hex", "breakthrough",
                                           "seabattle", "blackjack")},
        # A temporary accept carries the moment it lapses; nothing is temporary when off.
        "until": {},
    }
    # No key and online off: start() opens no socket.
    hall.start()
    assert hall.snapshot()["state"] == "off"
    # Not connected: a client frame refuses plainly, in the words the screen puts beside
    # Retry, rather than blocking forever or reading as "your invites are off".
    assert hall.prefs(open=True) == {"ok": False, "text": "Not connected to the lobby yet — Retry"}
    assert hall.request("someone", "connect4")["ok"] is False


def test_every_door_says_not_connected_and_retry_dials_again(tmp_path):
    """The one sentence and the one control: press Retry and the Hall dials at once.

    The Hall said "The lobby is not connected." from a state nothing could see or fix: the
    card drew an empty accept list as "invites are off", and no line was logged anywhere.
    """
    import logging

    source = Online(tmp_path, url="http://127.0.0.1:1", secret=lambda _name: "k")
    hall = Hall(source)
    hall.start()
    try:
        # It cannot reach 127.0.0.1:1, so every door says the same thing.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and hall.snapshot()["state"] == "live":
            time.sleep(0.02)
        not_live = hall.snapshot()
        assert not_live["state"] != "live"
        assert hall.looking(["connect4"])["text"] == "Not connected to the lobby yet — Retry"
        # Nothing is lost by asking again: the state stays a state, never an exception.
        after = hall.retry()
        assert after["state"] in {"off", "connecting", "old-server"}
    finally:
        hall.stop()


def test_signing_in_again_dials_a_refused_socket_at_once(tmp_path):
    """A key the lobby refused is a pause, not a dead end: the next start() must dial at once.

    This is the owner's report ("it won't let me check Let people invite me", 2026-11-18) at its
    source: the card was drawn from a snapshot whose state was not ``live``, and every door that
    was supposed to fix it - the sign-in, the Games page opening, Retry - called ``start()``,
    which returned the moment it saw a worker thread. The worker was sitting out a 60-second
    pause after the refused key (or its reconnect delay), so the socket the person had just
    signed in for was never dialled, and the switch stayed dead for as long as they were
    willing to look at it.
    """
    async def scenario():
        server, client = await started(tmp_path / "server")
        hall = None
        try:
            ada, ada_token = await sign_in(client, "Ada")
            base = str(client.make_url("/")).rstrip("/")
            key = {"now": "not-a-real-token"}
            source = Online(tmp_path / "plugin", url=base, secret=lambda _name: key["now"])
            source.turn_on()
            hall = Hall(source)
            hall.start()
            # The lobby refuses that key: the state is a quiet "off" with the reason, and the
            # worker is now waiting before it tries the same refused key again.
            refused = await wait_snapshot(hall, lambda s: s["state"] == "off" and s.get("error"))
            assert "did not accept" in refused["error"], refused

            # The person signs in with the key that works. The route's one action is start().
            key["now"] = ada_token
            hall.start()
            live = await wait_snapshot(hall, lambda s: s["state"] == "live", timeout=2)
            assert live["you"]["name"] == "Ada"
        finally:
            if hall:
                await asyncio.to_thread(hall.stop)
            await client.close()
    run(scenario())


def test_retry_answers_with_the_state_the_dial_reached(tmp_path):
    """Retry's answer is read by the card, so it must be the state after the dial, not before it.

    /online/hall/retry used to hand back the snapshot taken the instant start() returned - always
    "connecting" - so the one control offered beside "Lobby not connected" answered "not
    connected" every time, on a lobby that was up.
    """
    async def scenario():
        server, client = await started(tmp_path / "server")
        hall = None
        try:
            ada, ada_token = await sign_in(client, "Ada")
            base = str(client.make_url("/")).rstrip("/")
            key = {"now": "not-a-real-token"}
            source = Online(tmp_path / "plugin", url=base, secret=lambda _name: key["now"])
            source.turn_on()
            hall = Hall(source)
            hall.start()
            await wait_snapshot(hall, lambda s: s["state"] == "off" and s.get("error"))

            key["now"] = ada_token
            answer = await asyncio.to_thread(hall.retry)
            assert answer["state"] == "live", answer
            assert answer["you"]["name"] == "Ada"
        finally:
            if hall:
                await asyncio.to_thread(hall.stop)
            await client.close()
    run(scenario())


def test_the_reason_a_socket_could_not_be_opened_reaches_the_log(tmp_path, caplog):
    """A Hall that cannot connect says why, once, in the logger the other shelf parts use."""
    source = Online(tmp_path, url="http://127.0.0.1:1", secret=lambda _name: "")
    source.turn_on()
    hall = Hall(source)
    with caplog.at_level("INFO", logger="shelf.online_hall"):
        hall.start()
        hall.stop()
    text = " ".join(record.getMessage() for record in caplog.records)
    assert "no sign-in key" in text, text
    # The credential is never in a log line, even the one that says there is none.
    assert "SECRET-KEY-VALUE" not in text


def test_hall_validates_client_frames(tmp_path):
    source = Online(tmp_path, url="http://127.0.0.1:1", secret=lambda _name: "")
    hall = Hall(source)
    # Bad types are caught before anything is sent (so they never reach the socket).
    assert hall.request(123, "connect4")["ok"] is False
    assert hall.request("x" * 101, "connect4")["ok"] is False
    assert hall.respond("rid", "yes")["ok"] is False
    assert hall.cancel("")["ok"] is False
    assert hall.prefs(open="yes")["ok"] is False
    assert hall.prefs(games={"connect4": "on"})["ok"] is False


def test_hall_routes_return_contract_d_shape(monkeypatch):
    """The dashboard routes delegate to the hall and keep the contract-D shape."""
    from dashboard import plugin_api

    class FakeSource:
        on = True

    class FakeHall:
        def __init__(self):
            self.started = False
            self.calls = []

        def start(self, **kwargs):
            self.started = True
            self.start_calls = getattr(self, "start_calls", []) + [kwargs]

        def snapshot(self):
            return {"state": "live", "you": {"id": "a", "name": "Ada"},
                    "prefs": {"open": False, "games": {}}, "roster": [], "requests": [], "seated": None}

        def prefs(self, open=None, games=None):
            self.calls.append(("prefs", open, games))
            return {"ok": True, "text": "Saved."}

        def request(self, to, game):
            self.calls.append(("request", to, game))
            return {"ok": True, "text": "Request sent."}

        def respond(self, id, accept):
            self.calls.append(("respond", id, accept))
            return {"ok": True, "text": "You are seated."}

        def cancel(self, id):
            self.calls.append(("cancel", id))
            return {"ok": True, "text": "Cancelled."}

    source = FakeSource()
    hall = FakeHall()
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (source, None))
    monkeypatch.setattr(plugin_api, "_online_hall", lambda src: hall)

    view = plugin_api.online_hall_view()
    assert set(view) == {"state", "you", "prefs", "roster", "requests", "seated"}
    assert hall.started, "GET lazily starts the hall when online is on"
    assert hall.start_calls == [{"wake": False}], "and asks as a read, never as a press"

    assert plugin_api.online_hall_prefs({"open": True, "games": {"connect4": True}})["ok"]
    assert plugin_api.online_hall_request({"to": "b", "game": "connect4"})["ok"]
    assert plugin_api.online_hall_respond({"id": "r1", "accept": True})["ok"]
    assert plugin_api.online_hall_cancel({"id": "r1"})["ok"]
    assert hall.calls == [
        ("prefs", True, {"connect4": True}),
        ("request", "b", "connect4"),
        ("respond", "r1", True),
        ("cancel", "r1"),
    ]


def test_a_dropped_socket_never_leaves_a_stale_live_state(monkeypatch):
    """While the socket is gone the Hall must say "connecting", and a page that asks for a game in
    that window must be refused rather than queued and replayed after the reconnect."""
    import threading
    import types

    from shelf import online_hall as mod

    sent = []

    class DropSock:
        """One session that goes live, then drops; from then on nothing can connect again."""

        dropped = False

        def __init__(self, url, timeout=5):
            self.helloed = False
            self.pongs = 0

        def send_json(self, frame):
            sent.append(frame)

        def receive(self, timeout=0.15):
            if DropSock.dropped:
                raise OSError("socket dropped")
            if not self.helloed:
                self.helloed = True
                return {"t": "hello", "v": 1, "you": {"id": "web:1", "name": "Bea"},
                        "prefs": {"open": False, "games": {}}, "roster": [], "requests": [], "rev": 1}
            # Stay reachable for a few frames so the test can observe "live", then drop for good.
            if self.pongs < 3:
                self.pongs += 1
                time.sleep(0.05)   # a real socket does not answer instantly; keeps "live" observable
                return {"t": "pong"}
            DropSock.dropped = True
            raise OSError("socket dropped")

        def close(self):
            pass

    monkeypatch.setattr(mod.wsmod, "Socket", DropSock)
    online = types.SimpleNamespace(on=True, url="http://127.0.0.1:1", key=lambda: "k", game=lambda: "connect4")
    hall = mod.Hall(online)
    hall.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hall.snapshot()["state"] != "live":
            time.sleep(0.02)
        assert hall.snapshot()["state"] == "live", hall.snapshot()

        # Now it drops. Within the backoff window the page must not be told we are live.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hall.snapshot()["state"] == "live":
            time.sleep(0.02)
        assert hall.snapshot()["state"] == "connecting", hall.snapshot()

        answer = hall.request("web:2", "connect4")
        assert answer == {"ok": False, "text": "Not connected to the lobby yet — Retry"}, answer
        assert hall._out.qsize() == 0, "a request was queued while the lobby was down"
    finally:
        hall.stop()


def test_two_hermes_halls_on_one_lobby_see_each_other(tmp_path):
    """Two PCs, each a Hermes signed in under its own name, list each other in the Hall (owner,
    2026-11-16: "bluewren" and "Locutus" did not see each other). Until now only Hermes-and-browser
    was covered."""
    async def scenario():
        server, client = await started(tmp_path / "server")
        first = second = None
        try:
            wren, wren_token = await sign_in(client, "bluewren")
            locutus, locutus_token = await sign_in(client, "Locutus")
            base = str(client.make_url("/")).rstrip("/")
            first = Hall(_source(tmp_path / "pc-one", base, wren_token))
            second = Hall(_source(tmp_path / "pc-two", base, locutus_token))
            first.start()
            second.start()
            await wait_snapshot(first, lambda s: locutus["id"] in [r["id"] for r in s["roster"]])
            await wait_snapshot(second, lambda s: wren["id"] in [r["id"] for r in s["roster"]])
        finally:
            for hall in (first, second):
                if hall:
                    await asyncio.to_thread(hall.stop)
            await client.close()
    run(scenario())


def test_a_server_that_goes_silent_is_dropped_and_dialled_again(monkeypatch):
    """A server host that dies without closing the socket (sentinel, 2026-11-18) leaves a socket
    that never errors. The Hall pings every 20 s; when nothing at all comes back for a while it
    must give up on that socket and dial again, or it stays "live" on a dead line long after the
    server is back."""
    import types

    from shelf import online_hall as mod

    opened = []

    class SilentSock:
        def __init__(self, url, timeout=5):
            opened.append(self)
            self.helloed = False

        def send_json(self, frame):
            pass

        def receive(self, timeout=0.15):
            if not self.helloed:
                self.helloed = True
                return {"t": "hello", "v": 1, "you": {"id": "web:1", "name": "Bea"},
                        "prefs": {"open": False, "games": {}}, "roster": [], "requests": [], "rev": 1}
            time.sleep(timeout)   # the host is gone: no frame, no error, ever
            return None

        def close(self):
            pass

    monkeypatch.setattr(mod.wsmod, "Socket", SilentSock)
    online = types.SimpleNamespace(on=True, url="http://127.0.0.1:1", key=lambda: "k", game=lambda: "connect4")
    hall = mod.Hall(online)
    hall.quiet_limit = 0.6
    hall.retry_first = 0.05
    hall.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(opened) < 2:
            time.sleep(0.02)
        assert len(opened) >= 2, "a silent socket was kept forever; the Hall never dialled again"
    finally:
        hall.stop()


def test_a_server_that_cannot_be_reached_says_so_and_clears_when_it_answers(monkeypatch):
    """While the server is down the Hall must say so in words, not sit on "Joining the Hall…";
    the words go away by themselves once the server answers again."""
    import types

    from shelf import online_hall as mod

    up = {"now": False}

    class Sock:
        def __init__(self, url, timeout=5):
            if not up["now"]:
                raise OSError("timed out")
            self.helloed = False

        def send_json(self, frame):
            pass

        def receive(self, timeout=0.15):
            if not self.helloed:
                self.helloed = True
                return {"t": "hello", "v": 1, "you": {"id": "web:1", "name": "Bea"},
                        "prefs": {"open": False, "games": {}}, "roster": [], "requests": [], "rev": 1}
            time.sleep(0.02)
            return {"t": "pong"}

        def close(self):
            pass

    monkeypatch.setattr(mod.wsmod, "Socket", Sock)
    online = types.SimpleNamespace(on=True, url="http://127.0.0.1:1", key=lambda: "k", game=lambda: "connect4")
    hall = mod.Hall(online)
    hall.retry_first = 0.05
    hall.retry_most = 0.1
    hall.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and "error" not in hall.snapshot():
            time.sleep(0.02)
        snap = hall.snapshot()
        assert snap["state"] == "connecting", snap
        assert "not answering" in snap.get("error", ""), snap

        up["now"] = True
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hall.snapshot()["state"] != "live":
            time.sleep(0.02)
        snap = hall.snapshot()
        assert snap["state"] == "live", snap
        assert "error" not in snap, snap
    finally:
        hall.stop()


def test_two_halls_find_each_other_again_after_the_server_restarts(tmp_path):
    """The whole outage end to end: two PCs see each other, the lobby server stops (sentinel went
    down), it comes back on the same address with the same accounts, and both PCs list each other
    again without anyone touching them."""
    from aiohttp.test_utils import TestClient, TestServer

    from online.server import App
    from test_online_server import LOADED

    async def scenario():
        server, client = await started(tmp_path / "server")
        port = client.port
        first = second = None
        try:
            wren, wren_token = await sign_in(client, "bluewren")
            locutus, locutus_token = await sign_in(client, "Locutus")
            base = str(client.make_url("/")).rstrip("/")
            first = Hall(_source(tmp_path / "pc-one", base, wren_token))
            second = Hall(_source(tmp_path / "pc-two", base, locutus_token))
            for hall in (first, second):
                hall.retry_first = 0.05
                hall.retry_most = 0.2
            first.start()
            second.start()
            await wait_snapshot(first, lambda s: locutus["id"] in [r["id"] for r in s["roster"]])
            await wait_snapshot(second, lambda s: wren["id"] in [r["id"] for r in s["roster"]])

            await client.close()          # the server goes away
            await wait_snapshot(first, lambda s: s["state"] == "connecting")
            await asyncio.sleep(0.5)       # down for a while; both keep trying

            again = App(tmp_path / "server", games=LOADED)
            client = TestClient(TestServer(again.build(), port=port))
            await client.start_server()    # back on the same address, same accounts
            await wait_snapshot(first, lambda s: s["state"] == "live"
                                and locutus["id"] in [r["id"] for r in s["roster"]], timeout=10)
            await wait_snapshot(second, lambda s: s["state"] == "live"
                                and wren["id"] in [r["id"] for r in s["roster"]], timeout=10)
        finally:
            for hall in (first, second):
                if hall:
                    await asyncio.to_thread(hall.stop)
            await client.close()
    run(scenario())


def test_prefs_carry_the_twenty_minute_window():
    """A temporary accept keeps its window: the screen says "for 20 min" from it.

    The server sends prefs.games true while a game is accepted standing or for twenty
    minutes, and prefs.until holds the moment a temporary one lapses. Dropping until here
    left every screen calling a temporary accept permanent.
    """
    live = Hall._clean_prefs({
        "open": True,
        "games": {"chessboard": True, "connect4": True},
        "until": {"chessboard": 1700000000.5, "connect4": 0},
    })
    assert live["until"] == {"chessboard": 1700000000.5}, live
    assert live["games"]["chessboard"] is True

    # An older server has no until at all, and that is simply a standing list.
    old = Hall._clean_prefs({"open": True, "games": {"connect4": True}})
    assert old["until"] == {}
    assert old["games"]["connect4"] is True
    # Nor does a broken one make the page fail: it is read as standing.
    assert Hall._clean_prefs({"games": {"connect4": True}, "until": "soon"})["until"] == {}


def test_the_hall_lists_every_game_the_server_can_seat():
    """The socket's own list, not just the panel's.

    Blackjack reached the server and the lobby panel but not this list, so "All games" left
    it out and a Blackjack search read back as an empty one.
    """
    from online.requests import REQUESTABLE as SERVER_GAMES
    from shelf.online_hall import REQUESTABLE as HALL_GAMES
    assert sorted(HALL_GAMES) == sorted(SERVER_GAMES)


def test_a_window_that_has_run_out_reads_off_in_the_snapshot():
    """The screen never sees a stale on, so it can never echo one back.

    The server counts an expired twenty minutes as off the moment it passes; a snapshot
    that still said on would have the page draw the chip pressed and post it that way.
    """
    hall = Hall.__new__(Hall)
    hall._lock = threading.Lock()
    hall._state = "live"
    hall._error = ""
    hall._you = {"id": "me", "name": "Ada", "invisible": False, "looking": []}
    hall._roster = {}
    hall._requests = {}
    hall._seated = None
    now = time.time()
    hall._prefs = {
        "open": False,
        "games": {"chessboard": True, "connect4": True},
        "until": {"chessboard": now - 1, "connect4": now + 600},
    }
    prefs = hall.snapshot()["prefs"]
    assert prefs["games"]["chessboard"] is False, "a lapsed window is off"
    assert "chessboard" not in prefs["until"], "and it has no window to show"
    assert prefs["games"]["connect4"] is True, "a running one is still on"
    assert prefs["until"]["connect4"] == now + 600


def test_turning_on_a_game_whose_window_has_lapsed_leaves_no_window_behind():
    """A press after the twenty minutes is a plain choice, and reads as one.

    Keeping the lapsed stamp would have the chip read off again on the very next draw.
    """
    class Wire:
        def __init__(self):
            self._lock = threading.Lock()
            self._prefs = {"open": False, "games": {"chessboard": True}, "until": {"chessboard": 1.0}}
            self._you = {"id": "me", "name": "Ada", "invisible": False, "looking": []}
            self.frames = []

        def send(self, frame):
            self.frames.append(frame)
            return {"ok": True, "text": "Saved."}

    wire = Wire()
    assert Hall.prefs(wire, games={"chessboard": True})["ok"] is True
    assert wire.frames[-1] == {"t": "prefs", "games": {"chessboard": True}}
    assert "chessboard" not in wire._prefs["until"], "the lapsed window is gone"
    assert wire._prefs["games"]["chessboard"] is True
    assert wire._prefs["open"] is True, "and the chip turned the master switch on with it"


def test_always_keeps_a_game_and_a_looking_ack_carries_ask_always():
    """"Always let people invite you to Chess?": both ends of that question.

    Yes is a prefs frame carrying always - the server clears the twenty-minute window and
    leaves the game accepted. And the press that created the window gets ask_always back on
    its ack: a screen cannot ask a question it was never told to ask.
    """
    class Wire:
        def __init__(self):
            self._lock = threading.Lock()
            self._prefs = {"open": False, "games": {}, "until": {"chessboard": 1.0}}
            self._you = {"id": "me", "name": "Ada", "invisible": False, "looking": []}
            self.frames = []
            self.answer = {"ok": True, "text": "Looking for Chess.", "ask_always": True}

        def send(self, frame):
            self.frames.append(frame)
            return dict(self.answer)

    wire = Wire()
    answer = Hall.prefs(wire, always={"chessboard": True})
    assert wire.frames[-1] == {"t": "prefs", "always": {"chessboard": True}}, wire.frames[-1]
    assert answer["ok"] is True
    assert wire._prefs["games"]["chessboard"] is True
    assert wire._prefs["open"] is True, "keeping a game turns the master switch on"
    assert "chessboard" not in wire._prefs["until"], "the twenty-minute window is gone"

    # A shape the server cannot read is refused here, in words, and nothing is sent.
    wire.frames.clear()
    refused = Hall.prefs(wire, always={"chessboard": "yes"})
    assert refused["ok"] is False and wire.frames == []

    # The whole ack is kept, so ask_always reaches the screen that pressed.
    hall = Hall.__new__(Hall)
    hall._lock = threading.Lock()
    hall._pending = {"h7": {"event": threading.Event(), "answer": None}}
    hall._apply({"t": "ack", "op": "h7", "ok": True, "text": "Looking for Chess.", "ask_always": True})
    assert hall._pending["h7"]["answer"]["ask_always"] is True


def test_a_looking_ack_sets_the_switches_it_came_with():
    """Play <game> opened a twenty-minute accept on the server; the ack carries it.

    The ack is the only thing that knows, so the page has to take its prefs from there:
    without it the chip stayed off and said nothing about twenty minutes.
    """
    class Wire:
        # The one Hall method the press path really uses: prefs are cleaned on the way in.
        _clean_prefs = staticmethod(Hall._clean_prefs)

        def __init__(self):
            self._lock = threading.Lock()
            self._prefs = {"open": False, "games": {}, "until": {}}
            self._you = {"id": "me", "name": "Ada", "invisible": False, "looking": []}
            self.frames = []

        def send(self, frame):
            self.frames.append(frame)
            return {"ok": True, "text": "Looking for Chessboard.", "ask_always": True,
                    "prefs": {"open": False,
                              "games": {"chessboard": True, "connect4": False},
                              "until": {"chessboard": 1700000000.0}}}

    wire = Wire()
    answer = Hall.looking(wire, ["chessboard"])
    assert answer["ok"] is True
    assert wire.frames[-1] == {"t": "looking", "games": ["chessboard"]}, wire.frames[-1]
    assert wire._you["looking"] == ["chessboard"]
    assert wire._prefs["games"]["chessboard"] is True, "the twenty-minute accept shows at once"
    assert wire._prefs["until"]["chessboard"] == 1700000000.0
    assert wire._prefs["games"]["connect4"] is False
    # An older server sends no prefs on the ack: what the press changed still applies.
    wire = Wire()
    wire.send = lambda frame: {"ok": True, "text": "Looking for Connect4."}
    Hall.looking(wire, ["connect4"])
    assert wire._you["looking"] == ["connect4"]


def test_turning_a_chip_on_puts_the_master_switch_on():
    """A chip shown on really accepts, so the page turns the switch on with it.

    The chip and the switch are one answer as far as a person can see them, and the
    server does the same; a page that left the switch off showed a chip that refused.
    """
    class Wire:
        def __init__(self):
            self._lock = threading.Lock()
            self._prefs = {"open": False, "games": {}, "until": {}}
            self._you = {"id": "me", "name": "Ada", "invisible": False, "looking": []}
            self.frames = []

        def send(self, frame):
            self.frames.append(frame)
            return {"ok": True, "text": "Saved."}

    wire = Wire()
    assert Hall.prefs(wire, games={"connect4": True})["ok"] is True
    assert wire._prefs["open"] is True, "a chip shown on really accepts"
    assert wire._prefs["games"]["connect4"] is True

    # A chip turned off leaves the switch as it was.
    wire = Wire()
    Hall.prefs(wire, games={"connect4": False})
    assert wire._prefs["open"] is False
    # And a frame that sets the switch itself wins over the chip.
    wire = Wire()
    wire._prefs["open"] = True
    Hall.prefs(wire, open=False, games={"connect4": True})
    assert wire._prefs["open"] is False


def test_a_read_of_the_hall_never_wakes_the_worker_but_a_press_does(monkeypatch):
    """GET /view and GET /online/hall are polls: they keep the worker running, never nudge it.

    A refused sign-in and a server with no lobby socket each wait 60 s before the next dial, on
    purpose. The page reads the Hall every 3 s - twice over with the Games card and the Hall both
    open - so a read that woke the worker turned those pauses into a dial every 1.5 s, forever,
    with a log line for each one.
    """
    import types

    from shelf import online_hall as mod

    dialled = []

    class NoHall:
        """A server that answers the upgrade with 404: it has no lobby socket at all."""

        def __init__(self, url, timeout=5):
            dialled.append(url)
            raise mod.wsmod.SocketError("The table refused the connection (HTTP/1.1 404 Not Found).")

    monkeypatch.setattr(mod.wsmod, "Socket", NoHall)
    online = types.SimpleNamespace(on=True, url="http://127.0.0.1:1", key=lambda: "k",
                                   game=lambda: "connect4")
    hall = mod.Hall(online)
    hall.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hall.snapshot()["state"] != "old-server":
            time.sleep(0.02)
        assert hall.snapshot()["state"] == "old-server", hall.snapshot()
        assert len(dialled) == 1, dialled

        # Every read the page makes: the worker must stay in its 60-second pause.
        for _ in range(25):
            hall.start(wake=False)
            time.sleep(0.01)
        assert len(dialled) == 1, (
            f"a read woke the worker out of its 60 s pause: {len(dialled)} dials"
        )

        # A press is still a press: sign in again, or press Retry, and it dials at once.
        hall.start()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and len(dialled) < 2:
            time.sleep(0.02)
        assert len(dialled) == 2, "a sign-in or a Retry must still dial at once"
    finally:
        hall.stop()


def test_the_two_read_routes_ask_the_hall_without_nudging_it(monkeypatch):
    """GET /view (through the online payload) and GET /online/hall are reads, not presses."""
    import types

    from dashboard import plugin_api

    calls = []

    class FakeHall:
        def start(self, **kwargs):
            calls.append(("start", kwargs))

        def snapshot(self):
            return {"state": "live", "you": {}, "prefs": {}, "roster": [], "requests": [],
                    "seated": None}

    class FakeSource:
        on = True

        def refresh(self):
            pass

        def check_queue(self):
            pass

        def snapshot(self):
            return {"on": True, "match": None}

        def set_ladder(self, view):
            pass

        def poll_alert(self):
            pass

        def live_alert(self):
            return None

    source = FakeSource()
    ladder = types.SimpleNamespace(status=lambda: {})
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (source, ladder))
    monkeypatch.setattr(plugin_api, "_online_hall", lambda src: FakeHall())

    plugin_api.online_hall_view()
    plugin_api._online_payload_unsafe(refresh=False)
    assert calls == [("start", {"wake": False}), ("start", {"wake": False})], calls


def test_a_press_that_lands_mid_dial_is_not_lost(monkeypatch):
    """Retry, or a sign-in, pressed while a connect is in flight must dial again - not wait.

    ``_dialling`` stayed true from the start of an attempt until the wait after it, and ``start()``
    refused to record a wake while it was set, so a press in that window was dropped: the worker
    then sat out the whole backoff (up to 8 s, or 60 s after a refused key) with the press spent.
    """
    import types

    from shelf import online_hall as mod

    dials = []
    held = threading.Event()

    class SlowConnect:
        def __init__(self, url, timeout=5):
            dials.append(url)
            if len(dials) == 1:
                held.wait(5)      # the first attempt is still inside its connect
            raise mod.wsmod.SocketError("Could not connect: timed out")

    monkeypatch.setattr(mod.wsmod, "Socket", SlowConnect)
    online = types.SimpleNamespace(on=True, url="http://127.0.0.1:1", key=lambda: "k",
                                   game=lambda: "connect4")
    hall = mod.Hall(online)
    hall.retry_first = 3.0
    hall.retry_most = 3.0
    hall.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not dials:
            time.sleep(0.01)
        assert len(dials) == 1, dials

        # The person presses Retry (or signs in again) while that connect is still open.
        hall.start()
        held.set()
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline and len(dials) < 2:
            time.sleep(0.01)
        assert len(dials) == 2, "the press was dropped: the worker waited out the whole backoff"
    finally:
        held.set()
        hall.stop()


def test_a_malformed_server_address_is_a_failed_dial_not_a_dead_worker(tmp_path, caplog):
    """A port typo must be a dial that failed, with a reason - not a worker that dies silently.

    ``urlsplit(...).port`` raises ValueError for "http://host:99999", and the worker caught only
    SocketError and OSError around the connect. The thread died with the state stuck on
    "connecting", every poll spawned another doomed thread, and the Hall said "Joining the Hall…"
    for as long as the person was willing to look at it.
    """
    source = Online(tmp_path, url="http://host:99999", secret=lambda _name: "k")
    source.turn_on()
    hall = Hall(source)
    hall.retry_first = 0.05
    hall.retry_most = 0.1
    with caplog.at_level("INFO", logger="shelf.online_hall"):
        hall.start()
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and hall._misses < 2:
                time.sleep(0.02)
            assert hall._misses >= 2, "the worker died on the bad address instead of backing off"
            assert hall._thread is not None and hall._thread.is_alive(), "the worker thread stayed up"
            assert hall.snapshot()["state"] == "connecting", hall.snapshot()
        finally:
            hall.stop()
    said = " ".join(record.getMessage() for record in caplog.records)
    assert "99999" in said or "Port out of range" in said, said


def test_a_worker_stuck_in_a_connect_is_not_left_dialling_beside_a_new_one(monkeypatch):
    """A connect that outlives stop()'s join keeps its own stop event, so it exits by itself.

    A connect still inside ``Socket()`` cannot be closed from outside, and a stalled DNS answer can
    outlast the join. ``stop()`` cleared ``_thread`` regardless, and ``start()`` then installed a
    fresh, unset stop event for the new worker - which the old one read too, so it came back to life
    and dialled beside it: two sockets, one Hall.
    """
    import types

    from shelf import online_hall as mod

    dials = []
    held = threading.Event()

    class StuckConnect:
        def __init__(self, url, timeout=5):
            dials.append(url)
            if len(dials) == 1:
                held.wait(5)      # the first connect outlives the join, like a stalled DNS answer
            self.helloed = False

        def send_json(self, frame):
            pass

        def receive(self, timeout=0.15):
            if not self.helloed:
                self.helloed = True
                return {"t": "hello", "v": 1, "you": {"id": "web:1", "name": "Bea"},
                        "prefs": {"open": False, "games": {}}, "roster": [], "requests": [], "rev": 1}
            time.sleep(0.02)
            return {"t": "pong"}

        def close(self):
            pass

    monkeypatch.setattr(mod.wsmod, "Socket", StuckConnect)
    online = types.SimpleNamespace(on=True, url="http://127.0.0.1:1", key=lambda: "k",
                                   game=lambda: "connect4")
    hall = mod.Hall(online)
    hall.stop_join = 0.05
    hall.start()
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not dials:
            time.sleep(0.01)
        assert len(dials) == 1, dials

        # stop() cannot join a worker stuck in its connect; the next start() must not orphan it.
        hall.stop()
        hall.start()
        time.sleep(0.3)
        assert len(dials) == 1, "a second worker dialled beside the one still in its connect"

        # Let the stuck connect finish: it must notice its own stop event and leave.
        held.set()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and hall._thread is not None and hall._thread.is_alive():
            time.sleep(0.02)
        assert hall._thread is None or not hall._thread.is_alive(), (
            "the worker left behind kept running after its own stop event was set"
        )

        # And once it is gone, a start() opens exactly one worker again.
        hall.start()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and len(dials) < 2:
            time.sleep(0.02)
        assert len(dials) == 2, dials
    finally:
        held.set()
        hall.stop()


def test_retry_says_joining_while_the_dial_is_still_running(monkeypatch):
    """The sentence beside Retry is read from the state the dial reached - joining is not failure.

    /online/hall/retry answered "Not connected to the lobby yet" for every non-live state,
    including "connecting": a dial that had not had its two seconds was reported as a failure, and
    the card kept that sentence even after the next read came back live.
    """
    from dashboard import plugin_api
    from shelf import online_hall as hall_mod

    class FakeHall:
        def __init__(self, state):
            self.state = state

        def retry(self):
            return {"state": self.state, "you": {}, "prefs": {}, "roster": [], "requests": [],
                    "seated": None}

    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (object(), None))
    expected = {
        "connecting": ("Joining the lobby now — one moment.", False),
        "live": ("", True),
        "off": (hall_mod.NOT_CONNECTED, False),
        "old-server": (hall_mod.NOT_CONNECTED, False),
    }
    for state, (text, ok) in expected.items():
        monkeypatch.setattr(plugin_api, "_online_hall", lambda src, s=state: FakeHall(s))
        answer = plugin_api.online_hall_retry()
        assert answer["ok"] is ok, (state, answer)
        assert answer["text"] == text, (state, answer)
