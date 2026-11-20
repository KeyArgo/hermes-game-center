"""Read-only picture of a live lobby, for the person running the server.

``python3 -m online.doctor --db PATH`` opens that sqlite file with ``mode=ro`` and
prints what is open, who was around, and what the idle sweep would close. It never
writes. The same report is the staff page at ``/admin/doctor``.

Chat text stays out of the report: a line is an id, an author and a time.
"""

from __future__ import annotations

import argparse
import datetime
import html
import json
import logging
import sqlite3
import time
from collections import deque
from pathlib import Path

from online.rooms import EMPTY_IDLE_CLOSE_SECONDS, FINISHED, IDLE_CLOSE_SECONDS, SWEEP_REASONS

# A player seen within this window counts as recent presence when this process
# has no lobby sockets to ask. The live page passes the hub's own connections
# instead, and does not fall back.
PRESENCE_SECONDS = 15 * 60.0
CHAT_LINES = 20

log = logging.getLogger("gameshelf.online")


class RecentProblems(logging.Handler):
    """The last warnings and errors this process logged, for the staff page.

    The CLI doctor has no process to remember; the shell wrapper reads journald.
    """

    def __init__(self, limit: int = 20) -> None:
        super().__init__(level=logging.WARNING)
        self.rows: deque = deque(maxlen=limit)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = record.getMessage()
        except Exception:
            message = ""
        try:
            from shelf.diagnostics import mask
            message = mask(message)
        except Exception:
            pass
        self.rows.append({
            "at": float(getattr(record, "created", time.time())),
            "level": record.levelname,
            "message": message,
        })


RECENT = RecentProblems()


def install_recent_problems(logger: logging.Logger | None = None) -> RecentProblems:
    target = logger or log
    if RECENT not in target.handlers:
        target.addHandler(RECENT)
    return RECENT


def open_readonly(path: Path) -> sqlite3.Connection:
    """A connection that cannot write. ``mode=ro`` refuses a missing file too."""
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _age(now: float, then: float) -> int:
    return int(max(0.0, float(now) - float(then or 0)))


def _when(then: float) -> str:
    if not then:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(float(then)))


def _utc_midnight(when: float) -> float:
    moment = datetime.datetime.fromtimestamp(float(when), datetime.timezone.utc)
    start = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.timestamp()


def _sweep_summary(conn, now: float) -> dict:
    """Last sweep, and how many rooms each reason closed since UTC midnight."""
    today = {reason: 0 for reason in SWEEP_REASONS}
    last = 0.0
    start = _utc_midnight(now)
    rows = conn.execute(
        "SELECT at, reason FROM audit WHERE reason IN (?, ?, ?, ?)",
        SWEEP_REASONS,
    ).fetchall()
    for row in rows:
        code = str(row["reason"] or "")
        if code not in today:
            continue
        at = float(row["at"] or 0)
        if at >= last:
            last = at
        if at >= start:
            today[code] += 1
    return {"last_at": last, "today": today}


def _room_state(data_root: Path, room_id: str) -> dict:
    name = str(room_id or "")
    if not name or "/" in name or "\\" in name or ".." in Path(name).parts:
        return {}
    path = data_root / "rooms" / name / "state.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _seats(state: dict) -> list[dict]:
    seats = []
    for side in ("white", "black"):
        kind = str(state.get(side) or "")
        name = str(state.get(f"{side}_name") or "").strip()
        if not kind and not name:
            continue
        seats.append({"side": side, "name": name, "kind": kind})
    return seats


