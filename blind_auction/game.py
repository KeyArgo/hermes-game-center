"""Blind Auction: two seats, five lots, private values, one secret bid each."""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

ID = "blind-auction"
TITLE = "Blind Auction"
EXAMPLE = "new"
MAX_PLIES = 80
HELP = [
    "Two seats and five lots. Each lot is worth a different amount to each of you.",
    "Talk first, then send one secret set of bids. The higher bid on a lot wins it.",
    "The table goes to the higher net worth: spare coins plus what your lots were worth to you.",
]


def create(root: Path, settings: dict | None = None):
    from talktable.engine import create as _create

    return _create(Path(root), ID, settings)
