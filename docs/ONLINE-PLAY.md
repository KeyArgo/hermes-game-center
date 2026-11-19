# Online play and the bot ladder
_Applies to Game Center 1.0.0 · last revised 2026-11-18 (431bd033)_

Game Center's nine table games run on your computer. **Games with other people** are the one part that
leaves it: a separate service at `https://games.hermesnet.xyz`, run by the author. It is **off until you
turn it on**, and this page explains exactly what happens when you do.

## The disclosure you see before turning it on

> Online play and match alerts are off until you turn them on here. When they are on, Game Center talks to
> `https://games.hermesnet.xyz` and sends: the display name you pick, your recovery key when you sign in,
> which game you are waiting for, the moves you make, your chip and point totals (so they can be moved
> somewhere else later — they are never used for a leaderboard), and — for the bot ladder — your bot's
> name and the move it picks. While online play is on, Game Center also stays connected to the lobby —
> even with the lobby panel closed — so others can see you are online, and it sends which games you will
> accept a challenge in, whether you are appearing offline, which games you are looking for a match in,
> and the play requests you send or answer. If you use them, it also sends the optional
> things you choose to post: a strategy card you publish, a report you file, a block you set, and a bot
> challenge you start. The key is kept in Hermes's credentials, never in a file of ours and never in a
> log. It does not send your chats with Hermes, your files, your model or its key, or any telemetry. The
> server sees your network address the way any website does. Everything else on this page runs on this
> computer and keeps working when the server is down.

That paragraph is generated from the `lobby_url` setting, so it always names the address actually used.

## Get online: the card at the top of the Games page

The first thing on the Games page is **Get online**, and it is the whole way in, in the order a person
meets it:

1. **Which Game Center this is.** The card names the lobby it will talk to (`Game Center on
   games.hermesnet.xyz`) and which Hermes connection this window is using. A window on another machine's
   Hermes says **“This window runs Game Center on <name>”** and offers **Open connection settings**
   (Settings → Gateways, where the connections are listed): to play as this computer, switch the
   connection to **This device**.
2. **Turn online play on** — the same switch as the dock's Lobby tab, and the same disclosure first.
3. **A name**, or the player you already have: **Create my player** (the name box starts empty; **Suggest
   a name** fills it with one nobody has taken, when this build has the generator), or **I have a player**
   with the name and key you saved.
4. Once signed in: **You are &lt;name&gt; online**, with **Change my name** and **Sign out**.
5. **Show my key** — masked until you press it, then **Copy my key** — and **Save my account file**, which
   writes `GameCenter-<name>.json` (`name`, `key`, `server`, `saved_at`) to your **Downloads** folder and
   says where it went.
6. **Check online**, the same walk the Hall runs.

When everything works the card folds to one line — **Online as &lt;name&gt; on &lt;host&gt; ✓ · Manage** — and
**Manage** opens it again. The steps are the dock's own: the card and the pane draw the same block
(`onlineAccountBlock`), so the two can never disagree about what sign-in asks for.

The pane and the card both show **Change my name** and **Sign out**, and neither is allowed to invent a
name: an empty box creates nothing, and nothing is ever auto-created on the server.

## Turning it on, and the address

The switch lives in the dock's **Lobby** tab (Game Center, beside the chat): **Play with people online →
Turn on online play**. **Turn online play off** is in the same place and stops everything immediately.

The address is a setting — **Plugins → Game Center → Online lobby address** (`lobby_url`), default
`https://games.hermesnet.xyz`. Point it at your own lobby (for example `http://127.0.0.1:8790` while
running one from `online/`) and the dock uses that instead; a bad or empty address falls back to the
default rather than breaking the page.

Nothing is polled and nothing is sent while the switch is off.

## The Hall

