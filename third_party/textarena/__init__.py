"""Vendored subset of TextArena (MIT) — see LICENSE and README.md beside this file.

This replaces the upstream ``textarena/__init__.py``, which imports the
registration table, the online API client, the wrappers and the agents. Those
pull in openai, requests, rich, nltk and python-chess (GPL), and this plugin
ships none of them. The names below are exactly the ones the four vendored
environments reach through ``import textarena as ta``.
"""

from textarena.core import (  # noqa: F401
    GAME_ID,
    Env,
    Info,
    Message,
    Observations,
    ObservationType,
    Rewards,
    State,
)
from textarena.state import (  # noqa: F401
    FFAMultiPlayerState,
    MinimalMultiPlayerState,
    SinglePlayerState,
    TeamMultiPlayerState,
    TwoPlayerState,
)

# The upstream version the vendored files were copied from.
__version__ = "0.7.3"

__all__ = [
    "Env",
    "State",
    "ObservationType",
    "GAME_ID",
    "Info",
    "Message",
    "Observations",
    "Rewards",
    "SinglePlayerState",
    "TwoPlayerState",
    "FFAMultiPlayerState",
    "TeamMultiPlayerState",
    "MinimalMultiPlayerState",
]
