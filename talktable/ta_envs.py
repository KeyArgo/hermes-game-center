"""Load the vendored TextArena environments without installing the package.

``third_party/`` is put in front of ``sys.path`` so the environments' own
``import textarena as ta`` resolves to the copy in this repository, never to a
copy someone may have installed globally (which would drag in python-chess,
openai and requests).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "third_party"
PACKAGE = VENDOR / "textarena"


def _ours(module: Any) -> bool:
    found = getattr(module, "__file__", "") or ""
    try:
        return PACKAGE in Path(found).resolve().parents
    except (OSError, ValueError):
        return False


def load() -> Any:
    """The vendored ``textarena`` package, imported once."""
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))
    found = sys.modules.get("textarena")
    if found is not None and not _ours(found):
        # Something else claimed the name first. Drop it and its submodules so
        # the environments below cannot end up half-ours and half-theirs.
        for name in [key for key in sys.modules if key == "textarena" or key.startswith("textarena.")]:
            del sys.modules[name]
    import textarena as ta  # noqa: F401  (the environments import it by this name)

    if not _ours(ta):
        raise ImportError(f"the vendored textarena was not the one loaded: {getattr(ta, '__file__', '?')}")
    return ta


TITLE_BY_ENV = {
    "SecretMafiaEnv": "Mafia",
    "LiarsDiceEnv": "Liar's Dice",
    "IteratedPrisonersDilemmaEnv": "Prisoner's Dilemma",
    "SimpleBlindAuctionEnv": "Blind Auction",
}


def env_class(name: str):
    """One vendored environment class by its short name."""
    load()
    if name == "SecretMafiaEnv":
        from textarena.envs.SecretMafia.env import SecretMafiaEnv

        return SecretMafiaEnv
    if name == "LiarsDiceEnv":
        from textarena.envs.LiarsDice.env import LiarsDiceEnv

        return LiarsDiceEnv
    if name == "IteratedPrisonersDilemmaEnv":
        from textarena.envs.IteratedPrisonersDilemma.env import IteratedPrisonersDilemmaEnv

        return IteratedPrisonersDilemmaEnv
    if name == "SimpleBlindAuctionEnv":
        from textarena.envs.SimpleBlindAuction.env import SimpleBlindAuctionEnv

        return SimpleBlindAuctionEnv
    raise KeyError(name)
