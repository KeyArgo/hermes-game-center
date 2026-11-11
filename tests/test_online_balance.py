"""Recording what each account holds: the balance endpoint, and the note the dock sends.

Two halves. The server half runs the real App over a real client and pins the four things
that matter about a self-reported number: it needs a key, a bad value is refused, one write
per account per ten seconds, the last write wins and the history stays short. The source half
pins the sender: nothing while online play is off, nothing when the totals did not change,
one note every thirty seconds at most, and silence when anything goes wrong.

Every number here is self-reported play money. Nothing in the server, and nothing the dock
sends, can make it a leaderboard, a rating or a match result - and one test says so directly,
by using the tables the endpoint writes to prove they are read by nothing else.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
from pathlib import Path
from urllib import error as urlerror
from urllib.parse import urlsplit

import pytest
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from online import guard  # noqa: E402
from online.rooms import load_games  # noqa: E402
from online.server import App  # noqa: E402
from online.store import Store  # noqa: E402
from shelf import online_source  # noqa: E402
from shelf.wallet import START_CHIPS  # noqa: E402

LOADED = load_games()


# ---------------------------------------------------------------------------
# The server: one row per account, written by that account's own computer.
# ---------------------------------------------------------------------------


def run(coro):
    return asyncio.run(coro)


async def started(tmp_path):
    server = App(tmp_path, games=LOADED, clock=lambda: 1700000000.0)
    client = TestClient(TestServer(server.build()))
    await client.start_server()
    return server, client


async def sign_in(client, name):
    response = await client.post("/api/session", json={"name": name})
    assert response.status == 200, await response.text()
    body = await response.json()
    return body["player"], body["token"]


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_the_route_the_dock_calls_is_the_route_the_server_has(tmp_path):
    """The two halves of this feature have to agree on one path: /api/balance."""
    server = App(tmp_path, games=LOADED)
    try:
        routes = {(route.method, getattr(route.resource, "canonical", None))
                  for route in server.build().router.routes()}
    finally:
        server.store.close()
    assert ("POST", "/api/balance") in routes
    assert ("GET", "/api/balance") in routes


def test_a_balance_needs_a_key(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            assert (await client.post("/api/balance", json={"chips": 1, "points": 2})).status == 401
            assert (await client.get("/api/balance")).status == 401
            assert (await client.post("/api/balance", json={"chips": 1, "points": 2},
                                      headers=auth("not-a-real-token"))).status == 401
            assert (await client.get("/api/balance", headers=auth("not-a-real-token"))).status == 401
            ada, ada_token = await sign_in(client, "Ada")
            assert server.store.balance(ada["id"]) is None, "a refused write stored nothing"
            taken = await client.post("/api/balance", json={"chips": 5, "points": 6}, headers=auth(ada_token))
            assert taken.status == 200, await taken.text()
        finally:
            await client.close()

    run(scenario())


@pytest.mark.parametrize("body", [
    {},
    {"chips": 10},
    {"points": 10},
    {"chips": -1, "points": 0},
    {"chips": 0, "points": -1},
    {"chips": 1.5, "points": 0},
    {"chips": 0, "points": 2.0},
    {"chips": "10", "points": 0},
    {"chips": None, "points": 0},
    {"chips": True, "points": 0},
    {"chips": 0, "points": False},
    {"chips": 10 ** 16, "points": 0},
])
def test_only_whole_numbers_of_zero_or_more_are_taken(tmp_path, body):
    """A fraction, a boolean, a string or a negative is a client bug, not a wallet."""
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            refused = await client.post("/api/balance", json=body, headers=auth(ada_token))
            assert refused.status == 400, f"{body} was accepted"
            assert server.store.balance(ada["id"]) is None
            # A refused value does not spend the account's one-write budget: the same
            # client can send a fixed value at once.
            good = await client.post("/api/balance", json={"chips": 7, "points": 8}, headers=auth(ada_token))
            assert good.status == 200, await good.text()
            assert server.store.balance(ada["id"])["chips"] == 7
        finally:
            await client.close()

    run(scenario())


def test_one_write_every_ten_seconds_per_account(tmp_path):
    async def scenario():
        clock = [1000.0]
        server, client = await started(tmp_path)
        try:
            server.balance_limit = guard.Limiter(1, 10.0, clock=lambda: clock[0])
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            first = await client.post("/api/balance", json={"chips": 100, "points": 1}, headers=auth(ada_token))
            assert first.status == 200
            too_soon = await client.post("/api/balance", json={"chips": 200, "points": 2}, headers=auth(ada_token))
            assert too_soon.status == 429
            assert server.store.balance(ada["id"])["chips"] == 100, "the refused write changed nothing"
            # The limit is per account, not per address: another person is unaffected.
            other = await client.post("/api/balance", json={"chips": 300, "points": 3}, headers=auth(bea_token))
            assert other.status == 200
            clock[0] += 9.9
            assert (await client.post("/api/balance", json={"chips": 200, "points": 2},
                                      headers=auth(ada_token))).status == 429
            clock[0] += 0.2
            allowed = await client.post("/api/balance", json={"chips": 200, "points": 2}, headers=auth(ada_token))
            assert allowed.status == 200
            assert server.store.balance(ada["id"])["chips"] == 200
        finally:
            await client.close()

    run(scenario())


def test_the_last_write_wins_and_history_keeps_the_order(tmp_path):
    async def scenario():
        clock = [1000.0]
        server, client = await started(tmp_path)
        try:
            server.balance_limit = guard.Limiter(1, 10.0, clock=lambda: clock[0])
            ada, ada_token = await sign_in(client, "Ada")
            for chips, points in ((500, 0), (450, 1), (900, 4)):
                clock[0] += 10
                answer = await client.post("/api/balance", json={"chips": chips, "points": points},
                                           headers=auth(ada_token))
                assert answer.status == 200, await answer.text()
                stored = await answer.json()
                assert stored["balance"]["chips"] == chips and stored["balance"]["points"] == points
                assert stored["balance"]["player_id"] == ada["id"]
            mine = await (await client.get("/api/balance", headers=auth(ada_token))).json()
            assert mine["balance"]["chips"] == 900 and mine["balance"]["points"] == 4
            log = server.store.balance_log(ada["id"])
            assert [(row["chips"], row["points"]) for row in log] == [(900, 4), (450, 1), (500, 0)]
            assert log[0]["at"] >= log[-1]["at"]
        finally:
            await client.close()

    run(scenario())


def test_an_account_reads_only_its_own_balance(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            assert (await client.post("/api/balance", json={"chips": 1234, "points": 56},
                                      headers=auth(ada_token))).status == 200
            mine = await (await client.get("/api/balance", headers=auth(ada_token))).json()
            assert mine["balance"]["chips"] == 1234
            theirs = await (await client.get("/api/balance", headers=auth(bea_token))).json()
            assert theirs["balance"]["chips"] == 0 and theirs["balance"]["points"] == 0
            assert theirs["balance"]["player_id"] == bea["id"]
        finally:
            await client.close()

    run(scenario())


def test_the_history_stops_at_a_hundred_per_account(tmp_path):
    store = Store(tmp_path / "online.sqlite3")
    try:
        ada, _ = store.create_player("Ada")
        bea, _ = store.create_player("Bea")
        for step in range(105):
            store.set_balance(ada["id"], step, step * 2, now=1000.0 + step)
        for step in range(3):
            store.set_balance(bea["id"], step, 0, now=1000.0 + step)

        log = store.balance_log(ada["id"])
        assert len(log) == 100, "one account cannot grow this table without bound"
        assert log[0]["chips"] == 104, "the newest change is kept"
        assert log[-1]["chips"] == 5, "the five oldest were dropped"
        assert store.balance_log(ada["id"], limit=1000)[-1]["chips"] == 5
        # One account's cap never touches another's rows.
        assert len(store.balance_log(bea["id"])) == 3
        assert store.balance(ada["id"])["chips"] == 104 and store.balance(ada["id"])["points"] == 208
        assert store.balance(ada["id"])["updated"] == 1104.0
    finally:
        store.close()


def test_the_tables_come_along_on_an_older_database(tmp_path):
    """The tables are additive: an existing database gains them and keeps its rows."""
    path = tmp_path / "online.sqlite3"
    legacy = sqlite3.connect(str(path))
    legacy.executescript(
        "CREATE TABLE players (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,"
        " public INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL, seen REAL NOT NULL);"
    )
    legacy.execute("INSERT INTO players VALUES ('web:old', 'hash', 'Old Ada', 1, 1.0, 1.0)")
    legacy.commit()
    legacy.close()

    store = Store(path)
    try:
        assert store.player("web:old")["name"] == "Old Ada"
        store.set_balance("web:old", 42, 3, now=1234.0)
        assert store.balance("web:old") == {"player_id": "web:old", "chips": 42, "points": 3, "updated": 1234.0}
    finally:
        store.close()


def test_a_balance_never_reaches_a_leaderboard_or_a_rating(tmp_path):
    """A self-reported number is a note, not a score: no read path can see it."""
    store = Store(tmp_path / "online.sqlite3")
    try:
        ada, _ = store.create_player("Ada")
        store.update_player(ada["id"], public=True)
        store.set_balance(ada["id"], 10 ** 9, 10 ** 6, now=5.0)
        assert store.balance(ada["id"])["chips"] == 10 ** 9
        # None of the ranked read paths know anything about it.
        assert store.stats(ada["id"]) == {"rated": [], "bots": []}
        assert store.leaderboard("connect4") == []
        assert store.leaderboard("connect4", pool="bots") == []
        assert store.rating_info(ada["id"], "connect4") == (1200, 0)
        # A finished result is what a board is built from, and it carries no chips.
        store.db.execute(
            "INSERT INTO ratings (player_id, game, rating, games, wins, losses, draws) VALUES (?, ?, ?, 1, 1, 0, 0)",
            (ada["id"], "connect4", 1216.0))
        row = store.leaderboard("connect4")[0]
        assert row["rating"] == 1216 and "chips" not in row and "points" not in row
    finally:
        store.close()


# ---------------------------------------------------------------------------
# The dock's side: one quiet note, when the wallet changed.
# ---------------------------------------------------------------------------


class Recorder:
    """Stands in for urlopen: remembers every request and answers with what it is told."""

    def __init__(self, answer=None, status=200):
        self.answer = {"ok": True} if answer is None else answer
        self.status = status
        self.calls: list[dict] = []

    def __call__(self, request, timeout=0):
        raw = request.data
        self.calls.append({
            "method": request.get_method(),
            "path": urlsplit(request.full_url).path,
            "body": json.loads(raw.decode("utf-8")) if raw else None,
            "auth": request.get_header("Authorization") or "",
        })
        if self.status == 0:
            raise urlerror.URLError("down")
        payload = json.dumps(self.answer).encode()
        opener = self

        class Answer:
            status = opener.status

            def read(self, limit=0):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Answer()

    @property
    def notes(self) -> list[dict]:
        """Only the balance writes this recorder saw."""
        return [call for call in self.calls if call["path"] == "/api/balance"]


def put_wallet(folder: Path, chips: int, points: int, **extra) -> Path:
    path = folder / "wallet.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chips": chips, "bonus": points, **extra}), encoding="utf-8")
    return path


def a_source(folder: Path, opener: Recorder, clock: list) -> online_source.Online:
    source = online_source.Online(folder, opener=opener, secret=lambda name: "key-1",
                                  clock=lambda: clock[0])
    source.turn_on()
    return source


def test_nothing_is_sent_while_online_play_is_off(tmp_path):
    put_wallet(tmp_path, 9000, 7)
    opener = Recorder()
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "key-1")
    assert source.report_balance() is False
    source.refresh()
    source.snapshot()
    assert opener.calls == [], "off means no address is opened at all"


def test_nothing_is_sent_when_nobody_is_signed_in(tmp_path):
    put_wallet(tmp_path, 9000, 7)
    opener = Recorder()
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "")
    source.turn_on()
    assert source.report_balance() is False
    source.refresh()
    assert opener.notes == []
    assert opener.calls, "the lobby read itself still happens"


def test_a_changed_wallet_goes_up_once_and_an_unchanged_one_does_not(tmp_path):
    opener = Recorder()
    source = a_source(tmp_path, opener, [1000.0])
    put_wallet(tmp_path, 9000, 7)
    assert source.report_balance() is True
    assert opener.notes[0]["body"] == {"chips": 9000, "points": 7}
    assert opener.notes[0]["auth"] == "Bearer key-1", "the write carries the account's own key"
    assert source.report_balance() is False, "the same totals are not sent twice"
    assert len(opener.notes) == 1


def test_a_second_change_waits_out_the_thirty_seconds(tmp_path):
    clock = [1000.0]
    opener = Recorder()
    source = a_source(tmp_path, opener, clock)
    put_wallet(tmp_path, 10000, 0)
    assert source.report_balance() is True
    put_wallet(tmp_path, 9500, 0)
    clock[0] += 5
    assert source.report_balance() is False, "a change inside the window waits"
    assert [note["body"]["chips"] for note in opener.notes] == [10000]
    clock[0] += 25
    assert source.report_balance() is True
    assert [note["body"]["chips"] for note in opener.notes] == [10000, 9500]
    # The waiting change is what goes up, not every change since: the total, not a delta.
    put_wallet(tmp_path, 9400, 2)
    clock[0] += 30
    assert source.report_balance() is True
    assert opener.notes[-1]["body"] == {"chips": 9400, "points": 2}


def test_the_first_note_carries_what_the_person_sees(tmp_path):
    """A wallet that was never written is the blank one, so the totals are the page's."""
    opener = Recorder()
    source = a_source(tmp_path, opener, [1000.0])
    assert online_source.wallet_totals(tmp_path) == (START_CHIPS, 0)
    assert source.report_balance() is True
    assert opener.notes[0]["body"] == {"chips": START_CHIPS, "points": 0}


