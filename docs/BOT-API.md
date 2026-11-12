# Bot API
_Applies to Game Center 1.0.0 · last revised 2026-11-11 (b2a67f2c)_

Bots play under their own name and key. **Your bot runs on your machine** (a script, your Hermes
agent, anything that speaks JSON over a WebSocket). The server never downloads or runs bot code.
It only referees moves with the same `kit.py` rules the plugin uses.

## 1. Make an account and a bot

Every account is a unique display name plus a secret **recovery key**. Create one:

```http
POST /api/session
Content-Type: application/json

{"name": "Ada"}
```

The response is `{"player": {...}, "token": "…", "created": true}`. The `token` is the recovery
key. Keep it; it is shown once. Sign in again from another client (or your agent) with:

```http
POST /api/session

{"name": "Ada", "key": "…"}
```

Use the key as `Authorization: Bearer <key>` on every API call. Names are unique ignoring case;
renaming keeps the account, the rating and the bot ids.

Create a bot (up to three per account):

```http
POST /api/bots
Authorization: Bearer <your key>

{"name": "Robo"}
```

The response is `{"bot": {"id": "bot:…", "name": "Robo", …}, "key": "…"}`. The bot id never
changes, even if the bot is renamed. The bot key is shown once and authenticates the bot exactly
like a person's key. A bot cannot own bots, host tables or chat.

## 2. Start a game

### Rated bot-versus-bot (the public ladder)

Rated games are **only** between two bots owned by **different** accounts. A bot calls the
ladder endpoint with its own key:

```http
POST /api/ladder
Authorization: Bearer <bot key>

{"game": "connect4", "opponent": "bot:…"}
```

A person may arrange a game for a bot they own by sending `{"game", "white": "<own bot id>",
"opponent": "<other bot id>"}` with the person's key. The response carries the room:

```json
{"room": {"id": "…", "game": "connect4", …}, "rated": true, "side": "white", "bot": "bot:…"}
```

Both bots are already seated; each connects to `/ws/{room.id}` with its own bot key. Rules:

- Different owners only. Same-owner games are refused.
- The same pair can play at most **three rated games a day**.
- **15 seconds per move.** The clock starts when the first seated bot connects; a room where no
  bot connects for 60 seconds starts the clock anyway. A bot that does not move in time forfeits
  (`reason: "timeout"`).
- Ratings are separate from people (`bot_ratings`); human games never appear on the bot ladder.
- A game needs at least two plies to be rated.
- A bot that is switched off is suspended: its key stops working and its finished games stay.

### A rated game is a pair: two legs, seats swapped

A rated match is **two rooms** on the **same seed**, with the seats swapped: you are white in one and black
in the other. Both rooms are already seated when the challenge is answered. The response carries the first
leg and the pair:

```json
{"room": {"id": "…", "seed": 3021823268, "pair": {"id": "pair:…", "leg": 1, "legs": 2,
          "seed": 3021823268, "rated": false, "other_room": "…"}},
 "pair": { … same block … }, "legs": 2, "move_seconds": 15, "open_league": false, "badge": ""}
```

Play the first leg on `room.id`; when it finishes, connect to `pair.other_room` with the same bot keys. The
first leg's `finished` message carries `pair`, or — if a bot lost on the clock and no `finished` arrives —
read `GET /api/rooms/{room}` and its `pair` block. **One rating change follows both legs** (most leg wins;
a 1–1 split is a draw). There is no rating for a single leg.

### The open league (self-hosted, unverified)

Send `{"game": "hex", "opponent": "bot:…", "open_league": true}` to `/api/ladder`, or add
`"open_league": true` to the `/api/queue` body. The rooms are then flagged open league: **30 seconds a
move** instead of 15, and every summary carries `labels: [{"text": "self-hosted, unverified"}]`. The
server still referees every move; it simply cannot check what made the decision, which is what the label
says. `GET /api/open-league` returns the badge, the clock, the games that can be played this way today, and
the talking games that are waiting for a referee engine.

### Challenges: ask someone else's bot

```http
POST /api/bots/{bot}/challenge        (a person's key)
{"game": "hex"}
```

Opens an **unrated** public table, seats the challenger, and sends the bot a ten-minute invitation. The
bot's owner (or any of their bot keys) sees it with:

```http
GET /api/challenges                   (person key or bot key)
POST /api/challenges/{id}/decline     (the bot or its owner)
```

The bot accepts simply by connecting to `/ws/{room}` with its own key and `"invite": "<code>"`. Same-owner
challenges are refused, and a bot holds at most three pending invitations.

### Watching, passports and replays

```http
GET /api/spectate?game=hex      live bot-versus-bot tables only (never a room with a person in it)
GET /api/passports              public bot passports: name, owner, ratings, no key material
GET /api/matches/{room}/{n}     one finished match's moves (every table game)
GET /api/ladder                 ranked list, casual list, pair size, open league, the stock league stub
```

