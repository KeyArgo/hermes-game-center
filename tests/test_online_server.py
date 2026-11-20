"""Game Center Online over real HTTP and WebSockets: players, a spectator, chat, invites."""
from pathlib import Path
import asyncio
import json
import sys

from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from online.rooms import load_games  # noqa: E402
from online.server import App  # noqa: E402

LOADED = load_games()


def run(coro):
    return asyncio.run(coro)


async def started(tmp_path, clock=None):
    server = App(tmp_path, games=LOADED, **({} if clock is None else {"clock": clock}))
    client = TestClient(TestServer(server.build()))
    await client.start_server()
    return server, client


async def sign_in(client, name):
    response = await client.post("/api/session", json={"name": name})
    assert response.status == 200, await response.text()
    body = await response.json()
    return body["player"], body["token"]


async def open_room(client, token, **body):
    response = await client.post("/api/rooms", json={"game": "connect4", "public": True, **body},
                                 headers={"Authorization": f"Bearer {token}"})
    assert response.status == 200, await response.text()
    return await response.json()


class Seat:
    """One browser tab: a WebSocket plus everything the server has said to it."""

    def __init__(self, ws):
        self.ws = ws
        self.inbox = []

    async def until(self, test, timeout=3.0):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        for message in self.inbox:
            if test(message):
                return message
        while True:
            left = end - loop.time()
            assert left > 0, f"timed out; last messages: {self.inbox[-4:]}"
            raw = await self.ws.receive(timeout=left)
            if raw.type.name != "TEXT":
                raise AssertionError(f"socket ended: {raw.type}")
            message = json.loads(raw.data)
            self.inbox.append(message)
            if test(message):
                return message

    async def send(self, **message):
        await self.ws.send_str(json.dumps(message))

    async def result(self, ref, **message):
        await self.send(ref=ref, **message)
        return await self.until(lambda m: m.get("t") == "result" and m.get("ref") == ref)

    def latest_state(self):
        return [m for m in self.inbox if m.get("t") == "state"][-1]


async def connect(client, room_id, token, **extra):
    seat = Seat(await client.ws_connect(f"/ws/{room_id}"))
    await seat.send(t="auth", token=token, **extra)
    await seat.until(lambda m: m.get("t") in {"hello", "error", "closed"})
    return seat


