"""The online source: off until asked, honest about the server, and the ladder.

Two halves. The first half needs no server: it pins the promises a person can
check by reading - nothing is sent before they say yes, the key only ever goes to
Hermes's credential route, a dead server is a quiet state, and the alert rules
hold. The second half runs the real lobby server on localhost (never the live
site) and proves a match through the queue and a rated ladder game played by a
champion with a fake model.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib import request as urlrequest

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shelf import online_source, ws as wsmod  # noqa: E402
from shelf.ladder import Ladder, choose, estimate_text, move_prompt  # noqa: E402


# ---------------------------------------------------------------------------
# The quiet half: no server, no sockets, just the promises.
# ---------------------------------------------------------------------------


class Opener:
    """Stands in for urlopen and remembers every address it was asked for."""

    def __init__(self, answer=None, status=200):
        self.seen: list[str] = []
        self.answer = answer or {}
        self.status = status

    def __call__(self, request, timeout=0):
        self.seen.append(f"{request.get_method()} {request.full_url}")
        if self.status == 0:
            from urllib.error import URLError

            raise URLError("down")
        body = json.dumps(self.answer).encode()
        opener = self

        class Answer:
            status = opener.status

            def read(self, limit=0):
                return body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Answer()


def test_online_is_off_and_touches_nothing_until_asked(tmp_path):
    opener = Opener()
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "")
    assert source.on is False
    view = source.refresh()
    assert view["on"] is False
    assert opener.seen == []
    # Every action refuses plainly, and still nothing was sent.
    assert source.queue("connect4")["ok"] is False
    assert source.sign_up("Ada")["ok"] is False
    assert source.set_alert("connect4", True)["ok"] is False
    assert opener.seen == []


def test_turning_it_on_uses_the_shipped_address_and_says_what_is_sent(tmp_path):
    opener = Opener()
    source = online_source.Online(tmp_path, opener=opener)
    view = source.turn_on()
    assert view["url"] == "https://games.hermesnet.xyz"
    assert "off until you turn them on" in view["disclosure"]
    assert "recovery key" in view["disclosure"]
    assert "network address" in view["disclosure"]
    assert "telemetry" in view["disclosure"]
    # The wallet's totals go up too, and the paragraph has to say so (and say they are not a score).
    assert "chip and point totals" in view["disclosure"]
    assert "never used for a leaderboard" in view["disclosure"]
    assert opener.seen == [], "turning it on does not send anything by itself"


@pytest.mark.parametrize("raw", ["", "not a url", "ftp://example.com", "https://user@host/", "javascript:alert(1)"])
def test_a_bad_address_falls_back_to_the_default(raw):
    assert online_source.plain_url(raw) == online_source.DEFAULT_URL


def test_the_address_is_a_setting(tmp_path):
    source = online_source.Online(tmp_path, url="http://127.0.0.1:8791/")
    assert source.url == "http://127.0.0.1:8791"


def test_the_secret_goes_through_the_credential_route_only(tmp_path):
    stored: dict[str, str] = {}
    opener = Opener({"player": {"id": "p1", "name": "Ada"}, "token": "key-abc", "created": True})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: stored.get(name, ""),
                                  store_secret=lambda name, value: bool(stored.setdefault(name, value)))
    source.turn_on()
    answer = source.sign_up("Ada")
    assert answer["ok"] is True
    assert stored[online_source.KEY_ENV] == "key-abc", "the key goes to the credential route"
    assert answer["key_to_copy"] == "key-abc", "and is shown once so it can be copied"
    written = (tmp_path / online_source.STATE_FILE).read_text(encoding="utf-8")
    assert "key-abc" not in written, "never in a plain file of ours"
    assert "key-abc" not in json.dumps(source.snapshot()), "never in the page's view"
    assert "key-abc" not in json.dumps(answer.get("online") or {})


def test_a_hermes_without_a_credential_route_asks_the_person_to_paste_it(tmp_path):
    opener = Opener({"player": {"id": "p1", "name": "Ada"}, "token": "key-abc"}, )
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "",
                                  store_secret=lambda name, value: False)
    source.turn_on()
    answer = source.sign_up("Ada")
    assert answer["ok"] is True
    assert answer["stored"] is False
    assert "Plugins > Game Center" in answer["text"]
    assert "key-abc" not in (tmp_path / online_source.STATE_FILE).read_text(encoding="utf-8")


def test_signing_in_keeps_the_key_it_was_given(tmp_path):
    stored: dict[str, str] = {}
    opener = Opener({"player": {"id": "p1", "name": "Ada"}, "token": "key-abc"})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: stored.get(name, ""),
                                  store_secret=lambda name, value: bool(stored.setdefault(name, value)))
    source.turn_on()
    assert source.sign_in("Ada", "key-abc")["ok"] is True
    assert stored[online_source.KEY_ENV] == "key-abc"
    assert source.linked is True


def test_a_dead_server_is_a_plain_state_and_waits_longer_each_time(tmp_path):
    clock = [1000.0]
    opener = Opener(status=0)
    source = online_source.Online(tmp_path, opener=opener, clock=lambda: clock[0], secret=lambda name: "k")
    source.turn_on()
    source.refresh()
    assert source.offline is True
    assert "still works" in source.offline_text
    first = len(opener.seen)
    clock[0] += 5
    source.refresh()
    assert len(opener.seen) == first, "no second try before the backoff is up"
    clock[0] += 15
    source.refresh()
    assert len(opener.seen) == first + 1
    clock[0] += 30
    source.refresh()
    assert len(opener.seen) == first + 2
    clock[0] += 60
    source.refresh()
    assert len(opener.seen) == first + 3
    # The page still answers with the local view while the server is down.
    view = source.snapshot()
    assert view["offline"] is True
    assert view["on"] is True


def test_alerts_need_the_key_and_a_yes_and_are_suppressed_by_a_match(tmp_path):
    opener = Opener({"prefs": {"connect4": True}, "alerts": [{"game": "connect4", "waiting": 2, "at": 500}],
                     "looking": {"connect4": 2}})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "k", clock=lambda: 1000.0)
    source.turn_on()
    assert source.poll_alert() is None, "no game is switched on yet"
    source.set_alert("connect4", True)
    alert = source.poll_alert()
    assert alert and alert["game"] == "connect4"
    assert alert["text"].startswith("2 people")
    # It stays on screen while people are still waiting...
    source.refresh(force=True)
    assert source.live_alert() == alert
    # ...and the same alert is never told twice, even if the server sends it again.
    source._alert_at = 0.0
    assert source.poll_alert() is None
    # When the queue empties, the line clears.
    source._lobby = {"looking": [], "looking_counts": {"connect4": 0}}
    assert source.live_alert() is None


def test_a_queued_person_is_notified_of_their_own_table_not_an_alert(tmp_path):
    opener = Opener({"queued": False, "matched": {"room": {"id": "r1", "game": "connect4",
                                                           "seats": [{"side": "white", "name": "Ada"},
                                                                     {"side": "black", "name": "Bea"}]},
                                                   "side": "black"}})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: "k", clock=lambda: 1000.0)
    source.turn_on()
    source._state["name"] = "Ada"
    source._state["game"] = "connect4"
    view = source.check_queue(force=True)
    match = view["match"]
    assert match and match["room_id"] == "r1"
    assert match["url"] == "https://games.hermesnet.xyz/t/r1"
    assert match["opponent"] == "Ada", "the other seat is the opponent"
    assert match["side"] == "black"


def test_leaving_the_queue_is_plain_even_without_a_key(tmp_path):
    source = online_source.Online(tmp_path, opener=Opener(), secret=lambda name: "")
    source.turn_on()
    assert source.stop_queue()["ok"] is True


def test_a_found_table_survives_a_restart(tmp_path):
    """The queue entry is gone once a table is made, so this line is the only way back."""
    key = {online_source.KEY_ENV: "k"}
    opener = Opener({"queued": False, "matched": {"room": {"id": "r1", "game": "connect4",
                                                           "seats": [{"side": "white", "name": "Ada"},
                                                                     {"side": "black", "name": "Bea"}]},
                                                   "side": "black"}})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: key.get(name, ""),
                                  clock=lambda: 1000.0)
    source.turn_on()
    source.queue("connect4")
    assert source.check_queue(force=True)["match"]["room_id"] == "r1"

    again = online_source.Online(tmp_path, opener=Opener(), secret=lambda name: key.get(name, ""),
                                 clock=lambda: 1100.0)
    kept = again.match()
    assert kept and kept["room_id"] == "r1", "Hermes restarting does not lose the table"
    assert kept["opponent"] == "Ada"
    assert kept["url"] == "https://games.hermesnet.xyz/t/r1"

    # "Not now" still means gone, even after another restart.
    again.dismiss_match()
    after = online_source.Online(tmp_path, opener=Opener(), secret=lambda name: key.get(name, ""),
                                 clock=lambda: 1200.0)
    assert after.match() is None


def test_a_table_left_too_long_is_dropped_after_a_restart(tmp_path):
    key = {online_source.KEY_ENV: "k"}
    opener = Opener({"queued": False, "matched": {"room": {"id": "r1", "game": "connect4"},
                                                   "side": "black"}})
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: key.get(name, ""),
                                  clock=lambda: 1000.0)
    source.turn_on()
    source.queue("connect4")
    source.check_queue(force=True)
    late = online_source.Online(tmp_path, opener=Opener(), secret=lambda name: key.get(name, ""),
                                clock=lambda: 1000.0 + online_source.MATCH_KEEP_SECONDS + 1)
    assert late.match() is None, "a stale table link is not offered as if it still worked"


def test_an_alert_the_lobby_refuses_is_not_ticked(tmp_path):
    """A ticked box that the server never received would never fire."""
    key = {online_source.KEY_ENV: "k"}
    down = online_source.Online(tmp_path, opener=Opener(status=0), secret=lambda name: key.get(name, ""))
    down.turn_on()
    answer = down.set_alert("connect4", True)
    assert answer["ok"] is False and answer.get("offline") is True
    assert down.alerts() == {}, "a failed request leaves the alert off"

    refused = online_source.Online(tmp_path, opener=Opener({"error": "no alerts for you"}, status=403),
                                   secret=lambda name: key.get(name, ""))
    refused.turn_on()
    assert refused.set_alert("connect4", True)["ok"] is False
    assert refused.alerts() == {}

    accepted = online_source.Online(tmp_path, opener=Opener({"prefs": {"connect4": True}}),
                                    secret=lambda name: key.get(name, ""))
    accepted.turn_on()
    assert accepted.set_alert("connect4", True)["ok"] is True
    assert accepted.alerts() == {"connect4": True}


def test_the_disclosure_names_the_setting_address(tmp_path):
    source = online_source.Online(tmp_path, url="http://127.0.0.1:8791")
    assert "http://127.0.0.1:8791" in source.snapshot()["disclosure"]


# ---------------------------------------------------------------------------
# The ladder's own pieces, still without a server.
# ---------------------------------------------------------------------------


def test_the_estimate_says_how_much_model_use_it_is():
    text = estimate_text(21, "Connect Four")
    assert "about 21 model calls" in text
    assert "on this computer" in text
    assert "15 seconds a move" in text


def test_the_prompt_is_the_board_and_the_legal_moves_only():
    picture = {"cells": [["w", ".", "b"]], "legal": ["1", "3"], "moves": ["1", "3"], "plies": 2}
    prompt, names = move_prompt(picture, "white", "Connect Four")
    assert "w . b" in prompt
    assert "Legal moves: 1, 3" in prompt
    assert "Reply with exactly one legal move" in prompt
    assert names == {"1": "1", "3": "3"}


def test_a_named_move_is_taken_and_a_stray_answer_still_moves():
    assert choose(" 3. ", {"1": "1", "3": "3"}, ["1", "3"]) == ("3", True)
    assert choose("I would rather not", {"1": "1", "3": "3"}, ["1", "3"]) == ("1", False)


def test_the_ladder_refuses_before_online_play_is_on(tmp_path):
    source = online_source.Online(tmp_path, opener=Opener(), secret=lambda name: "k")
    ladder = Ladder(source, ask=lambda who, system, prompt: {"move": "1"})
    assert ladder.start(game="connect4")["ok"] is False
    assert ladder.status()["state"] == "idle"


# ---------------------------------------------------------------------------
# The real half: a lobby server on localhost.
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class Server:
    """The real online/server.py App, run on localhost with the test's own limits.

    It is the same application and the same routes the deploy runs; only the
    per-minute caps are lifted, because one test client stands in for several
    people from a single address and would otherwise trip the public limiter.
    """

    def __init__(self, root: Path):
        self.root = root
        self.port = _free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        env = dict(os.environ)
        env["PYTHONPATH"] = str(ROOT) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        launcher = (
            "from pathlib import Path\n"
            "from aiohttp import web\n"
            "from online.server import App\n"
            f"app = App(Path({str(root)!r}), api_per_minute=100000, signups_per_hour=100000)\n"
            f"web.run_app(app.build(), host='127.0.0.1', port={self.port}, print=lambda *a, **k: None)\n"
        )
        self.process = subprocess.Popen(
            [sys.executable, "-c", launcher],
            cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )

    def wait(self, seconds: float = 30.0) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return True
            except OSError:
                time.sleep(0.05)
        return False

    def stop(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()


class Keys:
    """A stand-in for Hermes's credential store, scoped to one test."""

    def __init__(self):
        self.values: dict[str, str] = {}

    def read(self, name: str) -> str:
        return self.values.get(name, "")

    def write(self, name: str, value: str) -> bool:
        self.values[name] = value
        return True


