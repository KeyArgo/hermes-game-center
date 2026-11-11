"""Load a shared helper by file path, and load it again when the file changes.

Game modules and the plugin's hook keep helpers (the wallet, the slot spin) under fixed
sys.modules names. A plain cache would keep the copy from when the gateway started, so an
update would mix an old helper with new game files until the next gateway restart. Keyed on
the file's modification time, a changed file is picked up on the next call instead.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def load_fresh(name: str, path: Path):
    path = Path(path)
    try:
        # The key is the file *and* its stamp: two different files can share a
        # modification time (a copy, or an archive with preserved times), and the
        # cache must not hand one file's module to the other's name.
        stamp = (str(path.resolve()), path.stat().st_mtime_ns)
    except OSError:
        stamp = (str(path), None)
    held = sys.modules.get(name)
    if held is not None and getattr(held, "_fresh_stamp", None) == stamp:
        return held
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    module._fresh_stamp = stamp
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
    return module
