"""Load a shared helper by file path, and load it again when the file changes.

Game modules and the plugin's hook keep helpers (the wallet, the slot spin) under fixed
sys.modules names. A plain cache would keep the copy from when the gateway started, so an
update would mix an old helper with new game files until the next gateway restart. Keyed on
the file's modification time, a changed file is picked up on the next call instead.
"""

from __future__ import annotations

import importlib.util
import sys
import threading
from pathlib import Path

# One load at a time per module name. A cold miss used to let every caller compile
# the file; the second and later wait, then reuse the module the first one stored.
_fresh_guard = threading.Lock()
_fresh_locks: dict[str, threading.Lock] = {}


def _lock_for(name: str) -> threading.Lock:
    with _fresh_guard:
        lock = _fresh_locks.get(name)
        if lock is None:
            lock = threading.Lock()
            _fresh_locks[name] = lock
        return lock


def _stamp(path: Path):
    try:
        # The key is the file *and* its stamp: two different files can share a
        # modification time (a copy, or an archive with preserved times), and the
        # cache must not hand one file's module to the other's name.
        return (str(path.resolve()), path.stat().st_mtime_ns)
    except OSError:
        return (str(path), None)


def load_fresh(name: str, path: Path):
    path = Path(path)
    stamp = _stamp(path)
    held = sys.modules.get(name)
    if held is not None and getattr(held, "_fresh_stamp", None) == stamp:
        return held
    with _lock_for(name):
        held = sys.modules.get(name)
        if held is not None and getattr(held, "_fresh_stamp", None) == stamp:
            return held
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        # In sys.modules before exec, so a module that imports itself can find this copy.
        # The stamp stays off until exec finishes: a caller that arrives during the load
        # must wait on the lock, not take a module that has not been run yet.
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            # A broken new file must not take down the copy that was working.
            if held is not None:
                sys.modules[name] = held
                return held
            del sys.modules[name]
            raise
        module._fresh_stamp = stamp
        return module
