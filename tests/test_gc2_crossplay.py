"""Web and Hermes cross-play one real game over a real local server (lane XPLAY).

Two accounts meet in the lobby of the real server (``online/server.py`` behind
aiohttp's ``TestServer``, which is a real TCP port, so the plugin's own socket
can reach it):

* ``Web``  — a browser tab: an aiohttp WebSocket on ``/api/lobby/socket`` and on
             ``/ws/{room}``, playing with the page's ``cmd`` frames.
* ``Herm`` — Hermes: the same lobby socket, and ``shelf.online_table.OnlineTable``
             driven by a fake ``Online`` source (on, the test server's URL, the
             player's token), opening the room on its own worker thread.

Web asks Herm for connect4 through the REST twin, Herm accepts, the server seats
both in one private room, and they play it to a win. A second test force-closes
Hermes's socket mid-game and checks the table rides the reconnect without
resigning.
"""
from pathlib import Path
import asyncio
import contextlib
import json
import logging
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shelf.online_source import Online  # noqa: E402
from shelf.online_table import OnlineTable  # noqa: E402
from test_online_server import Seat, connect, run, sign_in, started  # noqa: E402

GAME = "connect4"
# White (Web, who asked) stacks column 1; black (Herm) answers in column 2. White's
# fourth stone is the seventh ply, so the game is decided and both sides can see it.
WEB_COLUMNS = ["1", "1", "1", "1"]
HERM_COLUMNS = ["2", "2", "2"]
PLIES_TO_WIN = 7


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def wait_for(test, timeout=10, what="the expected state"):
    """Poll ``test`` until it is true, or fail with a plain reason. Never waits forever."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        await asyncio.sleep(0.03)
    raise AssertionError(f"timed out after {timeout:g}s waiting for {what}")


async def open_lobby(client, token, kind):
    """Put one account on the lobby socket so presence counts it as online."""
    seat = Seat(await client.ws_connect("/api/lobby/socket"))
    await seat.send(t="auth", token=token, client=kind)
    hello = await seat.until(lambda m: m.get("t") in {"hello", "error"}, timeout=5)
    assert hello["t"] == "hello", hello
    assert hello["you"]["id"], hello
    return seat


async def ask_and_accept(client, web, web_token, herm, herm_token, web_lobby, herm_lobby):
    """Web asks Herm for a connect4 table; Herm accepts. Returns the shared room id."""
    opened = await client.post("/api/availability", json={"open": True}, headers=auth(herm_token))
    assert opened.status == 200, await opened.text()
    prefs = await opened.json()
    assert prefs["open"] is True and prefs["games"][GAME] is True, prefs

    asked = await client.post("/api/requests", json={"to": herm["id"], "game": GAME},
                              headers=auth(web_token))
    assert asked.status == 200, await asked.text()
    body = await asked.json()
    assert body["ok"] is True and body["request"]["state"] == "pending", body
    request_id = body["request"]["id"]

    seen = await herm_lobby.until(
        lambda m: m.get("t") == "request" and m["request"]["id"] == request_id, timeout=5)
    assert seen["request"]["from"]["id"] == web["id"], seen

    accepted = await client.post(f"/api/requests/{request_id}", json={"accept": True},
                                 headers=auth(herm_token))
    assert accepted.status == 200, await accepted.text()
    assert (await accepted.json())["ok"] is True

    web_seat = await web_lobby.until(lambda m: m.get("t") == "seated", timeout=5)
    herm_seat = await herm_lobby.until(lambda m: m.get("t") == "seated", timeout=5)
    assert web_seat["room_id"] and web_seat["room_id"] == herm_seat["room_id"], (web_seat, herm_seat)
    assert web_seat["game"] == GAME and herm_seat["game"] == GAME
    # The person who asked plays white and moves first; the one who accepted is black.
    assert web_seat["side"] == "white", web_seat
    assert herm_seat["side"] == "black", herm_seat
    assert web_seat["opponent"]["id"] == herm["id"], web_seat
    assert herm_seat["opponent"]["id"] == web["id"], herm_seat
    return web_seat["room_id"]


def open_hermes_table(tmp_path, url, token, room_id):
    """Hermes's own table over a fake source: on, the test server's URL, this token."""
    source = Online(tmp_path / "plugin", url=url, secret=lambda _: token)
    source.turn_on()
    table = OnlineTable(source)
    assert table.open(room_id)["ok"], "Hermes could not open the table"
    return table


def test_web_and_hermes_play_connect4_to_a_win(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)

    async def scenario():
        server, client = await started(tmp_path / "server")
        table = None
        sockets = []
        try:
            web, web_token = await sign_in(client, "Web")
            herm, herm_token = await sign_in(client, "Herm")
            web_lobby = await open_lobby(client, web_token, "web")
            herm_lobby = await open_lobby(client, herm_token, "hermes")
            sockets += [web_lobby, herm_lobby]

            room_id = await ask_and_accept(
                client, web, web_token, herm, herm_token, web_lobby, herm_lobby)

            web_ws = await connect(client, room_id, web_token)
            sockets.append(web_ws)
            table = open_hermes_table(
                tmp_path, str(client.make_url("/")).rstrip("/"), herm_token, room_id)

            seen_snapshots = []

            def snapshot():
                view = table.snapshot()
                seen_snapshots.append(view)
                return view

            def picture():
                return snapshot().get("picture") or {}

            def hermes_can_move():
                return (picture().get("permissions") or {}).get("can_move") is True

            def plies():
                return int((picture().get("plies") or 0))

            async def web_sees(plies_now, can_move):
                """The browser's latest board, once it is at ``plies_now`` for its seat."""
                frame = await web_ws.until(
                    lambda m: m.get("t") == "state" and m["picture"]["plies"] == plies_now
                    and m["picture"]["permissions"]["can_move"] is can_move, timeout=8)
                return frame["picture"]

            # Hermes sits black, so its first picture says the turn is Web's, not its.
            await wait_for(
                lambda: snapshot().get("side") == "black" and plies() == 0
                and (picture().get("permissions") or {}).get("can_move") is False,
                what="Hermes's first picture")
            assert snapshot()["opponent"]["name"] == "Web", snapshot()
            assert (await web_sees(0, True))["turn"] == "white"

            plies_seen = []
            for ply in range(1, PLIES_TO_WIN + 1):
                side = "white" if ply % 2 else "black"
                column = (WEB_COLUMNS if side == "white" else HERM_COLUMNS)[(ply - 1) // 2]
                if side == "white":
                    # It is Web's turn: Hermes's own picture refuses Herm a move.
                    assert not hermes_can_move(), picture()
                    before = await web_sees(ply - 1, True)
                    assert column in before["legal"], before["legal"]
                    answer = await web_ws.result(100 + ply, t="cmd", action="move", args=[column])
                    assert answer["ok"], answer
                else:
                    # It is Hermes's turn: its picture allows Herm and refuses Web.
                    await wait_for(lambda: plies() == ply - 1 and hermes_can_move(),
                                   what=f"Hermes's turn at ply {ply}")
                    assert not (await web_sees(ply - 1, False))["permissions"]["can_move"]
                    answer = await asyncio.to_thread(table.command, "move", [column])
                    assert answer["ok"], answer
                await wait_for(lambda: plies() == ply, what=f"ply {ply} on Hermes's table")
                plies_seen.append(plies())
            # Every ply landed, in order, on both tables.
            assert plies_seen == list(range(1, PLIES_TO_WIN + 1)), plies_seen

            # Both sides see the same ending: white's four in column one.
            web_final = await web_ws.until(
                lambda m: m.get("t") == "state" and m["picture"]["status"] == "win", timeout=8)
            hermes_final = await wait_for(lambda: picture().get("status") == "win" and picture(),
                                          what="the win on Hermes's table")
            assert web_final["picture"]["winner"] == "white", web_final["picture"]
            assert hermes_final["winner"] == "white", hermes_final
            assert web_final["picture"]["plies"] == PLIES_TO_WIN
            assert hermes_final["plies"] == PLIES_TO_WIN
            finished = snapshot()["finished"]
            assert finished, "OnlineTable.snapshot()['finished'] was not set"
            assert finished.get("winner") in (None, "white"), finished
            assert not hermes_can_move(), "Hermes could still move after the win"

            # The server's own record agrees with both pictures.
            state = server.rooms.state(server.store.room(room_id)) or {}
            assert state.get("status") == "win" and state.get("winner") == "white", state

            # Rule 7: no token reaches a table snapshot or the log.
            text = "\n".join(json.dumps(view) for view in seen_snapshots)
            assert seen_snapshots, "no snapshots were read"
            assert herm_token not in text, "Hermes's token reached a table snapshot"
            assert web_token not in text, "Web's token reached a table snapshot"
            assert '"token"' not in text
            assert herm_token not in caplog.text, "Hermes's token reached the log"
            assert web_token not in caplog.text, "Web's token reached the log"
        finally:
            if table:
                await asyncio.to_thread(table.close)
            for seat in sockets:
                with contextlib.suppress(Exception):
                    await seat.ws.close()
            await client.close()

    run(scenario())


def test_hermes_table_reconnects_without_resigning(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        table = None
        sockets = []
        try:
            web, web_token = await sign_in(client, "Web")
            herm, herm_token = await sign_in(client, "Herm")
            web_lobby = await open_lobby(client, web_token, "web")
            herm_lobby = await open_lobby(client, herm_token, "hermes")
            sockets += [web_lobby, herm_lobby]

            room_id = await ask_and_accept(
                client, web, web_token, herm, herm_token, web_lobby, herm_lobby)
            web_ws = await connect(client, room_id, web_token)
            sockets.append(web_ws)
            table = open_hermes_table(
                tmp_path, str(client.make_url("/")).rstrip("/"), herm_token, room_id)

            def snapshot():
                return table.snapshot()

            def picture():
                return snapshot().get("picture") or {}

            def hermes_can_move():
                return (picture().get("permissions") or {}).get("can_move") is True

            # Two moves: Web in column 1, Herm in column 2.
            await web_ws.result(1, t="cmd", action="move", args=["1"])
            await wait_for(lambda: picture().get("plies") == 1, what="ply 1")
            await wait_for(lambda: picture().get("plies") == 1 and hermes_can_move(),
                           what="Hermes's turn at ply 2")
            moved = await asyncio.to_thread(table.command, "move", ["2"])
            assert moved["ok"], moved
            await wait_for(lambda: picture().get("plies") == 2, what="ply 2")
            await web_ws.until(lambda m: m.get("t") == "state" and m["picture"]["plies"] == 2, timeout=8)

            # Force-close Hermes's own socket and watch the table recover on its own.
            sock = await wait_for(lambda: table._socket, what="Hermes's open socket")
            sock.close()

            states = []
            end = time.monotonic() + 15
            while time.monotonic() < end:
                states.append(snapshot().get("state"))
                if "reconnecting" in states and states[-1] == "live":
                    break
                await asyncio.sleep(0.05)
            assert "reconnecting" in states, f"the table never left 'live': {states[-6:]}"
            assert snapshot().get("state") == "live", f"the table did not come back: {states[-6:]}"
            await wait_for(lambda: picture().get("plies") == 2, what="the game after reconnecting")

            # Not resigned: the room kept the two plies and plays on from there.
            state = server.rooms.state(server.store.room(room_id)) or {}
            assert state.get("status") == "active", state
            assert int(state.get("plies") or 0) == 2, state
            assert not snapshot()["finished"], snapshot()["finished"]

            await web_ws.result(2, t="cmd", action="move", args=["1"])
            await wait_for(lambda: picture().get("plies") == 3, what="ply 3")
            await wait_for(lambda: picture().get("plies") == 3 and hermes_can_move(),
                           what="Hermes's turn at ply 4")
            again = await asyncio.to_thread(table.command, "move", ["2"])
            assert again["ok"], again
            await wait_for(lambda: picture().get("plies") == 4, what="ply 4")
            state = server.rooms.state(server.store.room(room_id)) or {}
            assert state.get("status") == "active" and int(state.get("plies") or 0) == 4, state
        finally:
            if table:
                await asyncio.to_thread(table.close)
            for seat in sockets:
                with contextlib.suppress(Exception):
                    await seat.ws.close()
            await client.close()

    run(scenario())