def collect(db_path, *, now: float | None = None, lobby_ids=None, spared=None,
            errors=None) -> dict:
    """One snapshot. ``lobby_ids`` is the hub's connections when the server has
    them; ``None`` means this process has no hub, so recent presence is used.
    ``spared`` are room ids a live seat would keep the sweep from closing.
    """
    moment = time.time() if now is None else float(now)
    data_root = Path(db_path).resolve().parent
    spared_ids = {str(item) for item in (spared or ())}
    conn = open_readonly(db_path)
    try:
        rooms = []
        rows = conn.execute(
            "SELECT rooms.*, players.name AS host_name FROM rooms "
            "LEFT JOIN players ON players.id = rooms.host_id "
            "WHERE rooms.closed = 0 ORDER BY rooms.created, rooms.id"
        ).fetchall()
        for row in rows:
            room = dict(row)
            state = _room_state(data_root, room["id"])
            status = str(state.get("status") or "")
            idle = _age(moment, room.get("active") or 0)
            held = room["id"] in spared_ids
            # A live seat keeps the two-hour rule and is not closed while they sit.
            # Everyone else is on the thirty-minute clock.
            limit = IDLE_CLOSE_SECONDS if held else EMPTY_IDLE_CLOSE_SECONDS
            active = float(room.get("active") or 0)
            rooms.append({
                "id": room["id"],
                "game": room["game"],
                "host_id": room["host_id"],
                "host_name": room.get("host_name") or "",
                "created": float(room.get("created") or 0),
                "active": active,
                "age_seconds": _age(moment, room.get("created") or 0),
                "idle_seconds": idle,
                "seats": _seats(state),
                "status": status,
                "finished_open": bool(status in FINISHED),
                "sweep_held": held,
                "sweep_at": active + limit,
                "would_sweep": (not held) and idle >= limit,
            })

        if lobby_ids is None:
            presence_source = "recent"
            people = [dict(row) for row in conn.execute(
                "SELECT id, name, seen FROM players WHERE seen >= ? AND bot = 0 ORDER BY seen DESC, name",
                (moment - PRESENCE_SECONDS,),
            )]
        else:
            presence_source = "lobby"
            wanted = [str(item) for item in lobby_ids]
            people = []
            if wanted:
                marks = ",".join("?" for _ in wanted)
                people = [dict(row) for row in conn.execute(
                    f"SELECT id, name, seen FROM players WHERE id IN ({marks}) ORDER BY name",
                    wanted,
                )]

        looking = [dict(row) for row in conn.execute(
            "SELECT looking.player_id, players.name, looking.game, looking.created "
            "FROM looking LEFT JOIN players ON players.id = looking.player_id "
            "ORDER BY looking.created, looking.player_id, looking.game"
        )]
        availability = []
        for row in conn.execute(
            "SELECT availability.player_id, players.name, availability.open, availability.updated "
            "FROM availability LEFT JOIN players ON players.id = availability.player_id "
            "ORDER BY players.name"
        ):
            games = [str(item["game"]) for item in conn.execute(
                "SELECT game FROM availability_games WHERE player_id = ? AND enabled = 1 ORDER BY game",
                (row["player_id"],),
            )]
            availability.append({
                "player_id": row["player_id"],
                "name": row["name"] or "",
                "open": bool(row["open"]),
                "updated": float(row["updated"] or 0),
                "games": games,
            })
        requests = [dict(row) for row in conn.execute(
            "SELECT r.id, r.game, r.state, r.created, r.expires, r.offer, "
            "r.from_id, fa.name AS from_name, r.to_id, ta.name AS to_name "
            "FROM play_requests r "
            "LEFT JOIN players fa ON fa.id = r.from_id "
            "LEFT JOIN players ta ON ta.id = r.to_id "
            "WHERE r.state = 'pending' AND r.expires > ? "
            "ORDER BY r.created, r.id",
            (moment,),
        )]
        # No text column: a chat line in this report is who and when, never what.
        chat = [dict(row) for row in conn.execute(
            "SELECT id, name, at, room_id FROM chat ORDER BY id DESC LIMIT ?",
            (CHAT_LINES,),
        )]
        chat.reverse()
        sweep = _sweep_summary(conn, moment)
    finally:
        conn.close()

    sweep_next = [room for room in rooms if not room.get("sweep_held")]
    sweep_next.sort(key=lambda room: (float(room.get("sweep_at") or 0), str(room.get("id") or "")))
    report = {
        "now": moment,
        "rooms": rooms,
        "presence": {"source": presence_source, "players": people},
        "looking": looking,
        "availability": availability,
        "requests": requests,
        "would_sweep": [room for room in rooms if room["would_sweep"]],
        "sweep": sweep,
        "sweep_next": sweep_next,
        "chat": chat,
        "errors": list(errors or []),
    }
    report["counts"] = {
        "open_rooms": len(rooms),
        "presence": len(people),
        "looking": len(looking),
        "availability": len(availability),
        "open_requests": len(requests),
        "would_sweep": len(report["would_sweep"]),
        "chat": len(chat),
        "errors": len(report["errors"]),
    }
    return report


def report_for_app(app, *, now: float | None = None) -> dict:
    """The live server's report: lobby sockets when the hub has them, and the
    warnings this process has logged since it started."""
    hub = getattr(app, "hub", None)
    lobby_ids = None
    spared = set()
    if hub is not None and hasattr(hub, "online_players"):
        lobby_ids = list(hub.online_players())
    if hub is not None and hasattr(hub, "seated_live"):
        try:
            open_rows = app.store.open_rooms(public_only=False)
        except Exception:
            open_rows = []
        for room in open_rows:
            try:
                if hub.seated_live(room):
                    spared.add(room["id"])
            except Exception:
                continue
    return collect(
        app.store.path, now=now, lobby_ids=lobby_ids, spared=spared, errors=list(RECENT.rows),
    )


