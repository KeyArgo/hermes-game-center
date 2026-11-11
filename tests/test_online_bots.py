"""Registered bots on Game Center Online: accounts, where they may sit, badges, never rated, switch-off."""
from pathlib import Path
import asyncio
import importlib.util
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("online_server_helpers", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in, open_room, connect = helpers.run, helpers.started, helpers.sign_in, helpers.open_room, helpers.connect

from online.store import Store  # noqa: E402


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def make_bot(client, token, name="Robo"):
    response = await client.post("/api/bots", json={"name": name}, headers=auth(token))
    assert response.status == 200, await response.text()
    body = await response.json()
    return body["bot"], body["key"]


def test_bot_accounts_owner_limits(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            bot, key = await make_bot(client, token)
            assert bot["bot"] and bot["owner_id"] == ada["id"] and bot["id"].startswith("bot:")
            listed = await (await client.get("/api/bots", headers=auth(token))).json()
            assert [b["name"] for b in listed["bots"]] == ["Robo"]
            # A bot cannot own bots, host tables, or take a used name.
            assert (await client.post("/api/bots", json={"name": "Robo2"}, headers=auth(key))).status == 403
            hosted = await client.post("/api/rooms", json={"game": "connect4"}, headers=auth(key))
            assert hosted.status == 400
            assert (await client.post("/api/bots", json={"name": "Ada"}, headers=auth(token))).status == 409
            await make_bot(client, token, "Robo2")
            await make_bot(client, token, "Robo3")
            assert (await client.post("/api/bots", json={"name": "Robo4"}, headers=auth(token))).status == 400
            # Someone else cannot switch Ada's bot off.
            bea, bea_token = await sign_in(client, "Bea")
            assert (await client.delete(f"/api/bots/{bot['id']}", headers=auth(bea_token))).status == 404
            assert (await client.delete(f"/api/bots/{bot['id']}", headers=auth(token))).status == 200
            assert (await client.get("/api/me", headers=auth(key))).status == 401
        finally:
            await client.close()
    run(scenario())


def test_bot_sits_only_where_welcome(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            bot, key = await make_bot(client, token)
            plain = (await open_room(client, token))["room"]
            assert not plain["bots_ok"]
            b = await connect(client, plain["id"], key)
            refused = await b.result(1, t="cmd", action="join")
            assert not refused["ok"] and "does not take bots" in refused["text"]
            await b.ws.close()

            welcome = (await open_room(client, token, bots=True))["room"]
            assert welcome["bots_ok"]
            b = await connect(client, welcome["id"], key)
            joined = await b.result(2, t="cmd", action="join")
            assert joined["ok"], joined
            state = await b.until(lambda m: m.get("t") == "state" and m["picture"]["seats"][1]["id"] == bot["id"])
            assert state["picture"]["seats"][1]["bot"] and state["room"]["seats"][1]["bot"]
            presence = await b.until(lambda m: m.get("t") == "presence" and any(p["id"] == bot["id"] for p in m["people"]))
            assert next(p for p in presence["people"] if p["id"] == bot["id"])["bot"]
            said = await b.result(3, t="chat", text="hello")
            assert not said["ok"]
            # A finished human-vs-bot match is never rated.
            a = await connect(client, welcome["id"], token)
            for ref, (seat, move) in enumerate([(a, "1"), (b, "2"), (a, "1"), (b, "2"), (a, "1"), (b, "2")], start=10):
                assert (await seat.result(ref, t="cmd", action="move", args=[move]))["ok"]
            done = await a.result(20, t="cmd", action="move", args=["1"])
            assert done["finished"] and done["finished"]["winner"] == "white" and not done["finished"]["rated"]
            for seat in (a, b):
                await seat.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_invite_link_seats_a_bot_and_switch_off_kicks_it(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            bot, key = await make_bot(client, token)
            made = await open_room(client, token, public=False)
            code = made["invites"]["black"]
            b = await connect(client, made["room"]["id"], key, invite=code)
            await b.until(lambda m: m.get("t") == "state" and m["picture"]["seats"][1]["id"] == bot["id"])
            await client.delete(f"/api/bots/{bot['id']}", headers=auth(token))
            closed = await b.until(lambda m: m.get("t") == "closed")
            assert "switched off" in closed["text"]
        finally:
            await client.close()
    run(scenario())


def test_old_database_gets_the_new_columns(tmp_path):
    path = tmp_path / "old.sqlite3"
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE players (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
            public INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, seen REAL NOT NULL);
        CREATE TABLE rooms (id TEXT PRIMARY KEY, game TEXT NOT NULL, host_id TEXT NOT NULL,
            public INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, active REAL NOT NULL,
            closed INTEGER NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0);
        INSERT INTO players VALUES ('web:old', 'h', 'Oldtimer', 1, 0, 0);
    """)
    db.commit()
    db.close()
    store = Store(path)
    old = store.player("web:old")
    assert old["name"] == "Oldtimer" and old["bot"] is False and old["owner_id"] == ""
    assert store.create_room("connect4", "web:old", True, bots_ok=True)["bots_ok"] == 1
    store.close()
    Store(path).close()  # a second start does not try to add them again


def test_parallel_bot_requests_respect_the_limit(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            answers = await asyncio.gather(*[client.post("/api/bots", json={"name": f"Par{i}"}, headers=auth(token)) for i in range(6)])
            assert sum(answer.status == 200 for answer in answers) == 3
            assert len(server.store.bots_of(ada["id"])) == 3
        finally:
            await client.close()
    run(scenario())
