"""Who is playing. Discord ids stay the key. The name is what the board shows."""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path


# The word filter every name passes through. Short and conservative, matched on
# whole words after folding, so ordinary words that merely contain these letters
# ("Scunthorpe", "therapist") still pass. The online shelf keeps its own copy for
# its own server; a name chosen here has to clear this one.
_BLOCKED = {
    "fuck", "fucker", "fucking", "shit", "cunt", "nigger", "nigga", "faggot", "fag",
    "retard", "kike", "spic", "chink", "whore", "slut", "rape", "rapist",
}
_SPACED = {"fuck", "fucker", "fucking", "shit", "nigger", "nigga", "faggot"}
# Names the shelf itself uses for seats and seats of honour. A person's name must
# not read as one of those.
_RESERVED = {
    "admin", "administrator", "host", "system", "server", "moderator", "mod",
    "referee", "bot", "local", "hermes", "staff", "official",
}
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"})

_FIRST = (
    "Amber", "Blue", "Brave", "Bright", "Calm", "Clever", "Copper", "Daring", "Early", "Fair",
    "Gentle", "Gold", "Green", "Happy", "Hidden", "Honest", "Ivory", "Jolly", "Kind", "Lively",
    "Lucky", "Merry", "Misty", "Nimble", "Olive", "Patient", "Quiet", "Rapid", "Rust", "Silver",
    "Steady", "Sunny", "Swift", "Tidy", "Velvet", "Witty",
)
_LAST = (
    "Otter", "Finch", "Heron", "Badger", "Marten", "Lynx", "Robin", "Sparrow", "Hare", "Fox",
    "Crane", "Wren", "Pike", "Moth", "Beaver", "Kestrel", "Stoat", "Plover", "Rook", "Dove",
    "Bison", "Gecko", "Koala", "Lemur", "Moose", "Puffin", "Quail", "Raven", "Seal", "Tern",
    "Vole", "Wolf", "Yak", "Zebra", "Crab", "Dolphin",
)


class Player:
    def __init__(self, id: str, name: str, platform: str, bot: bool = False, named: bool = False) -> None:
        self.id = id
        self.name = name
        self.platform = platform
        self.bot = bot
        self.named = named


def clean_name(text: str) -> str:
    flattened = " ".join(str(text or "").replace("\n", " ").split())
    kept = "".join(ch for ch in flattened if ch.isalnum() or ch in " _-.")
    kept = kept.strip()[:32]
    if kept.lower() in {"human", "local", "cpu"} or not any(ch.isalnum() for ch in kept):
        return ""
    return kept


def _fold(text: str) -> list[str]:
    plain = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode("ascii")
    return re.findall(r"[a-z]+", plain.lower().translate(_LEET))


def blocked_name(text: str) -> bool:
    """True when the name is a rude word, a spaced-out spelling of one, or reserved.

    Whole words are matched after folding. A name in pieces (``F.u.c.k``, ``f u c k``)
    is joined and checked, because that is the spelling someone uses on purpose. A
    single-word name is only checked at its start and end, so ordinary names that
    merely contain the letters — ``Ashita``, ``Scunthorpe`` — still pass.
    """
    words = _fold(text)
    if not words:
        return False
    joined = "".join(words)
    if joined in _RESERVED or any(word in _BLOCKED for word in words):
        return True
    if len(words) > 1:
        return any(bad in joined for bad in _SPACED)
    return any(joined.startswith(bad) or joined.endswith(bad) for bad in _SPACED)


def name_problem(text: str) -> str:
    """Why this name cannot be used, in plain words, or "" when it is fine.

    One set of rules for the welcome, Settings and ``/games name``: letters,
    numbers, spaces, dots, dashes and underscores, two to 32 characters, nothing
    rude and nothing the shelf uses for its own seats.
    """
    cleaned = " ".join(str(text or "").replace("\n", " ").split())
    if not cleaned:
        return "Type a name first."
    kept = clean_name(cleaned)
    if not kept:
        return "Use letters or numbers, up to 32 characters."
    if len(kept) < 2:
        return "Use at least two letters or numbers."
    if blocked_name(kept):
        return "Pick a different name."
    return ""


def suggest_name(seed: str = "") -> str:
    """A name that is already valid, so Continue can be pressed at once.

    The same seed always gives the same suggestion, so re-opening the welcome
    does not shuffle the name under the person's eyes.
    """
    digest = hashlib.sha256(str(seed or "game-center").encode("utf-8")).digest()
    return _FIRST[digest[0] % len(_FIRST)] + _LAST[digest[1] % len(_LAST)]


def _platform_name(platform: object, source: object) -> str:
    if platform:
        return str(getattr(platform, "value", platform) or "").strip().lower() or "local"
    if source is None:
        return "local"
    raw = getattr(source, "platform", "") or ""
    return str(getattr(raw, "value", raw) or "local").strip().lower() or "local"


class NameBook:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def get(self, player_id: str) -> str:
        return self._read().get(player_id, "")

    def remember(self, player_id: str, name: str) -> None:
        data = self._read()
        data[player_id] = name
        self._write(data)

    def set(self, player: Player, words: list[str]) -> str:
        where = "Discord" if player.platform == "discord" else player.platform
        if not words:
            return f"You are {player.name} on {where}."
        chosen = clean_name(" ".join(words))
        if not chosen:
            return "Usage: /games name Argo"
        if blocked_name(chosen):
            return "Pick a different name."
        self.remember(player.id, chosen)
        player.name = chosen
        player.named = True
        return f"You are {chosen} on {where}."

    def _read(self) -> dict[str, str]:
        if not self.path.is_file():
            return {}
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(loaded, dict):
            return {}
        return {str(key): str(value) for key, value in loaded.items()}

    def _write(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data), encoding="utf-8")
        os.replace(temporary, self.path)


def identify(platform: object, source: object, book: NameBook) -> Player:
    """Build the person from the Hermes session. A Discord user id is the stable key."""
    bot = bool(getattr(source, "is_bot", False))
    user_id = str(getattr(source, "user_id", "") or "").strip()
    shown = clean_name(str(getattr(source, "user_name", "") or ""))
    where = _platform_name(platform, source)
    player_id = f"{where}:{user_id}" if user_id else "local"
    saved = book.get(player_id)
    if saved:
        name = saved
        named = True
    elif shown:
        name = shown
        book.remember(player_id, name)
        named = True
    else:
        name = "You"
        named = False
    return Player(player_id, name, where, bot, named)