@pytest.fixture(scope="module")
def lobby(tmp_path_factory):
    server = Server(tmp_path_factory.mktemp("online-source-lobby"))
    try:
        assert server.wait(), "the lobby server did not start"
        yield server
    finally:
        server.stop()


def _source(root: Path, base: str, keys: Keys) -> online_source.Online:
    return online_source.Online(root, url=base, secret=keys.read, store_secret=keys.write)


def _sign_up(base: str, name: str) -> tuple[dict, str]:
    from urllib import request as urlrequest

    req = urlrequest.Request(base + "/api/session", data=json.dumps({"name": name}).encode(),
                             method="POST", headers={"Content-Type": "application/json"})
    with urlrequest.urlopen(req, timeout=10) as answer:
        body = json.loads(answer.read())
    return body["player"], body["token"]


def test_two_people_match_through_the_queue(lobby, tmp_path):
    """The Desktop's Find a match and the website's queue meet in the middle."""
    keys = Keys()
    desk = _source(tmp_path / "desk", lobby.base, keys)
    desk.turn_on()
    assert desk.sign_up("Desk Ada")["ok"] is True

    other, other_key = _sign_up(lobby.base, "Web Bea")

    first = desk.queue("connect4", "intermediate", "Connect Four")
    assert first["ok"] is True, first
    assert first["online"]["game"] == "connect4"

    # The website joins the same queue, the way its own page does.
    from urllib import request as urlrequest

    req = urlrequest.Request(lobby.base + "/api/queue", data=json.dumps({"game": "connect4"}).encode(),
                             method="POST", headers={"Content-Type": "application/json",
                                                     "Authorization": f"Bearer {other_key}"})
    with urlrequest.urlopen(req, timeout=10) as answer:
        site = json.loads(answer.read())
    assert site["matched"], "the second person is matched at once"

    view = desk.check_queue(force=True)
    match = view["match"]
    assert match, "the Desktop page is told about the same table"
    assert match["game"] == "connect4"
    assert match["opponent"] == "Web Bea"
    assert match["url"].startswith(lobby.base + "/t/")

    # And the lobby counts the person who is still waiting.
    third = _source(tmp_path / "third", lobby.base, Keys())
    third.turn_on()
    third.sign_up("Third Cy")
    third.queue("reversi")
    fresh = third.refresh(force=True)
    assert fresh["looking"].get("reversi") == 1


