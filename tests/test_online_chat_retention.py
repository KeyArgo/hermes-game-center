"""Chat is kept for thirty days, in the lobby and at every table.

The lobby handed back only the last day of #games chat, because it was reading chat with
LOBBY_HOURS - the same constant that says how long an open room stays listed. Keeping a
conversation and listing a room are two different questions, so chat now has a retention of its
own: thirty days. LOBBY_HOURS keeps its 24 hours and still decides which rooms the lobby shows.
"""

from __future__ import annotations

import time

from test_online_server import open_room, run, sign_in, started

DAY = 86400


def backdate(store, message_id: int, at: float) -> None:
    store.db.execute("UPDATE chat SET at = ? WHERE id = ?", (float(at), message_id))


def test_a_ten_day_old_lobby_line_is_still_there(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            player, token = await sign_in(client, "bluewren")
            said = server.store.add_chat("__lobby__", player["id"], player["name"], "player",
                                         "still here?")
            backdate(server.store, said["id"], time.time() - 10 * DAY)
            fresh = server.store.add_chat("__lobby__", player["id"], player["name"], "player", "today")
            answer = await client.get("/api/lobby/chat")
            assert answer.status == 200, await answer.text()
            body = await answer.json()
            texts = [line["text"] for line in body["messages"]]
            assert "today" in texts and fresh["text"] in texts
            assert "still here?" in texts, f"a line from ten days ago is still in the lobby: {texts}"
        finally:
            await client.close()
    run(scenario())


def test_a_ten_day_old_table_line_is_still_there(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            player, token = await sign_in(client, "bluewren")
            room = (await open_room(client, token))["room"]
            said = server.store.add_chat(room["id"], player["id"], player["name"], "player", "good game")
            backdate(server.store, said["id"], time.time() - 10 * DAY)
            lines = server.store.recent_chat(room["id"], 50)
            assert [line["text"] for line in lines] == ["good game"], "the table chat still has it"
        finally:
            await client.close()
    run(scenario())


def test_the_janitor_keeps_thirty_days_of_chat_and_no_more():
    from online import server as online_server

    assert online_server.CHAT_KEEP_DAYS == 30, "chat is kept for thirty days"
    assert online_server.LOBBY_HOURS == 24, "and a room is still listed for one day"
    assert online_server.CHAT_KEEP_DAYS > online_server.LOBBY_HOURS / 24


def test_lobby_hours_still_decides_which_rooms_are_listed(tmp_path):
    async def scenario():
        server, client = await started(tmp_path / "server")
        try:
            player, token = await sign_in(client, "bluewren")
            old = (await open_room(client, token))["room"]
            new = (await open_room(client, token))["room"]
            server.store.db.execute("UPDATE rooms SET active = ? WHERE id = ?",
                                    (time.time() - 2 * DAY, old["id"]))
            answer = await client.get("/api/lobby")
            assert answer.status == 200, await answer.text()
            listed = {room["id"] for room in (await answer.json())["rooms"]}
            assert new["id"] in listed, "a fresh table is still listed"
            assert old["id"] not in listed, "a table older than LOBBY_HOURS is not"
        finally:
            await client.close()
    run(scenario())
