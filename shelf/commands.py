""" /games is the front door. The game id picks which plugin handles the rest."""

from __future__ import annotations

import shlex

from .catalog import Catalog
from .lobby import looking, talk
from .who import NameBook

_LOBBY = {"chat", "looking", "doom", "name", "host", "install", "get", "remove", "uninstall", "match"}


def run(
    catalog: Catalog,
    raw: str,
    *,
    source: str = "command",
    complete=None,
    player=None,
    names: NameBook | None = None,
) -> str:
    text = (raw or "").strip()
    # /games doctrine import <json>: the document is JSON, so shlex.split would
    # eat its quotes and braces. Hand the rest through exactly as typed.
    import_head = text.split(None, 2)
    if len(import_head) >= 2 and import_head[0].lower() == "doctrine" and import_head[1].lower() == "import":
        body = import_head[2] if len(import_head) > 2 else ""
        return catalog.play("doctrine", "import " + body, source=source, complete=complete, player=player)
    try:
        parts = shlex.split(text)
    except ValueError:
        return "Could not read that. Try /games"
    if not parts:
        return catalog.list_text()
    refusal = _bot_refusal(catalog, parts, player)
    if refusal:
        return refusal
    head = parts[0].lower()
    if head == "chat":
        return talk(catalog.data_root, player, parts[1:])
    if head == "doom":
        rest = parts[1:]
        lobby_words = {"say", "looking", "stop", "who", "look"}
        if rest and rest[0].lower() in lobby_words:
            return talk(catalog.data_root, player, rest, game="doom")
        if catalog.has("doom"):
            return catalog.play("doom", " ".join(rest), source=source, complete=complete, player=player)
        return talk(catalog.data_root, player, rest, game="doom")
    if head == "match":
        # Matchmaking across games is not built yet. Say so in one line and
        # change nothing: the online queue stays the working way to find a game.
        return (
            "Coming soon: /games match <game> will look for players in several games at once, "
            "with a list to switch them off. For now, turn on online play in the Game Center dock "
            "and use Find a match."
        )
    if head == "looking":
        game = parts[1].lower() if len(parts) > 1 else ""
        address = ""
        extra = parts[2:]
        if extra and extra[0].lower() == "host" and len(extra) > 1:
            address = extra[1]
        elif extra and ":" in extra[0]:
            address = extra[0]
        known = catalog.has(game) or game in {"", "stop", "doom"}
        return looking(catalog.data_root, player, game, known, address=address)
    if head == "host":
        return _host(catalog, player, parts[1:])
    if head in {"install", "get"}:
        return catalog.install(parts[1] if len(parts) > 1 else "", source=source, player=player)
    if head in {"remove", "uninstall"}:
        return catalog.remove(parts[1] if len(parts) > 1 else "", source=source, player=player)
    if head == "name":
        if names is None or player is None:
            return "Type /games name Argo"
        return names.set(player, parts[1:])
    if head in {"allow-ai", "allow_ai"}:
        if len(parts) < 2:
            return "Usage: /games allow-ai connect4 black=local"
        game_id = parts[1].lower()
        rest = "allow-ai " + " ".join(parts[2:])
        return catalog.play(game_id, rest, source=source, complete=complete, player=player)
    rest = " ".join(parts[1:])
    if not rest:
        return catalog.play(head, "help", source=source, complete=complete, player=player)
    return catalog.play(head, rest, source=source, complete=complete, player=player)


def _bot_refusal(catalog: Catalog, parts: list[str], player) -> str | None:
    """A bot may play only the games that say so. Chess stays a person's seat."""
    if player is None or not getattr(player, "bot", False):
        return None
    head = parts[0].lower()
    if head in _LOBBY:
        return None
    if head in {"allow-ai", "allow_ai"} or (len(parts) > 1 and parts[1].lower() in {"allow-ai", "allow_ai"}):
        return "A bot cannot agree to an AI seat. A person types /games allow-ai."
    allowed = catalog.allows_bots(head)
    if allowed is None or allowed:
        return None
    welcome = catalog.bot_titles()
    title = catalog.title(head)
    if welcome:
        return f"{title} does not allow bots. Bots can play {', '.join(welcome)}."
    return f"{title} does not allow bots."


def _host(catalog: Catalog, player, parts: list[str]) -> str:
    if not parts or parts[0].lower() == "stop":
        return looking(catalog.data_root, player, "stop", True)
    game = parts[0].lower()
    address = parts[1] if len(parts) > 1 else ""
    if not address:
        return "Usage: /games host <game> <your-host:port>"
    kind = catalog.kind(game)
    if kind not in {None, "listen", "play"}:
        return (
            f"{catalog.title(game)} is not a host-from-client game. "
            f"Find people with /games looking {game}"
        )
    known = catalog.has(game)
    if not known:
        return f"No game named {game}. /games lists them."
    return looking(catalog.data_root, player, game, True, address=address)
