"""Find game.json files and load each game the same way."""

from __future__ import annotations

import importlib.util
import inspect
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .directory import Directory, join_line
from .fair import blocked
from .library import Library

_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
_KINDS = {"table", "server", "listen", "install", "play", "external"}
# The game.json contract this plugin accepts from another plugin.
SCHEMA_VERSION = 1
_PLUGIN_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
# A Desktop route is a plain path: /hello or /my-games/hello. No scheme, no query.
_ROUTE = re.compile(r"/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*/?")
# The folder this plugin runs from. Its games always win over any other copy.
_OWN_ROOT = Path(__file__).resolve().parent.parent


# Games the shelf knows about but does not ship. Empty in the published plugin: anything here would
# need a sibling plugin (agent-arena is GPL-3) or a server outside this repo.
EXTRAS: tuple[dict[str, Any], ...] = ()

# The Community shelf: cards for games other people made and host elsewhere. Game Center only
# hands the address to the person's browser when they press Open. It never fetches, frames or
# loads any of these pages, so nothing here runs inside Hermes.
_COMMUNITY_FILE = _OWN_ROOT / "community" / "games.json"
_COMMUNITY_NOTICE = (
    "These games are made by the community, not by Game Center or Nous. "
    "Game Center only opens the website in your browser when you press Open."
)
# Most community cards are a web game. Two are not: a download page (a project you save and open
# yourself) and a watch-only page (a demo you look at, not a game you play). The card says which,
# so Open never promises a game that is not there. An unknown kind is treated as a web page.
_COMMUNITY_KINDS = {"web", "download", "watch"}

# Play is this list and nothing else. It ships with the plugin, and only a reviewed
# commit changes it. A game's own manifest can never put it in Play: nothing here is
# read from a manifest, and nothing a plugin declares is read either.
_CURATED_FILE = _OWN_ROOT / "shelf" / "curated.json"
# The ship gate's verdicts, written by tools/ship_gate. A game with "ship": false has
# been proven broken or unclear: it leaves Play (the reviewed shelf) and appears on the
# Labs shelf instead, badged, until a later gate run passes it.
_SHIP_FILE = _OWN_ROOT / "shelf" / "ship.json"


def ship_states(path: Path | None = None) -> dict[str, dict[str, Any]]:
    """Read the gate's per-game verdicts. A missing or broken file means "nothing failed yet"."""
    # The ship gate's own browser runs must see every game, or a failed game disappears from
    # Play and the next run cannot open it at all (a self-fulfilling fail).
    if os.environ.get("GAMESHELF_IGNORE_SHIP") == "1":
        return {}
    source = Path(path) if path is not None else _SHIP_FILE
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in raw.items() if isinstance(value, dict)}


def ship_failed(states: dict[str, dict[str, Any]], game_id: str) -> bool:
    entry = states.get(str(game_id))
    return bool(entry and entry.get("ship") is False)


# What Experimental Games says about a game that is not in Play. It opens its own screen or
# nothing at all, and it never sits at Game Center's table.
_OPEN_SCREEN = "Opens in its own screen. No lobby or matchmaking."
_NO_SCREEN = "This game has no screen of its own. No lobby or matchmaking."
_BROKEN = "This game's own screen cannot be opened here. No lobby or matchmaking."


def curated_games(path: Path | None = None) -> dict[str, Any]:
    """The ids in Play, read from the small list that ships with the plugin.

    A bad entry is skipped and named in ``problems`` rather than silently dropped,
    so a typo in the list is visible in a test rather than quietly shrinking Play.
    """
    source = Path(path) if path is not None else _CURATED_FILE
    result: dict[str, Any] = {"games": [], "problems": []}
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result["problems"].append(
            f"The Play list could not be read ({type(exc).__name__}); Play is empty."
        )
        return result
    entries = raw.get("games") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        result["problems"].append("The Play list has no games; Play is empty.")
        return result
    seen: set[str] = set()
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, str):
            result["problems"].append(f"Play entry {index} is not a game id; skipped.")
            continue
        game_id = entry.strip()
        if not _ID.fullmatch(game_id):
            result["problems"].append(f"Play entry {index} is not a game id; skipped.")
            continue
        if game_id in seen:
            continue
        seen.add(game_id)
        result["games"].append(game_id)
    return result


_KNOWN_FILE = _OWN_ROOT / "shelf" / "known.json"
_MAKERS_FILE = _OWN_ROOT / "shelf" / "makers.json"


def known_games(path: Path | None = None) -> dict[str, Any]:
    """The short hand-kept list of game plugins Game Center knows by name.

    It is not a shop or an endorsement. A route is only used when a person wrote it here
    after checking it; an empty route is kept empty, never guessed.
    """
    source = Path(path) if path is not None else _KNOWN_FILE
    result: dict[str, Any] = {"plugins": {}, "problems": []}
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result["problems"].append(f"The known games list could not be read ({type(exc).__name__}).")
        return result
    entries = raw.get("plugins") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return result
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            result["problems"].append(f"Known entry {index} is not a plugin; skipped.")
            continue
        plugin_id = str(entry.get("plugin_id") or "").strip()
        title = str(entry.get("title") or "").strip()
        game_id = str(entry.get("id") or plugin_id).strip()
        if not _PLUGIN_ID.fullmatch(plugin_id) or not _ID.fullmatch(game_id) or not title:
            result["problems"].append(f"Known entry {index} needs a plugin_id, an id and a title; skipped.")
            continue
        route = str(entry.get("route") or "").strip()
        if route and (not _ROUTE.fullmatch(route) or ".." in route or "//" in route):
            result["problems"].append(f"{title}: the route must be a plain path such as /hold-em; skipped.")
            continue
        catalog = entry.get("catalog")
        if catalog is not None and catalog != "" and not _community_url(catalog):
            result["problems"].append(f"{title}: the catalog address must start with https://; skipped.")
            continue
        result["plugins"][plugin_id] = {
            "id": game_id,
            "title": title,
            "summary": str(entry.get("summary") or "").strip(),
            "route": route,
            "catalog": _community_url(catalog),
            "maker": entry.get("maker", "").strip() if isinstance(entry.get("maker"), str) else "",
            "note": entry.get("note", "").strip() if isinstance(entry.get("note"), str) else "",
        }
    return result


