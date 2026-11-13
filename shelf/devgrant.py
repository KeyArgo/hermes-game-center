"""The developer top-up's lock: a key file in the plugin's own data folder, none of it in this
repository.

Why it is built this way (owner's ask, 2026-11-09: "add a developer cheat ... has to be hackproof for
anyone who downloads the source code, so the password must not be seen in the repo"):

- **Nothing secret is in the source.** No passphrase, no default key, no hash. A downloaded copy of
  this repo can create every file it likes and still only reach the wallet of the machine it is
  running on.
- **The key file is the only thing that arms it.** It lives outside the repository, in the active
  profile's plugin data folder (``plugin_data_dir("hermes-gameshelf")``, see ``shelf/paths.py``), is
  written with mode 600, and holds a scrypt hash rather than the passphrase, so even reading it does
  not hand anyone the passphrase.
- **There is no remote door.** The plugin registers no route, no hook and no command for this. The
  only caller is ``scripts/dev-grant.py``, run by hand on the machine that owns the wallet.

The passphrase itself is chosen by the person at ``--init`` time and never leaves their head; the
hash cannot be reversed into it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
from pathlib import Path

log = logging.getLogger(__name__)

KEY_FILE = "gameshelf-dev.key"


def key_path(root: Path | None = None) -> Path:
    """Where the developer key lives: the profile's data folder, never inside a repository.

    ``root`` stands in for that folder in a test; production passes nothing and follows the active
    profile, so a key armed in one profile does not arm another.
    """
    if root is None:
        # Imported here, not at module level: this file is also loaded by path from scripts/ and by
        # the plugin's own loader, where the ``shelf`` package may not be on the path yet.
        from shelf import paths

        return paths.data_dir() / KEY_FILE
    return Path(root) / KEY_FILE


def _derive(passphrase: str, salt: bytes) -> bytes:
    # scrypt rather than a bare sha256: a short human passphrase should still cost an attacker real
    # time per guess. n=2**14 is a few milliseconds here, which is invisible at the command line.
    return hashlib.scrypt(passphrase.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)


def make_key(passphrase: str, root: Path | None = None) -> Path:
    """Write a new key file for ``passphrase`` and return its path. Overwrites an old one."""
    if not passphrase or len(passphrase) < 8:
        raise ValueError("the passphrase must be at least 8 characters")
    salt = secrets.token_bytes(16)
    payload = {
        "kind": "hermes-gameshelf-dev",
        "version": 1,
        "kdf": "scrypt",
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(_derive(passphrase, salt)).decode("ascii"),
    }
    path = key_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        log.warning("the grant key file could not be made owner-only", exc_info=True)
    return path


def read_key(root: Path | None = None) -> dict | None:
    """The key file's contents, or None when there is no key (which means: dev mode is off)."""
    try:
        raw = json.loads(key_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("kind") != "hermes-gameshelf-dev":
        return None
    return raw


def armed(root: Path | None = None) -> bool:
    """Whether this machine has a developer key at all. Without one, nothing can grant chips."""
    return read_key(root) is not None


def check(passphrase: str, root: Path | None = None) -> bool:
    """Whether ``passphrase`` opens the key on this machine. False when there is no key."""
    raw = read_key(root)
    if not raw or not passphrase:
        return False
    try:
        salt = base64.b64decode(raw["salt"])
        want = base64.b64decode(raw["hash"])
    except (KeyError, ValueError, TypeError):
        return False
    if not salt or not want:
        return False
    got = _derive(passphrase, salt)
    # compare_digest, not ==: a timing side channel is cheap to avoid and silly to leave in.
    return hmac.compare_digest(got, want)
