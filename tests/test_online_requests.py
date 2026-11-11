"""Play requests: availability defaults, refusal rules, seating, and the REST twins."""
from pathlib import Path
import asyncio
import sys
import time

from aiohttp.test_utils import TestClient, TestServer
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from online import requests as play_requests  # noqa: E402
from online.requests import NOT_AVAILABLE, REQUESTABLE, Service  # noqa: E402
from online.rooms import Rooms, load_games  # noqa: E402
from online.server import App  # noqa: E402
from online.store import Store  # noqa: E402

LOADED = load_games()


class Clock:
    """Starts at real time: tables stamp activity with time.time()."""

    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


class FakeHub:
    """status() from a dict, send_to() appended as (player id, frame)."""

    def __init__(self):
        self.statuses: dict[str, str | None] = {}
        self.sent: list[tuple[str, dict]] = []

    def status(self, player_id: str):
        return self.statuses.get(player_id)

    async def send_to(self, player_id: str, frame: dict):
        self.sent.append((player_id, frame))


@pytest.fixture
def world(tmp_path):
    store = Store(tmp_path / "online.sqlite3")
    clock = Clock()
    rooms = Rooms(store, tmp_path, games=LOADED, clock=clock)
    hub = FakeHub()
    service = Service(store, rooms, hub, clock=clock)
    people = {name: store.create_player(name)[0] for name in ("Ada", "Bea", "Eve")}
    try:
        yield store, rooms, people, clock, hub, service
    finally:
        store.close()


def run(coro):
    return asyncio.run(coro)


async def open_up(service, hub, *players):
    for player in players:
        hub.statuses[player["id"]] = "online"
        ack = await service.handle(player, {"t": "prefs", "open": True})
        assert ack["ok"], ack


async def ask(service, player, target, game):
    return await service.handle(player, {"t": "request", "to": target["id"], "game": game})


def test_defaults_off(world):
    store, _rooms, people, _clock, _hub, service = world
    tables = {row[0] for row in store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"availability", "availability_games", "play_requests"} <= tables
    prefs = service.prefs(people["Ada"]["id"])
    assert prefs == {"open": False, "games": {game: False for game in REQUESTABLE}}
    assert service.pending_for(people["Ada"]["id"]) == []


def test_open_with_no_games_enables_all_requestable(world):
    _store, _rooms, people, _clock, _hub, service = world

    async def scenario():
        ada = people["Ada"]
        ack = await service.handle(ada, {"t": "prefs", "open": True, "op": "p1"})
        assert ack["t"] == "ack" and ack["op"] == "p1" and ack["ok"]
        assert service.prefs(ada["id"]) == {"open": True, "games": {game: True for game in REQUESTABLE}}

    run(scenario())


def test_open_false_keeps_choices(world):
    _store, _rooms, people, _clock, _hub, service = world

    async def scenario():
        ada = people["Ada"]
        ack = await service.handle(ada, {"t": "prefs", "games": {"connect4": True, "go": False}})
        assert ack["ok"], ack
        chosen = service.prefs(ada["id"])
        assert chosen["open"] is False
        assert chosen["games"]["connect4"] is True
        assert chosen["games"]["go"] is False
        assert chosen["games"]["reversi"] is False
        # Games are already set, so opening does not turn the rest on.
        assert (await service.handle(ada, {"t": "prefs", "open": True}))["ok"]
        opened = service.prefs(ada["id"])
        assert opened["open"] is True and opened["games"] == chosen["games"]
        assert (await service.handle(ada, {"t": "prefs", "open": False}))["ok"]
        closed = service.prefs(ada["id"])
        assert closed["open"] is False and closed["games"] == chosen["games"]

    run(scenario())


