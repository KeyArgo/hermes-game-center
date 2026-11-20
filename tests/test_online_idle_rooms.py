"""A table nobody is sitting at is not a game.

One Blackjack room was opened and left on 11-18: it stayed open with state 'active', its host
read as "playing" for fifteen hours, and Play skipped them. Presence now counts a room only
while it is active AND someone seated there is connected, or the room was touched in the last
fifteen minutes. The server closes a room with no seated player connected after thirty
quiet minutes; a live seat is not closed by the idle sweep while they are there.
The close is said in the audit log and in journald, and anyone still on the socket
is told before it hangs up.

python3 -m pytest -q tests/test_online_idle_rooms.py
"""
from __future__ import annotations

import asyncio
import logging
import time

from test_online_server import connect, open_room, run, sign_in, started


async def lobby(client, token):
    ws = await client.ws_connect('/api/lobby/socket')
    await ws.send_json({'t': 'auth', 'token': token, 'client': 'web'})
    return ws, await ws.receive_json()


async def a_table(client, name='Ada', other='Bea'):
    """One room with both people seated and connected, as a real match starts."""
    one, one_token = await sign_in(client, name)
    two, two_token = await sign_in(client, other)
    room = (await open_room(client, one_token))['room']
    first = await connect(client, room['id'], one_token)
    second = await connect(client, room['id'], two_token)
    assert (await second.result(1, t='cmd', action='join'))['ok']
    return one, one_token, two, two_token, room, first, second


def quiet_for(server, room_id, seconds):
    """Backdate the room's own activity stamp, the way an abandoned table ages."""
    server.store.db.execute('UPDATE rooms SET active = ? WHERE id = ?',
                            (time.time() - seconds, room_id))


def test_an_abandoned_table_does_not_keep_its_host_playing(tmp_path):
    async def scenario():
        now = {'t': time.time()}
        server, client = await started(tmp_path, clock=lambda: now['t'])
        try:
            ada, ada_token, _bea, _bea_token, room, first, second = await a_table(client)
            assert ada['id'] in server.hub.playing_players()
            await first.ws.close()
            await second.ws.close()
            await asyncio.sleep(.05)
            # Past the disconnect grace with nobody at the table: the room row is still open
            # and its state still 'active', but nobody is playing it.
            now['t'] += 60
            assert server.store.room(room['id'])['closed'] == 0
            assert ada['id'] not in server.hub.playing_players()
            # The shape of the live bug: the host is back in the lobby, and the room is still
            # open and 'active' fifteen hours later. A lobby socket is not a seat at a table,
            # so the host reads as online, not as playing.
            now['t'] += 15 * 3600
            watcher, hello = await lobby(client, ada_token)
            await asyncio.sleep(.05)
            assert ada['id'] in [row['id'] for row in hello['roster']]
            assert ada['id'] not in server.hub.playing_players()
            assert server.hub.status(ada['id']) == 'online'
            await watcher.close()
        finally:
            await client.close()
    run(scenario())


def test_a_table_in_live_play_still_reads_as_playing(tmp_path):
    async def decision_and_play():
        server, client = await started(tmp_path)
        try:
            ada, ada_token, bea, bea_token, room, first, second = await a_table(client)
            # Both are signed in to the lobby as well, which is how the roster sees them.
            a_lobby, _ah = await lobby(client, ada_token)
            b_lobby, _bh = await lobby(client, bea_token)
            for player in (ada, bea):
                assert player['id'] in server.hub.playing_players()
                assert server.hub.status(player['id']) == 'playing'
            # A long think: the room has not been touched for an hour, but both people are
            # still sitting at it, so they are still playing it.
            quiet_for(server, room['id'], 3600)
            assert ada['id'] in server.hub.playing_players()
            assert bea['id'] in server.hub.playing_players()
            await first.ws.close()
            await second.ws.close()
            await a_lobby.close()
            await b_lobby.close()
        finally:
            await client.close()
    run(decision_and_play())


def test_a_disconnected_seat_counts_inside_the_grace_and_frees_after(tmp_path):
    async def scenario():
        now = {'t': time.time()}
        server, client = await started(tmp_path, clock=lambda: now['t'])
        try:
            ada, _at, bea, _bt, _room, first, second = await a_table(client)
            await first.ws.close()
            await second.ws.close()
            await asyncio.sleep(.05)
            # Inside the 45-second disconnect grace, a brief drop still reads as playing.
            now['t'] += 30
            assert ada['id'] in server.hub.playing_players()
            assert bea['id'] in server.hub.playing_players()
            # Past the grace, neither is held as playing — no 15-minute wait.
            now['t'] += 16
            assert ada['id'] not in server.hub.playing_players()
            assert bea['id'] not in server.hub.playing_players()
        finally:
            await client.close()
    run(scenario())


