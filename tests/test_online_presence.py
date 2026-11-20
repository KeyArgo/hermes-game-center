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


def test_leaving_and_disconnect_eviction_free_both_players_immediately(tmp_path):
    """After both seats leave (or disconnect past the grace), both report online at once,
    presence is pushed without waiting, and direct requests and pairing work right away."""
    import time

    async def scenario():
        now = {'t': time.time()}
        server, client = await started(tmp_path, clock=lambda: now['t'])
        try:
            ada, at = await sign_in(client, 'Ada')
            bea, bt = await sign_in(client, 'Bea')
            a_lobby, _ = await lobby(client, at)
            b_lobby, _ = await lobby(client, bt)
            for token in (at, bt):
                resp = await client.post(
                    '/api/availability',
                    headers={'Authorization': f'Bearer {token}'},
                    json={'open': True, 'games': {'blackjack': True, 'connect4': True}},
                )
                assert resp.status == 200
            # Cancel the periodic 0.5s hub task so the presence pushes we wait on must come
            # from the server's own leave/eviction hooks rather than a background timer.
            if server.hub.task:
                server.hub.task.cancel()
                server.hub.task = None
                await asyncio.sleep(0)

            # 1. Explicit leave: both leave blackjack -> room closes, both online at once,
            #    pushed to lobby sockets, and a direct request succeeds immediately.
            room = (await open_room(client, at, game='blackjack'))['room']
            a = await connect(client, room['id'], at)
            b = await connect(client, room['id'], bt)
            assert (await b.result(1, t='cmd', action='join'))['ok']
            assert server.hub.status(ada['id']) == 'playing'
            assert server.hub.status(bea['id']) == 'playing'

            assert (await a.result(2, t='cmd', action='leave'))['ok']
            await until(b_lobby, lambda m: m.get('t') == 'presence'
                        and m['row']['id'] == ada['id'] and m['row']['status'] == 'online')
            assert server.hub.status(ada['id']) == 'online'
            assert server.hub.status(bea['id']) == 'playing'

            assert (await b.result(3, t='cmd', action='leave'))['ok']
            await until(a_lobby, lambda m: m.get('t') == 'presence'
                        and m['row']['id'] == bea['id'] and m['row']['status'] == 'online')
            assert server.store.room(room['id'])['closed'] == 1
            assert server.hub.status(ada['id']) == 'online'
            assert server.hub.status(bea['id']) == 'online'
            req = await client.post(
                '/api/requests',
                headers={'Authorization': f'Bearer {at}'},
                json={'to': bea['id'], 'game': 'connect4'},
            )
            assert req.status == 200, await req.text()
            body = await req.json()
            assert body['ok'] is True
            # Cancel that request so the pair can test disconnect-eviction and pairing next.
            cancel = await client.post(
                f"/api/requests/{body['request']['id']}",
                headers={'Authorization': f'Bearer {at}'},
                json={'cancel': True},
            )
            assert cancel.status == 200
            await a.ws.close()
            await b.ws.close()

            # 2. Per-seat grace & disconnect eviction without the 15-minute wait.
            room2 = (await open_room(client, at, game='blackjack'))['room']
            a2 = await connect(client, room2['id'], at)
            b2 = await connect(client, room2['id'], bt)
            assert (await b2.result(1, t='cmd', action='join'))['ok']
            assert (await a2.result(2, t='cmd', action='move', args=['bet1000']))['ok']
            await a2.ws.close()
            await asyncio.sleep(0.05)
            # Within grace: Ada still counts as playing alongside live Bea.
            now['t'] += 30
            for ws in (a_lobby, b_lobby):
                await ws.send_json({'t': 'ping'})
                await until(ws, lambda m: m.get('t') == 'pong')
            assert ada['id'] in server.hub.playing_players()
            assert bea['id'] in server.hub.playing_players()
            # Past grace: Ada is freed per-seat even while Bea still holds a live socket.
            now['t'] += 16
            for ws in (a_lobby, b_lobby):
                await ws.send_json({'t': 'ping'})
                await until(ws, lambda m: m.get('t') == 'pong')
            assert ada['id'] not in server.hub.playing_players()
            assert bea['id'] in server.hub.playing_players()

            # Now Bea also disconnects and both are swept past grace.
            await b2.ws.close()
            await asyncio.sleep(0.05)
            now['t'] += 46
            for ws in (a_lobby, b_lobby):
                await ws.send_json({'t': 'ping'})
                await until(ws, lambda m: m.get('t') == 'pong')
            await server.sweep_disconnects(now['t'])
            await until(a_lobby, lambda m: m.get('t') == 'presence'
                        and m['row']['id'] == bea['id'] and m['row']['status'] == 'online')
            assert server.store.room(room2['id'])['closed'] == 1
            assert server.hub.status(ada['id']) == 'online'
            assert server.hub.status(bea['id']) == 'online'
            # Direct request and find-match pairing both work immediately.
            looking = await server.requests.handle(ada, {'t': 'looking', 'games': ['blackjack']})
            assert looking['ok']
            pending = server.requests.pending_for(bea['id'])
            assert any(item['game'] == 'blackjack' and item['from']['id'] == ada['id']
                       for item in pending), f'expected immediate blackjack offer: {pending}'
            # Also test pairing someone who was already looking when eviction freed the table.
            cancel2 = await client.post(
                f"/api/requests/{pending[0]['id']}",
                headers={'Authorization': f'Bearer {at}'},
                json={'cancel': True},
            )
            assert cancel2.status == 200
            server.store.set_looking(ada['id'], ['connect4'], now['t'])
            paired = await server.requests.pair_looking(now['t'])
            assert paired >= 1, 'pairing succeeds immediately without a 15-minute wait'
            await a_lobby.close()
            await b_lobby.close()
        finally:
            await client.close()
    run(scenario())