def test_only_the_wallet_totals_are_sent(tmp_path):
    opener = Recorder()
    source = a_source(tmp_path, opener, [1000.0])
    put_wallet(tmp_path, 9000, 7, reward=500, tokens=99999, tokens_total=1234567, spins=42, feed=[{"x": 1}])
    assert source.report_balance() is True
    assert opener.notes[0]["body"] == {"chips": 9000, "points": 7}
    # Reward chips minted by the older token route are chips, not points.
    put_wallet(tmp_path, 9000, 0, reward=500)
    assert online_source.wallet_totals(tmp_path) == (9000, 0)


def test_a_broken_wallet_is_no_numbers_rather_than_an_error(tmp_path):
    (tmp_path / "wallet.json").write_text("{not json", encoding="utf-8")
    assert online_source.wallet_totals(tmp_path) == (START_CHIPS, 0)
    put_wallet(tmp_path, 500, 1)
    (tmp_path / "wallet.json").write_text(json.dumps({"chips": "lots", "bonus": "some"}),
                                          encoding="utf-8")
    assert online_source.wallet_totals(tmp_path) == (START_CHIPS, 0)
    # A folder with no wallet at all is the same blank wallet the person's own page shows.
    assert online_source.wallet_totals(tmp_path / "not-there") == (START_CHIPS, 0)


