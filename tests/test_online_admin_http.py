"""Admin and moderation over real HTTP: roles, the two keys, every power, undo."""
import asyncio
import json
import sys
import time
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from online.rooms import load_games  # noqa: E402
from online.server import App  # noqa: E402
from online.store import token_hash  # noqa: E402

LOADED = load_games()


def run(coro):
    return asyncio.run(coro)


async def started(tmp_path):
    server = App(tmp_path, games=LOADED)
    client = TestClient(TestServer(server.build()))
    await client.start_server()
    return server, client


async def sign_in(client, name, key=None):
    body = {"name": name}
    if key:
        body["key"] = key
    response = await client.post("/api/session", json=body)
    return response, (await response.json())


def make_staff(server, player, role, key):
    server.store.set_staff(player["id"], role, token_hash(key), "test")


def headers(token, staff_key=""):
    out = {"Authorization": f"Bearer {token}"}
    if staff_key:
        out["X-Staff-Key"] = staff_key
    return out


async def act(client, token, key, **body):
    response = await client.post("/api/admin/action", json=body, headers=headers(token, key))
    return response, await response.json()


async def with_roles(tmp_path):
    """An owner, an admin, a moderator and a plain player, all signed in."""
    server, client = await started(tmp_path)
    people = {}
    for name in ("Alice", "Bob", "Carol", "Dave"):
        response, body = await sign_in(client, name)
        assert response.status == 200, await response.text()
        people[name] = {"player": body["player"], "token": body["token"]}
    make_staff(server, people["Alice"]["player"], "owner", "owner-key")
    make_staff(server, people["Bob"]["player"], "admin", "admin-key")
    make_staff(server, people["Carol"]["player"], "moderator", "mod-key")
    return server, client, people


def test_admin_gate_needs_both_keys(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        no_key = await client.get("/api/admin/me", headers=headers(people["Alice"]["token"]))
        assert no_key.status == 401
        wrong = await client.get("/api/admin/me", headers=headers(people["Alice"]["token"], "nope"))
        assert wrong.status == 401
        # A real staff key that belongs to someone else is no use either.
        borrowed = await client.get("/api/admin/me", headers=headers(people["Dave"]["token"], "owner-key"))
        assert borrowed.status == 401
        mine = await client.get("/api/admin/me", headers=headers(people["Alice"]["token"], "owner-key"))
        assert mine.status == 200
        body = await mine.json()
        assert body["role"] == "owner" and body["name"] == "Alice"
        await client.close()
    run(scenario())


def test_owner_is_untouchable(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        owner = people["Alice"]
        response, body = await act(client, people["Bob"]["token"], "admin-key",
                                   action="suspend", target_id=owner["player"]["id"], minutes=60,
                                   reason="test")
        assert body["ok"] is False and "owner" in body["text"].lower()
        response, body = await act(client, people["Carol"]["token"], "mod-key",
                                   action="silence", target_id=owner["player"]["id"], minutes=60)
        assert body["ok"] is False
        assert server.store.punishment(owner["player"]["id"], "suspend") is None
        assert server.store.staff_role(owner["player"]["id"]) == "owner"
        await client.close()
    run(scenario())


def test_only_the_owner_appoints_admins(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        create = await client.post("/api/session", json={"name": "Erin"})
        erin = await create.json()
        response, body = await act(client, people["Bob"]["token"], "admin-key",
                                   action="appoint", target_id=erin["player"]["id"], role="admin")
        assert body["ok"] is False and "Only the owner" in body["text"]
        response, body = await act(client, people["Bob"]["token"], "admin-key",
                                   action="appoint", target_id=erin["player"]["id"], role="moderator")
        assert body["ok"] is True and body.get("staff_key"), body
        assert server.store.staff_role(erin["player"]["id"]) == "moderator"
        response, body = await act(client, people["Carol"]["token"], "mod-key",
                                   action="appoint", target_id=erin["player"]["id"], role="moderator")
        assert body["ok"] is False
        response, body = await act(client, people["Alice"]["token"], "owner-key",
                                   action="appoint", target_id=erin["player"]["id"], role="admin")
        assert body["ok"] is True and body.get("staff_key")
        assert server.store.staff_role(erin["player"]["id"]) == "admin"
        await client.close()
    run(scenario())


def test_moderator_limits(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]["player"]
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="silence", target_id=dave["id"], minutes=0)
        assert body["ok"] is False
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="suspend", target_id=dave["id"], minutes=8 * 1440)
        assert body["ok"] is False
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="suspend", target_id=dave["id"], minutes=7 * 1440)
        assert body["ok"] is True, body
        assert server.store.suspended(dave["id"])
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="force-rename", target_id=dave["id"], name="Nobody")
        assert body["ok"] is False
        await client.close()
    run(scenario())


