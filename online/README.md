# Game Center Online

Live tables for the curated Game Shelf board games (Connect Four, Reversi, Checkers, Gomoku,
Chess, Go, Hex, Breakthrough, Sea Battle) with invite links, spectators, table chat, matchmaking, an
opt-in leaderboard and a public bot ladder. People join from a browser; Hermes Desktop's Game
Center links here ("Play online").

The referee is the same `kit.py` and game rules the plugin uses. Every move, seat, resignation,
draw and rematch is a `Table.command` run as the identified web player (`platform="web"`, one
person per seat). This package adds what the kit has no notion of: rooms and hosts, invites,
presence and disconnect claims, chat and moderation, matchmaking, recording results and ratings.

| File | What it does |
|---|---|
| `server.py` | aiohttp app: pages, JSON API, one WebSocket per tab, rate limits, janitor |
| `rooms.py` | curated game allowlist, room rules over `kit.Table`, match numbering, bot move clock |
| `matchqueue.py` | small in-memory matchmaking queue with expiring entries and a widening window |
| `presence.py` | the lobby socket hub: one row per account that is online, its status and its switches |
| `requests.py` | play requests, the request switch, find match (offers to both sides) and the seating path |
| `store.py` | SQLite: players (hashed keys), rooms, invites, chat, moderation, matches, Elo, availability, looking |
| `guard.py` | name and chat limits, word filter, rate limiter |
| `web/` | page, styles, the browser app, vendored React 19.1 (pinned ESM, see `vendor/SHA256SUMS`) |
| `examples/` | (beside this folder) `../examples/bot-ladder/`: a tiny bot and a scripted rated game |

The browser draws boards with `BoardSvg` exported from `../desktop/plugin.js`, served as
`/board.js`, so Desktop and web boards are the same code. No community or uncurated game code is
ever imported or run by the server.

## Run locally

```sh
cd /path/to/hermes-gameshelf
python3 -m online.server --data /tmp/gameshelf-online --port 8790
# open http://127.0.0.1:8790 in two browser profiles
```

Needs Python 3.11+ and `aiohttp`. Options: `--trust-proxy` (read `X-Real-IP` behind nginx),
`--signups-per-hour` (default 20 per address), `--api-per-minute` (default 120 per address).

## Rules worth knowing

- **Identity:** a unique name and a random recovery key. The key is shown once; copy it to sign
  in on another browser, device or your own agent. Names are unique ignoring case. Losing the key
  loses the name; the record cannot be recovered.
- **Curated only:** the nine games in `rooms.CURATED`, reviewed in this repo. Nothing else is
  loaded, listed or run.
- **Lobby:** `GET /api/lobby` lists open public tables, per-game waiting counts and the people and
  bots looking for a game, with level and provisional rating.
- **Matchmaking:** `POST /api/queue` and `DELETE /api/queue`. Entries expire after ten minutes,
  the rating window widens from ±150 to ±300 to any rating, same level is preferred, and a small
  pool is never split into many queues. "Play the computer while you wait" is a practice table;
  when a person arrives the waiting player is told and can switch. Bot opponents are badged
  **BOT** and those games are unrated.
- **Private tables** are unlisted; a non-host sits only through a one-time invite link
  (`/t/<room>#invite=<code>`; the code stays out of server logs). Public tables are listed under
  Lobby and anyone can sit. Anyone with the room link can watch.
- **Only the host** starts matches, makes invites, mutes/removes people and closes the table.
  Players mid-match cannot be removed. Closing mid-match is the host's resignation; a host who
  is not playing cannot close on two other people's match.
- **Leaving** mid-match is a resignation. If an opponent's connection is gone for 120 s the
  other player can claim the win (`disconnect`).
- **Ratings:** Elo per game (start 1200, K 32) for finished games between two people with at
  least 2 moves; the same pair counts at most 3 times a day. Bot games are a separate record.
  The public leaderboard lists only people who opt in.
- **Bot ladder:** rated bot-versus-bot games only, across different owners, with their own Elo
  table and a 15-second move clock. `GET /api/bots/{id}` has the career record; `GET
  /api/leaderboard?pool=bots` is the ladder. Bots run on their owner's machine. See
  `docs/BOT-API.md`.
- **Alerts:** `GET/POST /api/alerts` stores an opt-in per game, server-side only, with a ten
  minute cooldown. The server sends nothing; a client polls while it is open.
- **Balances:** `GET/POST /api/balance` keeps one account's own chip and point totals, as that
  account's computer reports them. Self-reported and never a leaderboard, rating or match result:
  the server keeps the latest pair plus the last 100 changes per account, and a write is allowed
  once every ten seconds per account. `GET` returns the caller's own row only.
- **Chat:** text only, 300 characters, 5 messages per 10 s, word filter; kept 7 days. Bots cannot
  chat. There is no private chat.
- **Housekeeping:** idle tables close after 3 days and their folders are deleted.

## Known limits

- A determined person can make new names (20 per address per hour) to dodge a mute or to farm
  ratings within the per-pair cap. Removal also blocks the removed person's address from that
  table for a day.
- One server process. Presence and the matchmaking queue live in memory; after a restart, seated
  players who do not come back become claimable after the grace period and queue entries are
  gone.
- Ladder games cannot prove fair play against collusion or outside help; the 3-a-day pair cap and
  the move clock are the only controls.

## Upgrading an existing database

See `UPGRADE.md`. Migrations add tables and columns only; no row is dropped or rewritten.

## Tests

```sh
python3 -m pytest -q tests/test_online_server.py tests/test_online_rooms.py tests/test_online_names.py \
  tests/test_online_bots.py tests/test_online_lessons.py tests/test_online_arcade.py \
  tests/test_online_lobby.py tests/test_online_ladder.py
```
