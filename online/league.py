"""Which games are rated, how a rated match is paired, and how long a move may take.

Two ideas live here, both plain data so tests can hold them still:

* **Ranked is a short list.** Only games where the better player wins more often are
  rated. Four-in-a-row, checkers, Kalah and Gomoku stay casual: a strong player can
  be held to a draw by accident often enough that a rating would say more about luck
  than skill.
* **A ranked match is a pair.** The same deal is played twice with the seats
  swapped, and the pair counts as one game. One rating change follows both legs, so
  a lucky seat or a lucky deal cannot decide a rating on its own.

Games that do not exist on this shelf yet (Chess960, Sea Battle, Pet Battles) are
named in ``FUTURE_RANKED`` and documented, never enabled: a game is ranked only when
its id is in ``RANKED_GAMES`` *and* the server actually hosts it.
"""

from __future__ import annotations

RANKED_GAMES = (
    "go",
    "hex",
    "breakthrough",
    "chessboard",
    "reversi",
    "liars_dice",
    "mafia",
    "prisoners_dilemma",
    "blind_auction",
    "doctrine",
    "doctrine_arena",
)

# Decided, documented, not built: these need a game (or a server-side model) first.
FUTURE_RANKED = ("chess960", "sea_battle", "pet_battles")

CASUAL_ONLY = ("connect4", "checkers", "gomoku")

# A rated pair is two legs: the same seed, the seats swapped.
PAIR_LEGS = 2

# Talking games ask the owner's machine for a decision, so they get longer.
TALKING_GAMES = ("liars_dice", "mafia", "prisoners_dilemma", "blind_auction")
RANKED_MOVE_SECONDS = 15
OPEN_LEAGUE_MOVE_SECONDS = 30

# A challenge waits ten minutes for the bot's owner to bring it to the table.
CHALLENGE_SECONDS = 600
CHALLENGES_PER_BOT = 3

OPEN_LEAGUE_BADGE = "self-hosted, unverified"


def ranked(game: str, available=()) -> bool:
    """True when this game is on the ranked list and the server hosts it."""
    return game in RANKED_GAMES and (not available or game in available)


def casual(game: str) -> bool:
    return game in CASUAL_ONLY


def talking(game: str) -> bool:
    return game in TALKING_GAMES


def move_seconds(game: str = "", *, open_league: bool = False) -> float:
    """How long a seated bot may take for one move before it forfeits."""
    return float(OPEN_LEAGUE_MOVE_SECONDS if open_league or talking(game) else RANKED_MOVE_SECONDS)


def label(game: str, available=()) -> str:
    if ranked(game, available):
        return "Ranked"
    if casual(game):
        return "Casual only"
    return "Unranked"


def split(games) -> dict:
    """Sort the server's games into the three shelves the page shows."""
    found = {"ranked": [], "casual": [], "other": []}
    for game in games:
        if ranked(game, games):
            found["ranked"].append(game)
        elif casual(game):
            found["casual"].append(game)
        else:
            found["other"].append(game)
    return found
