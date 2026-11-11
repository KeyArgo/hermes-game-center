"""Which Game Center titles this profile has added. Empty until someone hits Get."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from pathlib import Path

_FILE = "installed.json"
_ID_MAX = 32

from .filelock import file_lock

log = logging.getLogger(__name__)


class Library:
    # One lock per Library instance would not cover two instances over the same
    # folder (the dashboard opens a fresh Catalog per request), so the lock is
    # shared process-wide.
    _lock = threading.RLock()

    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)
        self.path = self.folder / _FILE

    def ids(self) -> set[str]:
        if not self.path.is_file():
            return set()
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return set()
        if not isinstance(loaded, dict):
            return set()
        raw = loaded.get("ids") or []
        if not isinstance(raw, list):
            return set()
        return {str(item).strip().lower()[:_ID_MAX] for item in raw if str(item).strip()}

    def has(self, game_id: str) -> bool:
        return str(game_id or "").strip().lower() in self.ids()

    def add(self, game_id: str) -> None:
        with self._lock:
            self._modify(add=str(game_id).strip().lower()[:_ID_MAX])

    def discard(self, game_id: str) -> None:
        with self._lock:
            self._modify(discard=str(game_id).strip().lower())

    def _modify(self, *, add: str = "", discard: str = "") -> None:
        """Read-modify-write under the lock; the file is only ever swapped whole."""
        self.folder.mkdir(parents=True, exist_ok=True)
        # Lock a dedicated file that is never renamed: _save swaps installed.json
        # to a new file, so locking that path would let a third process lock the
        # new file while another still holds the old.
        with file_lock(self.folder / ".installed.lock", best_effort=True):
            current = self.ids()
            if add:
                current.add(add)
            if discard:
                current.discard(discard)
            self._save(current)

    def _save(self, ids: set[str]) -> None:
        payload = json.dumps({"ids": sorted(ids)})
        # A unique temp name means two writers can never clobber each other's
        # temp file before the final, atomic rename into place.
        fd, temporary = tempfile.mkstemp(dir=self.folder, prefix=".installed.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                try:
                    os.unlink(temporary)
                except OSError:
                    log.debug("a temporary file could not be removed", exc_info=True)
