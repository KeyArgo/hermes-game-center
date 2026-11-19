"""L1: the plugin's own rotating log — errors with tracebacks, slow requests, lobby life.

The log lives in the plugin's OWN data folder (the one register() is given), never a
hardcoded home. Secrets (recovery keys, bot_key, staff_key, tokens) are masked on the
way out, including inside tracebacks. The clock is fake wherever timing is judged.
"""

from __future__ import annotations

import importlib.util
import inspect
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from types import SimpleNamespace

import pytest

from shelf import diagnostics

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _clean_logger():
    """Each test starts with no file handler on the gameshelf or shelf loggers."""
    loggers = [logging.getLogger(name) for name in (diagnostics.LOGGER_NAME, *diagnostics.ALSO_LOGGED)]
    for logger in loggers:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()
    yield
    for logger in loggers:
        for handler in list(logger.handlers):
            logger.removeHandler(handler)
            handler.close()
    diagnostics.stop_health()


def _file(tmp_path: Path) -> Path:
    return tmp_path / diagnostics.LOG_NAME


def _text(tmp_path: Path) -> str:
    return _file(tmp_path).read_text(encoding="utf-8")


def test_attach_puts_one_rotating_handler_in_the_data_folder(tmp_path):
    logger = diagnostics.attach(tmp_path)
    files = [h for h in logger.handlers if isinstance(h, RotatingFileHandler)]
    assert len(files) == 1
    handler = files[0]
    assert Path(handler.baseFilename) == _file(tmp_path)
    assert handler.maxBytes == 1_000_000
    assert handler.backupCount == 3
    assert _file(tmp_path).parent == tmp_path  # the folder it was given, nothing else
    # Idempotent: a second attach (a reload, a second surface) adds no second handler.
    diagnostics.attach(tmp_path)
    assert len([h for h in logger.handlers if isinstance(h, RotatingFileHandler)]) == 1


def test_rotation_keeps_three_backups_and_no_more(tmp_path, monkeypatch):
    monkeypatch.setattr(diagnostics, "LOG_MAX_BYTES", 200)
    logger = diagnostics.attach(tmp_path)
    for number in range(40):
        logger.info("line %02d %s", number, "x" * 40)
    for handler in logger.handlers:
        handler.flush()
    assert _file(tmp_path).is_file()
    for backup in (1, 2, 3):
        assert (tmp_path / f"{diagnostics.LOG_NAME}.{backup}").is_file()
    assert not (tmp_path / f"{diagnostics.LOG_NAME}.4").exists()


def test_mask_hides_keys_and_tokens_but_keeps_the_sentence():
    mask = diagnostics.mask
    assert "supersecret123" not in mask("sign-in failed bot_key=supersecret123 for Ada")
    assert "bot_key=***" in mask("bot_key=supersecret123")
    assert "abc123def456" not in mask('{"token": "***"}')
    assert "staff987654" not in mask("staff_key: staff987654")
    assert "keykeykey1" not in mask("recovery_key=keykeykey1")
    assert "lobbykey123" not in mask("lobby_key=lobbykey123")
    assert "bearertok123" not in mask("Authorization: Bearer bearertok123")
    assert "tok12345" not in mask("wss://host/ws?key=tok12345")
    # Ordinary words survive, even ones that end in 'key'.
    assert mask("the monkey jumped") == "the monkey jumped"
    assert mask("no secrets here") == "no secrets here"


def test_a_traceback_is_written_and_masked(tmp_path):
    logger = diagnostics.attach(tmp_path)
    try:
        raise ValueError("the lobby refused bot_key=supersecret123")
    except ValueError:
        logger.error("the request could not run", exc_info=True)
    for handler in logger.handlers:
        handler.flush()
    text = _text(tmp_path)
    assert "Traceback" in text
    assert "ValueError" in text
    assert "supersecret123" not in text
    assert "***" in text


def test_wrap_rest_logs_an_unhandled_error_with_traceback_and_reraises(tmp_path):
    diagnostics.attach(tmp_path)

    def boom():
        raise RuntimeError("the table broke")

    wrapped = diagnostics.wrap_rest(boom)
    with pytest.raises(RuntimeError):
        wrapped()
    text = _text(tmp_path)
    assert "boom" in text
    assert "Traceback" in text
    assert "the table broke" in text


def test_wrap_rest_logs_only_requests_slower_than_two_seconds(tmp_path):
    diagnostics.attach(tmp_path)
    ticks = [0.0]

    def clock():
        return ticks[0]

    def slow():
        ticks[0] += 2.5
        return {"ok": True}

    def quick():
        ticks[0] += 1.0
        return {"ok": True}

    assert diagnostics.wrap_rest(slow, clock=clock)() == {"ok": True}
    assert diagnostics.wrap_rest(quick, clock=clock)() == {"ok": True}
    text = _text(tmp_path)
    assert "slow request" in text
    assert "slow" in text and "2.5" in text
    assert text.count("slow request") == 1  # the quick one said nothing


