"""Identity, curated games, per-game lobby, matchmaking queue and alert preferences."""
from pathlib import Path
import importlib.util
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("online_helpers_lobby", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in, open_room, connect = helpers.run, helpers.started, helpers.sign_in, helpers.open_room, helpers.connect

from online.matchqueue import MatchQueue  # noqa: E402
from online.rooms import CURATED, load_games  # noqa: E402


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def make_bot(client, token, name):
    response = await client.post("/api/bots", json={"name": name}, headers=auth(token))
    assert response.status == 200, await response.text()
    body = await response.json()
    return body["bot"], body["key"]


def entry(player_id, *, game="connect4", pool="human", level="intermediate", rating=1200, joined=0.0,
          seen=0.0, owner="owner-a", practice=""):
    return {"player_id": player_id, "name": player_id, "pool": pool, "game": game, "level": level,
            "rating": rating, "games": 0, "joined": joined, "seen": seen, "practice_room": practice,
            "owner_id": owner}


def test_recovery_key_signs_in_another_client(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, key = await sign_in(client, "Ada")
            again = await client.post("/api/session", json={"name": "ada", "key": key})
            assert again.status == 200, await again.text()
            body = await again.json()
            assert body["player"]["id"] == ada["id"] and body["token"] == key and body["created"] is False
            wrong = await client.post("/api/session", json={"name": "Ada", "key": key + "x"})
            assert wrong.status == 401 and (await wrong.json())["needs_key"]
            missing = await client.post("/api/session", json={"name": "Ada"})
            assert missing.status == 409 and (await missing.json())["needs_key"]
            unknown = await client.post("/api/session", json={"name": "Nobody", "key": key})
            assert unknown.status == 401
            # The key never appears in lobby JSON or a player object.
            lobby = json.dumps(await (await client.get("/api/lobby")).json())
            me = json.dumps((await (await client.get("/api/me", headers=auth(key))).json())["player"])
            assert key not in lobby and key not in me and "token" not in me
        finally:
            await client.close()
    run(scenario())


def test_wrong_keys_are_rate_limited(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            await sign_in(client, "Ada")
            statuses = []
            for _ in range(11):
                answer = await client.post("/api/session", json={"name": "Ada", "key": "wrong-key"})
                statuses.append(answer.status)
            assert statuses[:10] == [401] * 10, statuses
            assert statuses[-1] == 429, statuses
        finally:
            await client.close()
    run(scenario())


def test_only_curated_games_are_loaded_or_listed(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ids = [card["id"] for card in (await (await client.get("/api/games")).json())["games"]]
            assert set(ids) == set(CURATED)
            assert ids[:5] == list(CURATED[:5])
            assert set(load_games()) == set(CURATED)
            assert "doctrine" not in ids and "doom" not in ids
            ada, token = await sign_in(client, "Ada")
            refused = await client.post("/api/rooms", json={"game": "doctrine"}, headers=auth(token))
            assert refused.status == 400
            await client.get("/api/lobby")
        finally:
            await client.close()
    run(scenario())


def test_queue_window_level_and_owner_rules():
    now = 1000.0
    queue = MatchQueue()

    def put(item):
        queue.entries[(item["pool"], item["game"], item["player_id"])] = item

    # Fresh entries pair inside +-150, never across a bigger rating gap.
    put(entry("a", rating=1200, joined=now - 5, seen=now))
    put(entry("b", rating=1340, joined=now - 4, seen=now))
    put(entry("c", rating=1500, joined=now - 3, seen=now))
    pairs = queue.match("connect4", "human", now)
    assert len(pairs) == 1
    assert {pairs[0][0]["player_id"], pairs[0][1]["player_id"]} == {"a", "b"}
    assert sorted(e["player_id"] for e in queue.entries.values()) == ["c"]

    # Widening: two entries that waited over 30 s pair at any rating.
    queue = MatchQueue()
    put(entry("low", rating=900, joined=now - 31, seen=now))
    put(entry("high", rating=2100, joined=now - 30, seen=now))
    assert queue.match("connect4", "human", now)

    # Same level is preferred even when another entry is older and inside the window.
    queue = MatchQueue()
    put(entry("old-hard", rating=1200, level="advanced", joined=now - 10, seen=now))
    put(entry("new-easy", rating=1200, level="beginner", joined=now - 1, seen=now))
    put(entry("old-easy", rating=1200, level="beginner", joined=now - 12, seen=now))
    pairs = queue.match("connect4", "human", now)
    assert pairs and pairs[0][0]["level"] == pairs[0][1]["level"] == "beginner"

    # Bots never pair with people, and never with their own owner or themselves.
    queue = MatchQueue()
    put(entry("human", pool="human", joined=now - 5, seen=now, rating=1200))
    put(entry("bot:one", pool="bot", joined=now - 5, seen=now, rating=1200, owner="owner-a"))
    assert queue.match("connect4", "human", now) == []
    assert queue.match("connect4", "bot", now) == []
    put(entry("bot:two", pool="bot", joined=now - 4, seen=now, rating=1200, owner="owner-b"))
    pairs = queue.match("connect4", "bot", now)
    assert len(pairs) == 1 and {pairs[0][0]["player_id"], pairs[0][1]["player_id"]} == {"bot:one", "bot:two"}


def test_expiring_entries_are_pruned():
    now = 1000.0
    queue = MatchQueue()
    queue.entries[("human", "connect4", "a")] = entry("a", joined=now - 700, seen=now - 601)
    queue.reports["a"] = (now - 181, {"room": {}})
    queue.prune(now)
    assert queue.entries == {} and queue.reports == {}


def test_two_humans_find_each_other_through_the_queue_and_finish(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            first = await client.post("/api/queue", json={"game": "hex", "level": "intermediate"}, headers=auth(ada_token))
            assert first.status == 200
            body = await first.json()
            assert body["queued"] and body["matched"] is None
            lobby = await (await client.get("/api/lobby", headers=auth(ada_token))).json()
            assert lobby["looking"]["hex"] == 1
            waiting = lobby["waiting"]["hex"]
            assert waiting[0]["name"] == "Ada" and waiting[0]["kind"] == "human"
            assert waiting[0]["level"] == "intermediate" and waiting[0]["provisional"] is True
            second = await client.post("/api/queue", json={"game": "hex", "level": "intermediate"}, headers=auth(bea_token))
            matched = (await second.json())["matched"]
            room_id = matched["room"]["id"]
            bea_side = matched["side"]
            assert bea_side in ("white", "black")
            ada_side = "black" if bea_side == "white" else "white"
            status = await (await client.get("/api/queue", headers=auth(ada_token))).json()
            assert status["matched"] and status["matched"]["room"]["id"] == room_id and status["matched"]["side"] == ada_side
            summary = await (await client.get(f"/api/rooms/{room_id}")).json()
            seats = {seat["side"]: seat["name"] for seat in summary["room"]["seats"]}
            assert seats == {ada_side: "Ada", bea_side: "Bea"}
            # A ranked match is a pair: leg 1 and leg 2, seats swapped, one deal.
            pair = summary["room"]["pair"]
            assert pair["leg"] == 1 and pair["legs"] == 2 and pair["other_room"]

            a = await connect(client, room_id, ada_token)
            b = await connect(client, room_id, bea_token)
            players = {ada_side: a, bea_side: b}
            ref = 1
            for side, move in (("white", "a1"), ("black", "b1"), ("white", "a2"), ("black", "b2")):
                answer = await players[side].result(ref, t="cmd", action="move", args=[move])
                assert answer["ok"], answer
                ref += 1
            done = await b.result(ref, t="cmd", action="resign")
            assert done["finished"], done
            assert done["finished"]["winner"] == ada_side and done["finished"]["rated"] is False
            assert done["finished"]["pair"]["waiting"] is True
            await a.ws.close()
            await b.ws.close()

            # Leg 2: the same deal, the seats swapped, and the same person wins it too.
            other = pair["other_room"]
            a = await connect(client, other, ada_token)
            b = await connect(client, other, bea_token)
            other_summary = await (await client.get(f"/api/rooms/{other}")).json()
            other_seats = {seat["side"]: seat["name"] for seat in other_summary["room"]["seats"]}
            swapped_ada = "black" if ada_side == "white" else "white"
            swapped_bea = "white" if bea_side == "black" else "black"
            assert other_seats == {swapped_ada: "Ada", swapped_bea: "Bea"}
            players = {swapped_ada: a, swapped_bea: b}
            ref = 20
            for side, move in (("white", "a1"), ("black", "b1"), ("white", "a2"), ("black", "b2")):
                answer = await players[side].result(ref, t="cmd", action="move", args=[move])
                assert answer["ok"], answer
                ref += 1
            done = await b.result(ref, t="cmd", action="resign")
            assert done["finished"]["winner"] == swapped_ada
            expected_score = "2-0" if ada_side == "white" else "0-2"
            assert done["finished"]["pair"]["rated"] is True and done["finished"]["pair"]["score"] == expected_score
            await a.ws.close()
            await b.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_queue_delete_and_separate_games_never_match(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            one = (await (await client.post("/api/queue", json={"game": "connect4"}, headers=auth(ada_token))).json())
            two = (await (await client.post("/api/queue", json={"game": "reversi"}, headers=auth(bea_token))).json())
            assert one["queued"] and two["queued"] and not one["matched"] and not two["matched"]
            lobby = await (await client.get("/api/lobby")).json()
            assert lobby["looking"]["connect4"] == 1 and lobby["looking"]["reversi"] == 1
            gone = await client.delete("/api/queue", headers=auth(ada_token))
            assert (await gone.json())["queued"] is False
            status = await (await client.get("/api/queue", headers=auth(ada_token))).json()
            assert status["queued"] is False and status["matched"] is None
        finally:
            await client.close()
    run(scenario())


def test_practice_room_honors_the_selected_level(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            made = await client.post("/api/rooms", json={"game": "connect4", "mode": "bot", "public": True, "level": "beginner"},
                                     headers=auth(token))
            assert made.status == 200, await made.text()
            room = (await made.json())["room"]
            state = server.rooms.state(server.store.room(room["id"]))
            assert state["level"] == "beginner"
            assert room["seats"][1]["level"] == "beginner"
            # Old spellings still seat a table.
            older = await client.post("/api/rooms", json={"game": "connect4", "mode": "bot", "public": True, "level": "easy"},
                                      headers=auth(token))
            assert older.status == 200, await older.text()
            assert server.rooms.state(server.store.room((await older.json())["room"]["id"]))["level"] == "beginner"
            bad = await client.post("/api/rooms", json={"game": "connect4", "mode": "bot", "public": True, "level": "impossible"},
                                    headers=auth(token))
            assert bad.status == 400
        finally:
            await client.close()
    run(scenario())


def test_deleted_bot_leaves_the_queue(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, key_b = await make_bot(client, bea_token, "Robo B")
            assert (await (await client.post("/api/queue", json={"game": "connect4"}, headers=auth(key_a))).json())["queued"]
            gone = await client.delete(f"/api/bots/{bot_a['id']}", headers=auth(ada_token))
            assert gone.status == 200
            queued = (await (await client.post("/api/queue", json={"game": "connect4"}, headers=auth(key_b))).json())
            assert queued["queued"] and queued["matched"] is None
            assert all(entry["player_id"] != bot_a["id"] for entry in server.queue.entries.values())
        finally:
            await client.close()
    run(scenario())


def test_lobby_lists_open_tables_but_not_private_ones(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            public = (await open_room(client, token))["room"]
            made = await client.post("/api/rooms", json={"game": "connect4", "public": False, "mode": "two"}, headers=auth(token))
            private = (await made.json())["room"]
            lobby = await (await client.get("/api/lobby")).json()
            ids = [room["id"] for room in lobby["rooms"]]
            assert public["id"] in ids and private["id"] not in ids
            card = next(game for game in lobby["games"] if game["id"] == "connect4")
            assert card["open_tables"] >= 1
            seat = next(room for room in lobby["rooms"] if room["id"] == public["id"])["seats"][0]
            assert {"level", "rating", "provisional"} <= set(seat)
        finally:
            await client.close()
    run(scenario())


def test_bots_and_people_appear_in_separate_lobby_lists(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            made = await client.post("/api/bots", json={"name": "Robo"}, headers=auth(token))
            bot = (await made.json())["bot"]
            key = (await made.json())["key"]
            await client.post("/api/queue", json={"game": "connect4"}, headers=auth(token))
            await client.post("/api/queue", json={"game": "connect4"}, headers=auth(key))
            lobby = await (await client.get("/api/lobby", headers=auth(token))).json()
            assert lobby["looking"]["connect4"] == 1
            assert lobby["looking_bots"]["connect4"] == 1
            assert [p["name"] for p in lobby["waiting"]["connect4"]] == ["Ada"]
            assert [p["name"] for p in lobby["bots_waiting"]["connect4"]] == [bot["name"]]
            assert lobby["bots_waiting"]["connect4"][0]["kind"] == "bot"
        finally:
            await client.close()
    run(scenario())


def test_alert_preferences_are_opt_in_and_rate_limited(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, token = await sign_in(client, "Ada")
            off = await (await client.get("/api/alerts", headers=auth(token))).json()
            assert off["prefs"]["connect4"] is False and off["alerts"] == []
            bad = await client.post("/api/alerts", json={"game": "doom", "enabled": True}, headers=auth(token))
            assert bad.status == 400
            enabled = await client.post("/api/alerts", json={"game": "connect4", "enabled": True}, headers=auth(token))
            assert (await enabled.json())["prefs"]["connect4"] is True
            other, other_token = await sign_in(client, "Bea")
            await client.post("/api/queue", json={"game": "connect4"}, headers=auth(other_token))
            first = await (await client.get("/api/alerts", headers=auth(token))).json()
            assert first["alerts"] and first["alerts"][0]["game"] == "connect4" and first["alerts"][0]["waiting"] >= 1
            second = await (await client.get("/api/alerts", headers=auth(token))).json()
            assert second["alerts"] == []  # ten-minute cooldown
            bot_made = await client.post("/api/bots", json={"name": "Robo"}, headers=auth(token))
            bot_key = (await bot_made.json())["key"]
            forbidden = await client.post("/api/alerts", json={"game": "connect4", "enabled": True}, headers=auth(bot_key))
            assert forbidden.status == 403
        finally:
            await client.close()
    run(scenario())
