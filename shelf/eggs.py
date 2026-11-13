"""Easter eggs: small surprises that hide in Game Center and pay points when found.

Owner's ask, 2026-11-09: "find easter eggs that show up randomly through game center that gives the
user points if they find. we can update them every now and again but one user can use them once, and
each can pay out as much as 10k in points or as little as 1k."

How it works, and why:

- **One egg shows at a time, on a clock everyone shares.** The hour is the unit: a hash of
  ``hour + salt`` decides whether an egg is out and which one. That keeps the schedule server-side
  and identical on every surface, so a person cannot refresh the machine to reroll for a better egg.
- **The catalogue is data.** Adding, retiring or repricing an egg is one row in ``EGGS``; nothing
  else needs to change, which is what "we can update them every now and again" asks for.
- **A person finds each egg once, ever.** The wallet keeps the ids claimed, so the tenth sighting of
  the same egg pays nothing. That is the "one user can use them once" rule, enforced where the
  points are actually paid rather than in the UI.
- **Pay between 1,000 and 10,000 points.** Points are the leaderboard currency, so an easter egg is
  a real gain in standing, not play money.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path

# The catalogue. ``points`` is what finding it pays; ``hint`` is shown once someone is close enough
# to see it, in the owner's voice. Keep ids stable forever: they are the record of who found what.
EGGS = (
    {"id": "wing-in-the-glass", "points": 1000, "where": "slots",
     "hint": "A wing is hiding in the glass of the fruit machine."},
    {"id": "seventh-drachma", "points": 1500, "where": "slots",
     "hint": "The Olympus reels have a coin that pays nothing. Look anyway."},
    {"id": "tray-of-nine", "points": 2000, "where": "slots",
     "hint": "Nine windows, one tray. Something is under the tray."},
    {"id": "quiet-owl", "points": 2500, "where": "lobby",
     "hint": "An owl watches the lobby after midnight."},
    {"id": "junior-seal", "points": 3000, "where": "games",
     "hint": "The referee's badge is not always the referee's badge."},
    {"id": "the-long-road", "points": 4000, "where": "home",
     "hint": "Two hundred and three carriers, and one of them is not a carrier."},
    {"id": "nous-in-the-marquee", "points": 6000, "where": "slots",
     "hint": "The marquee is blank until a jackpot. It is not always blank."},
    {"id": "the-argo-stamp", "points": 10000, "where": "anywhere",
     "hint": "One developer stamp is slightly the wrong colour."},
    # The one that is just the mark. ``art`` names a picture the desktop already draws for the reels
    # (the Nous stamp), and that artwork carries its own slogan - nothing is printed on top of it
    # (owner's ask, 2026-11-09: "just the nous image we use in the slots, no need to add anything,
    # it already mentions the slogan on it"). Allowed up to 5,000 points, the top of the second tier.
    {"id": "rebellion-mark", "points": 5000, "where": "slots", "art": "NOUS",
     "hint": "One Nous stamp on the cabinet is not on a reel."},
)

# How often an egg is out: one hour in EGG_ODDS. Eight keeps it a surprise rather than a schedule
# people can plan around.
EGG_ODDS = 8

EGG_BY_ID = {egg["id"]: egg for egg in EGGS}

# The salt is not a secret and not a password: it only stops the schedule lining up with the clock
# in a way people could memorise. Change it to reshuffle when the catalogue changes.
SALT = "gameshelf-eggs-v1"


def _hash(*parts: object) -> int:
    raw = ":".join(str(part) for part in parts)
    return int.from_bytes(hashlib.sha256(raw.encode("utf-8")).digest()[:8], "big")


def slot(hour: int | None = None) -> int:
    """The hour this is about, so every caller in the same hour agrees on the answer."""
    return int(time.time() // 3600) if hour is None else int(hour)


def current(hour: int | None = None) -> dict | None:
    """The egg showing right now, or None. Deterministic for the hour, so no rerolling.

    There is no override any more (owner's decision, 2026-11-13): the developer cheats were removed
    outright rather than hidden, so there is nothing to force — the schedule is the schedule, on every
    machine, for everyone holding a copy of this source.
    """
    at = slot(hour)
    roll = _hash(SALT, "roll", at) % EGG_ODDS
    if roll != 0:
        return None
    egg = EGGS[_hash(SALT, "which", at) % len(EGGS)]
    return dict(egg, hour=at, ends_at=(at + 1) * 3600)


def find(egg_id: str) -> dict | None:
    """The catalogue row for an id, or None."""
    return EGG_BY_ID.get(str(egg_id or ""))


def points_for(egg_id: str) -> int:
    egg = find(egg_id)
    return int(egg["points"]) if egg else 0