def test_instrument_router_wraps_routes_and_keeps_their_signature(tmp_path):
    from fastapi import APIRouter

    diagnostics.attach(tmp_path)
    router = APIRouter()
    diagnostics.instrument_router(router)

    @router.get("/probe")
    def probe(game: str = ""):
        raise ValueError("probe failed")

    route = router.routes[-1]
    assert "game" in inspect.signature(route.endpoint).parameters
    with pytest.raises(ValueError):
        route.endpoint()
    text = _text(tmp_path)
    assert "probe" in text and "Traceback" in text


def _hooks(tmp_path: Path, name: str):
    """The hooks the real register() registers, the way test_focused_chat_spins does."""
    spec = importlib.util.spec_from_file_location(name, ROOT / "__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(plugin)
    hooks: dict[str, list] = {}
    ctx = SimpleNamespace(
        get_config=lambda key, default=None: default,
        register_hook=lambda hook, fn: hooks.setdefault(hook, []).append(fn),
        register_command=lambda *args, **kwargs: None,
        register_tool=lambda *args, **kwargs: None,
    )
    plugin.register(ctx, data_root=tmp_path)
    return plugin, hooks


def test_register_attaches_the_log_to_the_data_folder_it_is_given(tmp_path):
    _hooks(tmp_path, "gameshelf_log_register_plugin")
    assert _file(tmp_path).is_file()


def test_a_hook_error_is_logged_with_a_traceback_and_swallowed(tmp_path, monkeypatch):
    plugin, hooks = _hooks(tmp_path, "gameshelf_log_hook_plugin")

    def broken(*args, **kwargs):
        raise RuntimeError("hook internals broke bot_key=supersecret123")

    monkeypatch.setattr(plugin, "load_fresh", broken)
    # The hook must not raise into Hermes's turn.
    hooks["pre_llm_call"][0](turn_id="t1", session_id="s1")
    for handler in logging.getLogger(diagnostics.LOGGER_NAME).handlers:
        handler.flush()
    text = _text(tmp_path)
    assert "Traceback" in text
    assert "hook internals broke" in text
    assert "supersecret123" not in text


def test_the_lobby_logs_connect_disconnect_and_reconnect(tmp_path, monkeypatch):
    """Hall's worker says when the lobby socket opens, drops and dials again — key-free."""
    from shelf import online_hall

    diagnostics.attach(tmp_path)
    events = []

    class FakeSocket:
        def __init__(self, url, timeout=5):
            events.append("dial")
            self.url = url

        def send_json(self, message):
            if message.get("t") == "auth":
                events.append("auth")

        def receive(self, timeout=None):
            # First session drops at once; the second is stopped by the test.
            if events.count("drop") == 0:
                events.append("drop")
                raise online_hall.wsmod.SocketError("The connection dropped: reset")
            raise online_hall.wsmod.SocketError("The connection dropped: reset")

        def close(self):
            events.append("close")

    monkeypatch.setattr(online_hall.wsmod, "Socket", FakeSocket)
    source = SimpleNamespace(on=True, key=lambda: "supersecret123", url="https://lobby.example")
    hall = online_hall.Hall(source)
    hall.retry_first = 0.01
    hall.retry_most = 0.02
    hall.start()
    try:
        import time
        end = time.monotonic() + 3
        while time.monotonic() < end and events.count("dial") < 2:
            time.sleep(0.01)
    finally:
        hall.stop()
    assert events.count("dial") >= 2, events
    text = _text(tmp_path)
    assert "lobby connect" in text
    assert "lobby disconnect" in text
    assert "lobby reconnect" in text
    assert "supersecret123" not in text
    assert diagnostics.lobby_socket_count() == 0  # nothing left registered after stop

def test_the_shelf_modules_reach_the_file_too(tmp_path):
    """The Hall, the socket and the stores log under ``shelf.*``; a reason the lobby could not be
    reached is worth nothing if it never lands in the file a person is asked to send."""
    diagnostics.attach(tmp_path)
    diagnostics.attach(tmp_path)
    logging.getLogger("shelf.online_hall").warning("could not reach wss://lobby.example: refused")
    text = _text(tmp_path)
    assert "shelf.online_hall" in text and "could not reach wss://lobby.example" in text
    assert text.count("could not reach") == 1, "one handler per logger, never two copies of a line"
