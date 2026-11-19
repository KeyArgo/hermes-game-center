"""The owner's matchmaking, server side (PLAN-MATCH, lane S).

Play <game> asks people who accept that game, the one who has waited longest since a
game first, one person at a time, sixty seconds each. A game played but not accepted
is accepted for twenty minutes and can be made permanent.
"""
from pathlib import Path
import asyncio
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from online import presence as lobby_presence  # noqa: E402
from online.requests import REQUESTABLE, Service  # noqa: E402
from online.rooms import Rooms, load_games  # noqa: E402
from online.store import Store  # noqa: E402

LOADED = load_games()

OFFER_SECONDS = 60
TEMP_SECONDS = 1200


class Clock:
    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


class FakeHub:
    """status() and online_players() from dicts; send_to() records (player id, frame)."""

    def __init__(self):
        self.statuses: dict[str, str | None] = {}
        self.online: set[str] = set()
        self.sent: list[tuple[str, dict]] = []

    def status(self, player_id):
        return self.statuses.get(player_id)

    def online_players(self):
        return set(self.online)

    async def send_to(self, player_id, frame):
        self.sent.append((player_id, frame))


@pytest.fixture
def world(tmp_path):
    store = Store(tmp_path / "online.sqlite3")
    clock = Clock()
    rooms = Rooms(store, tmp_path, games=LOADED, clock=clock)
    hub = FakeHub()
    service = Service(store, rooms, hub, clock=clock)
    people = {name: store.create_player(name)[0] for name in ("Ada", "Bea", "Eve", "Cal", "Dee")}
    try:
        yield store, rooms, people, clock, hub, service
    finally:
        store.close()


def run(coro):
    return asyncio.run(coro)


def here(hub, *players):
    for player in players:
        hub.statuses[player["id"]] = "online"
        hub.online.add(player["id"])


def offers(hub):
    return [(pid, frame["request"]) for pid, frame in hub.sent if frame.get("t") == "request"]


def seated(hub):
    return {pid: frame for pid, frame in hub.sent if frame.get("t") == "seated"}


def lines(hub, player):
    """The status sentences one person was sent."""
    return [frame for pid, frame in hub.sent
            if pid == player["id"] and frame.get("t") == "looking_status"]


def asked_card(hub):
    told = offers(hub)
    assert told, "nobody was asked"
    card = told[0][1]
    assert {pid for pid, _card in told} == {card["from"]["id"], card["to"]["id"]}, "the offer reaches both"
    return card


async def look(service, player, games=None, **extra):
    frame = {"t": "looking"}
    if games is not None:
        frame["games"] = games
    frame.update(extra)
    return await service.handle(player, frame)


async def ask(service, player, target, game):
    return await service.handle(player, {"t": "request", "to": target["id"], "game": game})


async def accepts(service, player, *games, open_flag=True):
    ack = await service.handle(
        player, {"t": "prefs", "open": open_flag, "games": {game: True for game in games}})
    assert ack["ok"], ack
    return ack


def played_at(store, player, when):
    """The time of this account's last finished game, as the server keeps it."""
    store.db.execute(
        "INSERT INTO availability (player_id, open, updated, invisible, last_game_end) VALUES (?, 0, ?, 0, ?) "
        "ON CONFLICT(player_id) DO UPDATE SET last_game_end = excluded.last_game_end",
        (player["id"], time.time(), float(when)),
    )


# --- who is asked ---------------------------------------------------------------

