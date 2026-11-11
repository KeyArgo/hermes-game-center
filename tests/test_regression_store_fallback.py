"""The standalone import path brings in the module store.py actually uses.

`online/store.py` is also imported by small scripts that put `online/` first on `sys.path`
(the try/except at the top of the file exists for exactly that). That fallback imported
`league`, which store.py never refers to, and left `guard` undefined — so on that path the
first call to `guard.skeleton()` raised NameError, which no test could see because the suite
always imports the package form.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ONLINE = Path(__file__).resolve().parent.parent / "online"


def _run(code: str) -> str:
    done = subprocess.run([sys.executable, "-c", code], cwd=str(ONLINE),
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def test_the_standalone_import_can_use_guard() -> None:
    """`import store` with only online/ on the path must provide a working guard."""
    out = _run(
        "import sys; sys.path.insert(0, '.'); import store; "
        "print(store.guard.skeleton('Ada Lovelace'))"
    )
    # skeleton() folds the name for comparison, so it drops the space by design.
    assert out == "adalovelace", out


def test_the_standalone_import_does_not_need_league() -> None:
    """store.py never uses league; the fallback must not depend on it being importable."""
    out = _run("import sys; sys.path.insert(0, '.'); import store; print('league' in dir(store))")
    assert out == "False", out