def test_the_server_being_down_never_breaks_local_play(lobby, tmp_path):
    keys = Keys()
    source = _source(tmp_path / "offline", f"http://127.0.0.1:{_free_port()}", keys)
    source.turn_on()
    view = source.refresh(force=True)
    assert view["offline"] is True
    assert "still works" in view["offline_text"]
    # Choosing a name while the server is down is an offline answer, not an error.
    answer = source.sign_up("Ada")
    assert answer["ok"] is False and answer["offline"] is True
    # And a queue ask without a name refuses locally, without a request.
    assert source.queue("connect4")["ok"] is False
    # Nothing about the local shelf changed: the same object still answers.
    assert view["on"] is True


def test_a_champion_plays_a_rated_ladder_game_with_a_fake_model(lobby, tmp_path, monkeypatch):
    keys = Keys()
    source = _source(tmp_path / "champ", lobby.base, keys)
    source.turn_on()
    assert source.sign_up("Ladder Ada")["ok"] is True
    bot = source.ensure_bot("Iron Vanguard")
    assert bot["ok"] is True, bot
    assert keys.values[online_source.BOT_KEY_ENV] == bot["key"]

    # Another owner's bot, waiting in the ladder queue.
    other, other_key = _sign_up(lobby.base, "Ladder Bea")
    from urllib import request as urlrequest

    def call(path, body=None, key=""):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        req = urlrequest.Request(lobby.base + path, data=data, method="POST" if data else "GET", headers=headers)
        with urlrequest.urlopen(req, timeout=10) as answer:
            return json.loads(answer.read())

    rival_bot = call("/api/bots", {"name": "House Bot"}, other_key)
    rival, rival_key = rival_bot["bot"], rival_bot["key"]

    asked: list[str] = []

    def fake_model(who, system, prompt):
        asked.append(prompt)
        legal = prompt.split("Legal moves: ", 1)[-1].split("\n", 1)[0].split(", ")
        return {"move": legal[0], "tokens": 0}

    ladder = Ladder(source, ask=fake_model, games=lambda game: None)
    state = ladder.start(game="hex", title="Hex", champion={"id": "c1", "name": "Iron Vanguard"})
    assert state["ok"] is True, state

    # The other owner's bot joins the same ladder queue; the server matches them.
    # (Joining is one POST; after that it only reads, because a second POST would
    # take the bot out of a match it has already been put in.)
    call("/api/queue", {"game": "hex"}, rival_key)
    joined = call("/api/queue", None, rival_key)
    for _ in range(15):
        if joined.get("matched"):
            break
        time.sleep(1.0)
        joined = call("/api/queue", None, rival_key)
    assert joined.get("matched"), f"the two bots were matched: {ladder.status()}"

    room = joined["matched"]["room"]["id"]
    side = str(joined["matched"].get("side") or "white")
    play_bot(lobby.base, room, rival_key, side)

    end = time.time() + 60
    while time.time() < end and ladder.status()["state"] not in {"done", "error"}:
        time.sleep(0.2)
    status = ladder.status()
    assert status["state"] == "done", status
    assert "not rated" not in status["text"], f"the game must be rated: {status['text']}"
    assert asked, "the fake model was asked for moves"
    assert status["calls"] >= 2

    career = source.bot_career(bot["id"])
    assert career and career.get("games"), "the ladder recorded the game"
    assert career["games"][0]["games"] >= 1
    assert (career.get("bot") or {}).get("rating", {}).get("hex"), "a rating was recorded"
    assert career.get("history"), "the rating history names the change"
    assert career.get("opponents"), "and it names the opponent"


