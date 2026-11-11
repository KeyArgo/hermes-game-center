"""The online lobby as a second source for the dock's Lobby tab.

Game Center's own lobby is a file on this computer. This is the other source: the
lobby server at ``games.hermesnet.xyz`` (or wherever the ``lobby_url`` setting
points), run by the same author. It is **off until the person turns it on**, and
this module is the only place that talks to it.

Three rules this file keeps:

* Nothing is sent before the person turns online play on. ``refresh`` and every
  other network call return the "off" answer without opening a socket.
* The recovery key is a credential. It is read with ``agent.secret_scope`` and
  written through Hermes's own credential route (``hermes_cli.config``), never to
  a file of ours, never to a log, and never into a message the page renders
  except the one time the server hands a new key out to be copied.
* A server that is down is a plain, quiet state: the answer says so, local play
  is untouched, and the next try waits longer each time (15, 30, 60, then 120
  seconds) until one gets through.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlsplit

from shelf.kitref import kit
from shelf.who import suggest_name

log = logging.getLogger(__name__)

DEFAULT_URL = "https://games.hermesnet.xyz"
KEY_ENV = "HERMES_GAMESHELF_LOBBY_KEY"
BOT_KEY_ENV = "HERMES_GAMESHELF_BOT_KEY"
# A staff key is separate from the recovery key: signing in says who you are,
# this says you may moderate. Neither one is enough on its own.
STAFF_KEY_ENV = "HERMES_GAMESHELF_STAFF_KEY"
STATE_FILE = "online.json"

POLL_SECONDS = 15
LEAGUE_SECONDS = 20
BACKOFF_SECONDS = (15, 30, 60, 120)
ALERT_EVERY_SECONDS = 600
TIMEOUT_SECONDS = 6.0
MATCH_KEEP_SECONDS = 1800
MAX_BYTES = 262144
# How often the local wallet's totals may be told to the server, at most. They go up
# only when they changed, so this is a ceiling on a quiet background note, not a poll.
BALANCE_SECONDS = 30

DISCLOSURE = (
    "Online play and match alerts are off until you turn them on here. When they are on, "
    "Game Center talks to {url} and sends: the display name you pick, your recovery key when "
    "you sign in, which game you are waiting for, the moves you make, your chip and point "
    "totals (so they can be moved somewhere else later - they are never used for a "
    "leaderboard), and - for the bot ladder - your bot's name and the move it picks. While "
    "online play is on, Game Center also stays connected to the lobby - even with the lobby "
    "panel closed - so others can see you "
    "are online, and it sends which games you will accept a challenge in, whether you are "
    "appearing offline, which games you are looking for a match in, and the play requests "
    "you send or answer. If you use them, it also sends the optional things you choose to "
    "post: a strategy card you publish, a report you file, a block you set, and a bot "
    "challenge you start. The key is kept in Hermes's credentials, "
    "never in a file of ours and never in a log. It does not send your chats with Hermes, your "
    "files, your model or its key, or any telemetry. The server sees your network address the "
    "way any website does. Everything else on this page runs on this computer and keeps "
    "working when the server is down."
)


def disclosure(url: str = DEFAULT_URL) -> str:
    """The one paragraph a person must see before online play is turned on."""
    return DISCLOSURE.format(url=plain_url(url))


def plain_url(raw: Any) -> str:
    """A plain http(s) address, or the default when the setting is unusable.

    The address is a setting, so a typo must not become an error page: anything
    that is not a real http(s) host falls back to the shipped default.
    """
    value = str(raw or "").strip()
    if not value or any(char.isspace() or ord(char) < 32 for char in value):
        return DEFAULT_URL
    try:
        parts = urlsplit(value)
    except ValueError:
        return DEFAULT_URL
    if parts.scheme.lower() not in {"http", "https"} or not parts.hostname or "@" in parts.netloc:
        return DEFAULT_URL
    return value.rstrip("/")


def wallet_totals(folder: Path | str) -> tuple[int, int]:
    """The chips and points this computer's wallet holds, as (chips, points).

    Read through ``shelf/wallet.py`` and nothing else: the wallet stays the one place
    that decides what a person has, and nothing here can change it. A missing,
    unreadable or half-written wallet is the blank one, not an error - a person who has
    never played holds the starting chips their own page shows them.

    ``points`` is the wallet's point balance (the key the page calls ``bonus``). Reward
    chips minted by the older token route are chips, not points, and stay out of it.
    """
    try:
        try:
            from shelf.wallet import Wallet, wallet_path
        except ImportError:  # the shelf root is on the path, not its parent
            from wallet import Wallet, wallet_path  # type: ignore

        held = Wallet(wallet_path(Path(folder))).read()
    except Exception:
        log.debug("the local wallet could not be read", exc_info=True)
        return 0, 0
    return _whole(held.get("chips")), _whole(held.get("bonus"))


def _whole(value: Any) -> int:
    """A stored count as a whole number of 0 or more; anything else is nothing."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def read_secret(name: str) -> str:
    """A credential, through Hermes's secret scope (never a file of ours)."""
    try:
        from agent.secret_scope import get_secret

        return str(get_secret(name) or "")
    except Exception:
        return ""


