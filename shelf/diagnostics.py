"""The plugin's own diagnostic log: one rotating file in the plugin's data folder.

Game Center keeps ``game-center.log`` (1 MB x 3 files) beside the state it already
writes, in the folder Hermes hands the plugin — never a hardcoded home. It records
what a person needs when something misbehaves: an error a REST handler or a hook
could not handle (with its traceback), a request slower than two seconds, and the
lobby socket's connect / disconnect / reconnect. Keys and tokens are masked on the
way out, tracebacks included, so the file is safe to attach to a bug report.

Stdlib only. The health sampler that shares this file lives here too (see
``HealthSampler``); it costs one short line every five minutes and nothing between.
"""

from __future__ import annotations

import functools
import logging
import re
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Callable

LOGGER_NAME = "gameshelf"
LOG_NAME = "game-center.log"
LOG_MAX_BYTES = 1_000_000
LOG_BACKUPS = 3
SLOW_SECONDS = 2.0

log = logging.getLogger(LOGGER_NAME)

# A secret's name ends in key/token/secret/password (bot_key, staff_key, the recovery
# key, lobby_key, an API token); its value is masked wherever the pair appears — a
# query string, a JSON body, a sentence. Bearer tokens are masked by their header.
_FIELD = re.compile(
    r"(?i)(\b[\w-]*(?:key|token|secret|password)[\w-]*[\"']?\s*[=:]\s*)[\"']?[A-Za-z0-9_\-./+=]{4,}"
)
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9_\-./+=]{4,}")


def mask(text: str) -> str:
    """The same sentence with every key- or token-shaped value replaced by ***."""
    text = _FIELD.sub(r"\1***", str(text))
    return _BEARER.sub(r"\1***", text)


class _MaskFormatter(logging.Formatter):
    """Masks the whole formatted record, traceback text included."""

    def format(self, record: logging.LogRecord) -> str:
        return mask(super().format(record))


def attach(data_root: Path | str) -> logging.Logger:
    """Put the rotating file handler on the gameshelf logger, once.

    ``data_root`` is the plugin's own data folder — the same one its state lives in.
    Calling this again (a reload, a second surface) adds no second handler.
    """
    folder = Path(data_root)
    folder.mkdir(parents=True, exist_ok=True)
    target = str(folder / LOG_NAME)
    for handler in log.handlers:
        if isinstance(handler, RotatingFileHandler) and handler.baseFilename == target:
            return log
    handler = RotatingFileHandler(
        target, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUPS, encoding="utf-8"
    )
    handler.setFormatter(_MaskFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    handler.setLevel(logging.INFO)
    log.setLevel(logging.INFO)
    log.addHandler(handler)
    return log


def wrap_rest(endpoint: Callable, *, clock: Callable[[], float] = time.monotonic) -> Callable:
    """One REST handler, watched: an unhandled error is logged with its traceback and
    re-raised (the host still answers the request its own way); a call slower than
    ``SLOW_SECONDS`` earns one warning. The signature is preserved for FastAPI."""

    @functools.wraps(endpoint)
    def watched(*args: Any, **kwargs: Any):
        start = clock()
        try:
            return endpoint(*args, **kwargs)
        except Exception:
            log.error("REST handler %s failed", endpoint.__name__, exc_info=True)
            raise
        finally:
            took = clock() - start
            if took > SLOW_SECONDS:
                log.warning("slow request %s took %.2fs", endpoint.__name__, took)

    return watched


def instrument_router(router: Any) -> None:
    """Wrap every route registered from here on, at decoration time, so the wrapper
    is what FastAPI builds its dependency tree from (a later swap would be ignored)."""
    for method in ("get", "post", "put", "delete", "patch", "head", "options"):
        original = getattr(router, method, None)
        if original is None:
            continue

        def decorator(path: str, *args: Any, _original=original, **kwargs: Any):
            def register(endpoint: Callable):
                return _original(path, *args, **kwargs)(wrap_rest(endpoint))
            return register

        setattr(router, method, decorator)


# The lobby sockets the plugin holds open, for the health line. Hall registers its
# one socket while a session is live and unregisters it when the session ends.
_LOBBY_LOCK = threading.Lock()
_LOBBY_SOCKETS: set = set()


def lobby_opened(sock: Any) -> None:
    with _LOBBY_LOCK:
        _LOBBY_SOCKETS.add(sock)


def lobby_closed(sock: Any) -> None:
    with _LOBBY_LOCK:
        _LOBBY_SOCKETS.discard(sock)


def lobby_socket_count() -> int:
    with _LOBBY_LOCK:
        return len(_LOBBY_SOCKETS)