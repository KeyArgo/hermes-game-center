"""Input limits for Game Center Online: display names, chat text, and rate limits."""

from __future__ import annotations

import re
import time
import unicodedata
from collections import deque

NAME_MIN = 2
NAME_MAX = 20
CHAT_MAX = 300

# A short, conservative list. Matching is on whole words after folding, so ordinary words
# that merely contain these letters pass. Room hosts can mute or remove for anything else.
_BLOCKED = {
    "fuck", "fucker", "fucking", "shit", "cunt", "nigger", "nigga", "faggot", "fag",
    "retard", "kike", "spic", "chink", "whore", "slut", "rape", "rapist",
}
_SPACED = {"nigger", "nigga", "faggot", "fucker", "fucking"}
_RESERVED = {"admin", "administrator", "host", "system", "server", "moderator", "mod",
             "referee", "bot", "local", "hermes", "staff", "official"}
_NAME_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.\-]*[A-Za-z0-9]$")
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"})


def _fold(text: str) -> list[str]:
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    return re.findall(r"[a-z]+", plain.lower().translate(_LEET))


def blocked(text: str) -> bool:
    words = _fold(text)
    joined = "".join(words)
    # Run-together spellings only for slurs that never occur inside ordinary words
    # ("therapist", "Scunthorpe" and "retardant" must pass).
    return any(word in _BLOCKED for word in words) or any(bad in joined for bad in _SPACED)


def clean_name(raw: object) -> tuple[str | None, str]:
    """Return (name, "") when usable, or (None, reason)."""
    name = " ".join(str(raw or "").split())
    if not (NAME_MIN <= len(name) <= NAME_MAX):
        return None, f"Names are {NAME_MIN} to {NAME_MAX} characters."
    if not _NAME_OK.match(name):
        return None, "Use letters, numbers, spaces, dots, dashes or underscores."
    # Names are short and shown everywhere, so spaced-out spellings are checked too.
    joined = "".join(_fold(name))
    if blocked(name) or joined in _RESERVED or any(bad in joined for bad in _BLOCKED):
        return None, "Pick a different name."
    return name, ""


def clean_chat(raw: object) -> tuple[str | None, str]:
    text = "".join(" " if ch.isspace() else ch for ch in str(raw or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")
    text = " ".join(text.split())
    if not text:
        return None, "Type a message."
    if len(text) > CHAT_MAX:
        return None, f"Messages are up to {CHAT_MAX} characters."
    if blocked(text):
        return None, "That message was blocked by the word filter."
    return text, ""


class Limiter:
    """At most ``count`` events per ``window`` seconds for each key."""

    def __init__(self, count: int, window: float, clock=time.monotonic) -> None:
        self.count = count
        self.window = window
        self.clock = clock
        self.events: dict[str, deque] = {}

    def allow(self, key: str) -> bool:
        now = self.clock()
        seen = self.events.setdefault(key, deque())
        while seen and now - seen[0] >= self.window:
            seen.popleft()
        if len(seen) >= self.count:
            return False
        seen.append(now)
        return True

    def prune(self) -> None:
        now = self.clock()
        for key in [key for key, seen in self.events.items() if not seen or now - seen[-1] >= self.window]:
            del self.events[key]


_LOOKALIKE = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j",
    "ѕ": "s", "ԁ": "d", "ӏ": "l", "α": "a", "ο": "o", "ρ": "p", "ε": "e", "ι": "i", "κ": "k",
    "ν": "v", "τ": "t", "η": "n", "μ": "u",
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s",
}


def skeleton(name: str) -> str:
    """One key per name, so a lookalike cannot pass for someone else.

    Folds case, accents, Cyrillic/Greek lookalikes and common digit swaps, drops
    spaces and punctuation, then folds `rn` and `vv`, which read as `m` and `w`.
    """
    value = unicodedata.normalize("NFKD", str(name or "").lower())
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = "".join(_LOOKALIKE.get(ch, ch) for ch in value)
    value = re.sub(r"[^a-z0-9]", "", value)
    return value.replace("rn", "m").replace("vv", "w")
