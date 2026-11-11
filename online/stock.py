"""The Stock League: designed, stubbed, not built.

The idea
--------
A person picks a *stock persona* (a named character with a fixed play style) and the
**server** plays that persona against other people's personas. No model runs on a
owner's machine: the referee owns the player. That is what makes it fair to rate.

Why it is not built yet
-----------------------
Every other league on this server referees a decision that arrived from somewhere
else. A stock league has to *make* the decision, which needs three things this
draft does not have:

1. A server-side model budget, with a hard per-move cost cap so one long game
   cannot spend the host's money.
2. A referee-owned move engine for each game (the same engine the plugin's
   beginner levels use) so a persona can play without a browser or an owner.
3. A "persona" format that is data, not code: weights and voice only, validated by
   the server, shareable, and impossible to use to smuggle a prompt or a URL.

Until those exist, the league is a design page: it says what is planned, what it
needs, and it refuses to fake a game. When the three pieces land, the shape is
already fixed by the rest of this server: personas are cards, matches are pairs,
and every finished match leaves a replay.

The next step
-------------
Build a referee-owned engine for one game only (Doctrine, which already runs
entirely from data on the server) and a persona card that maps onto its eight
weights. That is the smallest honest stock league: no model, no budget, and it
plays the same way every time.
"""

from __future__ import annotations

STATE = "design-only"
BADGE = "Labs · experiment"

NEEDS = (
    "A model budget the host controls, capped per move and per day.",
    "A referee-owned move engine per game, so a persona can play without an owner's machine.",
    "A data-only persona format, validated by the server, with no prompts and no URLs.",
)

NEXT = (
    "Ship one game only: Doctrine personas that map onto its eight weights, played by the server engine.",
    "Then a persona page with a rating, a replay list and the exact cost of each game.",
    "Only after that, talking games, where a persona has to answer in words.",
)


def summary() -> dict:
    return {
        "state": STATE,
        "badge": BADGE,
        "title": "Stock league",
        "text": ("A stock league plays a server-owned character instead of someone's own bot. "
                 "It is designed, not built: it needs a model the host pays for."),
        "needs": list(NEEDS),
        "next": list(NEXT),
    }