def test_two_players_and_spectator_play_live(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            eve, eve_token = await sign_in(client, "Eve")
            room = (await open_room(client, ada_token))["room"]
            a = await connect(client, room["id"], ada_token)
            b = await connect(client, room["id"], bea_token)
            e = await connect(client, room["id"], eve_token)
            joined = await b.result(1, t="cmd", action="join")
            assert joined["ok"], joined
            await e.until(lambda m: m.get("t") == "state" and m["picture"]["seats"][1]["id"] == bea["id"])
            # The spectator tries to move and is refused; the board does not change.
            refused = await e.result(2, t="cmd", action="move", args=["4"])
            assert not refused["ok"]
            moved = await a.result(3, t="cmd", action="move", args=["4"])
            assert moved["ok"], moved
            seen = await e.until(lambda m: m.get("t") == "state" and m["picture"]["plies"] == 1)
            assert seen["picture"]["moves"] == ["4"] and not seen["picture"]["permissions"]["can_move"]
            bea_view = await b.until(lambda m: m.get("t") == "state" and m["picture"]["plies"] == 1)
            assert bea_view["picture"]["permissions"]["can_move"]
            # Chat reaches everyone, tagged with the sender's role.
            said = await e.result(4, t="chat", text="nice opening")
            assert said["ok"]
            heard = await a.until(lambda m: m.get("t") == "chat")
            assert heard["message"]["name"] == "Eve" and heard["message"]["role"] == "watcher"
            def roles(message):
                return {person["name"]: person["role"] for person in message.get("people", [])}
            await a.until(lambda m: m.get("t") == "presence"
                          and roles(m) == {"Ada": "player", "Bea": "player", "Eve": "watcher"})
            # Finish by resignation; the result reaches the spectator and the record exists.
            done = await b.result(5, t="cmd", action="resign")
            assert done["finished"]["winner"] == "white" and not done["finished"]["rated"]  # 1 ply: unrated
            over = await e.until(lambda m: m.get("t") == "state" and m["picture"]["status"] == "resigned")
            assert over["matches"][0]["winner"] == "white"
            for seat in (a, b, e):
                await seat.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_private_invite_link_seats_friend_on_connect(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            eve, eve_token = await sign_in(client, "Eve")
            made = await open_room(client, ada_token, public=False)
            code = made["invites"]["black"]
            lobby = await (await client.get("/api/lobby")).json()
            assert lobby["rooms"] == []  # private tables are unlisted
            e = await connect(client, made["room"]["id"], eve_token)
            assert not (await e.result(1, t="cmd", action="join"))["ok"]
            b = await connect(client, made["room"]["id"], bea_token, invite=code)
            await b.until(lambda m: m.get("t") == "state" and m["picture"]["seats"][1]["id"] == bea["id"])
            reused = await e.result(2, t="redeem", code=code)
            assert not reused["ok"]
            again = await connect(client, made["room"]["id"], eve_token, invite=code)
            refused = await again.until(lambda m: m.get("t") == "result" and m.get("ref") == "invite")
            assert not refused["ok"] and "already used" in refused["text"]
            await again.ws.close()
            await b.ws.close()
            await e.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_auth_required_and_bad_input_rejected(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            room = (await open_room(client, ada_token))["room"]
            nobody = await connect(client, room["id"], "not-a-token")
            assert nobody.inbox[-1]["t"] == "error"
            assert (await client.post("/api/rooms", json={"game": "connect4"})).status == 401
            assert (await client.post("/api/session", json={"name": "admin"})).status == 400
            assert (await client.post("/api/session", json={"name": "<b>x</b>"})).status == 400
            bad = await client.post("/api/rooms", json={"game": "doom"}, headers={"Authorization": f"Bearer {ada_token}"})
            assert bad.status == 400
            missing = await connect(client, "nope", ada_token)
            assert missing.inbox[-1]["t"] == "closed"
            a = await connect(client, room["id"], ada_token)
            await a.ws.send_str("not json")
            await a.ws.send_str(json.dumps([1, 2]))
            ok = await a.result(1, t="ping-unknown")
            assert not ok["ok"]
            await a.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_chat_limits_and_mute(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            eve, eve_token = await sign_in(client, "Eve")
            room = (await open_room(client, ada_token))["room"]
            a = await connect(client, room["id"], ada_token)
            e = await connect(client, room["id"], eve_token)
            assert not (await e.result(1, t="chat", text="x" * 400))["ok"]
            answers = [await e.result(10 + i, t="chat", text=f"hi {i}") for i in range(6)]
            assert [item["ok"] for item in answers] == [True] * 4 + [False, False]  # 5 per 10 s; the refused long message used one
            assert (await a.result(30, t="mute", player_id=eve["id"]))["ok"]
            server.chat_limit.events.clear()
            muted = await e.result(31, t="chat", text="still here")
            assert not muted["ok"] and "muted" in muted["text"]
            assert not (await e.result(32, t="mute", player_id=ada["id"]))["ok"]
            await a.ws.close()
            await e.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_removed_person_cannot_return_and_close_kicks_everyone(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            eve, eve_token = await sign_in(client, "Eve")
            room = (await open_room(client, ada_token))["room"]
            a = await connect(client, room["id"], ada_token)
            e = await connect(client, room["id"], eve_token)
            assert (await a.result(1, t="remove", player_id=eve["id"]))["ok"]
            await e.until(lambda m: m.get("t") == "closed")
            again = await connect(client, room["id"], eve_token)
            assert again.inbox[-1]["t"] == "closed"
            assert (await a.result(2, t="close"))["ok"]
            await a.until(lambda m: m.get("t") == "closed")
            later = await connect(client, room["id"], ada_token)
            assert later.inbox[-1]["t"] == "closed"
        finally:
            await client.close()
    run(scenario())


def test_pages_and_assets_are_served_with_csp(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            for path in ("/", "/t/abc", "/b/bot:abc"):
                page = await client.get(path)
                assert page.status == 200
                assert "sha256-" in page.headers["Content-Security-Policy"]
                assert "importmap" in await page.text()
            for path in ("/app.js", "/board.js", "/sdk-shim.js", "/vendor/react.mjs", "/style.css"):
                asset = await client.get(path)
                assert asset.status == 200, path
            assert (await client.get("/vendor/../online.sqlite3")).status in {403, 404}
            games = await (await client.get("/api/games")).json()
            ids = [g["id"] for g in games["games"]]
            assert ids[:5] == ["connect4", "reversi", "checkers", "gomoku", "chessboard"]
            assert {"chessboard", "go", "hex"} <= set(ids)
        finally:
            await client.close()
    run(scenario())


def test_names_are_unique_ignoring_case(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            assert (await client.post("/api/session", json={"name": "ada"})).status == 409
            taken = await client.post("/api/me", json={"name": "ADA"}, headers={"Authorization": f"Bearer {bea_token}"})
            assert taken.status == 409
            same = await client.post("/api/me", json={"name": "ada"}, headers={"Authorization": f"Bearer {ada_token}"})
            assert same.status == 200 and (await same.json())["player"]["name"] == "ada"
        finally:
            await client.close()
    run(scenario())


def test_pending_socket_cap_and_removed_address_blocked(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            eve, eve_token = await sign_in(client, "Eve")
            room = (await open_room(client, ada_token))["room"]
            server.pending["127.0.0.1"] = 20  # as if 20 sockets were waiting to sign in
            refused = await client.get(f"/ws/{room['id']}")
            assert refused.status == 429
            server.pending.clear()
            a = await connect(client, room["id"], ada_token)
            e = await connect(client, room["id"], eve_token)
            # Same machine in tests, so pretend Eve came from another address.
            next(conn for conn in server.conns[room["id"]] if conn.player["id"] == eve["id"]).ip = "203.0.113.9"
            assert (await a.result(1, t="remove", player_id=eve["id"]))["ok"]
            assert server.blocked[room["id"]] == {"203.0.113.9": server.blocked[room["id"]]["203.0.113.9"]}
            await a.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_a_decline_and_a_sweep_close_the_sockets(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            _ada, ada_token = await sign_in(client, "Ada")
            _bea, bea_token = await sign_in(client, "Bea")
            room = (await open_room(client, ada_token))["room"]
            a = await connect(client, room["id"], ada_token)
            b = await connect(client, room["id"], bea_token)
            assert (await b.result(1, t="cmd", action="join"))["ok"]
            assert (await a.result(2, t="cmd", action="resign"))["ok"]
            assert (await a.result(3, t="cmd", action="rematch"))["ok"]
            waiting = asyncio.create_task(a.until(lambda m: m.get("t") == "closed"))
            answer = await b.result(4, t="cmd", action="decline")
            assert answer["ok"]
            closed = await waiting
            assert closed["text"] == "Bea declined a rematch."
            raw = await a.ws.receive(timeout=2)
            assert raw.type.name != "TEXT", raw.data

            room2 = (await open_room(client, ada_token))["room"]
            a2 = await connect(client, room2["id"], ada_token)
            b2 = await connect(client, room2["id"], bea_token)
            assert (await b2.result(1, t="cmd", action="join"))["ok"]
            assert (await a2.result(2, t="cmd", action="resign"))["ok"]
            state = server.rooms.state(room2)
            state["finished_at"] = server.rooms.clock() - 400
            from kit import write as kit_write
            kit_write(server.rooms.folder(room2["id"]), state)
            waiting2 = asyncio.create_task(a2.until(lambda m: m.get("t") == "closed"))
            await server.close_finished(server.rooms.clock())
            swept = await waiting2
            assert "closed" in swept["text"].lower()
            raw2 = await a2.ws.receive(timeout=2)
            assert raw2.type.name != "TEXT", raw2.data
        finally:
            await client.close()
    run(scenario())


def test_the_janitor_unseats_a_quiet_table(tmp_path):
    """The periodic sweep is the disconnect grace: still seated at 44s, gone at 46s."""
    async def scenario():
        import time
        now = {"t": time.time()}
        server, client = await started(tmp_path, clock=lambda: now["t"])
        seen = []
        original = server.sweep_disconnects

        async def wrapped(moment):
            seen.append(moment)
            return await original(moment)

        server.sweep_disconnects = wrapped
        task = asyncio.create_task(server.janitor(None))
        try:
            for _ in range(20):
                if seen:
                    break
                await asyncio.sleep(0.05)
            assert seen, "the janitor runs the disconnect sweep on its own cadence"
            ada, ada_token = await sign_in(client, "Ada")
            _bea, bea_token = await sign_in(client, "Bea")
            _eve, eve_token = await sign_in(client, "Eve")
            room = (await open_room(client, ada_token))["room"]
            a = await connect(client, room["id"], ada_token)
            b = await connect(client, room["id"], bea_token)
            eve = await connect(client, room["id"], eve_token)
            assert (await b.result(1, t="cmd", action="join"))["ok"]
            await a.ws.close()
            await b.ws.close()
            await asyncio.sleep(0.05)
            now["t"] += 44
            await server.sweep_disconnects(now["t"])
            state = server.rooms.state(server.store.room(room["id"]))
            assert state["white_id"] == ada["id"] and state["black_id"]
            now["t"] += 2
            waiting = asyncio.create_task(eve.until(lambda m: m.get("t") == "closed"))
            await server.sweep_disconnects(now["t"])
            closed = await waiting
            assert closed["t"] == "closed"
            assert server.store.room(room["id"])["closed"] == 1
            rows = server.store.db.execute(
                "SELECT reason FROM audit WHERE target_id = ?", (room["id"],)).fetchall()
            assert any(row["reason"] == "empty" for row in rows)
        finally:
            task.cancel()
            await client.close()
    run(scenario())


def test_a_dying_socket_cannot_stake_a_blackjack_hand(tmp_path):
    """A move arriving for a socket that is no longer live is rejected."""
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            _bea, bea_token = await sign_in(client, "Bea")
            room = (await open_room(client, ada_token, game="blackjack"))["room"]
            a = await connect(client, room["id"], ada_token)
            b = await connect(client, room["id"], bea_token)
            assert (await b.result(1, t="cmd", action="join"))["ok"]
            conn = next(c for c in server.conns[room["id"]] if c.player["id"] == ada["id"])
            # Simulate a dying socket already dropped from live table presence.
            server.rooms.disconnected(room["id"], ada["id"])
            await server.handle(conn, {"t": "cmd", "action": "move", "args": ["bet1000"], "ref": 9})
            res = await a.until(lambda m: m.get("t") == "result" and m.get("ref") == 9)
            assert res["ok"] is False, res
            state = server.rooms.state(server.store.room(room["id"]))
            assert not state.get("mid_round")
            assert state["stacks"] == [10000, 10000]
            await a.ws.close()
            await b.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_leave_and_disconnect_eviction_broadcast_notice_and_persist_it_in_picture(tmp_path):
    """Explicit leave and disconnect-grace eviction both emit a notice frame and store it in picture."""
    async def scenario():
        import time
        now = {"t": time.time()}
        server, client = await started(tmp_path, clock=lambda: now["t"])
        try:
            ada, ada_token = await sign_in(client, "Ada")
            _locutus, loc_token = await sign_in(client, "Locutus")

            # 1. Explicit leave on blackjack.
            room1 = (await open_room(client, ada_token, game="blackjack"))["room"]
            a1 = await connect(client, room1["id"], ada_token)
            l1 = await connect(client, room1["id"], loc_token)
            assert (await l1.result(1, t="cmd", action="join"))["ok"]
            waiting = asyncio.create_task(a1.until(lambda m: m.get("t") == "notice"))
            assert (await l1.result(2, t="cmd", action="leave"))["ok"]
            notice = await waiting
            assert notice["t"] == "notice"
            assert notice["kind"] == "left"
            assert notice["name"] == "Locutus"
            assert notice["text"] == "Locutus left the table."
            pic1 = server.rooms.picture(server.store.room(room1["id"]), ada["id"])
            assert pic1["table_notice"]["kind"] == "left"
            assert pic1["table_notice"]["name"] == "Locutus"
            assert pic1["table_notice"]["text"] == "Locutus left the table."
            assert pic1.get("note") == "Locutus left the table."
            await a1.ws.close()
            await l1.ws.close()

            # 2. Disconnect grace eviction on blackjack.
            room2 = (await open_room(client, ada_token, game="blackjack"))["room"]
            a2 = await connect(client, room2["id"], ada_token)
            l2 = await connect(client, room2["id"], loc_token)
            assert (await l2.result(1, t="cmd", action="join"))["ok"]
            assert (await a2.result(2, t="cmd", action="move", args=["bet1000"]))["ok"]
            await l2.ws.close()
            await asyncio.sleep(0.05)
            now["t"] += 44
            assert await server.sweep_disconnects(now["t"]) == []
            now["t"] += 2
            waiting2 = asyncio.create_task(a2.until(lambda m: m.get("t") == "notice"))
            await server.sweep_disconnects(now["t"])
            notice2 = await waiting2
            assert notice2["t"] == "notice"
            assert notice2["kind"] == "disconnected"
            assert notice2["name"] == "Locutus"
            assert notice2["text"] == "Locutus left the table."
            pic2 = server.rooms.picture(server.store.room(room2["id"]), ada["id"])
            assert pic2["table_notice"]["kind"] == "disconnected"
            assert pic2["table_notice"]["name"] == "Locutus"
            assert pic2["table_notice"]["text"] == "Locutus left the table."
            assert pic2.get("note") == "Locutus left the table."
            await a2.ws.close()
        finally:
            await client.close()
    run(scenario())
