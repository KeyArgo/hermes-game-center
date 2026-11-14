"""Game Center's backend must load on Windows, where there is no fcntl.

On a fresh Windows install every Game Center call answered
404 "Plugin not found" — shelf/wallet.py imported fcntl unguarded, so the dashboard API
module never loaded. This runs the import in a child Python with fcntl blocked and a
stand-in msvcrt, then moves chips through the wallet's Windows lock path.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CHILD = textwrap.dedent(r'''
    import importlib.util, json, sys, types, tempfile
    from pathlib import Path
    # Load the libraries that sniff for msvcrt to guess the OS before the stand-in exists.
    import subprocess, asyncio, getpass  # noqa: F401
    try:
        import fastapi, anyio  # noqa: F401
    except ImportError:
        pass
    sys.modules["fcntl"] = None            # import fcntl -> ImportError, as on Windows
    calls = []
    fake = types.ModuleType("msvcrt")
    fake.LK_NBLCK, fake.LK_UNLCK, fake.LK_LOCK = 2, 0, 1
    fake.locking = lambda fd, mode, n: calls.append(mode)
    sys.modules["msvcrt"] = fake
    root = Path(sys.argv[1])
    sys.path.insert(0, str(root))
    spec = importlib.util.spec_from_file_location("gc_dashboard_api", root / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert getattr(module, "router", None) is not None, "the dashboard API has no router"
    from shelf import wallet as w
    assert w.fcntl is None, "the wallet still reached a real fcntl"
    with tempfile.TemporaryDirectory() as tmp:
        wallet = w.Wallet(Path(tmp) / "wallet.json")
        before = wallet.read()["chips"]
        wallet.topup(w.MIN_BET)
        assert wallet.read()["chips"] >= before
    assert calls and calls[0] == fake.LK_NBLCK and fake.LK_UNLCK in calls, calls
    print("windows-import-ok", calls[:2])
''')


def test_backend_loads_and_wallet_locks_without_fcntl():
    done = subprocess.run([sys.executable, "-c", CHILD, str(ROOT)], capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stdout[-2000:] + done.stderr[-4000:]
    assert "windows-import-ok" in done.stdout