def play_bot(base: str, room: str, key: str, side: str) -> None:
    """The other bot: read the picture, send one legal move, until the table ends.

    A ranked game is a pair, so after the first table ends this bot walks to the
    pair's other table and plays the second leg with the seats swapped.
    """
    def summary(room_id: str) -> dict:
        with urlrequest.urlopen(base + f"/api/rooms/{room_id}", timeout=10) as answer:
            return (json.loads(answer.read()) or {}).get("room") or {}

    end = time.time() + 120
    for _ in range(2):
        sock = wsmod.Socket(wsmod.socket_url(base, f"/ws/{room}"), timeout=10.0)
        played = -1
        ref = 0
        try:
            sock.send_json({"t": "auth", "token": key})
            while time.time() < end:
                message = sock.receive(timeout=1.0)
                if message is None:
                    continue
                if message.get("t") == "closed":
                    return
                if message.get("t") != "state":
                    continue
                picture = message.get("picture") or {}
                if str(picture.get("status") or "") in {"win", "draw", "resigned", "abandoned"}:
                    break
                legal = picture.get("legal") or []
                permissions = picture.get("permissions") or {}
                plies = int(picture.get("plies") or 0)
                if permissions.get("can_move") and legal and plies != played:
                    played = plies
                    ref += 1
                    sock.send_json({"t": "cmd", "action": "move", "args": [str(legal[0])], "ref": ref})
        finally:
            sock.close()
        room_row = summary(room)
        pair = room_row.get("pair") or {}
        if not (pair.get("waiting") and pair.get("other_room")):
            return
        room = str(pair["other_room"])
        side = "black" if side == "white" else "white"


