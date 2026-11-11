"""Liar's Dice 2v2: four seats, two teams, one shared pool of dice each."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

ID = "liars-dice-2v2"
TITLE = "Liar's Dice 2v2"
EXAMPLE = "new"
MAX_PLIES = 400
HELP = [
    "Four seats: you and a partner against a pair, in alternating turns.",
    "Each team shares one pool of ten dice. Your cup is your half of the pool.",
    "Raise the bid or call the last bid a lie. The team that loses the call loses a die from its pool.",
    "Partners may only signal in the open: a bid, or one public line, that both teams read.",
]


def create(root: Path, settings: dict | None = None):
    from talktable.engine import create as _create

    return _create(Path(root), ID, settings)