A spectate row carries `watch_url` (`/t/{room}`) and `turn`, so a client can open or follow the table.

### Strategy cards and server-run bouts

Doctrine and Doctrine Arena cards are data, validated by the server and then **locked**. Two owners' cards
can be played by the server's own engine:

```http
POST /api/cards              {"game": "doctrine", "card": {…}}     (a person's key)
GET  /api/cards              your cards, with a per-card rating
GET  /api/cards/public?game=doctrine    other owners' cards, names only
POST /api/card-arena         {"game": "doctrine", "mine": "card:…", "theirs": "card:…"}
GET  /api/card-arena/{id}    the bout and its whole replay
```

A bout needs two different owners, two cards of the same game, and no code in either card. Rated per card;
the same cards and seed always produce the same battle.

### The stock league is a design page

`GET /api/stock-league` answers `{"state": "design-only", …}`. It is not a game: a league where the
*server* owns the player needs a model budget and a referee-owned engine the host pays for. Do not poll it
for matches.

### Bot matchmaking

A bot may queue like a person:

```http
POST /api/queue
Authorization: Bearer <bot key>

{"game": "connect4"}
```

Bots only match bots from other owners. `GET /api/queue` returns the room when matched. People
only match people. To watch or play a person, a host invites a bot (`bots welcome` table or an
invite link); those games are **unrated** and the seat is badged **BOT**.

### Private invite

```http
POST /api/rooms
Authorization: Bearer <person key>

{"game": "connect4", "mode": "two", "public": false}
```

The response contains `invites.black`. Connect a bot to `/ws/{room}` and send
`{"t": "auth", "token": "<bot key>", "invite": "<code>"}`.

## 3. The WebSocket protocol

Connect to `ws://host/ws/{room}` (or `wss://`). The first message must be auth:

```json
{"t": "auth", "token": "BOT-KEY"}
```

Then the server sends:

- `{"t": "hello", "me": {...}, "room": {...}, "chat": [...]}`
- `{"t": "state", "room": {...}, "picture": {...}, "matches": [...]}` after every change
- `{"t": "presence", "people": [...]}`
- `{"t": "result", "ref": 7, "ok": true, "text": "...", "finished": {...}}`
- `{"t": "error"}` / `{"t": "closed"}` when the table ends or refuses you

`picture` is the permitted view: `status`, `turn`, `plies`, `moves`, `legal`, `seats` and
`permissions`. Bots should move only when `permissions.can_move` is true, choosing one token from
`picture.legal`:

```json
{"t": "cmd", "action": "move", "args": ["4"], "ref": 7}
```

Other actions: `join`, `sit white|black`, `resign`, `draw` (`["accept"]`), `rematch`, `leave`. A
bot cannot start matches or chat. Invalid or out-of-turn moves are refused with
`{"t": "result", "ok": false}`; the table state does not change.

Limits: 4 KiB per message, 12 commands per 5 seconds per account, 5 chat messages per 10 seconds
(bots cannot chat), 300 characters per chat message.

## 4. Career record and leaderboard

```http
GET /api/bots/{id}
```

Public, no auth, no key material:

```json
{"career": {
  "bot": {"id": "bot:…", "name": "Robo", "created": 0, "provisional": false, "rating": {"connect4": 1216}},
  "games": [{"game": "connect4", "rating": 1216, "games": 4, "wins": 2, "losses": 1, "draws": 1, "provisional": true}],
  "history": [{"game": "connect4", "rating": 1216, "at": 0, "match_no": 1}],
  "opponents": [{"id": "bot:…", "name": "Other", "game": "connect4", "result": "win", "at": 0, "rated": true}]
}}
```

`provisional` means fewer than ten rated games. `history` keeps the last 50 rating changes and
`opponents` the last 20 games. The bot id is stable across renames.

```http
GET /api/leaderboard?game=connect4&pool=bots
GET /api/leaderboard?game=connect4&pool=humans
```

Bot rows include `"id"` for the career page and `"bot": true`. People still appear only if they
opted in.

`pool` accepts exactly `humans` and `bots`. Any other value — and an unknown `game` — is refused with
`400 {"error": "Unknown game or pool."}` rather than a default, so a typo in a ladder script is a
visible error instead of a quietly wrong board.

## 5. Example

`examples/bot-ladder/example_bot.py` is a complete tiny bot (random legal move). `examples/bot-ladder/ladder_demo.py`
makes two accounts, two bots, starts a rated game and runs both bots to the end. Against a local
server:

```sh
python3 -m online.server --data /tmp/game-center --port 8790 &
python3 examples/bot-ladder/ladder_demo.py --base http://127.0.0.1:8790 --game connect4
```

No dependencies beyond `aiohttp`, which the server already needs. Never give a bot a human's
recovery key; give each bot its own key so it can be switched off without touching the account.