def save_secret(name: str, value: str) -> bool:
    """Store a credential through Hermes's own route.

    This is the writer the Desktop's Settings form uses for a secret field
    (``PUT /api/env`` -> ``hermes_cli.config``), so a key saved here is in the
    same place as every other Hermes credential. Returns False when this Hermes
    build has no such route; the caller then asks the person to paste the key
    into Settings instead of writing it anywhere.
    """
    if not name or not value:
        return False
    try:
        from hermes_cli.config import save_env_value

        save_env_value(name, value)
    except Exception:
        return False
    try:
        from agent.secret_scope import invalidate_env_file_cache

        invalidate_env_file_cache()
    except Exception:
        log.debug("the secret cache could not be invalidated", exc_info=True)
    try:
        return read_secret(name) == value
    except Exception:
        return True


def _blank() -> dict:
    return {"lines": [], "looking": []}


def _blank_league() -> dict:
    """The league area before anything has been read: every section empty, no keys."""
    return {
        "at": 0.0, "ranked_games": [], "casual_games": [], "pair_legs": 2, "future_ranked": [],
        "live": [], "passports": [], "challenges": [], "cards": [],
        "open": {"badge": "self-hosted, unverified", "move_seconds": 30, "text": "",
                 "talking": {}, "live": [], "my_matches": []},
        "stock": {}, "offline": False,
    }


def _rows(value) -> list[dict]:
    """Rows from the server, with anything that is not an object dropped."""
    return [row for row in (value or []) if isinstance(row, dict)]