# ---------------------------------------------------------------------------
# Review findings: three ways the online side could have misbehaved.
# ---------------------------------------------------------------------------


def test_turning_online_play_off_leaves_the_server_queue(tmp_path):
    opener = Opener({"queued": True, "game": "connect4"})
    stored = {online_source.KEY_ENV: "k"}
    source = online_source.Online(tmp_path, opener=opener, secret=lambda name: stored.get(name, ""))
    source.turn_on()
    source._state["game"] = "connect4"
    source.turn_off()
    assert any("DELETE" in line and line.endswith("/api/queue") for line in opener.seen), \
        f"the queue entry must be removed: {opener.seen}"
    assert source.on is False


def test_a_slow_model_cannot_run_past_the_tables_clock(tmp_path, monkeypatch):
    ladder_mod = __import__("shelf.ladder", fromlist=["x"])
    monkeypatch.setattr(ladder_mod, "MOVE_SECONDS", 0.2)
    source = online_source.Online(tmp_path, opener=Opener(), secret=lambda name: "k")

    def slow(who, system, prompt):
        time.sleep(0.5)
        return {"move": "1"}

    ladder = ladder_mod.Ladder(source, ask=slow)
    started = time.monotonic()
    token, calls = ladder._pick({"name": "Slow"}, {"legal": ["1", "2"]}, "white", "Connect Four")
    elapsed = time.monotonic() - started
    assert token == "1", "a legal move is still played"
    assert elapsed < 0.45, f"the whole pick must fit one budget, took {elapsed:.2f}s"
    assert calls >= 1


def test_a_frame_arriving_in_two_pieces_is_not_lost():
    payload = b'{"t":"state"}'
    frame = bytes([0x81, len(payload)]) + payload

    class Pieces:
        def __init__(self, chunks):
            self.chunks = list(chunks)

        def recv(self, count):
            if not self.chunks:
                raise socket.timeout()
            return self.chunks.pop(0)

        def settimeout(self, value):
            pass

    sock = wsmod.Socket.__new__(wsmod.Socket)
    sock.sock = Pieces([frame[:4]])
    sock._buffer = b""
    sock._pieces = []
    sock._opcode = None
    sock._closed = False
    with pytest.raises(TimeoutError):
        sock._read_message()
    sock.sock.chunks.append(frame[4:])
    assert sock._read_message() == '{"t":"state"}', "the header must not be consumed without its payload"
