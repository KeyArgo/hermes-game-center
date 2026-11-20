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

import atexit
import functools
import inspect
import logging
import re
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

LOGGER_NAME = "gameshelf"
# The shelf modules (the Hall, the socket, the stores) log under their own names; the file
# carries them too, so the reason a lobby could not be reached is in the log a person sends.
ALSO_LOGGED = ("shelf",)
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
    for logger in (log, *(logging.getLogger(name) for name in ALSO_LOGGED)):
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)
    return log


def wrap_rest(endpoint: Callable, *, clock: Callable[[], float] = time.monotonic) -> Callable:
    """One REST handler, watched: an unhandled error is logged with its traceback and
    re-raised (the host still answers the request its own way); a call slower than
    ``SLOW_SECONDS`` earns one warning. The signature is preserved for FastAPI.

    A coroutine handler is watched from its own coroutine: a plain wrapper around one would return
    the coroutine object itself, which the host would read as the response.
    """
    if inspect.iscoroutinefunction(endpoint):

        @functools.wraps(endpoint)
        async def watched_async(*args: Any, **kwargs: Any):
            start = clock()
            try:
                return await endpoint(*args, **kwargs)
            except Exception:
                log.exception("REST handler %s failed", endpoint.__name__)
                raise
            finally:
                took = clock() - start
                if took > SLOW_SECONDS:
                    log.warning("slow request %s took %.2fs", endpoint.__name__, took)

        return watched_async

    @functools.wraps(endpoint)
    def watched(*args: Any, **kwargs: Any):
        start = clock()
        try:
            return endpoint(*args, **kwargs)
        except Exception:
            log.exception("REST handler %s failed", endpoint.__name__)
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


# Health ---------------------------------------------------------------------
# One line every five minutes: the process's resident memory, its thread count and
# the lobby sockets it holds. Six samples in a row that each grow, more than 50 MB
# together, mean something is leaking and the log says so once.

HEALTH_INTERVAL = 300.0
GROWTH_SAMPLES = 6
GROWTH_BYTES = 50 * 1024 * 1024
_MB = 1024 * 1024


def parse_proc_status(text: str) -> int | None:
    """VmRSS from /proc/self/status, in bytes, or None when the line is not there."""
    for line in text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) * 1024  # the kernel says kB
    return None


def _windows_rss() -> int | None:
    """The working set, stdlib only.

    ``K32GetProcessMemoryInfo`` lives on kernel32 and is the call that works when
    psapi was never loaded. ``GetProcessMemoryInfo`` is the same function under the
    older name. The argument types have to be declared: a process handle is a
    pointer, and passing it as a plain integer truncates it, so the call fails and
    the health line would say ``rss=?``.
    """
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetCurrentProcess()
        fn = getattr(kernel32, "K32GetProcessMemoryInfo", None)
        if fn is None:
            fn = ctypes.windll.psapi.GetProcessMemoryInfo  # type: ignore[attr-defined]
        if hasattr(fn, "argtypes"):
            fn.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wintypes.DWORD]
            fn.restype = wintypes.BOOL
        ok = fn(handle, ctypes.byref(counters), counters.cb)
        return int(counters.WorkingSetSize) if ok else None
    except Exception:
        return None


def rss_bytes() -> int | None:
    """The process's current resident memory, stdlib only. /proc on Linux,
    GetProcessMemoryInfo on Windows, resource's peak as the last resort."""
    try:
        return parse_proc_status(Path("/proc/self/status").read_text(encoding="ascii"))
    except OSError:
        pass
    if sys.platform == "win32":
        return _windows_rss()
    try:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(peak) if sys.platform == "darwin" else int(peak) * 1024
    except Exception:
        return None


class HealthSampler:
    """One daemon thread, one line per interval. Between samples it waits on an
    event — no busy loop — and ``stop()`` ends it. Every input is injectable so a
    test can drive it with a fake RSS and a fake clock."""

    def __init__(
        self,
        interval: float = HEALTH_INTERVAL,
        *,
        rss: Callable[[], int | None] = rss_bytes,
        threads: Callable[[], int] = threading.active_count,
        sockets: Callable[[], int] = lobby_socket_count,
        logger: logging.Logger = log,
        extra: Callable[[], str] | None = None,
    ) -> None:
        self.interval = interval
        self.rss = rss
        self.threads = threads
        self.sockets = sockets
        self.logger = logger
        self.extra = extra or (lambda: "")
        self._history: deque = deque(maxlen=GROWTH_SAMPLES)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def sample_once(self) -> str:
        try:
            rss = self.rss()
        except Exception:
            rss = None
        if rss is None:
            line = f"health rss=? threads={self.threads()} lobby_sockets={self.sockets()}"
        else:
            line = f"health rss={rss / _MB:.1f}MB threads={self.threads()} lobby_sockets={self.sockets()}"
            self._history.append(rss)
            if len(self._history) == GROWTH_SAMPLES:
                grew = all(b > a for a, b in zip(self._history, list(self._history)[1:]))
                total = self._history[-1] - self._history[0]
                if grew and total > GROWTH_BYTES:
                    self.logger.warning(
                        "memory keeps growing (+%.0fMB over %d samples)",
                        total / _MB, GROWTH_SAMPLES,
                    )
                    self._history.clear()
        try:
            line += self.extra() or ""
        except Exception:
            pass
        self.logger.info(line)
        return line

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self.sample_once()
            except Exception:
                self.logger.debug("the health sample did not run", exc_info=True)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="gameshelf-health")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)
        self._thread = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()


_HEALTH: HealthSampler | None = None
_HEALTH_LOCK = threading.Lock()


def start_health(interval: float = HEALTH_INTERVAL) -> HealthSampler:
    """The one sampler for the running plugin. Idempotent; stops at process exit."""
    global _HEALTH
    with _HEALTH_LOCK:
        if _HEALTH is None:
            _HEALTH = HealthSampler(interval)
            atexit.register(_HEALTH.stop)
        _HEALTH.start()
        return _HEALTH


def stop_health() -> None:
    global _HEALTH
    with _HEALTH_LOCK:
        if _HEALTH is not None:
            _HEALTH.stop()
            _HEALTH = None


def health_running() -> bool:
    with _HEALTH_LOCK:
        return _HEALTH is not None and _HEALTH.running