def test_the_wallet_is_only_ever_read(tmp_path):
    path = put_wallet(tmp_path, 9000, 7)
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    opener = Recorder()
    source = a_source(tmp_path, opener, [1000.0])
    assert source.report_balance() is True
    source.refresh()
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before, "the note never writes the wallet"
    assert not (tmp_path / "wallet.lock").exists(), "and does not even take the wallet's lock"


def test_the_refresh_poll_carries_a_changed_wallet(tmp_path):
    """The note rides the poll the dock already makes, so nothing new polls for it."""
    clock = [1000.0]
    opener = Recorder()
    source = a_source(tmp_path, opener, clock)
    put_wallet(tmp_path, 8000, 3)
    source.refresh()
    assert [note["body"] for note in opener.notes] == [{"chips": 8000, "points": 3}]
    assert any(call["path"] == "/api/lobby" for call in opener.calls)
    # A second poll with nothing changed adds no second note.
    clock[0] += 15
    source.refresh()
    assert len(opener.notes) == 1


def test_the_server_being_down_is_not_an_error(tmp_path):
    clock = [1000.0]
    put_wallet(tmp_path, 9000, 7)
    opener = Recorder(status=0)
    source = a_source(tmp_path, opener, clock)
    assert source.report_balance() is False, "a miss is a plain False, never an exception"
    assert source.report_balance() is False, "and the same totals are not retried inside the window"
    assert len(opener.notes) == 1
    view = source.refresh()
    assert view["offline"] is True and view["on"] is True, "local play is untouched"
    clock[0] += 30
    put_wallet(tmp_path, 8500, 7)
    assert source.report_balance() is False
    assert len(opener.notes) == 2, "a change is tried again once the window is up"