def _your_line(card: dict[str, Any]) -> dict[str, str]:
    """How one Experimental Games card opens, and the one plain line that says what it is not.

    Nothing here is a table at Game Center, so the line always says there is no
    lobby or matchmaking. A card whose route cannot be opened says that instead.
    """
    if card.get("error"):
        # A known plugin's own note is already plain ("not been checked yet"). Any
        # other broken card gets one plain line; the technical reason stays in the
        # card's error field rather than in the person's face.
        line = str(card["error"]) if card.get("known") else _BROKEN
        return {"opens": "none", "line": line}
    if card.get("kind") == "external":
        route = str(card.get("desktop_route") or "")
        if _ROUTE.fullmatch(route) and ".." not in route and "//" not in route:
            return {"opens": "screen", "line": _OPEN_SCREEN}
        return {"opens": "none", "line": "Its own screen has no usable address."}
    if card.get("builtin"):
        # Our own launch cards and panels: Doom, OpenTTD, Luanti, Wesnoth, Doctrine.
        return {"opens": "panel", "line": _OPEN_SCREEN}
    return {"opens": "none", "line": _NO_SCREEN}


def _community_url(raw: Any) -> str:
    """The web address for one community card, or "" when it is not a plain https link.

    https only: these are other people's sites, and a card must never be able to
    open a local file, a browser script or an insecure page.
    """
    value = str(raw or "").strip()
    if not value or any(char.isspace() or ord(char) < 32 for char in value):
        return ""
    try:
        parts = urlsplit(value)
    except ValueError:
        return ""
    if parts.scheme.lower() != "https":
        return ""
    if not parts.hostname or "@" in parts.netloc:
        return ""
    try:
        port = parts.port
    except ValueError:
        return ""
    if port is not None and not 0 < port < 65536:
        return ""
    return value


def community_games(path: Path | None = None) -> dict[str, Any]:
    """The Community shelf list: link-out cards, read from a data file.

    A bad entry is skipped and named in ``problems`` rather than dropped in
    silence or allowed to break the page. Nothing here contacts the sites.
    """
    source = Path(path) if path is not None else _COMMUNITY_FILE
    result: dict[str, Any] = {"notice": _COMMUNITY_NOTICE, "games": [], "problems": []}
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result["problems"].append(f"The community list could not be read ({type(exc).__name__}).")
        return result
    entries = raw.get("games") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        result["problems"].append("The community list has no games; nothing to show.")
        return result
    seen: set[str] = set()
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            result["problems"].append(f"Community entry {index} is not a game; skipped.")
            continue
        title = str(entry.get("title") or "").strip()
        name = title or f"Community entry {index}"
        game_id = str(entry.get("id") or "").strip()
        if not _ID.fullmatch(game_id):
            result["problems"].append(
                f"{name}: id must be lowercase letters, digits and dashes (up to 32); skipped."
            )
            continue
        if not title:
            result["problems"].append(f"{name}: it has no title; skipped.")
            continue
        creator = str(entry.get("creator") or "").strip()
        if not creator:
            result["problems"].append(f"{title}: it names no creator; skipped.")
            continue
        url = _community_url(entry.get("url"))
        if not url:
            result["problems"].append(f"{title}: the web address must start with https://; skipped.")
            continue
        if game_id in seen:
            result["problems"].append(f"{title}: another community card already uses the id {game_id}; skipped.")
            continue
        seen.add(game_id)
        kind = str(entry.get("kind") or "web").strip().lower()
        if kind not in _COMMUNITY_KINDS:
            result["problems"].append(f"{title}: the kind must be web, download or watch; shown as a web page.")
            kind = "web"
        note = entry.get("note")
        result["games"].append({
            "id": game_id,
            "title": title,
            "creator": creator,
            "url": url,
            "kind": kind,
            "note": note.strip() if isinstance(note, str) else "",
        })
    return result


def makers_shelf(path: Path | None = None) -> dict[str, Any]:
    """Read the link-out list of tools for making games."""
    source = Path(path) if path is not None else _MAKERS_FILE
    result: dict[str, Any] = {"notice": "", "note": "", "items": [], "problems": []}
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        result["problems"].append(f"The makers list could not be read ({type(exc).__name__}).")
        return result
    if isinstance(raw, dict):
        for field in ("notice", "note"):
            if isinstance(raw.get(field), str):
                result[field] = raw[field].strip()
    entries = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        result["problems"].append("The makers list has no items; nothing to show.")
        return result
    seen: set[str] = set()
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            result["problems"].append(f"Makers entry {index} is not a tool; skipped.")
            continue
        title = str(entry.get("title") or "").strip()
        name = title or f"Makers entry {index}"
        item_id = str(entry.get("id") or "").strip()
        maker = str(entry.get("maker") or "").strip()
        summary = str(entry.get("summary") or "").strip()
        kind = str(entry.get("kind") or "").strip()
        url = _community_url(entry.get("url"))
        if not _ID.fullmatch(item_id) or item_id in seen:
            result["problems"].append(f"{name}: the id is invalid or already used; skipped.")
        elif not title or not maker or not summary:
            result["problems"].append(f"{name}: it needs a title, maker and summary; skipped.")
        elif kind not in {"plugin", "skill"}:
            result["problems"].append(f"{name}: the kind must be plugin or skill; skipped.")
        elif not url:
            result["problems"].append(f"{name}: the web address must start with https://; skipped.")
        else:
            seen.add(item_id)
            note = entry.get("note")
            result["items"].append({
                "id": item_id, "title": title, "kind": kind, "maker": maker,
                "summary": summary, "url": url, "note": note.strip() if isinstance(note, str) else "",
            })
    return result


def kind_of(manifest: dict[str, Any]) -> str:
    raw = str(manifest.get("kind") or "table").strip().lower()
    return raw if raw in _KINDS else "table"


