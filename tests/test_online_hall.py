"""The plugin's lobby Hall against a real local lobby server.

Mirrors tests/test_online_table.py: the same in-process aiohttp server and the
same sign-in helpers, with the Hall's daemon thread driven from the test by
yielding to the event loop so the server can answer it.
"""
import asyncio
import json
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
    assert snap["prefs"] == {"open": False, "games": {game: False for game in
                                                      ("connect4", "reversi", "checkers", "gomoku",
                                                       "chessboard", "go", "hex", "breakthrough",
                                                       "seabattle")}}
    # No key and online off: start() opens no socket.
    hall.start()
    assert hall.snapshot()["state"] == "off"
    # Not connected: a client frame refuses plainly rather than blocking forever.
    assert hall.prefs(open=True) == {"ok": False, "text": "The lobby is not connected."}
    assert hall.request("someone", "connect4")["ok"] is False


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

        def start(self):
            self.started = True

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
        assert answer == {"ok": False, "text": "The lobby is not connected."}, answer
        assert hall._out.qsize() == 0, "a request was queued while the lobby was down"
    finally:
        hall.stop()
