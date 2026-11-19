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