def _seat_words(seats: list[dict]) -> str:
    if not seats:
        return "none"
    parts = []
    for seat in seats:
        who = seat.get("name") or seat.get("kind") or "empty"
        parts.append(f"{seat.get('side')}: {who}")
    return ", ".join(parts)


def _sweep_lines(report: dict) -> list[str]:
    sweep = report.get("sweep") or {}
    today = sweep.get("today") or {}
    last = float(sweep.get("last_at") or 0)
    lines = [
        "last sweep: " + (_when(last) if last else "(none)"),
        "swept today: " + " ".join(
            f"{name}={int(today.get(name) or 0)}" for name in SWEEP_REASONS
        ),
    ]
    return lines


def render_text(report: dict) -> str:
    lines = ["Game Center server doctor"]
    lines.extend(_sweep_lines(report))
    counts = report.get("counts") or {}
    lines.append(
        "counts: "
        + " ".join(f"{key}={counts.get(key, 0)}" for key in (
            "open_rooms", "presence", "looking", "availability",
            "open_requests", "would_sweep", "chat", "errors",
        ))
    )
    lines.append("open rooms:")
    if not report.get("rooms"):
        lines.append("  (none)")
    for room in report.get("rooms") or []:
        lines.append(
            f"  {room['id']} {room['game']} host={room.get('host_name') or '?'} "
            f"age={room['age_seconds']}s idle={room['idle_seconds']}s "
            f"seats={_seat_words(room.get('seats') or [])} "
            f"status={room.get('status') or '?'} "
            f"finished_open={'yes' if room.get('finished_open') else 'no'} "
            f"created={_when(room.get('created') or 0)} "
            f"active={_when(room.get('active') or 0)}"
        )
    presence = report.get("presence") or {}
    source = presence.get("source")
    label = "lobby connections" if source == "lobby" else "recent presence"
    lines.append(f"{label}:")
    people = presence.get("players") or []
    if not people:
        lines.append("  (none)")
    for person in people:
        lines.append(f"  {person.get('name') or '?'} seen={_when(person.get('seen') or 0)}")
    lines.append("looking:")
    if not report.get("looking"):
        lines.append("  (none)")
    for row in report.get("looking") or []:
        lines.append(f"  {row.get('name') or '?'} {row.get('game')} since={_when(row.get('created') or 0)}")
    lines.append("availability:")
    if not report.get("availability"):
        lines.append("  (none)")
    for row in report.get("availability") or []:
        games = ",".join(row.get("games") or []) or "-"
        lines.append(f"  {row.get('name') or '?'} open={'yes' if row.get('open') else 'no'} games={games}")
    lines.append("open play requests:")
    if not report.get("requests"):
        lines.append("  (none)")
    for row in report.get("requests") or []:
        lines.append(
            f"  {row.get('id')} {row.get('from_name') or '?'} -> {row.get('to_name') or '?'} "
            f"{row.get('game')} expires={_when(row.get('expires') or 0)}"
        )
    lines.append("rooms that would be swept:")
    if not report.get("would_sweep"):
        lines.append("  (none)")
    for room in report.get("would_sweep") or []:
        lines.append(f"  {room['id']} {room['game']} idle={room['idle_seconds']}s")
    lines.append("chat (last 20, no text):")
    if not report.get("chat"):
        lines.append("  (none)")
    for row in report.get("chat") or []:
        lines.append(f"  {row.get('id')} {row.get('name') or '?'} {_when(row.get('at') or 0)}")
    lines.append("errors:")
    if not report.get("errors"):
        lines.append("  (none in this process)")
    for row in report.get("errors") or []:
        lines.append(f"  {_when(row.get('at') or 0)} {row.get('level')} {row.get('message')}")
    lines.append("rooms that will be swept next:")
    upcoming = report.get("sweep_next") or []
    if not upcoming:
        lines.append("  (none)")
    for room in upcoming:
        lines.append(
            f"  {room['id']} {room['game']} at={_when(room.get('sweep_at') or 0)} "
            f"idle={room['idle_seconds']}s"
        )
    return "\n".join(lines) + "\n"


