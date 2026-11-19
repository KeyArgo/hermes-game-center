"""The #games chat on the Games page, shared online (owner, 2026-11-18: "I cannot see what the
other types in the room"). Two PCs, each signed in, against a real local lobby server: what one
types, the other reads. Signed out, the chat stays on this computer and says so."""
import asyncio
import time

from shelf.online_source import Online
from test_online_server import started, sign_in, run


def _pc(folder, base, token):
    source = Online(folder, url=base, secret=lambda _name: token)
    source.turn_on()
    return source


def test_what_one_pc_types_in_the_lobby_the_other_pc_reads(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            _wren, wren_token = await sign_in(client, "bluewren")
            _loc, loc_token = await sign_in(client, "Locutus")
            base = str(client.make_url("/")).rstrip("/")
            one = _pc(tmp_path / "pc-one", base, wren_token)
            two = _pc(tmp_path / "pc-two", base, loc_token)

            said = await asyncio.to_thread(one.say_lobby, "hi from levy9")
            assert said["ok"] is True, said
            lines = await asyncio.to_thread(two.lobby_lines, force=True)
            assert [(l["name"], l["text"]) for l in lines][-1:] == [("bluewren", "hi from levy9")], lines

            said = await asyncio.to_thread(two.say_lobby, "hi back")
            assert said["ok"] is True, said
            lines = await asyncio.to_thread(one.lobby_lines, force=True)
            assert [l["text"] for l in lines][-2:] == ["hi from levy9", "hi back"], lines
            assert all(l["at"] > 0 for l in lines), "every line carries when it was written"
        finally:
            await client.close()
    run(scenario())


def test_a_refused_or_unsent_lobby_line_says_why(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            _p, token = await sign_in(client, "bluewren")
            base = str(client.make_url("/")).rstrip("/")
            one = _pc(tmp_path / "pc-one", base, token)
            empty = await asyncio.to_thread(one.say_lobby, "   ")
            assert empty["ok"] is False and empty["text"], empty
        finally:
            await client.close()
        gone = await asyncio.to_thread(one.say_lobby, "anyone?")
        assert gone["ok"] is False and "not answering" in gone["text"], gone
    run(scenario())


def test_signed_out_there_is_no_online_chat(tmp_path):
    one = Online(tmp_path / "pc", url="http://127.0.0.1:9", secret=lambda _name: "")
    one.turn_on()
    assert one.lobby_lines(force=True) == []
    answer = one.say_lobby("hi")
    assert answer["ok"] is False and "Sign in" in answer["text"], answer


def test_the_games_page_chat_goes_to_the_lobby_when_signed_in(monkeypatch, tmp_path):
    """The page's own door: "chat say …" posts to the lobby, and the #games column reads the
    lobby's lines and says they are shared. Signed out, both stay on this computer."""
    from dashboard import plugin_api

    class FakeSource:
        def __init__(self, signed_in):
            self.signed_in = signed_in
            self.said = []

        def chat_shared(self):
            return self.signed_in

        def say_lobby(self, text):
            self.said.append(text)
            return {"ok": True, "text": "Sent to the lobby."}

        def lobby_lines(self):
            return [{"id": "1", "name": "bluewren", "text": "hi from levy9", "at": time.time()}]

        def chat_reached(self):
            return True

    online = FakeSource(True)
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (online, None))
    answer = plugin_api.command({"line": "chat say hello there"})
    assert answer == {"ok": True, "text": "Sent to the lobby."}, answer
    assert online.said == ["hello there"]
    lobby = plugin_api._lobby_payload(tmp_path)
    assert lobby["shared"] is True and lobby["reached"] is True
    assert [l["text"] for l in lobby["lines"]] == ["hi from levy9"]

    local = FakeSource(False)
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (local, None))
    assert plugin_api._lobby_say("chat say hello") is None, "signed out, the line stays on this computer"
    assert plugin_api._lobby_payload(tmp_path)["shared"] is False
    assert local.said == []


def test_check_online_walks_every_step_and_names_who_the_hall_lists(tmp_path):
    """Check online, against a real lobby: server, key, account, chat, then the Hall listing the
    other PC. Each failure says which step and what to do."""
    from shelf.online_hall import Hall

    async def scenario():
        server, client = await started(tmp_path / "server")
        hall = None
        try:
            _w, wren_token = await sign_in(client, "bluewren")
            base = str(client.make_url("/")).rstrip("/")
            one = _pc(tmp_path / "pc-one", base, wren_token)
            await asyncio.to_thread(one.say_lobby, "hi")
            steps = await asyncio.to_thread(one.check)
            assert [s["name"] for s in steps] == ["Online play", "Server", "Signed in", "Account", "Lobby chat"], steps
            assert all(s["ok"] for s in steps), steps
            assert "bluewren" in steps[3]["text"], steps
            assert wren_token not in str(steps), "the check never shows the key"

            stranger = _pc(tmp_path / "pc-two", base, "not-a-real-key")
            steps = await asyncio.to_thread(stranger.check)
            assert steps[-1]["name"] == "Account" and steps[-1]["ok"] is False, steps
            assert "I have a player" in steps[-1]["text"], steps
        finally:
            await client.close()
        steps = await asyncio.to_thread(one.check)
        assert steps[-1]["name"] == "Server" and steps[-1]["ok"] is False, steps
        assert "not answering" in steps[-1]["text"], steps
    run(scenario())


def test_check_online_route_adds_the_hall_and_who_is_there(monkeypatch):
    from dashboard import plugin_api

    class FakeSource:
        on = True

        def check(self):
            return [{"name": "Online play", "ok": True, "text": "On."},
                    {"name": "Account", "ok": True, "text": "The lobby knows you as bluewren."}]

    class FakeHall:
        def start(self):
            pass

        def snapshot(self):
            return {"state": "live", "you": {"name": "bluewren", "invisible": False},
                    "roster": [{"id": "p2", "name": "Locutus"}]}

    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (FakeSource(), None))
    monkeypatch.setattr(plugin_api, "_online_hall", lambda _s: FakeHall())
    answer = plugin_api.command({"line": "online check"})
    assert answer["ok"] is True, answer
    assert "OK   The Hall: Connected as bluewren. Also here: Locutus." in answer["text"], answer
