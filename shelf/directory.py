"""Live/stopped directory for Game Center worlds. No engines live here.

The referee and the Desktop both read ``directory.json`` under the plugin data
dir. games-host on the house machine writes the same shape. Tables are always
live; this file is for vendor servers and published listen addresses.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_FILE = "directory.json"
_STATUSES = {"live", "starting", "stopped", "missing"}


def _empty() -> dict[str, Any]:
    return {"playit_host": "", "units": {}}


class Directory:
    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)
        self.path = self.folder / _FILE

    def load(self) -> dict[str, Any]:
        empty = _empty()
        if not self.path.is_file():
            return empty
        try:
            loaded = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return empty
        if not isinstance(loaded, dict):
            return empty
        playit_host = str(loaded.get("playit_host") or os.environ.get("PLAYIT_HOST") or "")
        units: dict[str, dict[str, Any]] = {}
        raw_units = loaded.get("units") or {}
        if isinstance(raw_units, dict):
            for key, value in raw_units.items():
                if not isinstance(value, dict):
                    continue
                units[str(key)] = _unit(value)
        return {"playit_host": playit_host, "units": units}

    def save(self, state: dict[str, Any]) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state), encoding="utf-8")
        os.replace(temporary, self.path)

    def unit(self, unit_id: str) -> dict[str, Any]:
        return dict(self.load()["units"].get(unit_id) or {})

    def status(self, unit_id: str, default: str = "stopped") -> str:
        found = str(self.unit(unit_id).get("status") or "")
        if found in _STATUSES:
            return found
        return default if default in _STATUSES else "stopped"

    def join(self, unit_id: str) -> dict[str, Any] | None:
        entry = self.unit(unit_id)
        join = entry.get("join")
        return dict(join) if isinstance(join, dict) and join.get("host") else None

    def public_join(self, unit_id: str, fallback: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """LAN join, or Playit host:port when a tunnel hostname is configured."""
        state = self.load()
        entry = dict(state["units"].get(unit_id) or {})
        join = entry.get("join") if isinstance(entry.get("join"), dict) else None
        if not join:
            join = dict(fallback) if fallback else None
        if not join:
            return None
        result = {
            "host": str(join.get("host") or ""),
            "port": int(join.get("port") or 0),
            "proto": str(join.get("proto") or ""),
        }
        playit_host = str(entry.get("playit") or state.get("playit_host") or "")
        playit_port = entry.get("playit_port", result["port"])
        if playit_host:
            result["playit"] = f"{playit_host}:{playit_port}"
        return result

    def set_unit(self, unit_id: str, **fields: Any) -> dict[str, Any]:
        state = self.load()
        current = dict(state["units"].get(unit_id) or {})
        current.update({key: value for key, value in fields.items() if value is not None})
        if "status" in current and current["status"] not in _STATUSES:
            current["status"] = "stopped"
        state["units"][unit_id] = current
        if not state.get("playit_host"):
            state["playit_host"] = str(os.environ.get("PLAYIT_HOST") or "")
        self.save(state)
        return current


def _unit(value: dict[str, Any]) -> dict[str, Any]:
    join = value.get("join")
    cleaned_join = None
    if isinstance(join, dict) and join.get("host"):
        try:
            port = int(join.get("port") or 0)
        except (TypeError, ValueError):
            port = 0
        cleaned_join = {
            "host": str(join.get("host") or ""),
            "port": port,
            "proto": str(join.get("proto") or ""),
        }
    status = str(value.get("status") or "stopped")
    if status not in _STATUSES:
        status = "stopped"
    return {
        "status": status,
        "join": cleaned_join,
        "playit": str(value.get("playit") or ""),
        "playit_port": value.get("playit_port"),
        "reason": str(value.get("reason") or ""),
        "host": str(value.get("host") or ""),
    }


def join_line(join: dict[str, Any] | None) -> str:
    if not join or not join.get("host"):
        return ""
    lan = f"{join['host']}:{join['port']}"
    playit = str(join.get("playit") or "")
    if playit:
        return f"{playit} (LAN {lan})"
    return lan
