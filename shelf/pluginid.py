"""This plugin's id, and the one-time copy of the folder the old id left behind.

Hermes keys a plugin's data folder by the manifest's ``name``, so renaming the plugin would make an
existing player's wallet, name, champions and saved tables invisible: they live in the folder the
old id named and the new id looks elsewhere. On the first access the old folder is copied across,
once. ``OLD_ID`` below is the one place the previous name is written down.

The rules, in the order they matter:

* **Copy, never move and never delete.** The old folder is the only backup a player has.
* **The new folder always wins.** Only names it does not already have are copied, so a save made
  under the new id is never overwritten by an older one from the old id.
* **Once.** A marker file in the new folder ends it; without one every start would re-copy.
* **A failure is not an event.** A file that cannot be read (a lock on Windows, a full disk) is
  logged and the plugin carries on with whatever is there; no marker is written, so the next
  start fills in what is still missing. Nothing is ever half-written into place: each file is
  written beside its destination and swapped in, which is atomic on both POSIX and Windows.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

NEW_ID = "hermes-game-center"
# The manifest name before the rename. Read exactly once, by the copy below.
OLD_ID = "hermes-gameshelf"
# Written into the new folder after a full copy, so the copy can never run twice.
MARKER = ".copied-from-old-plugin-id"


def data_dir() -> Path:
    """``plugin-data/hermes-game-center``, with the old folder's contents copied in on first use."""
    from plugins.plugin_storage import plugin_data_dir

    root = plugin_data_dir(NEW_ID)
    migrate(root)
    return root


def migrate(new_dir: Path, old_dir: Path | None = None) -> bool:
    """Copy whatever ``old_dir`` has and ``new_dir`` has not. True when this call did the copy.

    ``old_dir`` defaults to the sibling folder under the old id: ``plugin_data_dir`` *creates*
    what it is asked for, so the old path is worked out from the new one instead of asking for
    it. Never raises: the player's first command must not fail over an old save.
    """
    new_dir = Path(new_dir)
    old_dir = Path(old_dir) if old_dir is not None else new_dir.parent / OLD_ID
    marker = new_dir / MARKER
    try:
        if marker.exists() or not old_dir.is_dir():
            return False
        _copy_missing(old_dir, new_dir)
        _swap_in(marker, lambda tmp: tmp.write_text(f"copied from the old plugin id {OLD_ID}\n", encoding="utf-8"))
    except OSError:
        log.warning("the old plugin data folder could not be copied; it will be retried", exc_info=True)
        return False
    return True


def _copy_missing(source: Path, target: Path) -> None:
    """Copy each name ``target`` does not have, and leave every name it has alone."""
    target.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        destination = target / item.name
        if destination.exists() or destination.is_symlink():
            continue
        if item.is_dir() and not item.is_symlink():
            _copy_missing(item, destination)
        else:
            _swap_in(destination, lambda tmp, item=item: shutil.copy2(item, tmp))


def _swap_in(destination: Path, fill: Callable[[Path], object]) -> None:
    """Fill a file beside ``destination``, then rename it into place.

    A half-written file therefore never wears the real name, on any platform: a copy that dies
    halfway leaves a ``.part`` file, which is cleaned up here and retried on the next start.
    """
    tmp = destination.with_name(destination.name + ".part")
    try:
        fill(tmp)
        os.replace(tmp, destination)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
