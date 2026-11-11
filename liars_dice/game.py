"""Liar's Dice: two to six seats, hidden dice, bids that only go up."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

ID = "liars-dice"
TITLE = "Liar's Dice"
EXAMPLE = "new"
MAX_PLIES = 400
HELP = [
    "Everyone rolls five dice and keeps them hidden.",
    "On your turn either raise the bid (more dice, or the same count on a higher face) or call the last bid a lie.",
    "The loser of a call loses a die. The last player holding dice wins.",
]


def create(root: Path, settings: dict | None = None):
    from talktable.engine import create as _create

    return _create(Path(root), ID, settings)
