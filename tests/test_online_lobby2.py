"""The lobby: everyone online shows, appear offline
hides you, the request switches are per game, find match pairs by the games the person chose,
a seat ends find match, and lobby posts are stamped and purged after a day.
"""
from pathlib import Path
import asyncio
import importlib.util
import re
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_spec = importlib.util.spec_from_file_location("lobby2_helpers", Path(__file__).with_name("test_online_server.py"))
helpers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helpers)
run, started, sign_in = helpers.run, helpers.started, helpers.sign_in

from online import requests as play_requests  # noqa: E402
from online.requests import NOT_AVAILABLE, REQUESTABLE, Service  # noqa: E402
from online.rooms import Rooms, load_games  # noqa: E402
from online.store import Store  # noqa: E402

LOADED = load_games()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


# --- the presence socket, the way a browser tab or Hermes connects --------------

async def lobby(client, token, kind="web"):
    ws = await client.ws_connect("/api/lobby/socket")
    await ws.send_json({"t": "auth", "token": token, "client": kind})
    return ws, await ws.receive_json()


async def until(ws, predicate, timeout=4):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while True:
        left = end - loop.time()
        assert left > 0, f"timed out waiting; nothing matched"
        frame = await ws.receive_json(timeout=left)
        if predicate(frame):
            return frame


async def ack(ws, frame, op):
    await ws.send_json({**frame, "op": op})
    answer = await until(ws, lambda m: m.get("t") == "ack" and m.get("op") == op)
    return answer


def test_everyone_signed_in_is_listed_as_soon_as_they_are_online(tmp_path):
    """A signed-in person is in the roster from their first lobby connection.

    Not because they queued, said hello or opened a page: the lobby connection is
    what being online means, for a browser tab and for Hermes alike.
    """
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, "Ada")
            bea, bt = await sign_in(client, "Bea")
            a, hello = await lobby(client, at, "hermes")
            assert [row["id"] for row in hello["roster"]] == [ada["id"]]
            # Nobody has queued, looked or said a word.
            assert server.store.db.execute("SELECT COUNT(*) FROM looking").fetchone()[0] == 0
            assert (await (await client.get("/api/lobby", headers=auth(at))).json())["looking"]["connect4"] == 0
            b, hello = await lobby(client, bt)
            assert ada["id"] in [row["id"] for row in hello["roster"]]
            assert server.hub.status(ada["id"]) == "online"
            await until(a, lambda m: m.get("row", {}).get("id") == bea["id"] and m["row"]["status"] == "online")
            for ws in (a, b):
                await ws.close()
        finally:
            await client.close()
    run(scenario())


def test_appear_offline_hides_you_and_stops_requests(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, "Ada")
            bea, bt = await sign_in(client, "Bea")
            a, _ = await lobby(client, at, "hermes")
            b, hello = await lobby(client, bt)
            assert ada["id"] in [row["id"] for row in hello["roster"]]
            assert (await ack(b, {"t": "prefs", "open": True, "games": {"connect4": True}}, "b1"))["ok"]

            hidden = await ack(a, {"t": "prefs", "invisible": True}, "a1")
            assert hidden["ok"], hidden
            # Everyone else loses the row; the person still sees themselves, marked.
            gone = await until(b, lambda m: m.get("t") == "gone" and m.get("id") == ada["id"])
            assert gone["id"] == ada["id"]
            # Her own view keeps her: she is online, she is simply not in anyone else's list.
            assert server.hub.status(ada["id"]) == "online"
            assert server.hub.roster(ada["id"])[0][0]["id"] == ada["id"]
            # A fresh connection of their own still says they are appearing offline.
            a2, hello = await lobby(client, at, "hermes")
            assert hello["you"]["invisible"] is True
            assert ada["id"] in [row["id"] for row in hello["roster"]]
            assert ada["id"] not in [row["id"] for row in server.hub.roster(bea["id"])[0]]
            # Nobody can ask them, and the refusal does not say why.
            ask_hidden = await ack(b, {"t": "request", "to": ada["id"], "game": "connect4"}, "b2")
            assert ask_hidden["ok"] is False and ask_hidden["text"] == NOT_AVAILABLE
            # And an appearing-offline person cannot ask someone else either.
            assert (await ack(b, {"t": "prefs", "open": True}, "b3"))["ok"]
            ask_out = await ack(a, {"t": "request", "to": bea["id"], "game": "connect4"}, "a2")
            assert ask_out["ok"] is False and "offline" in ask_out["text"].lower()
            # Coming back puts them in the roster again.
            assert (await ack(a, {"t": "prefs", "invisible": False}, "a3"))["ok"]
            await until(b, lambda m: m.get("row", {}).get("id") == ada["id"])
            for ws in (a, a2, b):
                await ws.close()
        finally:
            await client.close()
    run(scenario())


