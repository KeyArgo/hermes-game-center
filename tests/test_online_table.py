"""A person plays the real online room through the plugin socket."""
import asyncio
import json
import time

from shelf.online_source import Online
from shelf.online_table import OnlineTable
from test_online_server import started, sign_in, open_room, connect, run


async def wait_for(test, timeout=4):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = test()
        if value:
            return value
        await asyncio.sleep(.03)
    raise AssertionError("timed out waiting for table")


def test_person_plays_and_close_does_not_resign(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        table = None
        try:
            ada, token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            room = (await open_room(client, token))["room"]
            other = await connect(client, room["id"], bea_token)
            assert (await other.result(1, t="cmd", action="join"))["ok"]
            source = Online(tmp_path / "plugin", url=str(client.make_url('/')).rstrip('/'), secret=lambda _: token)
            table = OnlineTable(source)
            assert not table.open(room["id"])["ok"]
            source.turn_on()
            assert table.open(room["id"])["ok"]
            view = await wait_for(lambda: table.snapshot() if (table.snapshot().get("picture") or {}).get("permissions", {}).get("can_move") else None)
            assert view["side"] == "white" and view["opponent"]["name"] == "Bea"
            serialized = json.dumps(view)
            assert token not in serialized and '"token"' not in serialized
            moved = await asyncio.to_thread(table.command, "move", ["4"])
            assert moved["ok"], moved
            await wait_for(lambda: (table.snapshot().get("picture") or {}).get("plies") == 1)
            seen = await other.until(lambda m: m.get("t") == "state" and m["picture"]["plies"] == 1)
            assert seen["picture"]["moves"] == ["4"]
            illegal = await asyncio.to_thread(table.command, "move", ["99"])
            assert not illegal["ok"]
            await asyncio.to_thread(table.close)
            assert server.rooms.state(server.store.room(room["id"]))["status"] == "active"
            assert server.rooms.state(server.store.room(room["id"]))["plies"] == 1
            await other.ws.close()
        finally:
            if table:
                await asyncio.to_thread(table.close)
            await client.close()
    run(scenario())


def test_off_refuses_without_socket(tmp_path, monkeypatch):
    from shelf import online_table
    source = Online(tmp_path, url="http://example.test", secret=lambda _: "secret")
    monkeypatch.setattr(online_table.wsmod, "Socket", lambda *a, **k: (_ for _ in ()).throw(AssertionError("socket opened")))
    table = OnlineTable(source)
    assert table.open("room")["ok"] is False
    assert table.snapshot() == {}
    assert table.command([], [])["ok"] is False


def test_socket_worker_authenticates_and_correlates_results(tmp_path, monkeypatch):
    import queue
    from shelf import online_table

    class FakeSocket:
        def __init__(self, address, timeout):
            self.inbox = queue.Queue()
            self.sent = []
            sockets.append(self)
        def send_json(self, message):
            self.sent.append(message)
            if message["t"] == "auth":
                self.inbox.put({"t": "hello", "me": {"id": "a"}, "room": {"id": "r"}})
                self.inbox.put({"t": "state", "room": {"id": "r"}, "picture": {"seats": [{"id": "a", "side": "white"}, {"id": "b", "name": "Bea", "side": "black"}], "status": "active"}})
            else:
                self.inbox.put({"t": "result", "ref": message["ref"], "ok": True, "text": "Moved."})
        def receive(self, timeout):
            try:
                return self.inbox.get(timeout=timeout)
            except queue.Empty:
                return None
        def close(self):
            pass

    sockets = []
    monkeypatch.setattr(online_table.wsmod, "Socket", FakeSocket)
    source = Online(tmp_path, url="http://example.test", secret=lambda _: "person-secret")
    source.turn_on()
    table = OnlineTable(source)
    try:
        assert table.open("r")["ok"]
        deadline = time.monotonic() + 2
        while not table.snapshot().get("picture") and time.monotonic() < deadline:
            time.sleep(.01)
        assert table.snapshot()["side"] == "white"
        assert "person-secret" not in json.dumps(table.snapshot())
        answer = table.command("move", ["4"])
        assert answer["ok"] and answer["text"] == "Moved."
        assert sockets[0].sent == [{"t": "auth", "token": "person-secret"},
                                   {"t": "cmd", "action": "move", "args": ["4"], "ref": 1}]
    finally:
        table.close()


def test_say_sends_the_one_chat_frame_and_caps_it(tmp_path, monkeypatch):
    """The frame a message goes out as, and the cap, without a server in the way."""
    import queue
    from shelf import online_table

    class QuietSocket:
        def __init__(self, address, timeout):
            self.inbox = queue.Queue()
            self.sent = []

        def send_json(self, message):
            self.sent.append(message)
            if message["t"] == "auth":
                self.inbox.put({"t": "hello", "me": {"id": "a"}, "room": {"id": "r"}})

        def receive(self, timeout):
            try:
                return self.inbox.get(timeout=timeout)
            except queue.Empty:
                return None

        def close(self):
            pass

    sockets = []
    monkeypatch.setattr(online_table.wsmod, "Socket", lambda address, timeout: sockets.append(QuietSocket(address, timeout)) or sockets[-1])
    source = Online(tmp_path, url="http://example.test", secret=lambda _: "person-secret")
    source.turn_on()
    table = OnlineTable(source)
    try:
        # Nothing said before the table is there: the socket would drop it.
        assert not table.say("nobody is at the table")["ok"]
        assert table.open("r")["ok"]
        deadline = time.monotonic() + 2
        while table.snapshot().get("state") != "live" and time.monotonic() < deadline:
            time.sleep(.01)
        assert table.say("good luck")["ok"]
        assert table.say("x" * 400)["ok"]
        assert table.say("   ")["ok"] is False and table.say(None)["ok"] is False
        deadline = time.monotonic() + 2
        while len(sockets[0].sent) < 3 and time.monotonic() < deadline:
            time.sleep(.01)
        said = [frame for frame in sockets[0].sent if frame["t"] == "chat"]
        assert said == [{"t": "chat", "text": "good luck"}, {"t": "chat", "text": "x" * 300}], said
    finally:
        table.close()


def test_two_people_chat_through_a_real_server(tmp_path):
    """Bea's messages reach the table, the table's reach Bea, and the table keeps the last 50."""
    async def scenario():
        server, client = await started(tmp_path / "server")
        table = None
        try:
            ada, token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            room = (await open_room(client, token))["room"]
            other = await connect(client, room["id"], bea_token)
            assert (await other.result(1, t="cmd", action="join"))["ok"]
            # Something said before the table opens is in the hello frame, not lost.
            assert (await other.result(2, t="chat", text="before you joined"))["ok"]
            source = Online(tmp_path / "plugin", url=str(client.make_url('/')).rstrip('/'), secret=lambda _: token)
            source.turn_on()
            table = OnlineTable(source)
            assert table.open(room["id"])["ok"]
            hello = await wait_for(lambda: table.snapshot() if table.snapshot().get("state") == "live" else None)
            assert [m["text"] for m in hello["chat"]] == ["before you joined"]
            # Their messages arrive on the table's feed, named and with their role.
            assert (await other.result(3, t="chat", text="Good luck!"))["ok"]
            heard = await wait_for(lambda: next((m for m in table.snapshot()["chat"] if m["text"] == "Good luck!"), None))
            assert heard["name"] == "Bea" and heard["role"] == "player"
            # This table's own message goes out as the server's chat frame...
            assert table.say("Thanks — you too")["ok"]
            seen = await other.until(lambda m: m.get("t") == "chat" and m["message"]["text"] == "Thanks — you too")
            assert seen["message"]["name"] == "Ada"
            # ...and comes back here through the table's own feed, never drawn by hand.
            await wait_for(lambda: any(m["text"] == "Thanks — you too" for m in table.snapshot()["chat"]))
            # The cap is the server's own 300 characters.
            assert table.say("y" * 400)["ok"]
            capped = await other.until(lambda m: m.get("t") == "chat" and m["message"]["text"].startswith("yyyy"))
            assert capped["message"]["text"] == "y" * 300
            # Empty is refused here, and nothing reaches the room.
            before = len(server.store.recent_chat(room["id"], 100))
            assert table.say("   ") == {"ok": False, "text": "Type a message."}
            assert len(server.store.recent_chat(room["id"], 100)) == before
            # A message the server itself turns down comes back in its own words, with the text it
            # refused kept, so the panel can say so and put the words back.
            server.cmd_limit.events.clear()
            server.chat_limit.events.clear()
            for number in range(5):
                assert table.say(f"one of many {number}")["ok"]
            assert table.say("the sixth in ten seconds")["ok"]  # the shelf sends it; the server decides
            turned_down = await wait_for(lambda: table.snapshot().get("chat_error"))
            assert turned_down["text"] == "You are sending messages too fast."
            assert turned_down["sent"] == "the sixth in ten seconds"
            assert len(server.store.recent_chat(room["id"], 100)) == before + 5
            # The table keeps the last 50, not everything ever said.
            for number in range(55):
                server.cmd_limit.events.clear()
                server.chat_limit.events.clear()
                assert (await other.result(100 + number, t="chat", text=f"line {number}"))["ok"]
            await wait_for(lambda: len(table.snapshot()["chat"]) == 50
                           and table.snapshot()["chat"][-1]["text"] == "line 54")
            kept = table.snapshot()["chat"]
            assert [kept[0]["text"], kept[-1]["text"]] == ["line 5", "line 54"]
            await other.ws.close()
        finally:
            if table:
                await asyncio.to_thread(table.close)
            await client.close()
    run(scenario())