def test_a_refusal_is_dropped_in_silence(tmp_path):
    """A 429 is the server's answer, not a local error, and it does not stick."""
    clock = [1000.0]
    opener = Recorder({"error": "Too many balance updates."}, status=429)
    source = a_source(tmp_path, opener, clock)
    put_wallet(tmp_path, 9000, 7)
    assert source.report_balance() is False
    put_wallet(tmp_path, 9000, 9)
    opener.status = 200
    clock[0] += 30
    assert source.report_balance() is True
    assert opener.notes[-1]["body"] == {"chips": 9000, "points": 9}


def test_signing_in_again_sends_the_totals_to_that_account(tmp_path):
    """A new sign-in may be another account, so its totals are not skipped as unchanged."""
    keys = {"value": "key-1"}

    def keep(name, value):
        keys["value"] = value
        return True

    opener = Recorder({"player": {"id": "p1", "name": "Ada"}, "token": "key-1"})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: keys["value"],
                                  store_secret=keep, clock=lambda: 1000.0)
    source.turn_on()
    put_wallet(tmp_path, 5000, 1)
    assert source.report_balance() is True
    assert source.report_balance() is False
    assert source.forget()["ok"] is True
    keys["value"] = ""  # what forget() does to the real credential store
    assert source.report_balance() is False, "signed out: nothing goes up"
    assert source.sign_in("Ada", "key-1")["ok"] is True
    assert keys["value"] == "key-1"
    # The same second, the same totals: the reset at sign-in is what makes this true.
    assert source.report_balance() is True
    assert [note["body"] for note in opener.notes] == [{"chips": 5000, "points": 1},
                                                       {"chips": 5000, "points": 1}]


def test_the_disclosure_says_the_totals_are_sent(tmp_path):
    text = online_source.Online(tmp_path).snapshot()["disclosure"]
    assert "chip and point totals" in text
    assert "never used for a leaderboard" in text