While online play is on, Game Center keeps **one lobby connection** open — even with the lobby panel
closed, and even while you are playing — so other people can see you are online, and so a play request
reaches you the moment it is sent. It is the socket at `/api/lobby/socket`, and it carries only what the
roster needs: your display name, which games you will accept a challenge in (your **prefs**), whether you
are appearing offline, which games **find match** is on for, and the requests you send or answer. It never
carries your recovery key beyond the one sign-in frame, and it opens only after you have turned online
play on and signed in. Turning online play off, or signing out here, closes it at once.

**Everyone who is signed in is listed while they are online** — the roster is the lobby connection, not
the queue: nobody has to queue, say hello or open a page to appear in it. A person's row says whether they
are *online*, *away* (their browser tab is in the background) or *playing* (seated at a table), and which
games they will accept. The only way off the list is **Appear offline**, the first switch at the top of the
lobby: it is saved on your account on the server, so it holds across a reload, and while it is on you are
in nobody else's roster and no request reaches you (and you cannot send one). Turn it off to be listed
again.

**Taking requests** is two rows of switches under it: one master switch, and one switch for each of the
nine games the server can seat (Connect 4, Reversi, Checkers, Gomoku, Chess, Go, Hex, Breakthrough, Sea
Battle). The master switch gates everything; the per-game ones say what you will play. Both are saved on
the account, and the line under them names exactly what you are taking requests for.

The Hall is what makes **ask a person to play** work: you set which games you are open to, someone on
your roster asks you for a game (**Ask**, offered only to someone online who accepts a game you also
take), you accept, and both of you are seated at a private table — no code to paste. When you are not
signed in, or online play is off, the Hall is simply closed and the roster empty.

The lobby is a **side panel** with the panels it needs and no more: on the Games screen it is
`minmax(220px, 280px)` wide, enough to type a sentence in its chat box, and the game cards use
`minmax(min(100%, 200px), 1fr)`.

## Find a match

**Find match** is in the lobby panel, and it is **chips, not a button that guesses**: one chip per game
plus **All games**, and nothing is picked for you. Press the games you want (one, several, or All games)
and the lobby starts looking for exactly those; press a chip again to stop looking for that game, press
**Stop looking** to stop altogether. The chips read back what the server is looking for, so a chip can
never claim a game the lobby was not told about, and find match stays on — with Hermes closed to the lobby
panel, across a reconnect — until you stop it or you are seated.

While it is on, the server pairs you with anyone else who wants the same game *right now*: someone else
looking for it, or someone who is simply open to requests for it. Only people who are online, visible and
**not already at a table** are paired — nobody seated in a game is invited to another one, and they stay
listed as *playing*. A pair is offered **one** match at a time, and a pair that declined one is left alone
for ten minutes.

The offer reaches **both** people the same way, as a dialog — *"Bea wants to play Connect 4 — Join / Not
now"* — with a dim grey line beside the roster saying the same thing (Game Center draws that line itself:
it is **not** a chat message and is never sent to your model). Either person may press **Join**; that seats
both at the same private unrated table inside Hermes, by the same path a request takes.

## Your name and your recovery key

Online identity is a display name plus a **recovery key**, the same scheme the website uses, so one
account works in both places.

- **Create my player** picks a new name and shows the key once, with **Copy recovery key**. Save it
  somewhere safe: it is what signs you in on another computer or in a browser.
- **I have a player** signs in with a name and a key you already have.
- **Change my name** renames the account on the server (one rename every 30 days). A name someone else
  holds, or one changed too recently, is refused — and the card shows the server's own sentence, word for
  word, rather than a re-worded copy of it.
- **Show my key** reads the key back out of Hermes's credentials, masked until you press it, on **this**
  computer only: another computer asking the same Hermes gets a sentence, never the key. **Save my account
  file** writes `GameCenter-<name>.json` with `name`, `key`, `server` and `saved_at` into your Downloads
  folder and tells you the path.
- The key is stored through **Hermes's own credential route** — the same `.env` store and secret scope a
  provider API key uses, as `HERMES_GAMESHELF_LOBBY_KEY`. It is never written to Game Center's own files,
  never put in a log, and never part of the page's state (the view reports only whether a key is present).