def test_delete_message_tombstone_audit_and_undo(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        posted = await client.post("/api/lobby/chat", json={"text": "buy gold cheap"},
                                   headers=headers(dave["token"]))
        assert posted.status == 200, await posted.text()
        message = (await posted.json())["message"]
        found = await client.get("/api/lobby/chat")
        assert any(item["id"] == message["id"] for item in (await found.json())["messages"])
        response, body = await act(client, people["Carol"]["token"], "mod-key",
                                   action="delete-message", message_id=message["id"],
                                   reason="spam")
        assert body["ok"] is True, body
        shown = (await (await client.get("/api/lobby/chat")).json())["messages"]
        row = next(item for item in shown if item["id"] == message["id"])
        assert row["text"] == "removed by a moderator" and row["removed"] is True
        audit = await client.get("/api/admin/audit", headers=headers(people["Alice"]["token"], "owner-key"))
        entries = (await audit.json())["entries"]
        assert any(entry["action"] == "delete-message" and "buy gold cheap" in entry["detail"] for entry in entries)
        _, body = await act(client, people["Alice"]["token"], "owner-key",
                            action="undo", audit_id=body["audit_id"])
        assert body["ok"] is True, body
        shown = (await (await client.get("/api/lobby/chat")).json())["messages"]
        assert next(item for item in shown if item["id"] == message["id"])["text"] == "buy gold cheap"
        await client.close()
    run(scenario())


def test_silence_blocks_chat_not_play(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="silence", target_id=dave["player"]["id"], minutes=60, reason="rude")
        assert body["ok"] is True
        blocked = await client.post("/api/lobby/chat", json={"text": "hello"},
                                    headers=headers(dave["token"]))
        assert blocked.status == 403
        queued = await client.post("/api/queue", json={"game": "connect4"},
                                   headers=headers(dave["token"]))
        assert queued.status == 200, await queued.text()
        await client.close()
    run(scenario())


def test_suspension_blocks_sign_in_and_queue_then_expires(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="suspend", target_id=dave["player"]["id"], minutes=60, reason="abuse")
        assert body["ok"] is True
        # A fresh browser with the right recovery key is still refused.
        response, answer = await sign_in(client, "Dave", dave["token"])
        assert response.status == 403 and answer.get("suspended") is True
        queued = await client.post("/api/queue", json={"game": "connect4"},
                                   headers=headers(dave["token"]))
        assert queued.status == 403
        # The janitor lifts it when the clock passes.
        server.store.db.execute("UPDATE punishments SET until = ? WHERE kind = 'suspend'", (time.time() - 1,))
        server.store.expire_punishments(time.time())
        response, answer = await sign_in(client, "Dave", dave["token"])
        assert response.status == 200
        await client.close()
    run(scenario())


def test_permanent_ban_blocks_the_address_by_hash(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        _, body = await act(client, people["Bob"]["token"], "admin-key",
                            action="suspend", target_id=dave["player"]["id"], minutes=0,
                            address_block=True, reason="ban")
        assert body["ok"] is True, body
        rows = server.store.db.execute("SELECT * FROM address_blocks").fetchall()
        assert len(rows) == 1 and len(rows[0]["hash"]) == 64
        assert "127.0.0.1" not in rows[0]["hash"]
        refused, answer = await sign_in(client, "Newbie")
        assert refused.status == 403
        assert "New accounts" in answer["error"]
        await client.close()
    run(scenario())


def test_report_queue_and_one_click_close(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        posted = await client.post("/api/lobby/chat", json={"text": "you are terrible"},
                                   headers=headers(dave["token"]))
        message = (await posted.json())["message"]
        reported = await client.post("/api/reports", json={
            "kind": "message", "message_id": message["id"], "reason": "Abuse or threats"},
            headers=headers(people["Carol"]["token"]))
        assert reported.status == 200, await reported.text()
        # Reporting twice does not queue twice.
        again = await client.post("/api/reports", json={"kind": "message", "message_id": message["id"]},
                                  headers=headers(people["Carol"]["token"]))
        assert (await again.json())["ok"] is True
        queue = await client.get("/api/admin/reports?state=open",
                                 headers=headers(people["Alice"]["token"], "owner-key"))
        rows = (await queue.json())["reports"]
        assert len(rows) == 1 and rows[0]["text"] == "you are terrible"
        _, body = await act(client, people["Alice"]["token"], "owner-key",
                            action="close-report", report_id=rows[0]["id"], resolution="Handled.")
        assert body["ok"] is True
        queue = await client.get("/api/admin/reports?state=open",
                                 headers=headers(people["Alice"]["token"], "owner-key"))
        assert (await queue.json())["reports"] == []
        await client.close()
    run(scenario())


def test_block_list_hides_chat_and_tables(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave, carol = people["Dave"], people["Carol"]
        await client.post("/api/lobby/chat", json={"text": "from dave"}, headers=headers(dave["token"]))
        await client.post("/api/lobby/chat", json={"text": "from carol"}, headers=headers(carol["token"]))
        blocked = await client.post("/api/blocks", json={"player_id": dave["player"]["id"]},
                                    headers=headers(carol["token"]))
        assert blocked.status == 200, await blocked.text()
        visible = (await (await client.get("/api/lobby/chat", headers=headers(carol["token"]))).json())["messages"]
        assert all(item["name"] != "Dave" for item in visible)
        assert any(item["name"] == "Carol" for item in visible)
        # A table Dave hosts is hidden from Carol's lobby, not closed.
        room = await client.post("/api/rooms", json={"game": "connect4", "public": True},
                                 headers=headers(dave["token"]))
        room_id = (await room.json())["room"]["id"]
        lobby = (await (await client.get("/api/lobby", headers=headers(carol["token"]))).json())
        assert all(item["id"] != room_id for item in lobby["rooms"])
        other = await client.get("/api/lobby", headers=headers(people["Alice"]["token"]))
        assert any(item["id"] == room_id for item in (await other.json())["rooms"])
        listed = await client.get("/api/blocks", headers=headers(carol["token"]))
        assert [row["name"] for row in (await listed.json())["blocked"]] == ["Dave"]
        await client.delete(f"/api/blocks/{dave['player']['id']}", headers=headers(carol["token"]))
        visible = (await (await client.get("/api/lobby/chat", headers=headers(carol["token"]))).json())["messages"]
        assert any(item["name"] == "Dave" for item in visible)
        await client.close()
    run(scenario())


def test_name_spoofing_is_refused(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        for attempt in ("ALICE", "A l i c e", "Admіn", "аlice"):
            response, _ = await sign_in(client, attempt)
            assert response.status in (400, 409), attempt
        # A plain new name still works.
        response, _ = await sign_in(client, "Zed")
        assert response.status == 200
        await client.close()
    run(scenario())


def test_bot_reset_and_undo_restore_the_record(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        made = await client.post("/api/bots", json={"name": "Robo"}, headers=headers(dave["token"]))
        bot = (await made.json())["bot"]
        server.store.db.execute(
            "INSERT INTO bot_ratings (player_id, game, rating, games, wins, losses, draws)"
            " VALUES (?, 'connect4', 1310, 9, 6, 2, 1)", (bot["id"],))
        _, body = await act(client, people["Bob"]["token"], "admin-key",
                            action="bot-reset", target_id=bot["id"], game="connect4", reason="farmed")
        assert body["ok"] is True, body
        left = server.store.db.execute(
            "SELECT COUNT(*) FROM bot_ratings WHERE player_id = ?", (bot["id"],)).fetchone()[0]
        assert left == 0
        _, body = await act(client, people["Alice"]["token"], "owner-key",
                            action="undo", audit_id=body["audit_id"])
        assert body["ok"] is True, body
        row = server.store.db.execute(
            "SELECT rating FROM bot_ratings WHERE player_id = ? AND game = 'connect4'",
            (bot["id"],)).fetchone()
        assert row is not None and row["rating"] == 1310
        await client.close()
    run(scenario())


def test_lookup_and_overview(tmp_path):
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        found = await client.get("/api/admin/user?name=Dave",
                                 headers=headers(people["Carol"]["token"], "mod-key"))
        assert found.status == 200
        player = (await found.json())["player"]
        assert player["name"] == "Dave" and player["staff_role"] == ""
        overview = await client.get("/api/admin/overview",
                                    headers=headers(people["Alice"]["token"], "owner-key"))
        body = await overview.json()
        assert body["players"] >= 4 and [row["role"] for row in body["staff"]].count("owner") == 1
        await client.close()
    run(scenario())


def test_a_suspended_player_is_still_findable_and_can_be_lifted(tmp_path):
    """A ban you cannot see or undo is a bug: staff lookup must find suspended accounts."""
    async def scenario():
        server, client, people = await with_roles(tmp_path)
        dave = people["Dave"]
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="suspend", target_id=dave["player"]["id"], minutes=1440, reason="spam")
        assert body["ok"] is True, body
        assert body["text"] == "Dave suspended."
        found = await client.get("/api/admin/user?name=Dave",
                                 headers=headers(people["Carol"]["token"], "mod-key"))
        assert found.status == 200, await found.text()
        player = (await found.json())["player"]
        assert player["suspended_until"] != 0, player
        # The suspended player's live token now gets a clear refusal, not "sign in".
        chat = await client.post("/api/lobby/chat", json={"text": "hello"},
                                 headers=headers(dave["token"]))
        assert chat.status == 403
        assert "suspended" in (await chat.json())["error"]
        # Lifting by name works too (the web and Desktop panels act on the name).
        _, body = await act(client, people["Carol"]["token"], "mod-key",
                            action="unsuspend", target="Dave")
        assert body["ok"] is True, body
        chat = await client.post("/api/lobby/chat", json={"text": "hello again"},
                                 headers=headers(dave["token"]))
        assert chat.status == 200, await chat.text()
        await client.close()
    run(scenario())


def test_cli_help_works_without_aiohttp(tmp_path):
    import subprocess

    result = subprocess.run([sys.executable, "-c",
                             "import sys; sys.modules['aiohttp'] = None; "
                             "from online import admin; admin.main(['--help'])"],
                            capture_output=True, text=True, cwd=str(ROOT))
    assert result.returncode == 0, result.stderr
    assert "grant-owner" in result.stdout
