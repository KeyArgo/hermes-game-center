"""Prisoner's Dilemma: three to six seats, every pair meets, points add up."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

ID = "prisoners-dilemma"
TITLE = "Prisoner's Dilemma"
EXAMPLE = "new"
MAX_PLIES = 200
HELP = [
    "Every pair of seats plays one short match: talk first, then choose in secret.",
    "Both work together: 3 points each. Both sell out: 1 each. One sells out: 5 to the seller, 0 to the other.",
    "Points from every match are added up, so the highest total across the field wins.",
]


def create(root: Path, settings: dict | None = None):
    from talktable.engine import create as _create

    return _create(Path(root), ID, settings)