- If a Hermes build has no credential route, the key is not kept at all: the dock says so and asks you to
  paste it into **Plugins → Game Center → Online recovery key** (a `secret` field in the manifest).
- **Sign out** removes the key from this computer. It does not delete the account.

## Find a match online: the rated queue

This is the other way into a game with a person, and it is the **wait pane's** own path, not the lobby's:
**Find a match online: <game>** puts you in the server's queue for the game the pane is on. The pane then
says "Looking for a … match" and keeps looking while you use Hermes.

When someone else is waiting for the same game, the dock says **"Your table is ready"**, names the
opponent and your colour, and **Play here** opens that room inside Hermes — the board is the one the
lobby server sends for your seat, you move by clicking it, and every move goes back to the server as
that table's own command. There is no local game behind it and nothing here guesses a move: the board
shows what the table has taken. **Open in browser** stays beside it as a small link to the same room on
the website, where the clock lives. **Not now** dismisses the line on this computer (the table itself
stays open on the server).

## The table's chat

On the table inside Hermes, **Table chat** sits beside the board (under it in a narrow window). It shows
the **last 50 messages** the server has for this seat — the same list the website's table chat draws, with
who said it and whether they are a player, the host or watching.

- Type in the box and press **Send**, or just press **Enter**. A message is capped at **300 characters**,
  the server's own limit.
- A line appears when the table has it, never on the key press: what you type comes back on the table's
  own feed like anybody else's message, so the panel never shows a message the server did not take.
- A message the server refuses — too fast, muted, silenced — says so in the panel, in the server's words,
  and the words you typed stay in the box.
- While the table is reconnecting, the box is closed; the chat is a conversation at this table, not a
  channel of its own.

Chat is the one thing here **you** write that leaves this computer. It goes to the same lobby server as
your moves, only while you are at a table, and only when you press Send or Enter.


## What each game draws online

The online table draws **the same table the game draws on this computer**, from one switch: blackjack is
the card felt, Sea Battle is the two fleets, backgammon is its own points and bar, and every grid game is
the one board. A game with no online renderer yet says *"This game can't be drawn online yet"* rather than
drawing an empty board, and Go keeps its **Pass**.

**Blackjack online is two people each playing their own hand against the dealer** — not a white-versus-
black match. The host sits in the first seat, the second person takes the seat beside it (between hands,
never mid-hand), and each keeps **10,000 chips of their own inside the table**. That stack is nobody's
Jackpot wallet: an online table never spends, wins, refills or even opens a wallet file, so a stranger at a
lobby table cannot touch the chips on this computer. The move on offer belongs to one person at a time —
the table refuses a press from the other seat and from a watcher — and a finished hand settles back to
betting with the table still open. There is no resign at a session table: **Close table** puts it away.

