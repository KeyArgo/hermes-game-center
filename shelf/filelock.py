"""One cross-process file lock for the shelf and the saved table state.

POSIX uses flock; Windows uses msvcrt.locking. Both hold the lock for the whole
read-modify-write block, so two writers cannot clobber each other's work.
"""

from __future__ import annotations

import contextlib
import errno
import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None
    import msvcrt

# How long the Windows lock waits for another process before giving up.
LOCK_TIMEOUT_SECONDS = 30.0
# msvcrt reports a lock another process holds as EACCES; those are the only
# errors worth retrying. Invalid handles and other OS errors must surface.
_CONTENTION_ERRNOS = {errno.EACCES, errno.EAGAIN, errno.EDEADLK}


@contextlib.contextmanager
def file_lock(path: Path, *, best_effort: bool = False):
    """Hold an exclusive lock on path until the with block exits.

    best_effort only affects POSIX: a filesystem without flock carries on
    unlocked instead of failing.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if fcntl is not None:
            held = True
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            except OSError:
                if not best_effort:
                    raise
                held = False
            try:
                yield
            finally:
                if held:
                    if best_effort:
                        try:
                            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                        except OSError:
                            log.debug("the lock could not be released", exc_info=True)
                    else:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            return
        # msvcrt locks a byte range from the current position. A file with no
        # bytes can still be locked, but writing one keeps the range concrete.
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
        while True:
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError as exc:
                if exc.errno not in _CONTENTION_ERRNOS:
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"timed out after {LOCK_TIMEOUT_SECONDS:g}s waiting for lock {path}"
                    ) from exc
                time.sleep(0.01)
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