def test_cannot_request_self(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada = people["Ada"]
        hub.statuses[ada["id"]] = "online"
        await service.handle(ada, {"t": "prefs", "open": True})
        ack = await ask(service, ada, ada, "connect4")
        assert not ack["ok"] and "someone else" in ack["text"].lower()
        assert store.db.execute("SELECT COUNT(*) FROM play_requests").fetchone()[0] == 0

    run(scenario())


def test_bots_cannot_request(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        bot = store.create_bot(ada["id"], "Rook")[0]
        await open_up(service, hub, ada, bea)
        hub.statuses[bot["id"]] = "online"
        to_bot = await ask(service, ada, bot, "connect4")
        from_bot = await ask(service, bot, bea, "connect4")
        assert not to_bot["ok"] and not from_bot["ok"]
        assert to_bot["text"] == from_bot["text"]
        assert "bot" in to_bot["text"].lower()
        assert store.db.execute("SELECT COUNT(*) FROM play_requests").fetchone()[0] == 0

    run(scenario())


def test_blackjack_and_slots_refused(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        blackjack = await ask(service, ada, bea, "blackjack")
        slots = await ask(service, ada, bea, "slots")
        assert not blackjack["ok"] and not slots["ok"]
        assert blackjack["text"] == slots["text"]
        assert "cannot be requested" in blackjack["text"]
        assert store.db.execute("SELECT COUNT(*) FROM play_requests").fetchone()[0] == 0

    run(scenario())


def test_target_away_playing_or_offline(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        seen = {}
        for label, status in (("away", "away"), ("playing", "playing"), ("offline", None)):
            hub.statuses[bea["id"]] = status
            ack = await ask(service, ada, bea, "connect4")
            assert not ack["ok"], label
            seen[label] = ack["text"]
        assert "away" in seen["away"].lower()
        assert "game" in seen["playing"].lower()
        assert "offline" in seen["offline"].lower()
        assert len(set(seen.values())) == 3
        hub.statuses[bea["id"]] = "online"
        assert (await ask(service, ada, bea, "connect4"))["ok"]

    run(scenario())


def test_game_disabled(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await service.handle(bea, {"t": "prefs", "games": {"connect4": False}}))["ok"]
        prefs = service.prefs(bea["id"])
        assert prefs["open"] is True and prefs["games"]["connect4"] is False
        assert prefs["games"]["reversi"] is True
        refused = await ask(service, ada, bea, "connect4")
        assert not refused["ok"] and "that game" in refused["text"].lower()
        assert (await ask(service, ada, bea, "reversi"))["ok"]

    run(scenario())


def test_block_either_way_is_generic(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        texts = []
        for blocker, blocked in ((ada, bea), (bea, ada)):
            store.db.execute("DELETE FROM blocks")
            store.db.execute(
                "INSERT INTO blocks (player_id, blocked_id, at) VALUES (?, ?, ?)",
                (blocker["id"], blocked["id"], clock.now),
            )
            ack = await ask(service, ada, bea, "connect4")
            assert not ack["ok"]
            texts.append(ack["text"])
        assert texts[0] == texts[1] == NOT_AVAILABLE
        assert "block" not in texts[0].lower()
        assert store.db.execute("SELECT COUNT(*) FROM play_requests").fetchone()[0] == 0

    run(scenario())


def test_eight_requests_per_hour(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        start = clock.now
        for _ in range(8):
            ack = await ask(service, ada, bea, "connect4")
            assert ack["ok"], ack
            pending = service.pending_for(ada["id"])
            assert len(pending) == 1
            cancelled = await service.handle(ada, {"t": "cancel", "id": pending[0]["id"]})
            assert cancelled["ok"], cancelled
        ninth = await ask(service, ada, bea, "connect4")
        assert not ninth["ok"] and "hour" in ninth["text"].lower()
        assert store.requests_sent_since(ada["id"], start - 1) == 8
        clock.now = start + 3600 + 1
        assert (await ask(service, ada, bea, "connect4"))["ok"]

    run(scenario())


def test_one_pending_per_pair(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, "connect4"))["ok"]
        again = await ask(service, ada, bea, "reversi")
        reverse = await ask(service, bea, ada, "gomoku")
        assert not again["ok"] and not reverse["ok"]
        assert again["text"] == reverse["text"]
        assert "already" in again["text"].lower()
        # The other person cannot cancel it out from under the sender.
        rid = service.pending_for(ada["id"])[0]["id"]
        assert not (await service.handle(bea, {"t": "cancel", "id": rid}))["ok"]
        assert (await service.handle(ada, {"t": "cancel", "id": rid}))["ok"]
        assert (await ask(service, bea, ada, "gomoku"))["ok"]

    run(scenario())


def test_five_inbound_pending(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        bea = people["Bea"]
        senders = [people["Ada"], people["Eve"]]
        senders += [store.create_player(name)[0] for name in ("Cal", "Dee", "Fay", "Gus")]
        await open_up(service, hub, bea, *senders)
        for sender in senders[:5]:
            ack = await ask(service, sender, bea, "connect4")
            assert ack["ok"], ack
        extra = await ask(service, senders[5], bea, "connect4")
        assert not extra["ok"] and "waiting" in extra["text"].lower()
        assert len(service.pending_for(bea["id"])) == 5

    run(scenario())


def test_decline_cooldown(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, "connect4"))["ok"]
        rid = service.pending_for(bea["id"])[0]["id"]
        hub.sent.clear()
        declined = await service.handle(bea, {"t": "respond", "id": rid, "accept": False})
        assert declined["ok"]
        assert hub.sent and {frame["t"] for _pid, frame in hub.sent} == {"request_update"}
        assert {frame["request"]["state"] for _pid, frame in hub.sent} == {"declined"}
        again = await ask(service, ada, bea, "connect4")
        reverse = await ask(service, bea, ada, "connect4")
        assert not again["ok"] and not reverse["ok"]
        assert "declined" in again["text"].lower() and again["text"] == reverse["text"]
        # A different game is not on cooldown. Cancel it so the pair is free again.
        assert (await ask(service, ada, bea, "reversi"))["ok"]
        other = service.pending_for(ada["id"])[0]["id"]
        assert (await service.handle(ada, {"t": "cancel", "id": other}))["ok"]
        created = store.play_request(rid)["created"]
        clock.now = created + 599
        assert not (await ask(service, ada, bea, "connect4"))["ok"]
        clock.now = created + 601
        assert (await ask(service, ada, bea, "connect4"))["ok"]

    run(scenario())


def test_expiry_at_90_seconds(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, "hex"))["ok"]
        req = service.pending_for(ada["id"])[0]
        assert req["expires"] - req["created"] == pytest.approx(90)
        assert req["state"] == "pending" and req["game"] == "hex"
        await service.expire(req["expires"] - 1)
        assert service.pending_for(ada["id"]) and store.play_request(req["id"])["state"] == "pending"
        hub.sent.clear()
        expired = await service.expire(req["expires"])
        assert expired == 1
        assert service.pending_for(ada["id"]) == []
        assert store.play_request(req["id"])["state"] == "expired"
        assert {frame["t"] for _pid, frame in hub.sent} == {"request_update"}
        assert {frame["request"]["state"] for _pid, frame in hub.sent} == {"expired"}

    run(scenario())


def _room_for(hub, store):
    room_ids = {frame["room_id"] for _pid, frame in hub.sent if frame.get("t") == "seated"}
    assert len(room_ids) == 1
    return store.room(room_ids.pop())


def test_accept_seats_both_in_private_unrated_room(world):
    store, rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, "connect4"))["ok"]
        req = service.pending_for(bea["id"])[0]
        told = {pid for pid, frame in hub.sent if frame.get("t") == "request"}
        assert told == {ada["id"], bea["id"]}
        hub.sent.clear()
        ack = await service.handle(bea, {"t": "respond", "id": req["id"], "accept": True, "op": "yes"})
        assert ack["ok"] and ack["op"] == "yes"
        room = _room_for(hub, store)
        assert room["public"] == 0 and room["ladder"] == 0 and room["pair_id"] == ""
        assert store.db.execute(
            "SELECT COUNT(*) FROM invites WHERE room_id = ?", (room["id"],)).fetchone()[0] == 0
        state = rooms.state(room)
        assert state["white_id"] == ada["id"] and state["black_id"] == bea["id"]
        seated = {pid: frame for pid, frame in hub.sent if frame.get("t") == "seated"}
        assert set(seated) == {ada["id"], bea["id"]}
        assert seated[ada["id"]]["side"] == "white" and seated[bea["id"]]["side"] == "black"
        assert seated[ada["id"]]["opponent"] == {"id": bea["id"], "name": "Bea"}
        assert seated[bea["id"]]["opponent"] == {"id": ada["id"], "name": "Ada"}
        assert seated[ada["id"]]["game"] == "connect4" and seated[ada["id"]]["request_id"] == req["id"]
        assert seated[ada["id"]]["room_id"] == room["id"] == seated[bea["id"]]["room_id"]
        assert {frame["request"]["state"] for _pid, frame in hub.sent if frame.get("t") == "request_update"} == {"accepted"}
        assert store.play_request(req["id"])["state"] == "accepted"
        assert store.play_request(req["id"])["room_id"] == room["id"]

    run(scenario())


def test_duplicate_accept_same_room(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, "connect4"))["ok"]
        rid = service.pending_for(bea["id"])[0]["id"]
        first = await service.handle(bea, {"t": "respond", "id": rid, "accept": True})
        hub.sent.clear()
        second = await service.handle(bea, {"t": "respond", "id": rid, "accept": True})
        assert first["ok"] and second["ok"]
        rooms_open = store.db.execute("SELECT COUNT(*) FROM rooms WHERE closed = 0").fetchone()[0]
        assert rooms_open == 1
        again = {frame["room_id"] for _pid, frame in hub.sent if frame.get("t") == "seated"}
        assert again == {store.play_request(rid)["room_id"]}

    run(scenario())


def test_concurrent_accepts_one_room(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        await open_up(service, hub, ada, bea)
        assert (await ask(service, ada, bea, "checkers"))["ok"]
        rid = service.pending_for(bea["id"])[0]["id"]

        async def accept():
            return await service.handle(bea, {"t": "respond", "id": rid, "accept": True})

        one, two = await asyncio.gather(accept(), accept())
        assert one["ok"] and two["ok"]
        assert store.db.execute("SELECT COUNT(*) FROM rooms WHERE closed = 0").fetchone()[0] == 1
        room_ids = {frame["room_id"] for _pid, frame in hub.sent if frame.get("t") == "seated"}
        assert room_ids == {store.play_request(rid)["room_id"]}

    run(scenario())


def test_other_pending_become_unavailable(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
        cal = store.create_player("Cal")[0]
        await open_up(service, hub, ada, bea, eve, cal)
        assert (await ask(service, ada, bea, "connect4"))["ok"]
        assert (await ask(service, ada, eve, "reversi"))["ok"]
        assert (await ask(service, cal, bea, "checkers"))["ok"]
        assert (await ask(service, eve, cal, "gomoku"))["ok"]
        rid = next(item["id"] for item in service.pending_for(ada["id"]) if item["game"] == "connect4")
        hub.sent.clear()
        assert (await service.handle(bea, {"t": "respond", "id": rid, "accept": True}))["ok"]
        states = {
            (row["from_id"], row["to_id"], row["game"]): row["state"]
            for row in store.db.execute("SELECT from_id, to_id, game, state FROM play_requests")
        }
        assert states[(ada["id"], bea["id"], "connect4")] == "accepted"
        assert states[(ada["id"], eve["id"], "reversi")] == "unavailable"
        assert states[(cal["id"], bea["id"], "checkers")] == "unavailable"
        assert states[(eve["id"], cal["id"], "gomoku")] == "pending"
        unavailable = {
            (frame["request"]["from"]["id"], frame["request"]["to"]["id"], frame["request"]["game"])
            for _pid, frame in hub.sent
            if frame.get("t") == "request_update" and frame["request"]["state"] == "unavailable"
        }
        assert unavailable == {
            (ada["id"], eve["id"], "reversi"),
            (cal["id"], bea["id"], "checkers"),
        }
        assert service.pending_for(eve["id"])[0]["game"] == "gomoku"

    run(scenario())


def test_rest_twins(tmp_path):
    async def scenario():
        server = App(tmp_path, games=LOADED)
        client = TestClient(TestServer(server.build()))
        await client.start_server()
        try:
            assert (await client.get("/api/availability")).status == 401
            assert (await client.get("/api/requests")).status == 401
            assert (await client.post("/api/requests", json={"to": "x", "game": "connect4"})).status == 401

            async def sign_in(name):
                response = await client.post("/api/session", json={"name": name})
                assert response.status == 200, await response.text()
                body = await response.json()
                return body["player"], body["token"]

            def auth(token):
                return {"Authorization": f"Bearer {token}"}

            ada, ada_token = await sign_in("Ada")
            bea, bea_token = await sign_in("Bea")
            eve, eve_token = await sign_in("Eve")
            hub = FakeHub()
            server.presence = type("Presence", (), {"hub": hub})()
            for person in (ada, bea, eve):
                hub.statuses[person["id"]] = "online"

            opened = await client.post("/api/availability", json={"open": True}, headers=auth(ada_token))
            assert opened.status == 200, await opened.text()
            prefs = await opened.json()
            assert prefs["open"] is True
            assert prefs["games"] == {game: True for game in REQUESTABLE}
            closed = await client.post("/api/availability", json={"open": False}, headers=auth(ada_token))
            kept = await closed.json()
            assert kept["open"] is False and kept["games"] == prefs["games"]
            listed = await (await client.get("/api/availability", headers=auth(ada_token))).json()
            assert listed == kept
            assert (await client.post("/api/availability", json={"open": True}, headers=auth(ada_token))).status == 200
            assert (await client.post("/api/availability", json={"open": True}, headers=auth(bea_token))).status == 200
            assert (await client.post("/api/availability", json={"open": True}, headers=auth(eve_token))).status == 200

            self_ask = await client.post(
                "/api/requests", json={"to": ada["id"], "game": "connect4"}, headers=auth(ada_token))
            assert self_ask.status == 400
            assert "someone else" in (await self_ask.json())["text"].lower()

            made = await client.post(
                "/api/requests", json={"to": bea["id"], "game": "connect4"}, headers=auth(ada_token))
            assert made.status == 200, await made.text()
            body = await made.json()
            assert body["ok"] and body["request"]["state"] == "pending"
            assert body["request"]["from"]["id"] == ada["id"] and body["request"]["to"]["id"] == bea["id"]
            rid = body["request"]["id"]
            ada_list = await (await client.get("/api/requests", headers=auth(ada_token))).json()
            bea_list = await (await client.get("/api/requests", headers=auth(bea_token))).json()
            assert ada_list["requests"][0]["id"] == rid == bea_list["requests"][0]["id"]

            accepted = await client.post(f"/api/requests/{rid}", json={"accept": True}, headers=auth(bea_token))
            assert accepted.status == 200, await accepted.text()
            room_ids = {frame["room_id"] for _pid, frame in hub.sent if frame.get("t") == "seated"}
            assert len(room_ids) == 1
            room = server.store.room(room_ids.pop())
            state = server.rooms.state(room)
            assert room["public"] == 0 and room["ladder"] == 0 and room["pair_id"] == ""
            assert state["white_id"] == ada["id"] and state["black_id"] == bea["id"]
            assert server.store.db.execute(
                "SELECT COUNT(*) FROM invites WHERE room_id = ?", (room["id"],)).fetchone()[0] == 0
            assert (await client.get("/api/requests", headers=auth(ada_token))).status == 200
            assert (await (await client.get("/api/requests", headers=auth(ada_token))).json())["requests"] == []

            other = await client.post(
                "/api/requests", json={"to": eve["id"], "game": "go"}, headers=auth(ada_token))
            assert other.status == 200, await other.text()
            other_id = (await other.json())["request"]["id"]
            cancelled = await client.post(
                f"/api/requests/{other_id}", json={"cancel": True}, headers=auth(ada_token))
            assert cancelled.status == 200, await cancelled.text()
            assert server.store.play_request(other_id)["state"] == "cancelled"

            declined_post = await client.post(
                "/api/requests", json={"to": eve["id"], "game": "hex"}, headers=auth(bea_token))
            assert declined_post.status == 200, await declined_post.text()
            decline_id = (await declined_post.json())["request"]["id"]
            declined = await client.post(
                f"/api/requests/{decline_id}", json={"accept": False}, headers=auth(eve_token))
            assert declined.status == 200, await declined.text()
            assert server.store.play_request(decline_id)["state"] == "declined"
            assert play_requests.service is server.requests
        finally:
            await client.close()

    run(scenario())
