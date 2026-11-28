# HOSTING
_Applies to Game Center 1.0.0 · last revised 2026-11-27 (555827f1)_

How to run Game Center's online lobby on a server, and what you are taking on when you do.

Hosting is a supported path, not a hidden one. The laptop's lobby points at
`https://games.hermesnet.xyz`, but `lobby_url` is a setting, so a server you run works the same way.
This page says what must be true before you point people at it.

## What the server is

`python -m online.server --data DIR` serves one thing: tables other people can join, plus the bot
ladder. It is not a proxy, it holds no personal files, and it never sees a chat with Hermes or a model
key. It stores a display name, a hashed recovery key, moves, ratings and match history.

It also serves the **lobby socket** at `GET /api/lobby/socket` (contract A, `online/presence.py`): one
account-level WebSocket per signed-in person, separate from the per-table `/ws/{room}` sockets and with
its own connection cap. It is what carries the roster, each person's open-to-play prefs, and the play
requests that seat two people at a private table. A reverse proxy in front of the server must pass the
WebSocket upgrade through on this path as well as on `/ws/`. A server built before this socket existed
answers the path with 404; a newer client treats that as "old server" and falls back quietly, so an
upgrade during a rollout does not break anyone mid-session.

## What it binds to by default

`--host 127.0.0.1 --port 8790`. That is loopback only. A fresh checkout does not accept a connection
from another machine. To serve other people you either change `--host` deliberately or, better, keep it
on loopback and put a reverse proxy in front.

## The four things that must be true before you expose it

1. **TLS in front.** The server speaks plain HTTP. Terminate TLS at nginx, Caddy, or your load
   balancer and forward to `127.0.0.1:8790`. Without TLS the recovery key crosses the network in the
   clear. If you are behind a proxy, pass `--trust-proxy` so the server reads the real client address
   from `X-Forwarded-For` instead of trusting every request.
2. **A real address, not a bare IP.** Recovery keys are bearer credentials. Serve the lobby on a name
   you control over HTTPS.
3. **The admin key held offline.** `/api/admin/*` is gated by a staff key. Generate it once, keep it in
   a password manager, never in the repo, never in shell history. `online/admin.py` shows the routes.
4. **A backup of `DIR`.** It holds `online.sqlite3` (players, ratings, matches) and the per-room
   folders. Without a backup, a disk failure erases every rating.

## What is already protected in the code

- Recovery keys are stored as SHA-256 hashes, never plaintext. The key is shown once at sign-in.
- Tokens travel in an `Authorization: Bearer` header and `localStorage`, never a cookie, so a
  cross-site form post cannot carry them. There is no CSRF surface to exploit.
- Rate limits are applied per address on sign-in, new accounts, the queue, alerts and the ladder.
- A suspended player holding a valid token is refused, not just hidden from the lobby.
- The per-room lock means one table's action cannot interleave with another's on the same room.
- Each online table keeps its own wallet file, so one room cannot spend another's chips.
- The dealer's hole card is masked in the per-player picture; the deck is never in a client message.

## What is your job, not the code's

- Deciding whether you want strangers on it at all. A private lobby for friends is a different risk
  from a public one.
- Watching the admin surface. Suspension and address blocks exist; someone has to use them.
- Keeping the host patched. The Python version, the OS, the proxy.
- Publishing a contact address for reports. `SECURITY.md` asks for private disclosure; a hosted service
  needs a real inbox behind it.

## Troubleshooting a live server

Two read-only doors, and neither one writes to the database or the journal.

**On the machine, over ssh.** `tools/gc-server-doctor.sh` reads the target from
`GC_SERVER_SSH` (required; the script says how to set it — nothing in this repo names a machine).
`GC_SERVER_APP` is the directory that contains the `online` package (default
`/opt/gameshelf-online/app`). `GC_SERVER_DATA` is the server's `--data` directory (default
`/var/lib/gameshelf-online`, the path in the unit file). The script runs `python3 -m online.doctor`
against that directory's `online.sqlite3`, opened with sqlite's `mode=ro`, then
`journalctl -u gameshelf-online --since -1h` filtered to WARNING and ERROR lines.

`python3 -m online.doctor --db PATH [--json]` prints open rooms (id, game, host, age, idle time,
seats), recent presence when it is not inside the server process, looking and availability rows,
open play requests, rooms the idle sweep would close, and the last 20 chat lines as id, author and
time — never the text — plus counts.

**In the browser, as staff.** `/admin/doctor` on the lobby is the same report, plus who is connected
(the live lobby sockets) and the last warnings and errors this process has logged. It uses the staff
key the admin routes already check (`Authorization` and `X-Staff-Key`); without them it answers 401.
There is no new secret. The Admin tab in Game Center has a Doctor section that reads it through the
same staff call (`GET /api/admin/doctor`).

## What hosting does not change

Local play, the store, lessons, the ladder estimate and every single-player table keep working with
the server down. Hosting adds a service; it does not become a dependency.