**Slots online opens your own machine** and says so in one line (*"Side-by-side Slots online is coming;
this is your own machine."*); playing the machines side by side is not built yet.


## Alerts

Per game, off by default: *"Tell me when someone online wants this game"*.

- The server holds a **ten-minute cooldown per game**, so you cannot be told more than once per game every
  ten minutes even if the queue keeps filling.
- The dock also refuses to tell you **twice for the same alert**, and suppresses alerts entirely while
  you have a table waiting or a game running.
- The alert appears as one line on the Lobby tab and one silent system notification, and the line clears
  when nobody is waiting for that game any more.
- Polling only happens while the page (or the dock's badge) is open: the lobby every 15 seconds, the queue
  every 15 seconds while you are queued, alerts every 15 seconds while at least one game has them on.
  After a failure it waits 15, then 30, then 60, then 120 seconds before trying again.

## Your chips and points

Blackjack and the slots keep your play-money in one wallet on this computer. While online play is on and
you are signed in, Game Center tells the lobby **your chip and point totals** — and nothing else about the
wallet: no spins, no bets, no history, no feed.

- It is **self-reported**: the numbers come from your own wallet file and the server simply keeps the last
  pair it was told, plus a short list (the last 100 changes) so a later migration can move them. It is
  never read back into a game, never shown on a leaderboard, and never used for a rating or a match.
- **One note, when it changes**: nothing is sent while the totals are the same, and never more than once
  every 30 seconds. A write the server refuses is simply dropped; nothing waits for the answer.
- **Nothing is sent while online play is off**, and everything about chips and points keeps working when
  the server is down. The wallet itself is only ever *read* by this route — see
  [SECURITY.md](../SECURITY.md).

## The bot ladder

> **Off the pane for now (2026-11-11).** The pane no longer offers the ladder, and neither does it offer
> *Enter the open league*: rated bot-versus-bot works against the lobby server but is not proven end to
> end, and it belongs with Champions. The routes below are unchanged — this is a UI gate in the plugin
> (`PANE_LADDER_OFF`, `PANE_LEAGUES_OFF`, with both blocks kept in the bundle behind a dated
> `FUTURE(2026-11-11)` note) — so turning it back on is flipping one line, not rebuilding it.

**Enter ladder** is a two-press door on purpose:

1. The first press asks the backend for an **estimate**: how many model calls one rated game is likely to
   take on this computer (one per move), that the table allows 15 seconds a move, roughly how many minutes
   that is, and that only the move your model picks is sent.
2. **Start ladder game** is the second press. Nothing is sent and no model call is made before it.

What runs where:

- Your **champion** (from Champions) or **your agent** plays as your own **bot**, with its own bot name and
  bot key — a separate credential (`HERMES_GAMESHELF_BOT_KEY`) made once and reused.
- The bot connects to the ladder with the bot protocol in [BOT-API.md](BOT-API.md): one WebSocket, an
  `auth` message, a picture of the table per turn, and one `move` per turn.
- The **model call happens here**, on your machine, through the same model slot as the rest of Game
  Center (Settings → Models → *Game Shelf opponent*). It is given the board and the list of legal moves
  and asked for one of them. If the model is slow or answers nonsense, the dock plays a legal move rather
  than forfeit on the clock, and the status line says how many calls were made.
- Only the chosen move leaves your machine.
- **Rated** games need two bots from **different owners**; the same pair can play three rated games a day;
  a game needs at least two plies to be rated, and it is rated as a **pair** (two legs, seats swapped).
  If no other bot turns up within ten minutes, nothing is played and nothing is used up.
- **Enter the open league** from the Lobby's Bots and leagues area instead, and the same game is played
  with a thirty-second clock and the **self-hosted, unverified** label.

## Ranked games, and why they are played twice

Only games where the better player usually wins are rated: **Go, Hex, Breakthrough, Reversi, Chess,
Doctrine, Doctrine Arena, Liar's Dice, Mafia, Prisoner's Dilemma and Auction** (Auction joins when the
server can referee it). **Connect Four, Checkers and Gomoku are casual only**: they are still fun,
they just never move a rating.

Every rated match is a **pair** — two tables, the **same seed and deal**, with the **seats swapped**. You
play white in one and black in the other. When both legs are in, **one** rating change follows the pair
(most leg wins; a 1–1 split is a draw). A single table — a private invite, a lesson, a bot you brought
yourself — is a friendly game and never rated.

The dock says where you are: *"Leg 1 of 2 · same deal, seats swapped"* on the table, and the ladder plays
both legs by itself. If you leave one leg unfinished, the pair simply never rates.

## Bots and leagues, in the Lobby tab

> **Off the pane for now (2026-11-11).** The pane's Lobby tab no longer draws this area — leagues, watching
> a live table and bot passports all work against the lobby server, but watching leaves Hermes for the
> browser. The **Stock league**'s **Read the design** is hidden with it. Both are UI gates
> (`PANE_LEAGUES_OFF`, `STOCK_LEAGUE_OFF`) with the blocks kept in the bundle, so the lobby server answers
> exactly as described below and bringing the area back is flipping one line.

The Lobby tab carries a **Bots and leagues** area (badged *Labs · experiment* in Phase 1):

- **Waiting for your bot** — invitations someone sent your bot, with **Decline**. Accepting means bringing
  your bot to the table from its passport.
- **Watch a game** — live bot-versus-bot tables, with **Watch** (opens the live table in your browser;
  watching is read-only). Only rooms where both seats are bots are listed, never a room with a person in it.
- **Bot passports** — every bot with a rated game, its owner, its best rating, and **Challenge**. A
  challenge opens an unrated table, sends a ten-minute invitation to the bot's owner, and has to be
  answered by their machine. Same-owner challenges are refused.
- **Card arena** — your saved Doctrine / Doctrine Arena cards, each with a rating. **Play a bout** picks
  another owner's locked card and the **server** plays the battle on its own engine (same cards, same
  seed, same result), rated per card, with a replay you can read here.
- **Open league** — rated play where the decision comes from each owner's own computer. The server only
  referees and keeps the clock, so the seat cannot be checked: **self-hosted, unverified**. The clock is
  30 seconds a move instead of 15. Liar's Dice, Mafia, Prisoner's Dilemma and Auction join when the server
  has a referee engine for them; the pane says so instead of pretending.
- **Stock league** — *Labs · experiment · needs a server-side model*. **Read the design** shows what it
  needs and the first step. It is designed and stubbed, not built; see [STOCK-LEAGUE.md](STOCK-LEAGUE.md).

## Replays

Every finished leg and every card bout leaves a replay on the server. A table's match has a plain move
list (`GET /api/matches/{room}/{number}`), and a card bout has its whole battle
(`GET /api/card-arena/{bout}`) — the same cards and seed always replay to the same battle.

## When the server is down

One plain sentence: *"The online lobby cannot be reached right now. Everything here that runs on this
computer still works."* The local lobby, the nine table games, lessons, hints, Review my game, champions,
tournaments, quick games against the computer and your own agent all keep working, exactly as before.
Nothing is retried in a tight loop; the backoff above applies.

## The lobby posts

Lobby chat (the website's **rail**, and the **#games** column in Hermes) is kept for **thirty days**, the same
as a table's chat, and in Hermes the column is the lobby's chat and nothing else: signed out, it asks you to
sign in instead of keeping a private copy. When two computers cannot see each other, **Check online** on The
Hall (or `/games online check`) shows each step to the lobby and which one needs fixing. Every line shows the
date and time it was written. The server's own housekeeping **deletes** a line older than thirty days rather
than only hiding it (the same janitor that expires requests and closes idle tables sweeps them), and a line
read back by the client is dropped if it is older than that or carries no time at all. Keeping chat and
listing tables are separate: an open table is still only in the lobby for a day.

## What is never sent

- Your chats with Hermes, or any local file.
- Your model, its provider credentials, or its key.
- Your local game history, lessons, champions, tournaments or ratings.
- Telemetry, analytics, crash reports or usage counters of any kind.

## What the server does see

The display name you pick; your recovery key when you sign in; the game you are waiting for and your
rating for it; queue status; the moves you make in online tables; the messages you type at a table; for
the ladder, your bot's name, its moves and its rating; and your own chip and point totals, as this
computer reports them (kept only for a later migration — never a leaderboard). As with any web service,
it also sees your network address and the time you connected.

## Limits worth knowing

- 4 KiB per WebSocket message, 12 commands per 5 seconds, 300 characters per chat message.
- Queue asks are rate-limited per player (30 a minute), which is why the dock polls at 15 seconds.
- Balance notes are rate-limited per player (one write every 10 seconds); the dock sends at most one
  every 30 seconds and only when the totals changed, so that ceiling is never reached in normal use.
- Three bots per account; names stick for 30 days between renames.
- A leaderboard asks for one of two pools — `humans` or `bots`. Anything else is refused, so a
  mistyped link shows an error instead of somebody else's board.

## Where the server lives

The lobby server is in this repository under [`online/`](../online/README.md). It is not part of the
published plugin: the plugin only speaks its documented HTTP and WebSocket API, so it works against the
public service or any self-hosted copy.
