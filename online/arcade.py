"""Community arcade shelf: link-out tiles for games other people host, plus "Remove my game".

Removal: whoever types the exact repo name hides the tile at once and gets a one-time code.
Putting that code in the repo (a HERMES-REMOVE.txt file or the README) proves ownership and makes
the removal permanent. Unproven removals lapse after REMOVAL_DAYS and the tile comes back.
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path

CATALOG = Path(__file__).resolve().parent / "arcade.json"
REMOVAL_DAYS = 14
PROOF_FILES = ("HERMES-REMOVE.txt", "README.md", "readme.md", "README")
PROOF_MAX_BYTES = 512 * 1024
LABELS = {
    "wip": "Community game, work in progress: may have bugs.",
    "prototype": "Early prototype: expect bugs or missing parts.",
}
_REPO = re.compile(r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$")
_ID = re.compile(r"^[a-z0-9-]{1,40}$")


def load(path: Path = CATALOG) -> list[dict]:
    """Tiles from the catalog file. Bad entries are skipped, never fatal."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    tiles = []
    for item in raw.get("tiles", []) if isinstance(raw, dict) else []:
        if not isinstance(item, dict):
            continue
        tile_id, url, repo = str(item.get("id", "")), str(item.get("url", "")), str(item.get("repo") or "")
        if not _ID.match(tile_id) or not url.startswith("https://") or (repo and not _REPO.match(repo)):
            continue
        label = item.get("label") if item.get("label") in LABELS else "wip"
        tiles.append({
            "id": tile_id, "title": str(item.get("title") or tile_id), "by": str(item.get("by") or ""),
            "url": url, "repo": repo, "featured": bool(item.get("featured")), "listed": bool(item.get("listed")),
            "label": label, "warning": LABELS[label], "blurb": str(item.get("blurb") or ""),
            "facts": [str(fact) for fact in item.get("facts") or [] if isinstance(fact, str)][:6],
        })
    return tiles


def new_code() -> str:
    return "hermes-remove-" + secrets.token_hex(4)


def same_repo(typed: object, repo: str) -> bool:
    text = str(typed or "").strip().removeprefix("https://github.com/").strip("/")
    return bool(repo) and text.lower() == repo.lower()


async def fetch_proof(session, repo: str) -> list[str]:
    """Text of the proof files in the repo's default branch (missing files are skipped)."""
    found = []
    for name in PROOF_FILES:
        url = f"https://raw.githubusercontent.com/{repo}/HEAD/{name}"
        try:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200:
                    continue
                body = b""
                while len(body) < PROOF_MAX_BYTES:
                    chunk = await response.content.read(PROOF_MAX_BYTES - len(body))
                    if not chunk:
                        break
                    body += chunk
                found.append(body.decode("utf-8", "replace"))
        except Exception:
            continue
    return found