def test_an_empty_table_closes_after_thirty_minutes_and_a_live_seat_stays_open(tmp_path):
    """Nobody seated and connected: thirty minutes. A live seat is not idle-closed at all.

    The clock is the server's own, not the wall: the room's activity stamp is moved
    under that clock, and the sweep is asked what it would do at that instant.
    """
    async def scenario():
        now = {"t": time.time()}
        server, client = await started(tmp_path, clock=lambda: now["t"])
        try:
            ada, ada_token = await sign_in(client, "Ada")
            bea, bea_token = await sign_in(client, "Bea")
            empty = (await open_room(client, ada_token))["room"]

            def age(room_id, seconds):
                server.store.db.execute(
                    "UPDATE rooms SET active = ? WHERE id = ?", (now["t"] - seconds, room_id))

            age(empty["id"], 29 * 60)
            assert server.sweep_idle_rooms(now["t"]) == []
            assert server.store.room(empty["id"])["closed"] == 0
            assert server.hub.seated_live(server.store.room(empty["id"])) is False

            age(empty["id"], 30 * 60)
            closed = [item["id"] for item in server.sweep_idle_rooms(now["t"])]
            assert closed == [empty["id"]]
            assert server.store.room(empty["id"])["closed"] == 1

            # Someone is at the table. Thirty minutes does not close it, and neither does
            # a quiet stretch past two hours: a live seat is not an abandoned table.
            attended = (await open_room(client, ada_token))["room"]
            sitting = await connect(client, attended["id"], ada_token)
            assert server.hub.seated_live(server.store.room(attended["id"])) is True
            age(attended["id"], 30 * 60)
            assert server.sweep_idle_rooms(now["t"]) == []
            age(attended["id"], 3 * 3600)
            assert server.sweep_idle_rooms(now["t"]) == []
            assert server.store.room(attended["id"])["closed"] == 0
            await sitting.ws.close()

            # The host has left. A watcher is still on the socket, and is not a seated
            # player, so the thirty-minute close tells them and then hangs up.
            quiet = (await open_room(client, ada_token))["room"]
            host = await connect(client, quiet["id"], ada_token)
            await host.ws.close()
            await asyncio.sleep(0.05)
            watcher = await connect(client, quiet["id"], bea_token)
            assert server.hub.seated_live(server.store.room(quiet["id"])) is False
            age(quiet["id"], 30 * 60)
            waiting = asyncio.create_task(watcher.until(lambda message: message.get("t") == "closed"))
            await server.close_idle(now["t"])
            note = await waiting
            assert "closed" in note["text"].lower()
            raw = await watcher.ws.receive(timeout=2)
            assert raw.type.name != "TEXT", raw.data
            assert server.store.room(quiet["id"])["closed"] == 1
            assert ada and bea
        finally:
            await client.close()
    run(scenario())


def test_the_idle_sweep_words_match_its_rule():
    """The sweep never closes a room while someone seated is connected. Its words, the
    janitor's and the doctor's must not promise a two-hour limit on a live seat."""
    import inspect

    from online import doctor, rooms, server
    for text in (inspect.getsource(rooms.Rooms.sweep_idle), inspect.getsource(server.App.sweep_idle_rooms),
                 inspect.getsource(server.App.janitor), inspect.getsource(doctor.collect)):
        lowered = text.lower()
        assert "two hours" not in lowered and "two-hour" not in lowered, text[:200]
    assert not hasattr(rooms, "IDLE_CLOSE_SECONDS"), "no constant for a limit the sweep does not apply"


def test_the_sweep_closes_only_rooms_nobody_is_sitting_at(tmp_path, caplog):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            _ada, _at, _bea, _bt, room, first, second = await a_table(client)
            # A room made a moment ago: quiet, but not idle.
            carl, carl_token = await sign_in(client, 'Carl')
            fresh = (await open_room(client, carl_token))['room']
            # A table quiet for three hours whose host is still connected to it.
            dora, dora_token = await sign_in(client, 'Dora')
            attended = (await open_room(client, dora_token))['room']
            sitting = await connect(client, attended['id'], dora_token)
            await first.ws.close()
            await second.ws.close()
            await asyncio.sleep(.05)
            quiet_for(server, room['id'], 3 * 3600)
            quiet_for(server, attended['id'], 3 * 3600)
            caplog.set_level(logging.WARNING, logger='gameshelf.online')
            closed = [item['id'] for item in server.sweep_idle_rooms(time.time())]
            assert closed == [room['id']]
            assert server.store.room(room['id'])['closed'] == 1
            assert server.store.room(attended['id'])['closed'] == 0
            assert server.store.room(fresh['id'])['closed'] == 0
            row = server.store.db.execute(
                "SELECT * FROM audit WHERE action = 'close-idle-room'").fetchone()
            assert row is not None and row['target_id'] == room['id']
            assert row['target_name'] == 'connect4'
            assert room['id'] in caplog.text and 'connect4' in caplog.text, caplog.text
            await sitting.ws.close()
        finally:
            await client.close()
    run(scenario())
