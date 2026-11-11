"""Lobby sockets expose one account per row, independently of room sockets."""
import asyncio

from test_online_server import run, started, sign_in, open_room, connect


async def lobby(client, token):
    ws = await client.ws_connect('/api/lobby/socket')
    await ws.send_json({'t': 'auth', 'token': token, 'client': 'web'})
    return ws, await ws.receive_json()


async def until(ws, predicate):
    while True:
        frame = await ws.receive_json(timeout=3)
        if predicate(frame):
            return frame


def test_presence_connections_away_and_grace(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        server.hub.grace = .1
        try:
            ada, at = await sign_in(client, 'Ada')
            bea, bt = await sign_in(client, 'Bea')
            a, hello = await lobby(client, at)
            # Defaults are off: the master switch, and every game (listed or not).
            assert hello['prefs']['open'] is False and not any(hello['prefs']['games'].values()) and hello['requests'] == []
            b, hello = await lobby(client, bt)
            assert [r['id'] for r in hello['roster']].count(ada['id']) == 1
            await until(a, lambda m: m.get('row', {}).get('id') == bea['id'])
            a2, hello = await lobby(client, at)
            assert [r['id'] for r in hello['roster']].count(ada['id']) == 1
            await a.close()
            await asyncio.sleep(.05)
            assert server.hub.status(ada['id']) == 'online'
            await a2.send_json({'t': 'away', 'on': True, 'op': 'away'})
            assert (await until(a2, lambda m: m.get('t') == 'ack'))['ok']
            await until(b, lambda m: m.get('row', {}).get('id') == ada['id'] and m['row']['status'] == 'away')
            await a2.close()
            await until(b, lambda m: m.get('t') == 'gone' and m['id'] == ada['id'])
            await b.close()
        finally:
            await client.close()
    run(scenario())


def test_block_auth_and_legacy_lobby(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, 'Ada')
            bea, bt = await sign_in(client, 'Bea')
            before = await (await client.get('/api/lobby')).json()
            server.store.db.execute('INSERT INTO blocks VALUES (?, ?, ?)', (ada['id'], bea['id'], 0))
            a, ah = await lobby(client, at)
            b, bh = await lobby(client, bt)
            assert bea['id'] not in [r['id'] for r in ah['roster']]
            assert ada['id'] not in [r['id'] for r in bh['roster']]
            bad, error = await lobby(client, 'bad')
            assert error == {'t': 'error', 'code': 'auth'}
            await a.send_json({'t': 'prefs', 'op': 1})
            ack = await until(a, lambda m: m.get('t') == 'ack')
            # With the requests service attached, presence hands prefs frames to it and acks its answer.
            assert ack['ok'] and ack['op'] == 1
            assert (await (await client.get('/api/lobby')).json()).keys() == before.keys()
            await bad.close()
            await a.close()
            await b.close()
        finally:
            await client.close()
    run(scenario())


def test_room_connection_cap_is_separate(tmp_path, monkeypatch):
    async def scenario():
        import online.server as module
        server, client = await started(tmp_path)
        try:
            _, token = await sign_in(client, 'Ada')
            room = (await open_room(client, token))['room']
            ws, _ = await lobby(client, token)
            monkeypatch.setattr(module, 'MAX_CONNECTIONS', 0)
            seat = await connect(client, room['id'], token)
            assert seat.inbox[-1]['t'] == 'closed'
            await ws.close()
        finally:
            await client.close()
    run(scenario())


def test_active_room_players_show_as_playing(tmp_path):
    async def scenario():
        server, client = await started(tmp_path)
        try:
            ada, at = await sign_in(client, 'Ada')
            bea, bt = await sign_in(client, 'Bea')
            _, et = await sign_in(client, 'Eve')
            a_lobby, _ = await lobby(client, at)
            b_lobby, _ = await lobby(client, bt)
            viewer, _ = await lobby(client, et)
            room = (await open_room(client, at))['room']
            a = await connect(client, room['id'], at)
            b = await connect(client, room['id'], bt)
            assert (await b.result(1, t='cmd', action='join'))['ok']
            for player in (ada, bea):
                await until(viewer, lambda m: m.get('row', {}).get('id') == player['id']
                            and m['row']['status'] == 'playing')
                assert server.hub.status(player['id']) == 'playing'
            for ws in (a.ws, b.ws, a_lobby, b_lobby, viewer):
                await ws.close()
        finally:
            await client.close()
    run(scenario())


def test_refresh_reuses_room_scan_and_preferences(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from online.presence import Connection
    import online.presence as presence
    from online.server import App

    class Socket:
        async def send_json(self, frame):
            pass

    async def scenario():
        server = App(tmp_path)
        assert server.presence is server.hub
        hub = server.hub
        calls = []
        monkeypatch.setattr(presence, '_service', lambda: SimpleNamespace(
            prefs=lambda pid: calls.append(pid) or {'open': False, 'games': {}}))
        for pid in ('a', 'b'):
            player = {'id': pid, 'name': pid}
            hub.players[pid] = player
            for _ in range(2):
                conn = Connection(Socket(), player, hub.clock())
                hub.connections.setdefault(pid, set()).add(conn)
                hub.views[conn] = {}
        queries = []
        server.store.db.set_trace_callback(queries.append)
        await hub.refresh()
        server.store.db.set_trace_callback(None)
        assert sorted(calls) == ['a', 'b']
        assert sum('FROM rooms WHERE closed = 0' in q for q in queries) == 1
        assert sum('FROM blocks WHERE' in q for q in queries) == 2
        server.store.db.close()
    run(scenario())
