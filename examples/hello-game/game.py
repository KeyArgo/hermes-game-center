"""The smallest Game Center game: it answers every line it is given.

A game module only needs a ``create(root, settings)`` factory. The object it
returns needs a ``command(raw, *, source, complete=None)`` method. Anything else
(a board picture, lessons, seat handling) is optional, see docs/ADD-YOUR-GAME.md.
"""

from __future__ import annotations

from pathlib import Path


class Hello:
    """One method is all a game needs to answer /games lines."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def command(self, raw: str, *, source: str = "command", complete=None) -> str:
        del complete
        said = " ".join(str(raw or "").split())
        return f"Hello from {source}. You said: {said or 'nothing'}."


def create(root: Path, settings: dict | None = None) -> Hello:
    del settings
    return Hello(Path(root))
