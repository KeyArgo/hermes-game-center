"""Mafia: a talking table for six or more seats, driven by the vendored SecretMafia env."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

ID = "mafia"
TITLE = "Mafia"
EXAMPLE = "new"
MAX_PLIES = 200
HELP = [
    "Six seats: two are mafia, one is a doctor, one is a detective, the rest are villagers.",
    "By day everyone talks, then everyone votes someone out. By night the mafia chooses a victim.",
    "You see your own role only. The reveal at the end shows every role.",
]


def create(root: Path, settings: dict | None = None):
    from talktable.engine import create as _create

    return _create(Path(root), ID, settings)