class Online:
    """One person's connection to the lobby server, as the page sees it."""

    def __init__(
        self,
        folder: Path,
        *,
        url: str = "",
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.time,
        secret: Callable[[str], str] = read_secret,
        store_secret: Callable[[str, str], bool] = save_secret,
        timeout: float = TIMEOUT_SECONDS,
    ) -> None:
        self.folder = Path(folder)
        self.url = plain_url(url)
        self.clock = clock
        self.secret = secret
        self.store_secret = store_secret
        self.timeout = timeout
        self._open = opener or urlrequest.urlopen
        self._fails = 0
        self._next_at = 0.0
        self._offline_text = ""
        self._lobby: dict = _blank()
        self._at = 0.0
        self._queue_at = 0.0
        self._alert_at = 0.0
        self._match: dict | None = None
        self._shown: dict | None = None
        self._ladder: dict = {}
        self._league: dict = {}
        self._league_at = 0.0
        # The wallet totals the last note carried, and when it went: the totals are
        # told to the server only when they changed, and at most every BALANCE_SECONDS.
        self._balance_totals: tuple[int, int] | None = None
        self._balance_at = 0.0
        # Who this person is on the staff side, if anyone. Asked at most every
        # half minute: the Admin tab is the only thing that reads it.
        self._staff: dict = {}
        self._staff_at = 0.0
        self._state = self._load()
        # A table found just before Hermes was closed is still the person's table:
        # the queue entry is gone from the server, so this line is the only way
        # back to it.
        stored_match = self._state.get("match")
        self._match = stored_match if isinstance(stored_match, dict) else None

    # State file: preferences only, never a key ------------------------------

    def _load(self) -> dict:
        path = self.folder / STATE_FILE
        empty = {"on": False, "name": "", "player": "", "game": "", "alerts": {}, "bot": {},
                 "match": None, "alert_seen": {}}
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return empty
        if not isinstance(loaded, dict):
            return empty
        raw_alerts = loaded.get("alerts")
        alerts = raw_alerts if isinstance(raw_alerts, dict) else {}
        raw_bot = loaded.get("bot")
        bot = raw_bot if isinstance(raw_bot, dict) else {}
        match = loaded.get("match") if isinstance(loaded.get("match"), dict) else None
        raw_seen = loaded.get("alert_seen")
        seen = raw_seen if isinstance(raw_seen, dict) else {}
        return {
            "alert_seen": {str(key)[:40]: int(value) for key, value in seen.items()
                           if isinstance(value, (int, float))},
            "on": bool(loaded.get("on")),
            "name": str(loaded.get("name") or "")[:40],
            "player": str(loaded.get("player") or "")[:80],
            "game": str(loaded.get("game") or "")[:40],
            "alerts": {str(key)[:40]: bool(value) for key, value in alerts.items()},
            "bot": {str(key): str(value)[:80] for key, value in bot.items()},
            "match": match,
            # Forget-staff is a flag, not a deleted credential. Dropping it on load
            # made the key come back the next time Hermes started.
            "staff_off": bool(loaded.get("staff_off")),
        }

    def _save(self) -> None:
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            path = self.folder / STATE_FILE
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(self._state), encoding="utf-8")
            os.replace(temporary, path)
        except OSError:
            log.warning("the online-play state could not be saved", exc_info=True)

    # Turning it on -----------------------------------------------------------

    @property
    def on(self) -> bool:
        return bool(self._state.get("on"))

    def turn_on(self) -> dict:
        self._state["on"] = True
        self._fails = 0
        self._next_at = 0.0
        self._offline_text = ""
        self._save()
        return self.snapshot()

    def turn_off(self) -> dict:
        # Leaving the server queue behind would hand someone a table with a player
        # who is no longer looking, so the queue entry goes first.
        if self.on and self.linked and self._state.get("game"):
            self._call("DELETE", "/api/queue", key=self.key())
        self._state["on"] = False
        self._state["game"] = ""
        self._match = None
        self._shown = None
        self._save()
        return self.snapshot()

    # Identity ----------------------------------------------------------------

    def key(self) -> str:
        return str(self.secret(KEY_ENV) or "")

    def bot_key(self) -> str:
        return str(self.secret(BOT_KEY_ENV) or "")

    @property
    def linked(self) -> bool:
        return bool(self.key())

    def sign_up(self, name: str) -> dict:
        """Make a new player on the server, and keep the key it hands out once."""
        chosen = " ".join(str(name or "").split())[:24]
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        if not chosen:
            return {"ok": False, "text": "Pick the name you want to be known by."}
        status, body = self._call("POST", "/api/session", {"name": chosen})
        if status == 200 and body.get("token"):
            self._remember(body.get("player") or {}, chosen)
            stored = self.store_secret(KEY_ENV, str(body["token"]))
            text = f"You are {self._state['name'] or chosen} online."
            if not stored:
                text += (" This Hermes has no place to keep keys, so copy the key below into "
                         "Plugins > Game Center > Online recovery key.")
            return {"ok": True, "text": text, "key_to_copy": str(body["token"]), "stored": stored,
                    "online": self.snapshot()}
        if status == 409 or body.get("needs_key"):
            return {"ok": False, "needs_key": True,
                    "text": f"That name is taken. Enter its recovery key to sign in as {chosen}."}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "The server did not take that name.")}

    def sign_in(self, name: str, key: str = "") -> dict:
        """Sign in with a name and its recovery key, and keep that key in credentials."""
        chosen = " ".join(str(name or "").split())[:24]
        secret = str(key or "").strip() or self.key()
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        if not chosen or not secret:
            return {"ok": False, "text": "Enter your name and your recovery key."}
        status, body = self._call("POST", "/api/session", {"name": chosen, "key": secret})
        if status == 200 and body.get("player"):
            self._remember(body.get("player") or {}, chosen)
            stored = self.store_secret(KEY_ENV, secret)
            text = f"You are {self._state['name'] or chosen} online."
            if not stored:
                text += " This Hermes could not keep the key; paste it into Settings."
            return {"ok": True, "text": text, "stored": stored, "online": self.snapshot()}
        if status == 401:
            return {"ok": False, "text": "That name and recovery key do not match."}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "That did not work.")}

    def ensure_account(self, seed: str = "") -> dict:
        """Auto-create a guest account with a suggested name if not already signed in. Key is stored silently, never exposed."""
        if self.linked:
            return {"ok": True, "online": self.snapshot()}
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        # Try suggested names with numeric suffix on collision
        for attempt in range(10):
            name = suggest_name(seed)
            if attempt > 0:
                name = f"{name} {attempt}"
            status, body = self._call("POST", "/api/session", {"name": name[:24]})
            if status == 200 and body.get("token"):
                self._remember(body.get("player") or {}, name)
                self.store_secret(KEY_ENV, str(body["token"]))
                return {"ok": True, "online": self.snapshot()}
            if status == 409 or body.get("needs_key"):
                continue  # Try next suffix
            if status == 0:
                return {"ok": False, "offline": True, "text": self.offline_text}
            break
        return {"ok": False, "text": "Could not create an online account. Try again."}

    def forget(self) -> dict:
        """Stop using the key on this computer. The server account is untouched."""
        if self.on and self.linked and self._state.get("game"):
            self._call("DELETE", "/api/queue", key=self.key())
        for name in (KEY_ENV, BOT_KEY_ENV):
            try:
                from hermes_cli.config import remove_env_value

                remove_env_value(name)
            except Exception:
                log.warning("a stored key could not be removed", exc_info=True)
        self._state.update({"name": "", "player": "", "game": "", "match": None, "bot": {}})
        self._match = None
        self._balance_totals = None
        self._save()
        return {"ok": True, "text": "Signed out on this computer. Your account is still there.",
                "online": self.snapshot()}

    def _remember(self, player: dict, fallback: str) -> None:
        name = str(player.get("name") or fallback)[:40]
        self._state["name"] = name
        self._state["player"] = str(player.get("id") or "")[:80]
        # Another account may have its own totals, so the next note is not skipped as
        # "unchanged" against the last account's numbers, and does not wait out the
        # previous account's window either.
        self._balance_totals = None
        self._balance_at = 0.0
        self._save()

    # The lobby ---------------------------------------------------------------

    def _fail(self) -> None:
        self._fails = min(self._fails + 1, len(BACKOFF_SECONDS) - 1)
        self._next_at = self.clock() + BACKOFF_SECONDS[self._fails - 1]
        self._offline_text = ("The online lobby cannot be reached right now. Everything here that "
                              "runs on this computer still works.")

    def _reached(self) -> None:
        self._fails = 0
        self._next_at = 0.0
        self._offline_text = ""

    @property
    def offline(self) -> bool:
        return bool(self._fails)

    @property
    def offline_text(self) -> str:
        return self._offline_text or ("The online lobby cannot be reached right now. Everything here "
                                      "that runs on this computer still works.")

    def refresh(self, *, force: bool = False) -> dict:
        """Read the public lobby, at most once per poll, with backoff after a miss.

        Nothing happens while online play is off. A slow or missing server never
        raises: the last lobby is kept and the answer says it is offline.
        """
        if not self.on:
            return self.snapshot()
        now = self.clock()
        if not force and now < self._next_at:
            return self.snapshot()
        if not force and self._at and now - self._at < POLL_SECONDS:
            return self.snapshot()
        status, body = self._call("GET", "/api/lobby")
        # A wallet that changed since the last look rides up with this poll: same
        # backoff, one note at most every BALANCE_SECONDS, and nothing waits on it.
        self.report_balance()
        if status == 200:
            self._reached()
            self._lobby = {
                "lines": [],
                "looking": self._rows(body),
                "waiting": body.get("waiting") if isinstance(body.get("waiting"), dict) else {},
                "bots_waiting": body.get("bots_waiting") if isinstance(body.get("bots_waiting"), dict) else {},
                "presence": body.get("presence") if isinstance(body.get("presence"), dict) else {},
                "ladder": body.get("ladder") if isinstance(body.get("ladder"), dict) else {},
                "looking_counts": body.get("looking") if isinstance(body.get("looking"), dict) else {},
                "rooms": body.get("rooms") if isinstance(body.get("rooms"), list) else [],
            }
            self._at = now
        elif status == 0:
            self._fail()
        else:
            # Reachable but unhappy (a 5xx or a refusal): say so, back off, keep the last view.
            self._fail()
        return self.snapshot()

    @staticmethod
    def _rows(body: dict) -> list[dict]:
        rows = []
        waiting = body.get("waiting")
        if isinstance(waiting, dict):
            for game, people in waiting.items():
                for person in people if isinstance(people, list) else []:
                    if isinstance(person, dict) and person.get("name"):
                        rows.append({"name": str(person["name"])[:40], "game": str(game)[:40]})
        return rows

    # The queue ---------------------------------------------------------------

    def queue(self, game: str, level: str = "intermediate", title: str = "") -> dict:
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        if not self.linked:
            return {"ok": False, "text": "Choose the name you play as first."}
        # Old easy/normal/hard spellings land on the four the server offers.
        level = str(kit.LEVEL_ALIASES.get(str(level).lower(), str(level).lower()))
        status, body = self._call("POST", "/api/queue", {"game": game, "level": level}, key=self.key())
        if status == 200:
            self._state["game"] = str(game)[:40]
            if body.get("matched"):
                self._remember_match(body["matched"])
            self._save()
            return {"ok": True, "text": self._queue_text(body, title), "online": self.snapshot()}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "The queue did not answer.")}

    def stop_queue(self) -> dict:
        if not self.on:
            return {"ok": False, "text": "Online play is off."}
        game = self._state.get("game") or ""
        self._state["game"] = ""
        self._save()
        if self.linked:
            self._call("DELETE", "/api/queue", key=self.key())
        return {"ok": True, "text": "Not looking for a match any more." if game else "You were not looking.",
                "online": self.snapshot()}

    def check_queue(self, *, force: bool = False) -> dict:
        """One queue poll. Stops polling once a table is found."""
        if not self.on or not self._state.get("game") or not self.linked:
            return self.snapshot()
        now = self.clock()
        if now < self._next_at:
            return self.snapshot()
        if not force and self._queue_at and now - self._queue_at < POLL_SECONDS:
            return self.snapshot()
        self._queue_at = now
        status, body = self._call("GET", "/api/queue", key=self.key())
        if status == 200:
            self._reached()
            if body.get("matched"):
                self._remember_match(body["matched"])
                self._save()
            elif not body.get("queued"):
                self._state["game"] = ""
                self._save()
        elif status == 0:
            self._fail()
        return self.snapshot()

    def _remember_match(self, matched: dict) -> None:
        room = matched.get("room") if isinstance(matched.get("room"), dict) else {}
        self._match = {"room": room, "side": str(matched.get("side") or ""), "at": self.clock()}
        self._state["game"] = ""
        # Preferences-only file: a room id and the opponent's name are not secrets,
        # and without this line a restart would lose the table the person was given.
        self._state["match"] = self._match

    def match(self) -> dict | None:
        if not self._match:
            return None
        if self.clock() - float(self._match.get("at") or 0) > MATCH_KEEP_SECONDS:
            self._match = None
            self._state["match"] = None
            self._save()
            return None
        room = self._match.get("room") or {}
        return {
            "room_id": str(room.get("id") or ""),
            "game": str(room.get("game") or ""),
            "title": str(room.get("title") or room.get("game") or ""),
            "side": str(self._match.get("side") or ""),
            "opponent": str(self._opponent(room) or ""),
            "url": f"{self.url}/t/{room.get('id')}" if room.get("id") else self.url,
        }

    def _opponent(self, room: dict) -> str:
        mine = str((self._match or {}).get("side") or "")
        for seat in room.get("seats") or []:
            if isinstance(seat, dict) and seat.get("side") != mine and seat.get("name"):
                return str(seat["name"])
        return ""

    def dismiss_match(self) -> dict:
        self._match = None
        self._state["match"] = None
        self._save()
        return {"ok": True, "text": "Table closed from here.", "online": self.snapshot()}

    def _queue_text(self, body: dict, title: str = "") -> str:
        if body.get("matched"):
            room = (body.get("matched") or {}).get("room") or {}
            return f"Your table is ready: {room.get('title') or room.get('game') or 'a game'}."
        waiting = int(body.get("waiting") or 0)
        game = title or body.get("game") or self._state.get("game") or "that game"
        if waiting > 1:
            return f"Looking for a {game} match. {waiting} people are waiting right now."
        return f"Looking for a {game} match. You are first in line; this keeps looking while you use Hermes."

    # Recording what this computer holds --------------------------------------
    # Chips and points are the person's own play money, kept on this computer by
    # shelf/wallet.py. The server keeps a copy only so it can be moved somewhere else
    # later: self-reported, never read back into play, never a leaderboard.

    def report_balance(self, *, force: bool = False, totals: tuple[int, int] | None = None) -> bool:
        """Tell the server this account's own chip and point totals, when they change.

        Three rules, all of them about not being a nuisance:

        * nothing is sent while online play is off or nobody is signed in;
        * an unchanged pair is not sent again;
        * a change goes up at most once every ``BALANCE_SECONDS``.

        Best effort by design: the answer is not waited for by anything, a failure is
        not raised and not shown, and local play never depends on this. Returns True
        when the server took the numbers.
        """
        if not self.on or not self.linked:
            return False
        chips, points = wallet_totals(self.folder) if totals is None else totals
        now = self.clock()
        if not force:
            if self._balance_totals == (chips, points):
                return False
            if self._balance_at and now - self._balance_at < BALANCE_SECONDS:
                return False
        status, _body = self._call("POST", "/api/balance", {"chips": int(chips), "points": int(points)},
                                   key=self.key())
        # The attempt is what the ceiling is measured from, so an unreachable server is
        # tried once a round rather than on every poll.
        self._balance_at = now
        self._balance_totals = (int(chips), int(points))
        if status != 200:
            return False
        self._reached()
        return True

    # Alerts ------------------------------------------------------------------

    def alerts(self) -> dict:
        return {str(game): bool(value) for game, value in (self._state.get("alerts") or {}).items()}

    def set_alert(self, game: str, enabled: bool) -> dict:
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        game = str(game or "").strip()[:40]
        if not game:
            return {"ok": False, "text": "Pick a game first."}
        # The server is the side that decides whether an alert can be sent, so a
        # failed request must not leave a ticked box that will never fire.
        if self.linked:
            status, body = self._call("POST", "/api/alerts", {"prefs": {game: bool(enabled)}}, key=self.key())
            if status == 0:
                self._fail()
                return {"ok": False, "offline": True,
                        "text": "The online lobby cannot be reached right now, so that alert was not "
                                "changed. Everything on this computer still works.",
                        "online": self.snapshot()}
            if status != 200:
                return {"ok": False,
                        "text": str(body.get("error") or "The lobby did not take that alert."),
                        "online": self.snapshot()}
            self._reached()
        self._state.setdefault("alerts", {})[game] = bool(enabled)
        self._save()
        word = "on" if enabled else "off"
        return {"ok": True, "text": f"Match alerts for {game} are {word}.", "online": self.snapshot()}

    def poll_alert(self) -> dict | None:
        """One look for an alert worth telling the person about, or None.

        The server already holds each game's ten-minute cooldown. This adds the
        two things only this side knows: never twice for the same alert, and
        nothing at all while a table of the person's own is waiting or running.
        The alert is kept on screen until the lobby says nobody is waiting.
        """
        if not self.on or not self.linked or not any(self.alerts().values()):
            return None
        now = self.clock()
        if self._alert_at and now - self._alert_at < POLL_SECONDS:
            return None
        self._alert_at = now
        status, body = self._call("GET", "/api/alerts", key=self.key())
        if status != 200:
            if status == 0:
                self._fail()
            return None
        self._reached()
        seen = self._state.get("alert_seen") if isinstance(self._state.get("alert_seen"), dict) else {}
        rows = body.get("alerts") if isinstance(body.get("alerts"), list) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            game, at = str(row.get("game") or ""), int(row.get("at") or 0)
            if not game or not self.alerts().get(game):
                continue
            if int(seen.get(game) or 0) >= at:
                continue
            seen[game] = at
            self._state["alert_seen"] = seen
            self._save()
            count = int(row.get("waiting") or 0)
            who = "Someone" if count < 2 else f"{count} people"
            self._shown = {"game": game, "at": at, "waiting": count,
                           "text": f"{who} online wants a game of {game} right now."}
            return self._shown
        return None

    def live_alert(self) -> dict | None:
        """The alert still worth showing: it stays until nobody is waiting."""
        if not self._shown:
            return None
        game = str(self._shown.get("game") or "")
        if int((self._lobby.get("looking_counts") or {}).get(game) or 0) > 0:
            return self._shown
        self._shown = None
        return None

    # The bot ladder: a bot of this person's own, played from this computer ----

    def ensure_bot(self, name: str) -> dict:
        """This person's ladder bot, made once and known by its saved id.

        The bot key is a credential like the person's key: it goes through the
        same route and is never written to ``online.json``.
        """
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        if not self.linked:
            return {"ok": False, "text": "Choose the name you play as first."}
        saved = self._state.get("bot") or {}
        if saved.get("id") and self.bot_key():
            return {"ok": True, "id": str(saved["id"]), "name": str(saved.get("name") or ""),
                    "key": self.bot_key(), "stored": True}
        wanted = " ".join(str(name or "").split())[:24]
        if not wanted:
            return {"ok": False, "text": "Name the bot first, so the ladder knows who is playing."}
        status, body = {}, {}
        for candidate in (wanted, f"{wanted} bot", f"{wanted} 2"):
            status, body = self._call("POST", "/api/bots", {"name": candidate[:24]}, key=self.key())
            if status != 409:
                break
        if status == 200 and isinstance(body.get("bot"), dict) and body.get("key"):
            bot = body["bot"]
            self._state["bot"] = {"id": str(bot.get("id") or ""), "name": str(bot.get("name") or "")}
            self._save()
            stored = self.store_secret(BOT_KEY_ENV, str(body["key"]))
            return {"ok": True, "id": str(bot.get("id") or ""), "name": str(bot.get("name") or ""),
                    "key": str(body["key"]), "stored": stored}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "The ladder did not take that bot name.")}

    def ladder_challenge(self, game: str, bot_id: str, opponent: str, *, open_league: bool = False) -> dict:
        """Ask for a rated game against one named bot."""
        body: dict = {"game": game, "white": bot_id, "opponent": opponent}
        if open_league:
            body["open_league"] = True
        status, answer = self._call("POST", "/api/ladder", body, key=self.key())
        if status == 200 and isinstance(answer.get("room"), dict):
            return {"ok": True, "room": answer["room"], "side": str(answer.get("side") or "white"),
                    "pair": answer.get("pair") or {}, "open_league": bool(answer.get("open_league"))}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(answer.get("error") or "The ladder said no.")}

    def bot_queue(self, game: str, key: str, *, open_league: bool = False) -> dict:
        body: dict = {"game": game, "level": kit.DEFAULT_LEVEL}
        if open_league:
            # The open league seats are self-hosted and unverified; that is the one
            # difference on the wire, and the server keeps the label with the room.
            body["open_league"] = True
        status, answer = self._call("POST", "/api/queue", body, key=key)
        if status == 200:
            return {"ok": True, "matched": answer.get("matched"), "waiting": int(answer.get("waiting") or 0)}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(answer.get("error") or "The queue did not answer.")}

    def bot_queue_state(self, key: str) -> dict:
        status, body = self._call("GET", "/api/queue", key=key)
        if status == 200:
            return {"ok": True, "matched": body.get("matched"), "queued": bool(body.get("queued")),
                    "waiting": int(body.get("waiting") or 0)}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "The queue did not answer.")}

    def bot_queue_stop(self, key: str) -> dict:
        self._call("DELETE", "/api/queue", key=key)
        return {"ok": True, "text": "Left the ladder queue."}

    def bot_career(self, bot_id: str) -> dict:
        status, body = self._call("GET", f"/api/bots/{bot_id}")
        if status == 200 and isinstance(body.get("career"), dict):
            return body["career"]
        return {}

    def room(self, room_id: str) -> dict:
        """One table's public summary, which is where the two-leg block lives."""
        if not room_id:
            return {}
        status, body = self._call("GET", f"/api/rooms/{room_id}")
        if status == 200 and isinstance(body.get("room"), dict):
            return body["room"]
        return {}

    # Leagues ----------------------------------------------------------------

    def league(self, *, force: bool = False) -> dict:
        """What the lobby's league area shows: ranked list, live bot games, passports,
        open-league note, my challenges and my cards.

        Six small reads, kept for ``LEAGUE_SECONDS`` so the pane's poll does not turn
        into a flood. Every one of them is public except challenges and cards, which
        only go out when there is a key to send.
        """
        now = self.clock()
        if not self.on or self.offline:
            return _blank_league()
        if not force and not self._at:
            # Nothing has been read yet: turning online play on sends nothing by itself.
            return _blank_league()
        if not force and self._league and now - self._league_at < LEAGUE_SECONDS:
            return self._league
        self._league_at = now
        ladder = self._call("GET", "/api/ladder")[1]
        open_league = self._call("GET", "/api/open-league")[1]
        live = self._call("GET", "/api/spectate")[1]
        passports = self._call("GET", "/api/passports")[1]
        challenges, cards = {}, {}
        key = self.key()
        if key:
            challenges = self._call("GET", "/api/challenges", key=key)[1]
            cards = self._call("GET", "/api/cards", key=key)[1]
        view = {
            "at": now,
            "ranked_games": _rows(ladder.get("ranked_games")),
            "casual_games": _rows(ladder.get("casual_games")),
            "pair_legs": int(ladder.get("pair_legs") or 2),
            "future_ranked": [str(item)[:40] for item in (ladder.get("future_ranked") or [])],
            "live": _rows(live.get("live")) or _rows(ladder.get("live")),
            "passports": _rows(passports.get("passports"))[:24],
            "challenges": _rows(challenges.get("challenges")),
            "cards": _rows(cards.get("cards")),
            "open": {
                "badge": str(open_league.get("badge") or "self-hosted, unverified"),
                "move_seconds": int(open_league.get("move_seconds") or 30),
                "text": str(open_league.get("text") or ""),
                "talking": open_league.get("talking_games") if isinstance(open_league.get("talking_games"), dict) else {},
                "live": _rows(open_league.get("live")),
                "my_matches": _rows(open_league.get("my_matches")),
            },
            "stock": ladder.get("stock") if isinstance(ladder.get("stock"), dict) else {},
            "offline": not ladder and not passports,
        }
        self._league = view
        return view

    def challenge_bot(self, bot_id: str, game: str) -> dict:
        key = self.key()
        if not key:
            return {"ok": False, "text": "Choose the name you play as first."}
        status, body = self._call("POST", f"/api/bots/{str(bot_id)[:80]}/challenge", {"game": game}, key=key)
        self._league_at = 0.0
        if status == 200:
            return {"ok": True, "text": str(body.get("text") or "Invitation sent."), "challenge": body.get("challenge") or {}}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "That invitation did not go through.")}

    def decline_challenge(self, challenge_id: str) -> dict:
        key = self.key() or self.bot_key()
        if not key:
            return {"ok": False, "text": "Choose the name you play as first."}
        status, body = self._call("POST", f"/api/challenges/{str(challenge_id)[:80]}/decline", key=key)
        self._league_at = 0.0
        if status == 200:
            return {"ok": True, "text": str(body.get("text") or "Invitation declined.")}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "That invitation could not be declined.")}

    def save_card(self, game: str, card: dict) -> dict:
        key = self.key()
        if not key:
            return {"ok": False, "text": "Choose the name you play as first."}
        status, body = self._call("POST", "/api/cards", {"game": game, "card": card}, key=key)
        self._league_at = 0.0
        if status == 200:
            return {"ok": True, "text": str(body.get("text") or "Card saved."), "card": body.get("card") or {}}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "That card was not taken.")}

    def run_bout(self, game: str, mine: str, theirs: str) -> dict:
        key = self.key()
        if not key:
            return {"ok": False, "text": "Choose the name you play as first."}
        status, body = self._call("POST", "/api/card-arena", {"game": game, "mine": mine, "theirs": theirs}, key=key)
        self._league_at = 0.0
        if status == 200:
            return {"ok": True, "text": str(body.get("text") or "Bout played."), "bout": body.get("bout") or {}}
        if status == 0:
            return {"ok": False, "offline": True, "text": self.offline_text}
        return {"ok": False, "text": str(body.get("error") or "That bout could not be played.")}

    def card_opponents(self, game: str) -> list[dict]:
        """Other owners' locked cards, by name: enough to pick a bout."""
        status, body = self._call("GET", f"/api/cards/public?game={game}")
        return _rows(body.get("cards")) if status == 200 else []

    def bout_replay(self, url: str) -> dict:
        path = str(url or "")
        if not path.startswith("/api/card-arena/"):
            return {}
        status, body = self._call("GET", path)
        return body if status == 200 else {}

    def open_league_challenge(self, game: str, bot_id: str, opponent: str) -> dict:
        return self.ladder_challenge(game, bot_id, opponent, open_league=True)


    # The page's view ---------------------------------------------------------

    # Staff (moderation) ------------------------------------------------------

    def staff_key(self) -> str:
        """The moderation key, if this computer has one and has not forgotten it."""
        if not self.on or self._state.get("staff_off"):
            return ""
        return read_secret(STAFF_KEY_ENV)

    def staff(self, *, force: bool = False) -> dict:
        """This account's staff role ('' when it is not staff). Cached briefly.

        The server decides: a staff key alone is not enough, it must match the
        signed-in account. Nothing here is trusted for a decision; every admin
        call re-checks both keys on the server.
        """
        blank = {"role": "", "name": "", "key": False, "powers": []}
        if not self.on or not self.linked:
            return dict(blank)
        now = self.clock()
        if not force and self._staff_at and now - self._staff_at < 30:
            return dict(self._staff or blank)
        if not self.staff_key():
            self._staff = dict(blank, name=self._state.get("name") or "")
            self._staff_at = now
            return dict(self._staff)
        status, body = self.admin("GET", "/api/admin/me")
        role = str((body or {}).get("role") or "") if status == 200 else ""
        self._staff = {
            "role": role,
            "name": str((body or {}).get("name") or self._state.get("name") or ""),
            "key": True,
            "powers": list((body or {}).get("powers") or []) if role else [],
        }
        self._staff_at = now
        return dict(self._staff)

    def set_staff_key(self, key: str) -> dict:
        """Check a staff key against the lobby, then keep it in Hermes's credentials."""
        candidate = str(key or "").strip()
        if not candidate:
            return {"ok": False, "text": "Paste the staff key."}
        if not self.on:
            return {"ok": False, "text": "Turn online play on first."}
        if not self.linked:
            return {"ok": False, "text": "Sign in to the lobby first. A staff key works with your own account."}
        if any(char.isspace() or ord(char) < 33 for char in candidate) or len(candidate) > 200:
            return {"ok": False, "text": "That does not look like a staff key."}
        status, body = self._call("GET", "/api/admin/me", key=self.key(), extra={"X-Staff-Key": candidate})
        if status != 200:
            return {"ok": False, "text": str((body or {}).get("error") or "That staff key does not work with this account.")}
        if not self.store_secret(STAFF_KEY_ENV, candidate):
            return {"ok": False, "text": "This Hermes cannot store a key right now; paste it in Settings instead."}
        self._state["staff_off"] = False
        self._save()
        self._staff_at = 0.0
        role = self.staff(force=True)
        return {"ok": True, "text": f"Staff key saved. You are {role.get('role')}.", "staff": role}

    def clear_staff_key(self) -> dict:
        """Forget the staff key here. The role stays with the account on the server."""
        self._state["staff_off"] = True
        self._save()
        self._staff = {}
        self._staff_at = 0.0
        return {"ok": True, "text": "Staff key forgotten on this computer."}

    def admin(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        """One staff call: the account's own key and the staff key together."""
        if not self.on or not self.linked:
            return 0, {}
        return self._call(method, path, body, key=self.key(), extra={"X-Staff-Key": self.staff_key()})

    def snapshot(self, *, refresh: bool = False) -> dict:
        if refresh:
            self.refresh()
        looking = self._lobby.get("looking_counts") or {}
        rows = self._lobby.get("looking") or []
        game = self._state.get("game") or ""
        names = [row["name"] for row in rows if row.get("game") == game][:6]
        return {
            "on": self.on,
            "url": self.url,
            "linked": self.linked,
            "name": self._state.get("name") or "",
            "disclosure": disclosure(self.url),
            "offline": self.offline,
            "offline_text": self.offline_text if self.offline else "",
            "game": game,
            "looking": {str(key): int(value or 0) for key, value in looking.items() if isinstance(value, int)},
            "waiting_names": names,
            "waiting": (self._lobby.get("waiting") or {}) if self.on else {},
            "bots_waiting": (self._lobby.get("bots_waiting") or {}) if self.on else {},
            "presence": (self._lobby.get("presence") or {}) if self.on else {},
            "match": self.match(),
            "alerts": self.alerts(),
            "ladder": self._ladder or {},
            "league": self.league(),
            "ladder_board": (self._lobby.get("ladder") or {}) if self.on else {},
            "bot": {"id": str((self._state.get("bot") or {}).get("id") or ""),
                    "name": str((self._state.get("bot") or {}).get("name") or "")},
            "staff": self.staff(),
            "fresh": bool(self._at and self.clock() - self._at < POLL_SECONDS * 4),
        }

    def set_ladder(self, view: dict) -> None:
        self._ladder = view

    # One HTTP call -----------------------------------------------------------

    def _call(self, method: str, path: str, body: dict | None = None, *, key: str = "",
              extra: dict | None = None) -> tuple[int, dict]:
        """One request. 0 means the server could not be reached at all."""
        if not self.on:
            return 0, {}
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urlrequest.Request(self.url + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if key:
            request.add_header("Authorization", f"Bearer {key}")
        for name, value in (extra or {}).items():
            if value:
                request.add_header(str(name), str(value))
        try:
            with self._open(request, timeout=self.timeout) as answer:
                raw = answer.read(MAX_BYTES)
                return int(getattr(answer, "status", 200) or 200), _json(raw)
        except urlerror.HTTPError as exc:
            try:
                raw = exc.read(MAX_BYTES)
            except Exception:
                raw = b""
            return int(exc.code or 0), _json(raw)
        except (urlerror.URLError, OSError, ValueError):
            return 0, {}


def _json(raw: bytes) -> dict:
    try:
        loaded = json.loads(raw or b"{}")
    except ValueError:
        return {}
    return loaded if isinstance(loaded, dict) else {}