def test_play_asks_only_people_who_accept_that_game(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea, eve, cal = (people[name] for name in ("Ada", "Bea", "Eve", "Cal"))
        here(hub, ada, bea, eve, cal)
        await accepts(service, bea, "chessboard")
        await accepts(service, eve, "connect4")
        hub.sent.clear()
        started = await look(service, ada, ["chessboard"])
        assert started["ok"], started
        card = asked_card(hub)
        assert card["game"] == "chessboard", "the invite names the game that was asked"
        assert card["offer"] is True
        assert card["from"]["id"] == ada["id"] and card["to"]["id"] == bea["id"]
        assert card["expires"] - card["created"] == pytest.approx(OFFER_SECONDS), "sixty seconds, not ninety"
        assert not any(pid in (eve["id"], cal["id"]) for pid, _card in offers(hub)), \
            "someone who does not accept chess is not asked for chess"
        said = lines(hub, ada)
        assert said and said[-1]["text"] == "Asking Bea — 60 s", said
        assert said[-1]["asking"] == {"id": bea["id"], "name": "Bea"}

    run(scenario())


def test_the_longest_wait_since_a_game_is_asked_first(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea, eve, cal = (people[name] for name in ("Ada", "Bea", "Eve", "Cal"))
        for who, when in ((bea, clock.now - 500), (eve, clock.now - 100), (cal, 0)):
            played_at(store, who, when)
        here(hub, ada, bea, eve, cal)
        for who in (bea, eve, cal):
            await accepts(service, who, "chessboard")
        hub.sent.clear()
        assert (await look(service, ada, ["chessboard"]))["ok"]
        first = asked_card(hub)
        assert first["to"]["id"] == cal["id"], "never played sorts before five hundred seconds"
        hub.sent.clear()
        declined = await service.handle(cal, {"t": "respond", "id": first["id"], "accept": False})
        assert declined["ok"], declined
        second = asked_card(hub)
        assert second["to"]["id"] == bea["id"], "five hundred seconds' wait comes before one hundred"
        hub.sent.clear()
        declined = await service.handle(bea, {"t": "respond", "id": second["id"], "accept": False})
        assert declined["ok"], declined
        assert asked_card(hub)["to"]["id"] == eve["id"], "the shortest wait is asked last, not skipped"

    run(scenario())


def test_an_offer_lasts_sixty_seconds_then_the_next_person_is_asked(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
        played_at(store, bea, clock.now - 500)
        played_at(store, eve, clock.now - 100)
        here(hub, ada, bea, eve)
        await accepts(service, bea, "chessboard")
        await accepts(service, eve, "chessboard")
        hub.sent.clear()
        assert (await look(service, ada, ["chessboard"]))["ok"]
        first = asked_card(hub)
        assert first["to"]["id"] == bea["id"], "the longest wait is asked first"
        await service.expire(first["expires"] - 1)
        assert store.play_request(first["id"])["state"] == "pending", "still open one second before"
        hub.sent.clear()
        await service.expire(first["expires"])
        assert store.play_request(first["id"])["state"] == "expired"
        second = asked_card(hub)
        assert second["to"]["id"] == eve["id"], "the person who has waited next longest is asked at once"
        assert second["game"] == "chessboard"

    run(scenario())


def test_nobody_free_keeps_looking_and_says_so(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        started = await look(service, ada, ["chessboard"])
        assert started["ok"], started
        assert offers(hub) == []
        assert service.looking(ada["id"]) == ["chessboard"], "the search goes on, it does not stop"
        said = lines(hub, ada)
        assert said and said[-1]["text"] == "Nobody is free for Chess right now — still looking.", said
        assert said[-1]["asking"] is None
        # Somebody who accepts the game comes online: the next pass asks them.
        hub.sent.clear()
        await accepts(service, bea, "chessboard")
        assert asked_card(hub)["to"]["id"] == bea["id"]

    run(scenario())


def test_a_search_that_turned_the_game_off_is_not_asked_for_it(world):
    """Looking is not accepting: the switch is what decides who may be asked.

    The search row outlives the twenty-minute accept it opened, so turning the game off
    leaves it behind. A person in that state still has a search running, but they no
    longer take the game, and an offer to them is an offer nobody can answer.
    """
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        played_at(store, bea, clock.now - 500)
        here(hub, ada, bea)
        assert (await look(service, bea, ["chessboard"]))["ok"]
        assert (await service.handle(bea, {"t": "prefs", "games": {"chessboard": False}}))["ok"]
        assert service.accepts(bea["id"], "chessboard") is False
        assert service.looking(bea["id"]) == ["chessboard"], "the search row is still there"
        hub.sent.clear()
        assert (await look(service, ada, ["chessboard"]))["ok"]
        assert not any(card["to"]["id"] == bea["id"] for _pid, card in offers(hub)), \
            "someone whose search no longer accepts the game is not asked for it"

    run(scenario())


def test_only_the_person_asked_can_accept_a_match_offer(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        await accepts(service, bea, "connect4")
        assert (await look(service, ada, ["connect4"]))["ok"]
        card = asked_card(hub)
        own = await service.handle(ada, {"t": "respond", "id": card["id"], "accept": True})
        assert own["ok"] is False and own["text"] == "Only the other player can accept.", own
        hub.sent.clear()
        joined = await service.handle(bea, {"t": "respond", "id": card["id"], "accept": True})
        assert joined["ok"], joined
        assert set(seated(hub)) == {ada["id"], bea["id"]}

    run(scenario())


def test_a_person_is_not_asked_twice_in_the_same_search(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
        here(hub, ada, bea, eve)
        await accepts(service, bea, "connect4")
        await accepts(service, eve, "connect4")
        played_at(store, bea, clock.now - 500)
        played_at(store, eve, clock.now - 100)
        hub.sent.clear()
        assert (await look(service, ada, ["connect4"]))["ok"]
        first = asked_card(hub)
        assert first["to"]["id"] == bea["id"]
        hub.sent.clear()
        declined = await service.handle(bea, {"t": "respond", "id": first["id"], "accept": False})
        assert declined["ok"], declined
        second = asked_card(hub)
        assert second["to"]["id"] == eve["id"], "a decline asks the next person at once"
        hub.sent.clear()
        await service.expire(second["expires"])
        await service.pair_looking(second["expires"])
        assert offers(hub) == [], "both were asked already; nobody is asked a second time"
        assert service.looking(ada["id"]) == ["connect4"]

    run(scenario())


def test_stop_looking_withdraws_the_offer(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        await accepts(service, bea, "go")
        assert (await look(service, ada, ["go"]))["ok"]
        card = asked_card(hub)
        hub.sent.clear()
        assert (await look(service, ada, on=False))["ok"]
        assert service.looking(ada["id"]) == []
        assert store.play_request(card["id"])["state"] == "cancelled", "the person stopped looking"
        told = {pid: frame for pid, frame in hub.sent if frame.get("t") == "request_update"}
        assert told[bea["id"]]["request"]["state"] == "cancelled"
        assert told[ada["id"]]["request"]["state"] == "cancelled"

    run(scenario())


# --- a game played but not accepted: twenty minutes, or for ever -------------------

def test_playing_a_game_you_do_not_accept_accepts_it_for_twenty_minutes(world):
    _store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        started = await look(service, bea, ["connect4"])
        assert started["ok"], started
        assert started.get("ask_always") is True, "the person is offered the permanent choice once"
        assert started["ask_always_games"] == ["connect4"]
        prefs = service.prefs(bea["id"])
        assert prefs["games"]["connect4"] is True, "the game now counts as accepted"
        assert prefs["open"] is False, "the master switch was not touched"
        assert prefs["until"]["connect4"] == pytest.approx(clock.now + TEMP_SECONDS)
        assert service.accepts(bea["id"], "connect4") is True, "accepted with the switch off"
        # So a direct ask for it works, and one for a game she never played does not.
        assert (await ask(service, ada, bea, "connect4"))["ok"]
        assert service.looking(bea["id"]) == ["connect4"]

    run(scenario())


def test_the_window_is_still_open_at_nineteen_minutes(world):
    _store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        started_at = clock.now
        assert (await look(service, bea, ["chessboard"]))["ok"]
        clock.now = started_at + TEMP_SECONDS - 1
        assert service.prefs(bea["id"])["games"]["chessboard"] is True
        assert service.accepts(bea["id"], "chessboard") is True
        assert (await ask(service, ada, bea, "chessboard"))["ok"]

    run(scenario())


def test_the_window_is_over_at_twenty_one_minutes(world):
    store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        started_at = clock.now
        assert (await look(service, bea, ["chessboard"]))["ok"]
        clock.now = started_at + TEMP_SECONDS + 1
        prefs = service.prefs(bea["id"])
        assert prefs["games"]["chessboard"] is False, "an expired twenty minutes counts as off"
        assert prefs["until"] == {}
        assert service.accepts(bea["id"], "chessboard") is False
        refused = await ask(service, ada, bea, "chessboard")
        assert refused["ok"] is False and "requests" in refused["text"].lower(), refused
        # Find match does not ask her either, and the search says so.
        hub.sent.clear()
        assert (await look(service, ada, ["chessboard"]))["ok"]
        assert offers(hub) == []
        assert lines(hub, ada)[-1]["asking"] is None
        assert service.looking(ada["id"]) == ["chessboard"], "her own twenty minutes are still running"
        # The sweep makes the stored row honest again.
        store.clear_expired_windows(clock.now)
        row = store.db.execute(
            "SELECT enabled, until FROM availability_games WHERE player_id = ? AND game = 'chessboard'",
            (bea["id"],)).fetchone()
        assert (row["enabled"], row["until"]) == (0, 0.0)

    run(scenario())


def test_always_makes_it_permanent(world):
    _store, _rooms, people, clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await look(service, bea, ["connect4"]))["ok"]
        ack = await service.handle(bea, {"t": "prefs", "always": {"connect4": True}})
        assert ack["ok"], ack
        prefs = service.prefs(bea["id"])
        assert prefs["open"] is True, "always turns the master switch on for that game"
        assert prefs["games"]["connect4"] is True
        assert prefs["until"] == {}, "there is no window left to show"
        # Playing it again is not a new choice, so there is no prompt.
        again = await look(service, bea, ["connect4"])
        assert again["ok"] and "ask_always" not in again
        # And the choice survives time passing.
        clock.now += TEMP_SECONDS * 3
        assert service.prefs(bea["id"])["games"]["connect4"] is True

    run(scenario())


def test_playing_again_inside_the_window_does_not_ask_always_again(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await look(service, bea, ["go"]))["ok"]
        again = await look(service, bea, ["go"])
        assert again["ok"] and "ask_always" not in again

    run(scenario())


def test_a_twenty_minute_game_is_in_the_roster(world):
    store, rooms, people, clock, hub, service = world

    async def scenario():
        bea = people["Bea"]
        assert (await look(service, bea, ["hex"]))["ok"]

        app = type("App", (), {"store": store, "rooms": rooms})()
        lobby = lobby_presence.Hub(app, clock=clock)
        lobby.players[bea["id"]] = bea
        prefs = {bea["id"]: service.presence_prefs(bea["id"])}
        row = lobby.row(bea["id"], playing=set(), prefs_by_player=prefs)
        assert row["games"] == ["hex"], "the roster shows the game she said yes to for twenty minutes"
        clock.now += TEMP_SECONDS + 1
        prefs = {bea["id"]: service.presence_prefs(bea["id"])}
        assert lobby.row(bea["id"], playing=set(), prefs_by_player=prefs)["games"] == []

    run(scenario())


def test_an_old_client_post_still_saves_and_always_is_taken(tmp_path):
    from aiohttp.test_utils import TestClient, TestServer
    from online.server import App

    async def scenario():
        server = App(tmp_path, games=LOADED)
        client = TestClient(TestServer(server.build()))
        await client.start_server()
        try:
            response = await client.post("/api/session", json={"name": "Ada"})
            body = await response.json()
            ada, token = body["player"], body["token"]
            auth = {"Authorization": f"Bearer {token}"}
            # Yesterday's body, byte for byte: no until, no always.
            old = await client.post("/api/availability", json={"games": {"chessboard": True}}, headers=auth)
            assert old.status == 200, await old.text()
            prefs = await old.json()
            assert prefs["games"]["chessboard"] is True and prefs["until"] == {}
            # The prompt's Yes rides on the same endpoint.
            kept = await client.post("/api/availability", json={"always": {"chessboard": True}}, headers=auth)
            assert kept.status == 200, await kept.text()
            always = await kept.json()
            assert always["open"] is True and always["games"]["chessboard"] is True
            assert always["until"] == {}
            assert server.store.availability_until(ada["id"]) == {}
        finally:
            await client.close()

    run(scenario())


def test_an_old_database_gains_the_new_columns_and_its_last_game(world, tmp_path):
    store, _rooms, people, _clock, _hub, _service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        store.db.execute(
            "INSERT INTO matches (room_id, match_no, game, white_id, black_id, white_name, black_name, "
            "white_kind, black_kind, winner, reason, plies, moves, rated, finished) "
            "VALUES ('r1', 1, 'connect4', ?, ?, 'Ada', 'Bea', 'human', 'human', '', '', 6, '[]', 0, ?)",
            (ada["id"], bea["id"], _clock.now - 300))
        store.close()
        # Opening the same file again is what an upgrade does.
        reopened = Store(store.path)
        try:
            ends = reopened.last_game_ends([ada["id"], bea["id"]])
            assert ends[ada["id"]] == pytest.approx(_clock.now - 300), "the wait is backfilled from matches"
            assert ends[bea["id"]] == pytest.approx(_clock.now - 300)
            columns = {row[1] for row in reopened.db.execute("PRAGMA table_info(availability_games)")}
            assert "until" in columns
        finally:
            reopened.close()

    run(scenario())
