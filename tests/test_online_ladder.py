"""Public bot ladder: cross-owner rated games, career records, pair cap, per-move clock, upgrades."""
from pathlib import Path
import importlib.util
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("online_helpers_ladder", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in, connect = helpers.run, helpers.started, helpers.sign_in, helpers.connect

from online.store import Store  # noqa: E402


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def make_bot(client, token, name):
    response = await client.post("/api/bots", json={"name": name}, headers=auth(token))
    assert response.status == 200, await response.text()
    body = await response.json()
    return body["bot"], body["key"]


async def ladder(client, key, game, opponent):
    made = await client.post("/api/ladder", json={"game": game, "opponent": opponent}, headers=auth(key))
    assert made.status == 200, await made.text()
    return await made.json()


HEX_MOVES = ("a1", "b1", "a2", "b2", "a3")


async def play_leg(client, room, key_white, key_black, *, winner="white", ref=1):
    """A few legal Hex moves, then the losing seat resigns. One leg of a pair."""
    white = await connect(client, room, key_white)
    black = await connect(client, room, key_black)
    for index, move in enumerate(HEX_MOVES):
        seat = white if index % 2 == 0 else black
        answer = await seat.result(ref, t="cmd", action="move", args=[move])
        assert answer["ok"], answer
        ref += 1
    loser = black if winner == "white" else white
    done = await loser.result(ref, t="cmd", action="resign")
    await white.ws.close()
    await black.ws.close()
    return done


def test_rated_bot_ladder_game_career_and_leaderboard(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, key_b = await make_bot(client, bea_token, "Robo B")
            challenge = await ladder(client, key_a, "hex", bot_b["id"])
            assert challenge["rated"] is True and challenge["side"] == "white"
            assert challenge["pair"]["leg"] == 1 and challenge["pair"]["legs"] == 2
            assert challenge["move_seconds"] == 15 and challenge["open_league"] is False
            room = challenge["room"]["id"]
            other = challenge["pair"]["other_room"]
            assert other and other != room
            done = await play_leg(client, room, key_a, key_b)
            # One leg is a replay and a scoreline; the pair is not rated yet.
            assert done["finished"] and done["finished"]["rated"] is False
            assert done["finished"]["pair"]["waiting"] is True
            career = await (await client.get(f"/api/bots/{bot_a['id']}")).json()
            assert career["career"]["games"] == []
            # Leg 2: the seats are swapped, and Robo A (black this time) wins it too.
            done = await play_leg(client, other, key_b, key_a, winner="black", ref=20)
            assert done["finished"]["pair"]["rated"] is True and done["finished"]["pair"]["winner"] == "white"
            assert done["finished"]["pair"]["score"] == "2-0"

            career = await (await client.get(f"/api/bots/{bot_a['id']}")).json()
            record = career["career"]
            assert record["bot"]["name"] == "Robo A"
            assert record["games"][0]["wins"] == 1 and record["games"][0]["rating"] > 1200
            assert record["history"] and record["history"][0]["rating"] == record["games"][0]["rating"]
            assert record["opponents"][0]["name"] == "Robo B" and record["opponents"][0]["result"] == "win"
            assert record["opponents"][0]["rated"] is True
            assert "token" not in str(career)

            human_rows = server.store.db.execute("SELECT COUNT(*) FROM ratings").fetchone()[0]
            bot_rows = server.store.db.execute("SELECT COUNT(*) FROM bot_ratings").fetchone()[0]
            assert human_rows == 0 and bot_rows == 2

            board = await (await client.get("/api/leaderboard?game=hex&pool=bots")).json()
            names = [row["name"] for row in board["rows"]]
            assert names == ["Robo A", "Robo B"]
            people = await (await client.get("/api/leaderboard?game=hex&pool=humans")).json()
            assert people["rows"] == []
            assert (await client.get("/api/leaderboard?game=hex&pool=nope")).status == 400
            assert (await client.get("/api/bots/bot:nope")).status == 404

            # The id is stable across a rename; the career stays with the bot.
            renamed = await client.post("/api/me", json={"name": "Robo A Prime"}, headers=auth(key_a))
            assert renamed.status == 200
            again = await (await client.get(f"/api/bots/{bot_a['id']}")).json()
            assert again["career"]["bot"]["name"] == "Robo A Prime"
            assert again["career"]["games"][0]["wins"] == 1
        finally:
            await client.close()
    run(scenario())


def test_casual_game_cannot_be_a_rated_ladder_game(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, _ = await make_bot(client, bea_token, "Robo B")
            made = await client.post("/api/ladder", json={"game": "connect4", "opponent": bot_b["id"]}, headers=auth(key_a))
            assert made.status == 400 and "casual only" in (await made.json())["error"]
        finally:
            await client.close()
    run(scenario())


def test_same_owner_pair_cap_and_timeout(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_a2, _ = await make_bot(client, ada_token, "Robo A2")
            bot_b, _ = await make_bot(client, bea_token, "Robo B")
            same = await client.post("/api/ladder", json={"game": "hex", "opponent": bot_a2["id"]}, headers=auth(key_a))
            assert same.status == 400 and "same owner" in (await same.json())["error"]

            # Play two plies, then let the bot to move run out its fifteen-second clock.
            bot_c, key_c = await make_bot(client, bea_token, "Robo C")
            challenge = await ladder(client, key_a, "hex", bot_c["id"])
            room = challenge["room"]["id"]
            a = await connect(client, room, key_a)
            c = await connect(client, room, key_c)
            assert (await a.result(1, t="cmd", action="move", args=["a1"]))["ok"]
            assert (await c.result(2, t="cmd", action="move", args=["b1"]))["ok"]
            server.rooms.turn_since[room] = server.clock() - 16
            # A no-op join must not buy the bot another fifteen seconds.
            assert server.rooms.run(server.store.room(room), server.store.player(bot_a["id"]), "join", [])["ok"]
            assert server.rooms.turn_since[room] <= server.clock() - 15
            expired = server.rooms.check_clocks(server.clock())
            assert room in expired
            state = server.rooms.state({"id": room, "game": "hex"})
            assert state["status"] == "resigned" and state["result_reason"] == "timeout"
            matches = server.store.recent_matches(room)
            assert matches and matches[0]["reason"] == "timeout" and matches[0]["rated"] == 0
            await a.ws.close()
            await c.ws.close()

            # Three rated games a day per pair: fill the history, then the fourth is refused.
            now = server.clock()
            for index in range(3):
                server.store.db.execute(
                    "INSERT INTO matches (room_id, match_no, game, white_id, black_id, white_name, black_name, "
                    "white_kind, black_kind, winner, reason, plies, moves, rated, finished) "
                    "VALUES (?, ?, 'hex', ?, ?, 'a', 'b', 'human', 'human', 'white', 'rules', 7, '[]', 1, ?)",
                    (f"old-{index}", index + 1, bot_a["id"], bot_b["id"], now - 60))
            refused = await client.post("/api/ladder", json={"game": "hex", "opponent": bot_b["id"]}, headers=auth(key_a))
            assert refused.status == 429
        finally:
            await client.close()
    run(scenario())


def test_late_move_forfeits_instead_of_using_the_next_tick(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, _ = await make_bot(client, bea_token, "Robo B")
            challenge = await ladder(client, key_a, "hex", bot_b["id"])
            room_id = challenge["room"]["id"]
            room = server.store.room(room_id)
            a = server.store.player(bot_a["id"])
            b = server.store.player(bot_b["id"])
            assert server.rooms.run(room, a, "move", ["a1"])["ok"]
            assert server.rooms.run(room, b, "move", ["b1"])["ok"]
            server.rooms.turn_since[room_id] = server.clock() - 16
            late = server.rooms.run(server.store.room(room_id), a, "move", ["a2"])
            assert not late["ok"] and late["finished"]
            assert late["finished"]["reason"] == "timeout"
            state = server.rooms.state({"id": room_id, "game": "hex"})
            assert state["status"] == "resigned" and state["result_reason"] == "timeout"
        finally:
            await client.close()
    run(scenario())


def test_ladder_clock_waits_for_a_connection_then_starts(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, _ = await make_bot(client, bea_token, "Robo B")
            challenge = await ladder(client, key_a, "hex", bot_b["id"])
            room_id = challenge["room"]["id"]
            other = challenge["pair"]["other_room"]
            now = server.clock()
            # Neither leg is clocked until a seated bot connects: leg 2 is waiting too.
            server.rooms.turn_since.pop(other, None)
            assert server.rooms.check_clocks(now + 16) == []      # no bot has connected yet
            assert server.rooms.check_clocks(now + 61) == []      # grace over: clock starts now
            expired = server.rooms.check_clocks(now + 77)         # 15 s of no move
            assert room_id in expired
            state = server.rooms.state({"id": room_id, "game": "hex"})
            assert state["status"] == "resigned" and state["result_reason"] == "timeout"
        finally:
            await client.close()
    run(scenario())


def test_ladder_respects_the_open_room_cap(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, _ = await make_bot(client, bea_token, "Robo B")
            server.store.open_room_count = lambda: 10**6
            refused = await client.post("/api/ladder", json={"game": "hex", "opponent": bot_b["id"]}, headers=auth(key_a))
            assert refused.status == 503
        finally:
            await client.close()
    run(scenario())


def test_ladder_rooms_are_tracked_past_the_lobby_limit(tmp_path):
    store = Store(tmp_path / "many.sqlite3")
    ids = [store.create_room("connect4", "web:host", False)["id"] for _ in range(205)]
    store.mark_ladder(ids[0], True)
    store.db.execute("UPDATE rooms SET active = 0 WHERE id = ?", (ids[0],))
    tracked = [room["id"] for room in store.active_ladder_rooms()]
    assert tracked == [ids[0]]
    store.mark_ladder(ids[0], False)
    assert store.active_ladder_rooms() == []
    store.close()


def test_old_database_upgrades_without_losing_rows(tmp_path):
    path = tmp_path / "old.sqlite3"
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE players (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
            public INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, seen REAL NOT NULL);
        CREATE TABLE rooms (id TEXT PRIMARY KEY, game TEXT NOT NULL, host_id TEXT NOT NULL,
            public INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, active REAL NOT NULL,
            closed INTEGER NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE ratings (player_id TEXT NOT NULL, game TEXT NOT NULL, rating REAL NOT NULL,
            games INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (player_id, game));
        CREATE TABLE matches (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL,
            match_no INTEGER NOT NULL, game TEXT NOT NULL, white_id TEXT NOT NULL, black_id TEXT NOT NULL,
            white_name TEXT NOT NULL, black_name TEXT NOT NULL, white_kind TEXT NOT NULL,
            black_kind TEXT NOT NULL, winner TEXT NOT NULL, reason TEXT NOT NULL, plies INTEGER NOT NULL,
            moves TEXT NOT NULL, rated INTEGER NOT NULL, finished REAL NOT NULL, UNIQUE (room_id, match_no));
        INSERT INTO players VALUES ('web:old', 'h', 'Oldtimer', 1, 0, 0);
        INSERT INTO rooms VALUES ('oldroom', 'connect4', 'web:old', 1, 0, 0, 0, 0);
        INSERT INTO ratings VALUES ('web:old', 'connect4', 1234, 7, 4, 3, 0);
    """)
    db.commit()
    db.close()
    for _ in range(2):
        store = Store(path)
        assert store.player("web:old")["name"] == "Oldtimer"
        assert store.room("oldroom")["game"] == "connect4"
        assert store.stats("web:old")["rated"][0]["rating"] == 1234
        tables = {row[0] for row in store.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert {"bot_ratings", "rating_history", "alert_prefs", "alert_sent"} <= tables
        store.close()
