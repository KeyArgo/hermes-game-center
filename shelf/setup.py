"""First-run welcome and quiet "someone wants a match" settings.

Everything here is local to this Hermes profile: one small JSON file in the
plugin's own data folder. There is no account, no email and no network call.

``looking_now`` is the only place that answers "who wants a match right now".
Today that answer comes from this referee's own ``/games looking`` list
(``shelf/lobby.py``), which is the list people in this Hermes and the chats it
shares write to. The online design adds a website source there and returns rows
with the same keys; the page, the badge, the tests and the wording stay as they
are.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from .directory import Directory, join_line
from .lobby import looking_rows

_FILE = "setup.json"
# One lock for this module's own read-change-write turns. The dashboard answers
# requests on several threads (the page polls, the badge polls, a person saves),
# so two writers must never interleave.
_LOCK = threading.RLock()
# A row the person dismissed stays quiet this long, then may come back while the
# same person is still looking. That is the rate limit on repeats.
RATE_SECONDS = 30 * 60
# How many rows the home page lists. The badge counts everyone, so nothing is lost.
MAX_ROWS = 12


def _empty() -> dict:
    return {"seen": False, "watched": {}, "paused": False, "ai": None, "quiet": {}}


class Setup:
    """The welcome answer, the games watched, the pause, the AI choice."""

    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)
        self.path = self.folder / _FILE

    # -- reading ---------------------------------------------------------
    def data(self) -> dict:
        raw = self._read()
        watched: dict[str, bool] = {}
        games = raw.get("watched")
        if isinstance(games, dict):
            for key, value in games.items():
                if value is True:
                    watched[str(key).strip().lower()] = True
        chosen = raw.get("ai")
        quiet: dict[str, dict] = {}
        entries = raw.get("quiet")
        if isinstance(entries, dict):
            for key, value in entries.items():
                if not isinstance(value, dict):
                    continue
                try:
                    at = float(value.get("at") or 0)
                except (TypeError, ValueError):
                    at = 0.0
                quiet[str(key)] = {"at": at, "dismissed": bool(value.get("dismissed"))}
        return {
            "seen": bool(raw.get("seen")),
            "watched": watched,
            "paused": bool(raw.get("paused")),
            "ai": None if chosen is None else bool(chosen),
            "quiet": quiet,
        }

    def state(self) -> dict:
        """The saved choices, ready for the page."""
        data = self.data()
        return {
            "seen": data["seen"],
            "watched": dict(data["watched"]),
            "paused": data["paused"],
            "ai": data["ai"],
        }

    # -- writing ---------------------------------------------------------
    def finish(self) -> None:
        """The welcome was answered or skipped: never ask again."""
        self._change(lambda data: data.update({"seen": True}))

    def reopen(self) -> None:
        """Show the welcome again, from Settings."""
        self._change(lambda data: data.update({"seen": False}))

    def watch(self, game: str, wanted: bool) -> None:
        clean = str(game or "").strip().lower()
        if not clean:
            return

        def change(data: dict) -> None:
            if wanted:
                data["watched"][clean] = True
            else:
                data["watched"].pop(clean, None)

        self._change(change)

    def set_paused(self, paused: bool) -> None:
        self._change(lambda data: data.update({"paused": bool(paused)}))

    def set_ai(self, value: bool | None) -> None:
        """True or False pins the choice; None follows the plugin's own setting."""
        self._change(lambda data: data.update({"ai": None if value is None else bool(value)}))

    def dismiss(self, key: str, *, now: float | None = None) -> None:
        """Hide one row. It stays hidden for RATE_SECONDS, then may come back."""
        clean = str(key or "").strip()
        if not clean:
            return
        at = float(now if now is not None else time.time())

        def change(data: dict) -> None:
            data["quiet"][clean] = {"at": at, "dismissed": True}

        self._change(change)

    def remember_quiet(self, updates: dict[str, dict], drop: list[str], *, now: float) -> None:
        """Merge one poll's alert bookkeeping without losing a dismissal.

        ``updates`` are the rows that are live right now; ``drop`` are the keys the
        poll no longer sees. The merge happens inside the lock against a fresh read,
        so a Dismiss that lands while a poll is in flight wins: a dismissal newer than
        the poll's own snapshot is never cleared, and one for someone who has stopped
        looking is kept until its window ends.
        """
        def change(data: dict) -> None:
            quiet = data["quiet"]
            for key, item in updates.items():
                saved = quiet.get(key) or {}
                if saved.get("dismissed") and float(saved.get("at") or 0) >= float(item.get("at") or 0):
                    continue
                quiet[key] = item
            for key in drop:
                saved = quiet.get(key) or {}
                if saved.get("dismissed") and now - float(saved.get("at") or 0) < RATE_SECONDS:
                    continue
                quiet.pop(key, None)
            data["quiet"] = quiet

        self._change(change)

    def _change(self, change) -> None:
        """Read, change and write in one turn, so two requests cannot undo each other.

        The dashboard serves requests on several threads: the page polls /view, the
        status bar polls /alerts, and the person presses Save. Without the lock and
        the fresh read, a poll could write back an older pause value.
        """
        with _LOCK:
            data = self.data()
            change(data)
            self.save(data)

    def save(self, data: dict) -> None:
        body = {
            "seen": bool(data.get("seen")),
            "watched": {str(key): True for key, value in (data.get("watched") or {}).items() if value is True},
            "paused": bool(data.get("paused")),
            "ai": data.get("ai"),
            "quiet": {
                str(key): {"at": float(item.get("at") or 0), "dismissed": bool(item.get("dismissed"))}
                for key, item in (data.get("quiet") or {}).items()
                if isinstance(item, dict)
            },
        }
        with _LOCK:
            self.folder.mkdir(parents=True, exist_ok=True)
            # A name of its own for every write: two writers must never share one
            # temporary file, or the second os.replace finds it already gone.
            temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            try:
                temporary.write_text(json.dumps(body), encoding="utf-8")
                os.replace(temporary, self.path)
            finally:
                if temporary.exists():
                    temporary.unlink()

    def _read(self) -> dict:
        if not self.path.is_file():
            return {}
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return loaded if isinstance(loaded, dict) else {}