def test_appear_offline_is_saved_on_the_account(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, "Ada")
            a, _ = await lobby(client, at)
            assert (await ack(a, {"t": "prefs", "open": True, "games": {"connect4": True}}, "a1"))["ok"]
            assert (await ack(a, {"t": "prefs", "invisible": True}, "a2"))["ok"]
            await a.close()
            # A brand-new connection, as if the browser was closed and opened again.
            again, hello = await lobby(client, at)
            assert hello["you"]["invisible"] is True
            # The request switches were not touched by it, and survive a save of them.
            assert hello["prefs"]["open"] is True and hello["prefs"]["games"]["connect4"] is True
            assert (await ack(again, {"t": "prefs", "games": {"reversi": True}}, "a3"))["ok"]
            assert server.store.invisible(ada["id"]) is True
            assert (await ack(again, {"t": "prefs", "invisible": False}, "a4"))["ok"]
            assert server.store.invisible(ada["id"]) is False
            assert server.store.availability(ada["id"])[0] is True
            await again.close()
        finally:
            await client.close()
    run(scenario())


# --- find match -----------------------------------------------------------------

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
    people = {name: store.create_player(name)[0] for name in ("Ada", "Bea", "Eve", "Cal")}
    try:
        yield store, rooms, people, clock, hub, service
    finally:
        store.close()


def here(hub, *players):
    for player in players:
        hub.statuses[player["id"]] = "online"
        hub.online.add(player["id"])


def offers(hub):
    return [(pid, frame["request"]) for pid, frame in hub.sent if frame.get("t") == "request"]


def seats(hub):
    return {pid: frame for pid, frame in hub.sent if frame.get("t") == "seated"}


async def look(service, player, games=None, **extra):
    frame = {"t": "looking"}
    if games is not None:
        frame["games"] = games
    frame.update(extra)
    return await service.handle(player, frame)