def _cell(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def render_html(report: dict) -> str:
    """The staff page. Every value is escaped; nothing here is a form."""
    parts = [
        "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>",
        "<title>Game Center doctor</title>",
        "<style>body{font:14px/1.45 sans-serif;margin:24px;color:#1c2430}",
        "table{border-collapse:collapse;margin:8px 0 18px}td,th{border:1px solid #d5dbe3;",
        "padding:4px 8px;text-align:left;vertical-align:top}th{background:#f4f6f8}",
        "h1{font-size:20px}h2{font-size:15px;margin:18px 0 6px}</style></head><body>",
        "<h1>Game Center doctor</h1>",
        "<p>Read-only. Chat text is not on this page.</p>",
    ]
    sweep = report.get("sweep") or {}
    today = sweep.get("today") or {}
    last = float(sweep.get("last_at") or 0)
    parts.append("<h2>Sweep</h2>")
    parts.append("<p>Last sweep: " + (_cell(_when(last)) if last else "(none)") + "</p>")
    parts.append("<p>Today: " + _cell(" ".join(
        f"{name}={int(today.get(name) or 0)}" for name in SWEEP_REASONS
    )) + "</p>")
    parts.append("<h2>Open rooms</h2>")
    parts.append("<table><tr><th>Game</th><th>Seats</th><th>Status</th><th>Created</th>"
                 "<th>Last active</th><th>Finished, still open</th><th>Would sweep</th></tr>")
    for room in report.get("rooms") or []:
        parts.append(
            "<tr><td>" + _cell(room.get("game")) + "</td><td>" + _cell(_seat_words(room.get("seats") or []))
            + "</td><td>" + _cell(room.get("status") or "unknown")
            + "</td><td>" + _cell(_when(room.get("created") or 0))
            + "</td><td>" + _cell(_when(room.get("active") or 0))
            + "</td><td>" + ("yes" if room.get("finished_open") else "no")
            + "</td><td>" + ("yes" if room.get("would_sweep") else "no") + "</td></tr>"
        )
    if not report.get("rooms"):
        parts.append("<tr><td colspan='7'>(none)</td></tr>")
    parts.append("</table>")

    presence = report.get("presence") or {}
    parts.append("<h2>" + ("Who is connected" if presence.get("source") == "lobby" else "Recent presence") + "</h2><ul>")
    for person in presence.get("players") or []:
        parts.append("<li>" + _cell(person.get("name") or "?") + "</li>")
    if not presence.get("players"):
        parts.append("<li>(none)</li>")
    parts.append("</ul>")

    parts.append("<h2>Looking</h2><ul>")
    for row in report.get("looking") or []:
        parts.append("<li>" + _cell(row.get("name") or "?") + " — " + _cell(row.get("game")) + "</li>")
    if not report.get("looking"):
        parts.append("<li>(none)</li>")
    parts.append("</ul>")

    parts.append("<h2>Availability</h2><ul>")
    for row in report.get("availability") or []:
        games = ", ".join(row.get("games") or []) or "none"
        flag = "open" if row.get("open") else "closed"
        parts.append("<li>" + _cell(row.get("name") or "?") + " — " + flag + " — " + _cell(games) + "</li>")
    if not report.get("availability"):
        parts.append("<li>(none)</li>")
    parts.append("</ul>")

    parts.append("<h2>Open play requests</h2><ul>")
    for row in report.get("requests") or []:
        parts.append(
            "<li>" + _cell(row.get("from_name") or "?") + " → " + _cell(row.get("to_name") or "?")
            + " — " + _cell(row.get("game")) + " — until " + _cell(_when(row.get("expires") or 0)) + "</li>"
        )
    if not report.get("requests"):
        parts.append("<li>(none)</li>")
    parts.append("</ul>")

    parts.append("<h2>Last server errors</h2><ul>")
    for row in report.get("errors") or []:
        parts.append("<li>" + _cell(row.get("level")) + " " + _cell(row.get("message")) + "</li>")
    if not report.get("errors"):
        parts.append("<li>(none in this process)</li>")
    parts.append("</ul>")
    parts.append("<h2>Rooms that will be swept next</h2><ul>")
    for room in report.get("sweep_next") or []:
        parts.append(
            "<li>" + _cell(room.get("id")) + " " + _cell(room.get("game"))
            + " at " + _cell(_when(room.get("sweep_at") or 0)) + "</li>"
        )
    if not report.get("sweep_next"):
        parts.append("<li>(none)</li>")
    parts.append("</ul></body></html>")
    return "".join(parts)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m online.doctor",
        description="Read-only snapshot of a Game Center lobby database.")
    parser.add_argument("--db", required=True, help="path to online.sqlite3 (opened read-only)")
    parser.add_argument("--json", action="store_true", help="print the snapshot as JSON")
    args = parser.parse_args(argv)
    path = Path(args.db)
    if not path.is_file():
        print(f"No database at {path}. Pass --db with the lobby's online.sqlite3.")
        return 2
    report = collect(path)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_text(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
