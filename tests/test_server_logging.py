"""L3: the lobby server watches itself too — the same health line, slow requests
and unhandled errors, all to its existing logger (the one journald keeps).

Timing is judged with the App's injectable clock; the health line with a fake RSS.
"""

from __future__ import annotations

import asyncio
import json
import logging
from types import SimpleNamespace

import pytest
from aiohttp import web

from online.server import App

MB = 1024 * 1024


def _request(path="/api/me", method="GET"):
    return SimpleNamespace(method=method, path_qs=path)


def test_an_unhandled_error_is_logged_with_a_traceback_and_reraised(tmp_path, caplog):
    app = App(tmp_path)

    async def handler(request):
        raise ValueError("the store broke")

    with caplog.at_level(logging.ERROR, logger="gameshelf.online"):
        with pytest.raises(ValueError):
            asyncio.run(app.observe(_request("/api/me?key=supersecret123"), handler))
    errors = [r for r in caplog.records if r.levelno == logging.ERROR and r.name == "gameshelf.online"]
    assert errors, caplog.text
    assert "Traceback" in caplog.text
    assert "the store broke" in caplog.text
    assert "supersecret123" not in caplog.text  # the query's key is masked


def test_an_http_refusal_is_not_an_error(tmp_path, caplog):
    app = App(tmp_path)

    async def handler(request):
        raise web.HTTPNotFound()

    with caplog.at_level(logging.ERROR, logger="gameshelf.online"):
        with pytest.raises(web.HTTPNotFound):
            asyncio.run(app.observe(_request(), handler))
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


def test_only_requests_slower_than_two_seconds_warn(tmp_path, caplog):
    ticks = [0.0]
    app = App(tmp_path, clock=lambda: ticks[0])

    async def slow(request):
        ticks[0] += 2.5
        return web.Response(text="ok")

    async def quick(request):
        ticks[0] += 1.0
        return web.Response(text="ok")

    with caplog.at_level(logging.WARNING, logger="gameshelf.online"):
        asyncio.run(app.observe(_request(), slow))
        asyncio.run(app.observe(_request(), quick))
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING and "slow request" in r.getMessage()]
    assert len(warnings) == 1
    assert "2.5" in warnings[0].getMessage()


def test_health_says_when_the_sweep_has_not_finished_for_two_minutes(tmp_path, caplog):
    """The periodic sweep stamps itself. Two minutes without that stamp shows on /health."""
    import contextlib

    now = {"t": 1_000_000.0}
    app = App(tmp_path, clock=lambda: now["t"])

    async def health():
        response = await app.health(SimpleNamespace())
        return json.loads(response.body)

    async def ask():
        fresh = await health()
        assert fresh["ok"] is True
        assert fresh["sweep_stale"] is False
        now["t"] += 119
        still = await health()
        assert still["sweep_stale"] is False
        now["t"] += 1
        late = await health()
        assert late["sweep_stale"] is True
        assert late["sweep"] == "no sweep for 2 minutes"
        app.note_sweep_done()
        cleared = await health()
        assert cleared["sweep_stale"] is False
        assert cleared["sweep"] == "ok"

    asyncio.run(ask())

    app.sweep_completed_at = app.clock() - 120
    app.health_watch.rss = lambda: 100 * MB
    with caplog.at_level(logging.INFO, logger="gameshelf.online"):
        line = app.health_watch.sample_once()
    assert "sweep=stale" in line

    # A finished pass of the janitor is what clears the alarm.
    app.sweep_completed_at = 0.0

    async def one_pass():
        task = asyncio.create_task(app.janitor(app.build()))
        try:
            for _ in range(40):
                if app.sweep_completed_at == now["t"]:
                    return
                await asyncio.sleep(0.05)
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    asyncio.run(one_pass())
    assert app.sweep_completed_at == now["t"]


def test_the_health_line_uses_the_server_logger_and_counts_sockets(tmp_path, caplog):
    app = App(tmp_path)
    app.health_watch.rss = lambda: 100 * MB
    app.conns["room-1"] = {object(), object()}
    app.conns["room-2"] = {object()}
    with caplog.at_level(logging.INFO, logger="gameshelf.online"):
        app.health_watch.sample_once()
    lines = [r for r in caplog.records if r.name == "gameshelf.online" and "health" in r.getMessage()]
    assert len(lines) == 1
    message = lines[0].getMessage()
    assert "rss=100.0MB" in message
    assert "lobby_sockets=3" in message
    assert "threads=" in message


def test_build_wires_the_watch_and_the_sampler_stops_at_shutdown(tmp_path):
    app = App(tmp_path)
    built = app.build()
    assert app.observe in built.middlewares

    async def scenario():
        for callback in built.on_startup:
            await callback(built)
        assert app.health_watch.running
        for callback in built.on_shutdown:
            await callback(built)
        for callback in built.on_cleanup:
            await callback(built)
        assert not app.health_watch.running

    asyncio.run(scenario())