def test_find_match_pairs_two_people_looking_for_the_same_game(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        started_ack = await service.handle(ada, {"t": "looking", "games": ["connect4"], "op": "f1"})
        assert started_ack["ok"] and started_ack["op"] == "f1", started_ack
        assert service.looking(ada["id"]) == ["connect4"]
        assert offers(hub) == [], "one person looking is not a match"
        # Someone looking for another game is not a match either.
        assert (await look(service, bea, ["reversi"]))["ok"]
        assert offers(hub) == [], "Connect Four is not Reversi"
        assert (await look(service, bea, ["gomoku", "connect4"]))["ok"]
        told = offers(hub)
        assert {pid for pid, _ in told} == {ada["id"], bea["id"]}, "the offer reaches both"
        assert {card["game"] for _pid, card in told} == {"connect4"}
        assert all(card["offer"] is True for _pid, card in told), "an offer either side can join"
        assert service.looking(bea["id"]) == ["connect4", "gomoku"]

    run(scenario())


def test_find_match_pairs_with_someone_open_to_requests_and_either_can_join(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        # Bea is not looking; she is simply open to Connect Four requests.
        assert (await service.handle(bea, {"t": "prefs", "open": True, "games": {"connect4": True}}))["ok"]
        hub.sent.clear()
        assert (await look(service, ada, ["connect4"]))["ok"]
        told = offers(hub)
        assert {pid for pid, _ in told} == {ada["id"], bea["id"]}
        rid = told[0][1]["id"]
        hub.sent.clear()
        # The person who was merely open can join it.
        joined = await service.handle(bea, {"t": "respond", "id": rid, "accept": True})
        assert joined["ok"], joined
        seated = seats(hub)
        assert set(seated) == {ada["id"], bea["id"]}
        room = store.room(seated[ada["id"]]["room_id"])
        state = _rooms.state(room)
        assert {state["white_id"], state["black_id"]} == {ada["id"], bea["id"]}
        assert room["public"] == 0 and room["ladder"] == 0
        assert service.looking(ada["id"]) == [], "a seat ends find match"

    run(scenario())


def test_find_match_pairing_is_reachable_by_the_looking_side_too(world):
    """Both sides get the same offer, so either one may sit down."""
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await look(service, ada, ["hex"]))["ok"]
        assert (await look(service, bea, ["hex"]))["ok"]
        told = offers(hub)
        rid = told[0][1]["id"]
        sender = told[0][1]["from"]["id"]
        joiner = ada if sender == bea["id"] else bea
        hub.sent.clear()
        joined = await service.handle(joiner, {"t": "respond", "id": rid, "accept": True})
        assert joined["ok"], joined
        assert set(seats(hub)) == {ada["id"], bea["id"]}
        assert store.play_request(rid)["state"] == "accepted"

    run(scenario())


def test_find_match_never_invites_someone_already_at_a_table(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
        here(hub, ada, bea, eve)
        hub.statuses[bea["id"]] = "playing"
        assert (await look(service, bea, ["connect4"]))["ok"]
        hub.sent.clear()
        assert (await look(service, ada, ["connect4"]))["ok"]
        told = offers(hub)
        assert not any(pid == bea["id"] for pid, _card in told), \
            "nobody at an active table is invited to another one"
        assert hub.status(bea["id"]) == "playing", "they stay listed as playing"
        # The same for someone merely open to requests: Eve is open, so Ada is offered
        # to her the moment she opens up - but Bea, who is at a table, never is.
        hub.sent.clear()
        assert (await service.handle(eve, {"t": "prefs", "open": True, "games": {"connect4": True}}))["ok"]
        told = offers(hub)
        assert {pid for pid, _card in told} == {ada["id"], eve["id"]}, told
        assert not any(pid == bea["id"] for pid, _card in told)
        assert {card["game"] for _pid, card in told} == {"connect4"}

    run(scenario())


def test_find_match_skips_an_appearing_offline_person(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await service.handle(bea, {"t": "prefs", "invisible": True}))["ok"]
        assert (await look(service, ada, ["connect4"]))["ok"]
        assert offers(hub) == []
        # An appearing-offline person cannot look either, and stops looking if they were.
        hidden = await look(service, bea, ["connect4"])
        assert hidden["ok"] is False and "offline" in hidden["text"].lower(), hidden
        assert (await service.handle(bea, {"t": "prefs", "invisible": False}))["ok"]
        assert (await look(service, bea, ["go"]))["ok"]
        assert (await service.handle(bea, {"t": "prefs", "invisible": True}))["ok"]
        assert service.looking(bea["id"]) == [], "appearing offline stops find match"

    run(scenario())


def test_find_match_stops_by_hand_and_by_a_seat(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await look(service, ada, ["connect4", "go"]))["ok"]
        assert service.looking(ada["id"]) == ["connect4", "go"]
        stopped = await look(service, ada, on=False)
        assert stopped["ok"] and service.looking(ada["id"]) == []
        assert (await look(service, ada, ["connect4"]))["ok"]
        # An offer that is answered elsewhere takes the pair out of the pool.
        assert (await look(service, bea, ["connect4"]))["ok"]
        rid = offers(hub)[0][1]["id"]
        await service.handle(bea, {"t": "respond", "id": rid, "accept": True})
        assert service.looking(ada["id"]) == [] and service.looking(bea["id"]) == []
        assert store.db.execute("SELECT COUNT(*) FROM looking").fetchone()[0] == 0

    run(scenario())


def test_find_match_takes_every_game_at_once(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await look(service, ada, all=True))["ok"]
        assert service.looking(ada["id"]) == sorted(REQUESTABLE)
        assert (await look(service, bea, ["seabattle"]))["ok"]
        told = offers(hub)
        assert {pid for pid, _ in told} == {ada["id"], bea["id"]}
        assert {card["game"] for _pid, card in told} == {"seabattle"}
        assert (await look(service, ada, ["blackjack"]))["ok"] is False
        assert (await look(service, ada, []))["ok"] is False

    run(scenario())


def test_a_match_offer_is_only_ever_one_at_a_time(world):
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea, eve = people["Ada"], people["Bea"], people["Eve"]
        here(hub, ada, bea, eve)
        assert (await look(service, ada, ["connect4"]))["ok"]
        assert (await look(service, bea, ["connect4"]))["ok"]
        assert len(offers(hub)) == 2
        hub.sent.clear()
        # A third person looking for the same game does not get piled onto the pair.
        assert (await look(service, eve, ["connect4"]))["ok"]
        assert {pid for pid, _card in offers(hub)} == set()

    run(scenario())


def test_a_declined_offer_is_not_re_offered_at_once(world):
    store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        assert (await look(service, ada, ["checkers"]))["ok"]
        assert (await look(service, bea, ["checkers"]))["ok"]
        rid = offers(hub)[0][1]["id"]
        hub.sent.clear()
        declined = await service.handle(bea, {"t": "respond", "id": rid, "accept": False})
        assert declined["ok"], declined
        assert store.play_request(rid)["state"] == "declined"
        hub.sent.clear()
        # Looking again, and any later pairing pass, leaves the pair alone for ten minutes.
        assert (await look(service, ada, ["checkers"]))["ok"]
        assert offers(hub) == []

    run(scenario())


def test_requests_from_the_switches_still_work_as_before(world):
    """The per-game switches are the same availability the direct ask already used."""
    _store, _rooms, people, _clock, hub, service = world

    async def scenario():
        ada, bea = people["Ada"], people["Bea"]
        here(hub, ada, bea)
        for game in REQUESTABLE:
            assert (await service.handle(bea, {"t": "prefs", "games": {game: True}}))["ok"]
        assert (await service.handle(bea, {"t": "prefs", "open": True}))["ok"]
        asked = await service.handle(ada, {"t": "request", "to": bea["id"], "game": "seabattle"})
        assert asked["ok"], asked
        card = next(frame["request"] for _pid, frame in hub.sent if frame.get("t") == "request")
        assert card["offer"] is False, "a direct ask is not a match offer"
        assert (await service.handle(ada, {"t": "cancel", "id": card["id"]}))["ok"]

    run(scenario())


# --- lobby posts: date, time and a one-day shelf life ----------------------------

def test_lobby_posts_are_stamped_and_a_day_old_posts_are_purged(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, "Ada")
            fresh = await client.post("/api/lobby/chat", json={"text": "anyone for connect4?"}, headers=auth(at))
            assert fresh.status == 200, await fresh.text()
            posted = (await fresh.json())["message"]
            assert isinstance(posted["at"], (int, float)) and abs(posted["at"] - time.time()) < 30
            old = server.store.add_chat("__lobby__", ada["id"], "Ada", "player", "yesterday's news")
            server.store.db.execute("UPDATE chat SET at = ? WHERE id = ?", (time.time() - 25 * 3600, old["id"]))
            listed = (await (await client.get("/api/lobby/chat")).json())["messages"]
            assert [row["text"] for row in listed] == ["anyone for connect4?"], listed

            # The janitor deletes the old post rather than only hiding it.
            task = asyncio.create_task(server.janitor(server.build()))
            await asyncio.sleep(0.2)
            task.cancel()
            left = [dict(row) for row in server.store.db.execute("SELECT text FROM chat WHERE room_id = '__lobby__'")]
            assert [row["text"] for row in left] == ["anyone for connect4?"], left
            # A post older than the day but there in the database is gone from the answer too.
            server.store.db.execute("UPDATE chat SET at = ? WHERE room_id = '__lobby__'",
                                    (time.time() - 25 * 3600,))
            assert (await (await client.get("/api/lobby/chat")).json())["messages"] == []
        finally:
            await client.close()
    run(scenario())


def test_the_janitor_also_keeps_find_match_tidy(tmp_path):
    """Looking rows from someone who went offline do not sit in the pool for ever."""
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, "Ada")
            server.store.set_looking(ada["id"], ["connect4"], time.time())
            task = asyncio.create_task(server.janitor(server.build()))
            await asyncio.sleep(0.2)
            task.cancel()
            assert server.store.looking_games(ada["id"]) == [], "nobody is looking while offline"
        finally:
            await client.close()
    run(scenario())


# --- the Hermes side: the lobby connection is not tied to the lobby page ---------

def _fake_online(monkeypatch, started_flag):
    from dashboard import plugin_api

    class Source:
        on = True
        name = "Ada"
        url = "http://127.0.0.1:1"

        def refresh(self):
            return None

        def check_queue(self):
            return None

        def snapshot(self):
            return {"on": True, "url": self.url, "linked": True, "name": "Ada", "disclosure": "",
                    "offline": False, "offline_text": "", "game": "", "looking": {}, "waiting_names": [],
                    "match": None, "alerts": {}, "ladder": {}, "bot": {"id": "", "name": ""}, "fresh": False,
                    "staff": {"role": "", "name": "", "key": False, "powers": []}}

        def set_ladder(self, *_a, **_k):
            return None

        def poll_alert(self):
            return None

        def live_alert(self):
            return None

        def turn_on(self):
            return None

    class Ladder:
        def status(self):
            return {}

    class Hall:
        def start(self):
            started_flag.append("start")

        def snapshot(self):
            return {"state": "live", "you": {}, "prefs": {}, "roster": [], "requests": [], "seated": None}

    hall = Hall()
    monkeypatch.setattr(plugin_api, "_online_pair", lambda: (Source(), Ladder()))
    monkeypatch.setattr(plugin_api, "_online_hall", lambda _source: hall)
    return plugin_api, hall


def test_the_hall_connection_is_kept_up_by_any_poll_not_only_the_lobby_page(monkeypatch):
    started_flag = []
    plugin_api, hall = _fake_online(monkeypatch, started_flag)
    plugin_api.online_view()
    assert "start" in started_flag, "any online poll keeps the lobby connection up"
    started_flag.clear()
    plugin_api.online_on()
    assert "start" in started_flag, "turning online play on opens it too"
    # A GET of the lobby snapshot itself still opens it lazily (contract D).
    started_flag.clear()
    plugin_api.online_hall_view()
    assert "start" in started_flag


def test_the_hall_offers_a_find_match_door(tmp_path):
    """The plugin's hall carries the looking frames the page sends it."""
    from shelf.online_hall import Hall as PluginHall
    from shelf.online_source import Online

    source = Online(tmp_path, url="http://127.0.0.1:1", secret=lambda _n: "")
    hall = PluginHall(source)
    assert hall.looking(["connect4"])["ok"] is False, "not connected: it says so rather than queueing"
    assert hall.looking("connect4")["ok"] is False
    assert hall.looking({"connect4": True})["ok"] is False
    assert hall.looking([])["ok"] is False


# --- the two UIs list every game the server can seat ----------------------------

def _js_list(path: Path, name: str) -> list[str]:
    text = path.read_text(encoding="utf-8")
    block = re.search(rf"{name}\s*=\s*\[(.*?)\n\]", text, re.S)
    assert block, f"{path.name} has no {name}"
    return re.findall(r"\['([a-z0-9_]+)',\s*'[^']*'\]", block.group(1))


def test_hermes_lobby_lists_every_game_the_server_can_seat():
    ids = _js_list(ROOT / "desktop" / "src" / "72-lobby.js", "LOBBY_GAMES")
    assert sorted(ids) == sorted(REQUESTABLE), ids


def test_the_website_lobby_lists_every_game_the_server_can_seat():
    text = (ROOT / "online" / "web" / "app.js").read_text(encoding="utf-8")
    block = re.search(r"const REQUESTABLE_GAMES = \[(.*?)\n\]", text, re.S)
    assert block, "the website has no REQUESTABLE_GAMES list"
    pairs = re.findall(r"\['([a-z0-9_]+)',\s*'([^']+)'\]", block.group(1))
    listed = [game for game, _title in pairs]
    assert sorted(set(listed)) == sorted(REQUESTABLE), listed
    titles = dict(pairs)
    assert titles["connect4"] == "Connect Four" and titles["seabattle"] == "Sea Battle"


def test_the_lobby_panel_is_half_its_width_and_the_games_gain_a_column():
    home = (ROOT / "desktop" / "src" / "70-home.js").read_text(encoding="utf-8")
    assert "minmax(110px, 140px)" in home, "the lobby column is half its old width"
    assert "minmax(220px, 280px)" not in home
    tiles = re.search(r"gridTemplateColumns: 'repeat\(auto-fill, minmax\(min\(100%, (\d+)px\), 1fr\)\)'", home)
    assert tiles, "the game card grid is unchanged"
    assert int(tiles.group(1)) < 260, "the freed width buys one more column of game cards"