def _join(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not raw.get("host"):
        return None
    try:
        port = int(raw.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    return {"host": str(raw.get("host") or ""), "port": port, "proto": str(raw.get("proto") or "")}


def _worlds(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    raw = manifest.get("worlds")
    if not isinstance(raw, list):
        join = _join(manifest.get("join"))
        unit = str(manifest.get("unit") or manifest.get("id") or "")
        if join and unit:
            return [{
                "id": unit,
                "unit": unit,
                "title": str(manifest.get("title") or unit),
                "join": join,
                "wake": bool(manifest.get("wake", True)),
                "default": str(manifest.get("status") or "stopped"),
            }]
        return []
    worlds: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        unit = str(item.get("unit") or item.get("id") or "")
        join = _join(item.get("join"))
        if not unit:
            continue
        worlds.append({
            "id": str(item.get("id") or unit),
            "unit": unit,
            "title": str(item.get("title") or unit),
            "join": join,
            "wake": bool(item.get("wake", True)),
            "default": str(item.get("status") or "stopped"),
        })
    return worlds


def _subtitle(raw: Any) -> str:
    """A game's optional flavour subtitle: one short clean line, or "".

    It is decoration only. It never decides what a game is or where it sits, so
    a manifest with a bad subtitle still lists and plays exactly as before.
    """
    if not isinstance(raw, str):
        return ""
    try:
        text = "".join(" " if char in "\r\n\t" else char for char in raw
                       if char in "\r\n\t" or unicodedata.category(char) not in ("Cc", "Cf"))
        text = " ".join(text.split())
        if len(text) <= 60:
            return text
        cut = text[:60]
        # Trim at a word boundary when there is one, so a subtitle never ends in
        # half a word. A single 60-character word is left cut, because there is
        # nowhere better to stop.
        return (cut.rsplit(" ", 1)[0] or cut).rstrip()
    except (TypeError, ValueError):
        return ""


def _card_line(card: dict[str, Any]) -> str:
    line = f"{card['id']}: {card['title']} — {card.get('summary', '')}".rstrip()
    if card.get("bots"):
        line += " Bots can play."
    if card.get("kind") == "server" and card.get("where"):
        line += f" {card.get('status', '')} {card['where']}".replace("  ", " ")
    elif card.get("kind") == "server":
        line += f" {card.get('status', 'stopped')}"
    elif card.get("kind") == "listen":
        line += " Host from your client."
    elif card.get("kind") == "external":
        line += " Opens its own screen in the Game Center."
    if card.get("error"):
        line += f" {card['error']}"
    return line


def _call(command, raw: str, *, source: str, complete, player) -> str:
    params = inspect.signature(command).parameters
    kwargs = {"source": source, "complete": complete}
    accepts_player = "player" in params or any(
        item.kind is inspect.Parameter.VAR_KEYWORD for item in params.values()
    )
    if accepts_player:
        kwargs["player"] = player
    return command(raw, **kwargs)


def _manifest_files(plugin_dir: Path) -> list[Path]:
    """A plugin's own game.json, plus one folder of games beside its plugin.yaml."""
    found: list[Path] = []
    direct = plugin_dir / "game.json"
    if direct.is_file():
        found.append(direct)
    if not (plugin_dir / "plugin.yaml").is_file():
        return found
    for game_dir in sorted(plugin_dir.iterdir()):
        nested = game_dir / "game.json"
        if game_dir.is_dir() and nested.is_file() and nested != direct:
            found.append(nested)
    return found


def _plugin_name(yaml_path: Path) -> str:
    """The ``name`` from a plugin.yaml, without an inline YAML comment.

    Only the top-level ``name:`` key (column 0) counts: a nested ``name:``
    (e.g. a config field) must never be mistaken for the plugin's own name.
    """
    try:
        text = yaml_path.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        if line.startswith("name:"):
            value = line[len("name:"):].strip()
            value = value.split("#", 1)[0].strip().strip("'\"")
            return value
    return ""


def _own_plugin() -> str:
    """This plugin's own name, from the plugin.yaml beside shelf/.

    A game found in a folder this plugin owns ships with Game Center, so it is in
    the library from the first run and never sits behind a Get step.
    """
    return _plugin_name(_OWN_ROOT / "plugin.yaml") or _OWN_ROOT.name


def _plugin_owner(plugin_dir: Path, root: Path | None = None) -> tuple[str, Path]:
    """The plugin a game belongs to and the folder that owns it.

    That is the nearest enclosing plugin.yaml ``name`` going up from the folder a
    game was found in, but never past the scan root (an unrelated plugin.yaml
    higher up the tree must not claim a bare game) and never into a game's nested
    directories (a third party could plant a plugin.yaml there to claim an
    enabled plugin). Falls back to the folder name for plugins that ship a bare
    game.json with no plugin.yaml of their own.
    """
    folder = plugin_dir
    while True:
        if (folder / "plugin.yaml").is_file():
            return (_plugin_name(folder / "plugin.yaml") or folder.name), folder
        if root is not None and folder == root:
            break
        parent = folder.parent
        if parent == folder:  # filesystem root
            break
        folder = parent
    return plugin_dir.name, plugin_dir


def _entry_problem(directory: Path, entry: object) -> str:
    """Why this game.json's entry cannot be imported from its own folder, or "".

    The manifest is data written by another plugin, and the host imports whatever
    file it names. An entry that climbs out of the folder (`../x.py`), or names an
    absolute path, would run code the installer never vetted, so it is refused
    rather than resolved.
    """
    raw = str(entry or "").strip()
    if not raw:
        return "It ships no entry file."
    if Path(raw).is_absolute():
        return "Its entry must be a path inside its own folder, not an absolute one."
    if ".." in Path(raw).parts:
        return "Its entry must stay inside its own folder."
    try:
        target = (directory / raw).resolve()
        base = directory.resolve()
    except OSError:
        return "Its entry could not be resolved."
    if target != base and base not in target.parents:
        return "Its entry must stay inside its own folder."
    return ""


def _external_problem(manifest: dict[str, Any], plugin_id: str) -> str:
    """Why an external game.json cannot be opened, or "" when it is fine."""
    declared = str(manifest.get("plugin_id") or "").strip()
    if not _PLUGIN_ID.fullmatch(declared):
        return "The plugin_id is missing or is not a valid plugin name."
    if declared != plugin_id:
        return f"This game says plugin_id {declared}, but it ships in {plugin_id}."
    if manifest.get("schema_version") != SCHEMA_VERSION:
        return f"This game needs schema_version {SCHEMA_VERSION}."
    route = str(manifest.get("desktop_route") or "").strip()
    if not _ROUTE.fullmatch(route) or ".." in route or "//" in route or len(route) > 200:
        return "The desktop_route must be a plain path such as /hello."
    return ""


def _homes() -> list[Path]:
    """The active Hermes home.

    ``HERMES_HOME`` wins outright: when it names an isolated install or profile,
    the default ``~/.hermes`` belongs to a different environment and its plugins
    are not loaded where this plugin runs.
    """
    raw = os.environ.get("HERMES_HOME", "").strip()
    if raw:
        return [Path(raw).expanduser()]
    return [Path.home() / ".hermes"]


def _installed_folder(owner: Path) -> bool:
    """True for a plugin folder inside a Hermes plugins directory (an install)."""
    parent = owner.parent
    if parent.name != "plugins":
        return False
    for home in _homes():
        if _same_path(parent, home / "plugins"):
            return True
        # <home>/profiles/<name>/plugins/<plugin>
        if _same_path(parent.parent.parent, home / "profiles"):
            return True
    return False


def _plugin_priority(owner: Path) -> int:
    """Who wins when one plugin name is found more than once.

    The running plugin's own folder always wins (lower number), so a checkout or
    a symlinked install plays its own code. An installed copy beats a copy that
    only sits beside a checkout.
    """
    if _same_path(owner, _OWN_ROOT):
        return -1
    return 0 if _installed_folder(owner) else 1


def plugin_roots() -> list[Path]:
    """Every folder that can hold an installed plugin.

    The Hermes home's ``plugins`` folder and the active profile's come first, so
    an installed plugin (which may be a symlink into a checkout) is ranked as an
    install. This plugin's own folder is scanned too: a symlinked install
    resolves to its real path, and scanning only that resolved neighbour folder
    would hide every other installed plugin.
    """
    homes = _homes()
    profile = os.environ.get("HERMES_PROFILE", "").strip()
    if profile:
        for home in list(homes):
            homes.append(home / "profiles" / profile)
    roots: list[Path] = [home / "plugins" for home in homes]
    roots.append(_OWN_ROOT.parent)
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        try:
            key = str(root.resolve())
        except OSError:
            key = str(root)
        if key in seen:
            continue
        seen.add(key)
        unique.append(root)
    return unique


def _same_path(first: Path, second: Path) -> bool:
    try:
        return first.resolve() == second.resolve()
    except OSError:
        return str(first) == str(second)


def _why(exc: BaseException) -> str:
    """A short, plain reason a game did not start. Never a traceback."""
    if isinstance(exc, ModuleNotFoundError):
        return f"It needs a module that is not installed ({exc.name or 'unknown'})."
    text = " ".join(str(exc).split())
    if len(text) > 200:
        text = text[:197] + "..."
    return f"{type(exc).__name__}: {text}" if text else type(exc).__name__


class Catalog:
    def __init__(
        self,
        roots: list[Path],
        data_root: Path,
        settings: dict[str, Any] | None = None,
        enabled=None,
        curated: Any = None,
        known: Any = None,
    ) -> None:
        self.data_root = Path(data_root)
        self.settings = dict(settings or {})
        self.library = Library(self.data_root)
        self._enabled = enabled
        # Play is the curated list. Tests may hand in their own; the shipped file is
        # the only other source, so no plugin can add itself to Play.
        if curated is None:
            shipped = curated_games()
            self._curated: list[str] = list(shipped["games"])
            self.curated_problems: list[str] = list(shipped["problems"])
        else:
            self._curated = [
                item
                for item in (str(raw or "").strip() for raw in curated)
                if _ID.fullmatch(item)
            ]
            self.curated_problems = []
        self._manifests: list[tuple[Path, dict[str, Any]]] = []
        self._games: dict[str, Any] = {}
        self.problems: list[str] = []
        self._owners: dict[str, tuple[Path, int]] = {}
        self._ids: dict[str, tuple[Path, int]] = {}
        if known is None:
            self._known: dict[str, dict[str, Any]] = known_games()["plugins"]
        else:
            self._known = dict(known)
        seen: set[str] = set()
        self._seen = seen
        scanned: set[str] = set()
        self._detected: set[str] = set()
        for root in roots:
            if not root.is_dir():
                continue
            for child in sorted(root.iterdir()):
                if not child.is_dir():
                    continue
                if (child / "plugin.yaml").is_file():
                    self._detected.add(child.name)
                    name = _plugin_name(child / "plugin.yaml")
                    if name:
                        self._detected.add(name)
                try:
                    where = str(child.resolve())
                except OSError:
                    where = str(child)
                if where in scanned:
                    # The same plugin folder reached twice (a symlink beside the
                    # real folder, or a root listed twice): scan it once.
                    continue
                scanned.add(where)
                found = _manifest_files(child)
                for manifest_path in found:
                    self._read_manifest(manifest_path, child, root, seen)
                if not found:
                    self._known_card(child)

    def _known_card(self, plugin_dir: Path) -> None:
        """A game we know by name that ships no game.json, if its plugin is installed.

        The hand-kept list only supplies a title and, when a person checked it, a
        route. An unchecked route stays empty and the card says so plainly.
        """
        if not (plugin_dir / "plugin.yaml").is_file():
            return
        name = _plugin_name(plugin_dir / "plugin.yaml")
        entry = self._known.get(name)
        if entry is None or not self._allowed(name, plugin_dir) or not self._installed(plugin_dir):
            return
        manifest: dict[str, Any] = {
            "id": str(entry["id"]),
            "title": str(entry["title"]),
            "summary": str(entry.get("summary") or ""),
            "kind": "external",
            "schema_version": SCHEMA_VERSION,
            "plugin_id": name,
            "desktop_route": str(entry.get("route") or ""),
            "known": True,
        }
        if not manifest["desktop_route"]:
            manifest["_error"] = "Its own screen has not been checked yet, so Game Center does not open it."
        self._take(plugin_dir, plugin_dir, name, manifest, self._seen)

    def _read_manifest(self, path: Path, folder: Path, root: Path, seen: set[str]) -> None:
        """One game.json. A bad one is a friendly problem on its own card, never a crash."""
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            # ValueError covers JSON syntax and invalid UTF-8: one bad file is
            # skipped, never allowed to break the Center.
            self.problems.append(f"{path}: game.json could not be read ({type(exc).__name__}); skipped.")
            return
        if not isinstance(manifest, dict):
            self.problems.append(f"{path}: game.json is not a JSON object; skipped.")
            return
        game_id = str(manifest.get("id") or "")
        if not _ID.fullmatch(game_id):
            self.problems.append(
                f"{path}: id must be lowercase letters, digits and dashes (up to 32); skipped."
            )
            return
        if not str(manifest.get("title") or "").strip():
            self.problems.append(f"{path}: game.json has no title; skipped.")
            return
        # The owning plugin is the folder a game was found in (its plugin.yaml
        # name), never the manifest's self-declared "plugin" field, which a
        # third party could lie about.
        plugin_id, owner = _plugin_owner(folder, root)
        if not self._allowed(plugin_id, owner):
            return
        manifest["title"] = str(manifest.get("title") or "").strip()
        if kind_of(manifest) == "external":
            # The card and the Open button both use the stripped value that was
            # validated, never the raw string with spaces around it.
            manifest["desktop_route"] = str(manifest.get("desktop_route") or "").strip()
            error = _external_problem(manifest, plugin_id)
        else:
            error = "" if manifest.get("entry") else f"Its plugin {plugin_id} ships no entry file."
            if not error:
                error = _entry_problem(folder, manifest.get("entry"))
                if error:
                    self.problems.append(f"{path}: {error}")
        manifest["plugin_id"] = plugin_id
        if error:
            manifest["_error"] = error
        self._take(path, owner, plugin_id, manifest, seen)

    def _allowed(self, plugin_id: str, owner: Path) -> bool:
        """Is this plugin enabled? A gate may also want the folder name."""
        gate = self._enabled
        if gate is None:
            return True
        try:
            params = [
                item for item in inspect.signature(gate).parameters.values()
                if item.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            ]
            takes_folder = len(params) >= 2
        except (TypeError, ValueError):
            takes_folder = False
        try:
            return bool(gate(plugin_id, owner.name) if takes_folder else gate(plugin_id))
        except Exception:
            # A broken enabled state must not take the Center down.
            return False

    def _take(self, path: Path, owner: Path, plugin_id: str, manifest: dict[str, Any], seen: set[str]) -> None:
        """Keep one copy of a plugin, and one game per id, best copy first."""
        rank = _plugin_priority(owner)
        current = self._owners.get(plugin_id)
        if current is not None and not _same_path(current[0], owner):
            if rank >= current[1]:
                # A second copy of one plugin (a stale install, or a copy beside
                # a checkout) must not add a second set of games.
                self.problems.append(
                    f"{path}: plugin {plugin_id} is already installed from {current[0]}; skipped."
                )
                return
            self._drop_plugin(plugin_id, seen)
        # The better copy owns the plugin from here on, even if one of its games
        # is refused below.
        self._owners[plugin_id] = (owner, rank)
        game_id = manifest["id"]
        holder = self._ids.get(game_id)
        if holder is not None and not _same_path(holder[0], owner):
            if rank >= holder[1]:
                self.problems.append(
                    f"{path}: game id {game_id} is already provided by {holder[0]}; skipped."
                )
                return
            self._drop_game(game_id, seen)
        if game_id in seen:
            self.problems.append(f"{path}: another game already uses the id {game_id}; skipped.")
            return
        self._ids[game_id] = (owner, rank)
        seen.add(game_id)
        self._manifests.append((path.parent, manifest))

    def _drop_plugin(self, plugin_id: str, seen: set[str]) -> None:
        """Forget a lower-ranked copy of a plugin before its better copy is read."""
        kept: list[tuple[Path, dict[str, Any]]] = []
        for directory, manifest in self._manifests:
            if manifest.get("plugin_id") == plugin_id:
                seen.discard(manifest["id"])
                self._ids.pop(manifest["id"], None)
            else:
                kept.append((directory, manifest))
        self._manifests = kept

    def _drop_game(self, game_id: str, seen: set[str]) -> None:
        """Forget a lower-ranked game that another plugin provides by the same id."""
        self._manifests = [
            (directory, manifest)
            for directory, manifest in self._manifests
            if manifest["id"] != game_id
        ]
        self._ids.pop(game_id, None)
        seen.discard(game_id)

    def list_text(self) -> str:
        store = self.storefront()
        lines = ["Game Center"]
        by_id = {card["id"]: card for card in store["store"]}
        if store["games"]:
            lines.append("Library")
            for card in store["games"]:
                lines.append(_card_line(card))
            tables = [card for card in store["games"] if card["kind"] == "table"]
            if tables:
                lines.append(f"Play: /games {tables[0]['id']} new")
            else:
                card = store["games"][0]
                verb = "play" if card["kind"] == "play" else "help"
                lines.append(f"Play: /games {card['id']} {verb}")
        else:
            lines.append("Library is empty. Nothing is installed until you Get it.")
        get_cards = [by_id[game_id] for game_id in store["get"] if game_id in by_id]
        if get_cards or store["more"]:
            lines.append("Get")
            for card in get_cards:
                if card.get("needs_plugin"):
                    lines.append(
                        f"  {card['id']}: {card['title']} — {card.get('summary', '')} "
                        f"Enable plugin {card['needs_plugin']}."
                    )
                else:
                    lines.append(
                        f"  {card['id']}: {card['title']} — {card.get('summary', '')} "
                        f"/games install {card['id']}"
                    )
        lines.append("Find people: /games chat say anyone for reversi?  /games looking reversi")
        return "\n".join(lines)

    def missing_extras(self) -> list[dict[str, str]]:
        have = {manifest["id"] for _directory, manifest in self._manifests}
        return [dict(extra) for extra in EXTRAS if extra["id"] not in have]

    def listed(self) -> list[dict[str, Any]]:
        """Installed games shown in the library. A listed:false game still plays by id."""
        owned = self.library.ids()
        return [
            manifest
            for _directory, manifest in self._manifests
            if manifest.get("listed", True) is not False
            and (manifest["id"] in owned or self._builtin(manifest))
        ]

    def store_manifests(self) -> list[dict[str, Any]]:
        """Every title the store can sell, installed or not. Hidden games stay off it."""
        return [
            manifest
            for _directory, manifest in self._manifests
            if manifest.get("listed", True) is not False
        ]

    def curated(self) -> list[str]:
        """The ids in Play, in the order the shipped list names them."""
        return list(self._curated)

    def in_play(self, game_id: str) -> bool:
        return str(game_id or "").strip().lower() in set(self._curated)

    def play_cards(self) -> list[dict[str, Any]]:
        """Play: the curated, match-ready games, front and centre.

        The list is the only way in. Nothing in a game's own manifest is read here,
        so a plugin cannot promote itself, and a game that is not installed simply
        has no card.
        """
        directory = Directory(self.data_root)
        by_id = {str(manifest["id"]): manifest for _folder, manifest in self._manifests}
        states = ship_states()
        cards: list[dict[str, Any]] = []
        for game_id in self._curated:
            manifest = by_id.get(game_id)
            if manifest is None:
                continue
            if manifest.get("listed", True) is False:
                continue
            # A game that failed the ship gate is not shown on Play. It moves to Labs.
            if ship_failed(states, game_id):
                continue
            if not self._builtin(manifest):
                # The list names games this plugin ships. Another plugin that happens
                # to use a curated id never reaches Play; its card sits in Experimental Games,
                # clearly labelled, like every other outside game.
                continue
            card = self._card(manifest, directory)
            card["in_play"] = True
            cards.append(card)
        return cards

    def your_games(self) -> list[dict[str, Any]]:
        """Experimental Games: installed games that are not in Play, treated as outside code.

        A valid game.json in an installed, enabled plugin is enough to appear here.
        Nothing on this list is seated at Game Center's table, so every card says it
        has no lobby or matchmaking, and nothing here reaches tournaments or ratings.
        """
        directory = Directory(self.data_root)
        play = set(self._curated)
        cards: list[dict[str, Any]] = []
        for _folder, manifest in self._manifests:
            if manifest["id"] in play and self._builtin(manifest):
                continue
            if manifest.get("listed", True) is False:
                continue
            # An experiment has its own shelf; it is not a game on this list.
            if manifest.get("labs"):
                continue
            owner = (self._owners.get(str(manifest.get("plugin_id") or "")) or (None, 0))[0]
            if owner is None or not self._installed(owner):
                continue
            card = self._card(manifest, directory)
            card["in_play"] = False
            card.update(_your_line(card))
            cards.append(card)
        return cards

    def labs_games(self) -> list[dict[str, Any]]:
        """Installed experiments: games whose manifest says ``labs``.

        They are played on their own screen like any other installed game, but the
        page shows them on the Labs shelf, with the Labs badge, never as Play tiles.
        """
        directory = Directory(self.data_root)
        play = set(self._curated)
        states = ship_states()
        cards: list[dict[str, Any]] = []
        for _folder, manifest in self._manifests:
            failed = ship_failed(states, manifest["id"])
            on_labs = bool(manifest.get("labs")) or (failed and manifest["id"] in play and self._builtin(manifest))
            if not on_labs:
                continue
            if manifest["id"] in play and self._builtin(manifest) and not failed:
                continue
            if manifest.get("listed", True) is False:
                continue
            owner = (self._owners.get(str(manifest.get("plugin_id") or "")) or (None, 0))[0]
            if owner is None or not self._installed(owner):
                continue
            card = self._card(manifest, directory)
            card["in_play"] = False
            if failed:
                card["ship"] = False
                card["gate_fails"] = list((states.get(manifest["id"]) or {}).get("fails") or [])
            card.update(_your_line(card))
            cards.append(card)
        return cards

    def your_suggestions(self) -> list[dict[str, Any]]:
        """Known plugins that do not already have an Experimental Games card."""
        shown = {card["plugin"] for card in self.your_games()}
        cards: list[dict[str, Any]] = []
        for plugin, entry in self._known.items():
            if plugin in shown:
                continue
            installed = plugin in self._detected
            catalog = _community_url(entry.get("catalog"))
            if installed:
                line = "Installed but turned off in Hermes."
                if catalog:
                    line += " Open its catalog page to turn it on or read about it."
            else:
                line = "Not installed."
                if catalog:
                    line += " Its catalog page is where Hermes installs it, after you agree."
            if not catalog:
                line += " Read about it in your terminal with hermes plugins search."
            cards.append({
                "id": entry["id"], "title": entry["title"], "summary": entry.get("summary", ""),
                "maker": entry.get("maker", ""), "note": entry.get("note", ""),
                "catalog": catalog, "state": "installed-off" if installed else "not-installed", "line": line,
            })
        return cards

    def _installed(self, owner: Path) -> bool:
        """A plugin folder Game Center treats as installed: its own, or under a Hermes plugins dir."""
        return _same_path(owner, _OWN_ROOT) or _installed_folder(owner)

    def kind(self, game_id: str) -> str | None:
        for _directory, manifest in self._manifests:
            if manifest["id"] == game_id:
                return kind_of(manifest)
        return None

    def card(self, game_id: str) -> dict[str, Any] | None:
        for item in self.storefront()["store"]:
            if item["id"] == game_id:
                return item
        return None

    def cards(self) -> list[dict[str, Any]]:
        directory = Directory(self.data_root)
        return [self._card(manifest, directory) for manifest in self.listed()]

    def storefront(self) -> dict[str, Any]:
        directory = Directory(self.data_root)
        owned = self.library.ids()
        shelf: list[dict[str, Any]] = []
        seen: set[str] = set()
        for manifest in self.store_manifests():
            card = self._card(manifest, directory)
            card["installed"] = manifest["id"] in owned or self._builtin(manifest)
            shelf.append(card)
            seen.add(manifest["id"])
        more = []
        for extra in self.missing_extras():
            card = {
                "id": extra["id"],
                "title": extra["title"],
                "summary": extra["summary"],
                "plugin": extra["plugin"],
                "kind": str(extra.get("kind") or "install"),
                "installed": False,
                "bots": False,
                "draws": True,
                "status": "install",
                "needs_plugin": extra["plugin"],
                "wake": False,
                "unit": "",
                "join": None,
                "worlds": [],
                "where": "",
            }
            more.append(card)
            if extra["id"] not in seen:
                shelf.append(card)
                seen.add(extra["id"])
        games = [card for card in shelf if card.get("installed")]
        get_ids = [card["id"] for card in shelf if not card.get("installed")]
        # Play is the curated list, never the library: a game another plugin brings
        # is not match-ready until it is reviewed and added to shelf/curated.json.
        play_cards = self.play_cards()
        your_cards = self.your_games()
        suggestions = self.your_suggestions()
        play_ids = [card["id"] for card in play_cards]
        tables = [card["id"] for card in play_cards if card["kind"] == "table"]
        worlds = [card["id"] for card in games if card["kind"] == "server"]
        listen = [card["id"] for card in games if card["kind"] == "listen"]
        featured: list[str] = [play_ids[0]] if play_ids else []
        if not featured:
            panel = next((card["id"] for card in your_cards if card.get("opens") == "panel"), "")
            if panel:
                featured.append(panel)
        return {
            "games": games,
            "store": shelf,
            "more": more,
            "featured": featured,
            "play_now": tables,
            "play": play_cards,
            "your_games": your_cards,
            "labs_games": self.labs_games(),
            "your_suggestions": suggestions,
            "worlds": worlds,
            "listen": listen,
            "get": get_ids,
        }

    def _card(self, manifest: dict[str, Any], directory: Directory) -> dict[str, Any]:
        kind = kind_of(manifest)
        worlds = []
        for world in _worlds(manifest):
            join = directory.public_join(world["unit"], world.get("join")) or world.get("join")
            status = directory.status(world["unit"], default=str(world.get("default") or "stopped"))
            worlds.append({**world, "join": join, "status": status, "where": join_line(join)})
        join = _join(manifest.get("join"))
        unit = str(manifest.get("unit") or "")
        status = "live"
        where = ""
        if kind == "server":
            if worlds:
                status = "live" if any(item["status"] == "live" for item in worlds) else worlds[0]["status"]
                where = "; ".join(item["where"] for item in worlds if item.get("where"))
            elif unit:
                join = directory.public_join(unit, join) or join
                status = directory.status(unit, default=str(manifest.get("status") or "stopped"))
                where = join_line(join)
        elif kind == "listen":
            status = "idle"
        elif kind == "external":
            status = "external"
            where = ""
        card = {
            "id": manifest["id"],
            "title": manifest["title"],
            "subtitle": _subtitle(manifest.get("subtitle")),
            "summary": manifest.get("summary", ""),
            "plugin": str(manifest.get("plugin") or manifest.get("plugin_id") or ""),
            "plugin_id": str(manifest.get("plugin_id") or ""),
            "bots": bool(manifest.get("bots")),
            # One person against the house (Slots, Blackjack): the page offers Play and Leave only.
            "solo": bool(manifest.get("solo")),
            # A game whose rules cannot end level (Hex, Breakthrough, Go with komi)
            # says so here, and the table stops offering a draw for it.
            "draws": manifest.get("draws", True) is not False,
            # A game that says it is an experiment is never drawn as a Play tile:
            # the page puts it on the Labs shelf with the Labs badge.
            "labs": bool(manifest.get("labs")),
            "installed": True,
            "kind": kind,
            "wake": bool(manifest.get("wake", kind == "server")),
            "unit": unit,
            "join": join,
            "worlds": worlds,
            "status": status,
            "where": where,
        }
        if kind == "external":
            card["desktop_route"] = str(manifest.get("desktop_route") or "")
        card["builtin"] = self._builtin(manifest)
        if manifest.get("known"):
            card["known"] = True
        if manifest.get("_error"):
            card["error"] = str(manifest["_error"])
        return card

    def has(self, game_id: str) -> bool:
        return any(manifest["id"] == game_id for _directory, manifest in self._manifests)

    def allows_bots(self, game_id: str) -> bool | None:
        """True when this game welcomes a bot account. None when it is not on the shelf."""
        for _directory, manifest in self._manifests:
            if manifest["id"] == game_id:
                return bool(manifest.get("bots"))
        return None

    def title(self, game_id: str) -> str:
        for _directory, manifest in self._manifests:
            if manifest["id"] == game_id:
                return str(manifest.get("title") or game_id)
        return game_id

    def bot_titles(self) -> list[str]:
        return [str(manifest["title"]) for manifest in self.listed() if manifest.get("bots")]

    def install(self, game_id: str, *, source: str = "command", player=None) -> str:
        if source != "command" or (player is not None and getattr(player, "bot", False)):
            return "A person installs a game. They type /games install connect4"
        game_id = str(game_id or "").strip().lower()
        if not game_id:
            return "Usage: /games install connect4"
        extra = next((item for item in self.missing_extras() if item["id"] == game_id), None)
        if extra:
            return (
                f"{extra['title']} needs plugin {extra['plugin']}. "
                f"Enable that plugin, then /games install {game_id}"
            )
        if not self.has(game_id):
            return f"No game named {game_id}. /games lists the store."
        if self._hidden(game_id):
            return f"{self.title(game_id)} is not in the store."
        if self.library.has(game_id):
            return f"{self.title(game_id)} is already in your library. /games {game_id}"
        if any(manifest["id"] == game_id and self._builtin(manifest) for _d, manifest in self._manifests):
            return f"{self.title(game_id)} comes with Game Center, so it is already in your library. /games {game_id}"
        self.library.add(game_id)
        return f"Installed {self.title(game_id)}. /games {game_id}"

    def remove(self, game_id: str, *, source: str = "command", player=None) -> str:
        if source != "command" or (player is not None and getattr(player, "bot", False)):
            return "A person removes a game. They type /games remove connect4"
        game_id = str(game_id or "").strip().lower()
        if not game_id:
            return "Usage: /games remove connect4"
        # A built-in is always in the library, even on an older install that once saved it in
        # installed.json, so removing it must say so instead of claiming it went away.
        if any(manifest["id"] == game_id and self._builtin(manifest) for _d, manifest in self._manifests):
            return f"{self.title(game_id)} comes with Game Center, so it stays in your library."
        if not self.library.has(game_id):
            return f"{self.title(game_id)} is not in your library."
        self.library.discard(game_id)
        return f"Removed {self.title(game_id)} from your library. It is still in the store."

    def _hidden(self, game_id: str) -> bool:
        for _directory, manifest in self._manifests:
            if manifest["id"] == game_id:
                return manifest.get("listed", True) is False
        return False

    def _builtin(self, manifest: dict[str, Any]) -> bool:
        """True for a game that ships inside Game Center itself.

        Those are in the library from the first run: the Get step exists only for
        games another plugin brings, where a person has to decide to take it.
        """
        return str(manifest.get("plugin_id") or "") == _own_plugin()

    def _needs_install(self, game_id: str) -> bool:
        if self._hidden(game_id):
            return False
        if not self.has(game_id):
            return False
        if any(manifest["id"] == game_id and self._builtin(manifest) for _d, manifest in self._manifests):
            return False
        return not self.library.has(game_id)

    def picture(self, game_id: str, complete=None, player=None) -> dict | None:
        """Live or starting 2D board. Does not start a game or play a move."""
        game = self._load(game_id)
        if isinstance(game, str):
            return None
        fn = getattr(game, "picture", None)
        if not callable(fn):
            return None
        # A game that can offer "Improve my bot" needs to know whether a model
        # route exists; a game with a talking table also needs to know who is
        # looking, because it hides other seats' secrets from that viewer.
        # Games without either parameter are called exactly as before.
        params = inspect.signature(fn).parameters
        kwargs: dict[str, Any] = {}
        if "complete" in params:
            kwargs["complete"] = complete
        if "player" in params:
            kwargs["player"] = player
        pictured = fn(**kwargs)
        return pictured if isinstance(pictured, dict) else None

    def play(self, game_id: str, raw: str, *, source: str, complete=None, player=None) -> str:
        refusal = blocked(raw, source, allow_ai=bool(self.settings.get("allow_ai", True)))
        if refusal:
            return refusal
        if self._needs_install(game_id):
            return (
                f"{self.title(game_id)} is in the store, not your library. "
                f"A person types /games install {game_id}"
            )
        game = self._load(game_id)
        if isinstance(game, str):
            return game
        # Disabling AI must also freeze bots seated before the setting changed.
        # Otherwise a human move or rematch silently triggers the old bot seat.
        verb = (raw.strip().split() or [""])[0].lower()
        if not bool(self.settings.get("allow_ai", True)) and verb in {"move", "step", "rematch"}:
            pictured = self.picture(game_id) or {}
            seats = pictured.get("seats") or []
            has_bot = any(seat.get("kind") in {"local", "agent"} for seat in seats)
            if not seats:
                root = getattr(game, "root", self.data_root / game_id)
                try:
                    old_state = json.loads((Path(root) / "state.json").read_text(encoding="utf-8"))
                    has_bot = any(old_state.get(side) in {"local", "agent"} for side in ("white", "black"))
                except (OSError, ValueError, TypeError):
                    pass
            if has_bot:
                return "AI is off for this profile. Start a human-only table to keep playing."
        command = getattr(game, "command", None)
        if not callable(command):
            return f"{game_id} has no command()."
        return str(_call(command, raw, source=source, complete=complete, player=player))

    def _load(self, game_id: str):
        if game_id in self._games:
            return self._games[game_id]
        for directory, manifest in self._manifests:
            if manifest["id"] != game_id:
                continue
            title = str(manifest.get("title") or game_id)
            if manifest.get("_error"):
                return f"{title} could not start. {manifest['_error']}"
            if kind_of(manifest) == "external":
                return (
                    f"{title} opens its own screen. Select Open on its card in the Game Center."
                )
            entry = directory / str(manifest["entry"])
            if not entry.is_file():
                return f"{title} is missing {manifest['entry']}."
            escape = _entry_problem(directory, manifest["entry"])
            if escape:
                return f"{title} could not start. {escape}"
            module_name = f"hermes_gameshelf_game_{game_id.replace('-', '_')}"
            try:
                spec = importlib.util.spec_from_file_location(module_name, entry)
                if spec is None or spec.loader is None:
                    raise ImportError(f"cannot load {entry.name}")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                factory = getattr(module, str(manifest.get("factory") or "create"), None)
                if not callable(factory):
                    raise AttributeError(f"no {manifest.get('factory') or 'create'}()")
                game = factory(
                    self.data_root / game_id,
                    {**self.settings, "data_root": str(self.data_root)},
                )
            except (Exception, SystemExit) as exc:
                # One broken game gets one friendly line. The Center, every other
                # game and this card's remaining buttons keep working. SystemExit
                # is caught too: a third-party game module must never exit the app.
                return f"{title} could not start. {_why(exc)}"
            self._games[game_id] = game
            return game
        return f"No game named {game_id}. /games lists them."