def apply_choice(settings: dict, folder: Path) -> dict:
    """Fold the person's Settings choice for AI seats into a catalog's settings.

    One rule for every door: the Desktop page, chat commands and the plugin's own
    tool all build their catalog here. None means "follow the plugin setting".
    """
    chosen = Setup(folder).data()["ai"]
    if chosen is None:
        return dict(settings)
    return {**settings, "allow_ai": bool(chosen)}


def looking_now(
    folder: Path,
    setup: Setup,
    viewer_id: str = "",
    *,
    now: float | None = None,
) -> list[dict]:
    """Who is looking for a match the person asked about, right now.

    This is the one seam for the source. Today it reads this Hermes's own
    ``/games looking`` rows: people in this Hermes and the chats it shares,
    nothing from the internet. A website source would append rows shaped
    ``{"id", "name", "game", "address"?}`` here and stop.

    Each returned row carries ``key`` (stable per person and game), ``game``,
    ``name`` and ``where`` (a join address when one was offered, otherwise the
    address the directory holds for that game, otherwise "").
    """
    data = setup.data()
    watched = data["watched"]
    if data["paused"] or not watched:
        return []
    here = float(now if now is not None else time.time())
    quiet = dict(data["quiet"])
    rows: list[dict] = []
    updates: dict[str, dict] = {}
    seen: set[str] = set()
    directory: Directory | None = None
    for item in looking_rows(folder):
        game = str(item.get("game") or "").strip().lower()
        if not game or not watched.get(game):
            continue
        if viewer_id and str(item.get("id") or "") == str(viewer_id):
            continue
        key = f"{item.get('id')}|{game}"
        seen.add(key)
        note = quiet.get(key) or {}
        at = float(note.get("at") or 0)
        dismissed = bool(note.get("dismissed"))
        if dismissed and here - at < RATE_SECONDS:
            # Still inside the quiet window: the row stays hidden and its dismissal
            # record is left exactly as it is.
            continue
        # ``at`` is when this episode started looking, not "now": it stays put while the
        # row is live, so a Dismiss that lands during a poll is still newer than it and
        # wins in the merge. A row coming back after a quiet window starts a new episode.
        updates[key] = {"at": at if at and not dismissed else here, "dismissed": False}
        where = str(item.get("address") or "").strip()
        if not where:
            if directory is None:
                directory = Directory(folder)
            where = join_line(directory.public_join(game))
        rows.append({
            "key": key,
            "game": game,
            "name": str(item.get("name") or "").strip() or "Someone",
            "where": where,
        })
    rows.sort(key=lambda row: (row["game"], row["name"].lower()))
    # Keys nobody is using any more are dropped, except a dismissal still inside its
    # window: someone who stops looking and comes back must not re-announce themselves.
    drop = [key for key in quiet if key not in seen]
    if updates or drop:
        setup.remember_quiet(updates, drop, now=here)
    return rows
