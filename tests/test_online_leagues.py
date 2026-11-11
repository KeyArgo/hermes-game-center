"""Leagues on Game Center Online: what is ranked, the two-leg pair, the open league,
watching live bot games, replays, challenges and server-run card bouts."""
from pathlib import Path
import importlib.util
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("online_helpers_leagues", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in, connect, open_room = helpers.run, helpers.started, helpers.sign_in, helpers.connect, helpers.open_room

from online import league  # noqa: E402


def auth(token):
    return {"Authorization": f"Bearer {token}"}


async def make_bot(client, token, name):
    response = await client.post("/api/bots", json={"name": name}, headers=auth(token))
    assert response.status == 200, await response.text()
    body = await response.json()
    return body["bot"], body["key"]


def doctrine_card(name="Test Card", aggression=60):
    return {
        "schema": "doctrine-card/1",
        "name": name,
        "author": "tester",
        "personality": "Tests things carefully.",
        "weights": {
            "aggression": aggression, "safety": 30, "objective": 40, "focus": 50,
            "cohesion": 20, "center": 40, "mobility": 60, "endurance": 30,
        },
    }


def arena_card(name="Test Tank"):
    return {
        "kind": "doctrine-arena-card",
        "schema_version": 1,
        "name": name,
        "move": "hold",
        "weapon": "cannon",
        "armour": "medium",
        "aggression": 5,
        "range": 5,
        "jink": 3,
        "focus": "nearest",
    }


def test_the_ladder_says_what_is_ranked(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            body = await (await client.get("/api/ladder")).json()
            ranked = [row["id"] for row in body["ranked_games"]]
            casual = [row["id"] for row in body["casual_games"]]
            assert "hex" in ranked and "go" in ranked and "breakthrough" in ranked
            assert "connect4" in casual and "checkers" in casual and "gomoku" in casual
            assert "gomoku" in casual
            assert not set(ranked) & set(casual)
            assert body["pair_legs"] == 2
            assert "chess960" in body["future_ranked"] and "pet_battles" in body["future_ranked"]
            assert body["stock"]["state"] == "design-only"
            assert all(row["rated"] for row in body["ranked_games"])
            assert not any(row["rated"] for row in body["casual_games"])
            # A game is ranked only when it is on the list and the server hosts it.
            assert league.ranked("hex", ("hex",)) and not league.ranked("chess960", ("chess960",))
            assert league.casual("connect4")
        finally:
            await client.close()
    run(scenario())


def test_open_league_pairs_get_a_longer_clock_and_the_unverified_label(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, key_b = await make_bot(client, bea_token, "Robo B")
            made = await client.post("/api/ladder", json={"game": "hex", "opponent": bot_b["id"], "open_league": True},
                                     headers=auth(key_a))
            assert made.status == 200, await made.text()
            body = await made.json()
            assert body["open_league"] is True and body["move_seconds"] == 30
            assert body["badge"] == league.OPEN_LEAGUE_BADGE
            room_id = body["room"]["id"]
            labels = [row["text"] for row in body["room"]["labels"]]
            assert league.OPEN_LEAGUE_BADGE in labels and "Ranked" in labels
            assert server.store.room(room_id)["open_league"] == 1

            listing = await (await client.get("/api/open-league", headers=auth(ada_token))).json()
            assert listing["badge"] == league.OPEN_LEAGUE_BADGE and listing["move_seconds"] == 30
            assert any(row["id"] == "hex" for row in listing["games"])
            assert listing["talking_games"]["state"] == "design-only"
            assert any(row["id"] == "mafia" for row in listing["talking_games"]["games"])

            # The clock is the league's, not the ladder's: sixteen seconds is not late.
            a = await connect(client, room_id, key_a)
            b = await connect(client, room_id, key_b)
            assert (await a.result(1, t="cmd", action="move", args=["a1"]))["ok"]
            server.rooms.turn_since[room_id] = server.clock() - 16
            assert server.rooms.check_clocks(server.clock()) == []
            await a.ws.close()
            await b.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_a_live_bot_game_can_be_watched_and_a_human_table_cannot(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            eve, eve_token = await sign_in(client, "Eve")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, key_b = await make_bot(client, bea_token, "Robo B")
            made = await client.post("/api/ladder", json={"game": "hex", "opponent": bot_b["id"]}, headers=auth(key_a))
            room_id = (await made.json())["room"]["id"]
            a = await connect(client, room_id, key_a)
            b = await connect(client, room_id, key_b)
            assert (await a.result(1, t="cmd", action="move", args=["a1"]))["ok"]

            live = await (await client.get("/api/spectate")).json()
            games = [row for row in live["live"] if row["id"] == room_id]
            assert games, live
            row = games[0]
            assert {seat["name"] for seat in row["seats"]} == {"Robo A", "Robo B"}
            assert row["watch_url"] == f"/t/{room_id}" and row["turn"] in {"white", "black"}

            # A table with a person in it is not public watching.
            human = await open_room(client, eve_token, game="hex")
            human_id = human["room"]["id"]
            assert not [item for item in (await (await client.get("/api/spectate")).json())["live"]
                        if item["id"] == human_id]
            await a.ws.close()
            await b.ws.close()
        finally:
            await client.close()
    run(scenario())


def test_a_finished_leg_leaves_a_replay(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_a, key_a = await make_bot(client, ada_token, "Robo A")
            bot_b, key_b = await make_bot(client, bea_token, "Robo B")
            made = await client.post("/api/ladder", json={"game": "hex", "opponent": bot_b["id"]}, headers=auth(key_a))
            room_id = (await made.json())["room"]["id"]
            a = await connect(client, room_id, key_a)
            b = await connect(client, room_id, key_b)
            assert (await a.result(1, t="cmd", action="move", args=["a1"]))["ok"]
            assert (await b.result(2, t="cmd", action="move", args=["b1"]))["ok"]
            assert (await b.result(3, t="cmd", action="resign"))["ok"]
            await a.ws.close()
            await b.ws.close()

            replay = await (await client.get(f"/api/matches/{room_id}/1")).json()
            assert replay["match"]["game"] == "hex" and replay["match"]["winner"] == "white"
            assert replay["replay"]["kind"] == "moves" and replay["replay"]["moves"] == ["a1", "b1"]
            assert (await client.get(f"/api/matches/{room_id}/9")).status == 404
            assert (await client.get("/api/matches/nope/1")).status == 404
        finally:
            await client.close()
    run(scenario())


def test_challenge_this_bot(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            bot_b, key_b = await make_bot(client, bea_token, "Robo B")
            own, _ = await make_bot(client, bea_token, "Robo Own")

            same = await client.post(f"/api/bots/{own['id']}/challenge", json={"game": "hex"}, headers=auth(bea_token))
            assert same.status == 400 and "yours" in (await same.json())["error"]

            made = await client.post(f"/api/bots/{bot_b['id']}/challenge", json={"game": "hex"}, headers=auth(ada_token))
            assert made.status == 200, await made.text()
            body = await made.json()
            assert body["invite"] and body["room"]["game"] == "hex"
            room_id = body["room"]["id"]

            # The bot's owner sees it, with the challenger's name.
            listed = await (await client.get("/api/challenges", headers=auth(bea_token))).json()
            rows = [row for row in listed["challenges"] if row["bot_id"] == bot_b["id"]]
            assert rows and rows[0]["challenger"] == "Ada" and rows[0]["room_id"] == room_id

            # A stranger cannot decline somebody else's invitation.
            eve, eve_token = await sign_in(client, "Eve")
            refused = await client.post(f"/api/challenges/{rows[0]['id']}/decline", headers=auth(eve_token))
            assert refused.status == 403

            # The invited bot takes the seat and plays as a badged bot.
            socket = await connect(client, room_id, key_b, invite=body["invite"])
            picture = await socket.until(lambda m: m.get("t") == "state"
                                         and m["picture"]["seats"][1]["id"] == bot_b["id"])
            assert picture["picture"]["seats"][1]["bot"] is True
            assert picture["picture"]["seats"][1]["name"] == "Robo B"
            await socket.ws.close()

            # A decline closes the table and answers once.
            other = await client.post(f"/api/bots/{bot_b['id']}/challenge", json={"game": "hex"}, headers=auth(ada_token))
            second = (await other.json())["challenge"]
            declined = await client.post(f"/api/challenges/{second['id']}/decline", headers=auth(bea_token))
            assert declined.status == 200, await declined.text()
            assert server.store.room(second["room_id"])["closed"] == 1
            again = await client.post(f"/api/challenges/{second['id']}/decline", headers=auth(bea_token))
            assert again.status == 409
        finally:
            await client.close()
    run(scenario())


def test_card_bouts_run_on_the_server_and_leave_a_replay(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")

            saved = await client.post("/api/cards", json={"game": "doctrine", "card": doctrine_card("Ada Card", 90)},
                                      headers=auth(ada_token))
            assert saved.status == 200, await saved.text()
            mine = (await saved.json())["card"]
            theirs = (await (await client.post("/api/cards", json={"game": "doctrine", "card": doctrine_card("Bea Card", 20)},
                                               headers=auth(bea_token))).json())["card"]
            assert mine["id"] != theirs["id"]

            listed = await (await client.get("/api/cards", headers=auth(ada_token))).json()
            assert [row["name"] for row in listed["cards"]] == ["Ada Card"]
            assert listed["games"] == ["doctrine", "doctrine_arena"]

            same_owner = await client.post("/api/card-arena", json={"game": "doctrine", "mine": mine["id"], "theirs": mine["id"]},
                                           headers=auth(ada_token))
            assert same_owner.status == 400

            played = await client.post("/api/card-arena", json={"game": "doctrine", "mine": mine["id"], "theirs": theirs["id"]},
                                       headers=auth(ada_token))
            assert played.status == 200, await played.text()
            body = await played.json()
            assert body["bout"]["winner"] in {"one", "two", ""}
            assert body["bout"]["plies"] > 1 and body["bout"]["seed"]
            assert body["bout"]["one_rating"]["games"] == 1

            replay = await (await client.get(body["bout"]["replay_url"])).json()
            assert replay["bout"]["game"] == "doctrine" and replay["replay"]["frames"]
            assert replay["bout"]["one_name"] == "Ada Card"

            # A bad card is refused with a plain sentence, and posting an arena card works.
            bad = await client.post("/api/cards", json={"game": "doctrine", "card": {"schema": "doctrine-card/1"}},
                                    headers=auth(ada_token))
            assert bad.status == 400 and (await bad.json())["error"]
            arena = await client.post("/api/cards", json={"game": "doctrine_arena", "card": arena_card()},
                                      headers=auth(ada_token))
            assert arena.status == 200, await arena.text()
            bout = await client.post("/api/card-arena", json={"game": "doctrine_arena",
                                                              "mine": (await arena.json())["card"]["id"],
                                                              "theirs": mine["id"]}, headers=auth(ada_token))
            assert bout.status == 400  # different games cannot fight
        finally:
            await client.close()
    run(scenario())


def test_the_stock_league_is_a_design_page_not_a_game(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            body = await (await client.get("/api/stock-league")).json()
            assert body["state"] == "design-only" and body["badge"] == "Labs · experiment"
            assert body["needs"] and body["next"]
        finally:
            await client.close()
    run(scenario())
