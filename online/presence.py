"""Account-level lobby presence and its WebSocket protocol."""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import json
import time
from dataclasses import dataclass

from aiohttp import WSMsgType, web

MAX_LOBBY_CONNECTIONS = 2000
ROSTER_CAP = 200


def _service():
    try:
        module = importlib.import_module('online.requests')
    except ModuleNotFoundError as exc:
        if exc.name != 'online.requests':
            raise
        return None
    return getattr(module, 'service', None)


def _decode(raw):
    if raw.type != WSMsgType.TEXT:
        return {}
    try:
        value = json.loads(raw.data)
    except (ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _prefs_for(service, player_id):
    """The switches, plus appearing-offline and find match when the service can say them."""
    if service is None:
        return {'open': False, 'games': {}}
    getter = getattr(service, 'presence_prefs', None)
    return getter(player_id) if callable(getter) else service.prefs(player_id)


def _hidden(prefs) -> bool:
    return bool((prefs or {}).get('invisible'))


@dataclass(eq=False)
class Connection:
    ws: web.WebSocketResponse
    player: dict
    last_ping: float
    away: bool = False


class Hub:
    def __init__(self, app, *, clock=time.time, grace=15, ping_timeout=45):
        self.app = app
        self.clock = clock
        self.grace = grace
        self.ping_timeout = ping_timeout
        self.connections: dict[str, set[Connection]] = {}
        self.players: dict[str, dict] = {}
        self.left: dict[str, float] = {}
        self.rev = 0
        self.views: dict[Connection, dict] = {}
        self.task = None
        self.lock = asyncio.Lock()

    def playing_players(self):
        playing = set()
        for raw in self.app.store.db.execute('SELECT * FROM rooms WHERE closed = 0'):
            room = dict(raw)
            state = self.app.rooms.state(room) or {}
            if state.get('status') == 'active':
                playing.update(pid for pid in (state.get('white_id'), state.get('black_id')) if pid)
        return playing

    def online_players(self):
        """The accounts with a live lobby connection. This is what "online" means."""
        return set(self.players)

    def status(self, player_id, playing=None):
        if player_id not in self.players:
            return None
        if playing is None:
            playing = self.playing_players()
        if player_id in playing:
            return 'playing'
        conns = self.connections.get(player_id, ())
        if not conns or all(c.away or self.clock() - c.last_ping >= self.ping_timeout for c in conns):
            return 'away'
        return 'online'

    def row(self, player_id, playing=None, prefs_by_player=None):
        player = self.players[player_id]
        if prefs_by_player is None:
            prefs = _prefs_for(_service(), player_id)
        else:
            prefs = prefs_by_player[player_id]
        games = [game for game, enabled in prefs.get('games', {}).items() if enabled] if prefs.get('open') else []
        return {'id': player_id, 'name': player['name'], 'status': self.status(player_id, playing), 'games': games}

    def roster(self, viewer, playing=None, prefs_by_player=None):
        if playing is None:
            playing = self.playing_players()
        if prefs_by_player is None:
            service = _service()
            prefs_by_player = {pid: _prefs_for(service, pid) for pid in self.players}
        blocked = {r[0] for r in self.app.store.db.execute(
            'SELECT blocked_id FROM blocks WHERE player_id = ? UNION SELECT player_id FROM blocks WHERE blocked_id = ?',
            (viewer, viewer))}
        # Whoever is appearing offline is in nobody's roster but their own.
        rows = sorted((self.row(pid, playing, prefs_by_player) for pid in self.players
                       if pid not in blocked and (pid == viewer or not _hidden(prefs_by_player.get(pid)))),
                      key=lambda row: (row['name'].casefold(), row['name'], row['id']))
        return rows[:ROSTER_CAP], max(0, len(rows) - ROSTER_CAP)

    async def send_to(self, player_id, frame):
        for conn in list(self.connections.get(player_id, ())):
            with contextlib.suppress(ConnectionError, RuntimeError):
                await conn.ws.send_json(frame)

    async def refresh(self):
        async with self.lock:
            now = self.clock()
            for pid, left in list(self.left.items()):
                if now - left >= self.grace:
                    self.left.pop(pid, None)
                    self.players.pop(pid, None)
            if not self.views:
                return
            playing = self.playing_players()
            service = _service()
            prefs_by_player = {pid: _prefs_for(service, pid) for pid in self.players}
            rosters = {}
            for conn, previous in list(self.views.items()):
                viewer = conn.player['id']
                if viewer not in rosters:
                    rosters[viewer] = self.roster(viewer, playing, prefs_by_player)
                rows, _ = rosters[viewer]
                current = {r['id']: r for r in rows}
                for pid in previous.keys() - current.keys():
                    self.rev += 1
                    with contextlib.suppress(ConnectionError, RuntimeError):
                        await conn.ws.send_json({'t': 'gone', 'id': pid, 'rev': self.rev})
                for pid, row in current.items():
                    if previous.get(pid) != row:
                        self.rev += 1
                        with contextlib.suppress(ConnectionError, RuntimeError):
                            await conn.ws.send_json({'t': 'presence', 'row': row, 'rev': self.rev})
                self.views[conn] = current

    async def run(self):
        while True:
            await asyncio.sleep(0.5)
            await self.refresh()

    async def close(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        for conns in list(self.connections.values()):
            for conn in list(conns):
                await conn.ws.close()

    async def socket(self, request):
        # Share the existing pending-auth budget with room sockets.
        from online.server import MAX_PENDING, MAX_PENDING_PER_IP
        ip = self.app.ip(request)
        if self.app.pending.get(ip, 0) >= MAX_PENDING_PER_IP or sum(self.app.pending.values()) >= MAX_PENDING:
            return web.json_response({'error': 'Too many connections.'}, status=429)
        self.app.pending[ip] = self.app.pending.get(ip, 0) + 1
        ws = web.WebSocketResponse(max_msg_size=4096)
        try:
            await ws.prepare(request)
            try:
                first = await asyncio.wait_for(ws.receive(), 10)
            except asyncio.TimeoutError:
                await ws.close()
                return ws
        finally:
            self.app.pending[ip] -= 1
            if not self.app.pending[ip]:
                del self.app.pending[ip]
        message = _decode(first)
        player = self.app.store.player_by_token(str(message.get('token') or '')) if message.get('t') == 'auth' else None
        if not player or self.app.store.suspended(player['id']) or message.get('client') not in ('web', 'hermes'):
            await ws.send_json({'t': 'error', 'code': 'auth'})
            await ws.close()
            return ws
        if sum(map(len, self.connections.values())) >= MAX_LOBBY_CONNECTIONS:
            await ws.close()
            return ws
        conn = Connection(ws, player, self.clock())
        pid = player['id']
        self.players[pid] = player
        self.left.pop(pid, None)
        self.connections.setdefault(pid, set()).add(conn)
        if not self.task:
            self.task = asyncio.create_task(self.run())
        service = _service()
        prefs = _prefs_for(service, pid)
        rows, more = self.roster(pid)
        self.views[conn] = {r['id']: r for r in rows}
        # "you" carries what only this account may see about itself: whether it is appearing
        # offline, and what find match is on for. The roster rows stay the same shape.
        await ws.send_json({'t': 'hello', 'v': 1,
                            'you': {'id': pid, 'name': player['name'],
                                    'invisible': _hidden(prefs),
                                    'looking': list(prefs.get('looking') or [])},
                            'prefs': service.prefs(pid) if service else {'open': False, 'games': {}},
                            'roster': rows, 'more': more,
                            'requests': service.pending_for(pid) if service else [], 'rev': self.rev})
        await self.refresh()
        try:
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    if raw.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                        break
                    continue
                frame = _decode(raw)
                kind = frame.get('t')
                result = {'ok': True}
                if kind == 'ping':
                    conn.last_ping = self.clock()
                    await ws.send_json({'t': 'pong'})
                elif kind == 'away' and isinstance(frame.get('on'), bool):
                    conn.away = frame['on']
                elif kind in ('prefs', 'looking', 'request', 'respond', 'cancel'):
                    service = _service()
                    result = await service.handle(player, frame) if service else {'ok': False, 'text': 'Requests are not available on this server yet.'}
                else:
                    result = {'ok': False, 'text': 'Unknown operation.'}
                if 'op' in frame:
                    await ws.send_json({**result, 't': 'ack', 'op': frame['op']})
                await self.refresh()
        finally:
            self.views.pop(conn, None)
            self.connections[pid].discard(conn)
            if not self.connections[pid]:
                del self.connections[pid]
                self.left[pid] = self.clock()
            await self.refresh()
        return ws
