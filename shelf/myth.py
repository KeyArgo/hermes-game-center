"""Names and flavour from public-domain Greek myth around Hermes.

Hermes was the messenger, the god of roads and crossroads, of luck and games,
and the trickster of Olympus. Nothing here is branding: the ladder ranks and
the house boss name are plain English labels with a myth nod, and every one of
them still says what the thing is.

Two small functions only, both total: they never raise on bad input, so a
rating or a model string that arrives malformed can never take a page down.
"""

from __future__ import annotations

import math
import re

# Ladder titles, lowest band first. A champion's Elo decides its title; the
# bands are wide on purpose, so a title is a landmark rather than a treadmill.
_RANKS = (
    (1900.0, "Olympian"),
    (1600.0, "Trickster"),
    (1400.0, "Herald"),
    (1200.0, "Messenger"),
    (-math.inf, "Wayfarer"),
)
# A rating that is not a number is treated as the starting rating, the same
# default the Elo table uses.
_DEFAULT_RATING = 1500.0
_SEPARATORS = re.compile(r"[-_/.]+")


def rank_title(rating) -> str:
    """The myth-flavoured ladder title for one Elo rating."""
    value = _rating(rating)
    for floor, title in _RANKS:
        if value >= floor:
            return title
    return "Wayfarer"


def _rating(rating) -> float:
    if isinstance(rating, bool) or rating is None:
        return _DEFAULT_RATING
    try:
        value = float(rating)
    except (TypeError, ValueError):
        return _DEFAULT_RATING
    if not math.isfinite(value):
        return _DEFAULT_RATING
    return value


def pretty_model(model) -> str:
    """A model id as a person reads it: separators become spaces.

    The letters keep their case, because model names are written with their own
    capitalisation (Hermes-4-70B). An empty or non-string value gives "".
    """
    if not isinstance(model, str):
        return ""
    text = _SEPARATORS.sub(" ", model)
    return " ".join(text.split())
