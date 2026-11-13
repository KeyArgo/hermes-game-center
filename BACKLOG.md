# BACKLOG — ideas noticed but not done in this lane

## Where games live (IA lane)

- **Before release: the submission page must exist.** "Submit your game" opens
  `https://games.hermesnet.xyz/submit` (the `submit_url` setting's default). That page is not built
  yet — by design, this lane only wires the button and the guide. Either publish it or set
  `submit_url` to `""` (which shows the `submit_docs_url` guide link instead) before the plugin goes
  out.
- **agent-hold-em's Desktop route is unconfirmed.** It is the first entry in `shelf/known.json`, but
  the plugin is not installed on this machine, so its real route could not be checked. The entry
  ships with an empty route on purpose: the card says the screen "has not been checked yet" and no
  Open is offered. Fill the route in only after opening it by hand; never guess one.
- **`/games install` now only affects chat.** The page has no Get shelf any more: an installed
  plugin's game is in Your games immediately, and Play is curated. That leaves `install`/`remove` as
  chat-library verbs only. Either give them a place on the card ("add to chat") or retire them.
- **Your games has no search-independent order.** Cards follow plugin scan order. A per-person
  ordering (most recently opened first) would be friendlier once someone has several plugins.
- **A curated game from another plugin is untested.** `play_cards()` would show a curated id from any
  installed plugin, and its Open button would try Game Center's table. Every curated id today ships
  with this plugin, so the path is dead code; if an outside game is ever curated, it needs its own
  screen or a real table adapter first.

- **Mac bundles for the new launch cards.** Doom knows its macOS `.app` paths; OpenTTD, Luanti,
  Wesnoth and OpenRA are only looked up on `PATH`, which a cask install does not always provide.
  Their bundle paths were not added because they could not be checked on this machine without
  installing the games. The same holds on Windows: the OpenRA installer drops the game in Program
  Files without adding it to `PATH`, so a person must put its folder on `PATH` before Play can find
  it; the card's hint says so. (Doom's `mac_apps` are the only bundle paths this plugin knows.)

- **Tank Royale (Robocode Tank Royale, Apache-2.0) has no card yet.** It needs Java 11 or newer,
  and neither documented start is one fixed command:
  - the Linux native installer (`.deb`/`.rpm`, built with jpackage) puts the game in the application
    menu as **Robocode Tank Royale GUI** and installs no program on `PATH`;
  - the portable release is started as `java -jar robocode-tankroyale-gui-<version>.jar`, where the
    version is part of the file name.

  A card built on either one would guess a path or a version, so none ships and nothing of Tank
  Royale is bundled. The later route: let a launch card carry a leading argument list plus a jar
  name to search for (in `launchkit.py`, which other cards share), then add the card with the
  Java 11+ requirement in its install hint. Its Bot API is a separate package for people who want
  to write bots; Game Center's own agent seats are unrelated and must not be wired to it.

- **Doom port order vs Freedoom 0.13** (owner decision): the task fixes the detection order as
  `gzdoom, chocolate-doom, crispy-doom, prboom-plus, dsda-doom`, so Chocolate Doom (a vanilla,
  limit-removing-free engine) wins over Crispy Doom when both are installed. Freedoom 0.13 needs a
  limit-removing engine, so that combination can fail on vanilla limits. Either reorder Crispy ahead of
  Chocolate or skip vanilla engines for Freedoom once the task's order is no longer binding.

## Doctrine (not done in this lane)

- **Watch speed is one setting.** Doctrine's replay auto-plays at the same 900 ms as every other watch
  mode. A per-person speed control (or step-only) would be a nicer way to study a battle.
- **Card balance is tight.** Iron Vanguard is close to the strongest house card: 120 random weight sets
  only beat it 6-4 over ten seeded games at best. More archetypes or a per-match handicap would give
  "Improve my bot" more room to show a real gain.
- **~~Profile authoring runs the Hermes CLI.~~** Done (review, 2026-11-12): `doctrine author <name>` writes
  the card through `ctx.llm.complete` — text only, no child process, no tool set. (Quality review,
  2026-11-13: the input is a **signature**, not a profile — the name is validated as one name and written
  into the card as its author, and every surface says "signed" rather than claiming a profile ran.
  `tests/test_doctrine.py` pins that no subprocess is left in the authoring path.)
- **The import door is Doctrine-specific.** `POST /doctrine/import` exists because `/command` caps a line
  at 300 characters and a replay is ~40 KB. Other card games that share files will want one general
  import route instead of a per-game one.
- **Improve compares only against the current card.** It plays five seeds in both seats, which is enough
  to keep a regression out but not enough to rank a card on the ladder. A wider seeded suite would make
  the accept/keep decision steadier.
- **Review My Game → Rematch and the series score** (needs `kit.py`, outside lane/t5's files): after
  a review lesson passes, the Desktop's Rematch starts a new game with `allow-ai`, which resets
  `score` to 0-0. `kit._rematch` would keep the score, but `kit.py:296` refuses `rematch` while
  `state["lesson"]` is set, and the review is a one-step lesson. Either let `rematch` through when the
  lesson is a review (a `custom` step) with `lesson_done`, or carry `score` through `_new` when the
  previous table was a review of a finished game.
- **Review board drops the opponent kind** (`kit._review`, outside lane/t5's files): the review state
  always seats the other side as `local`, so a page cannot tell a game against your own agent from one
  against the built-in player. The Desktop remembers it for the session; after a reload the rematch
  falls back to the built-in player. Storing the reviewed opponent (e.g. in the review state) would fix
  it properly.

## Doctrine Arena (real-time, lane/rt)

- **You cannot pick your three opponents for a 4-bot battle.** `doctrine-arena ffa` always fields
  the same three house cards in seat order (`doctrine_arena/game.py`), and the store's "Four-way"
  button has no follow-up. A `ffa seed=7 seats=Bulwark,Sniper,Bruiser` form (and a small picker in
  the panel) would let a person deliberately set up the matchup they want to watch.
- **The arena panel is a viewer only.** `desktop/plugin.js` shows the canvas, the score line and
  Replay; your card is chosen and edited from `/games doctrine-arena card …` commands. The four
  house cards are invisible in the Desktop until you type `cards`. A row of four card buttons in
  the arena card would make the strategy-card idea obvious without a command line.
- **Arena replays have no step control.** They auto-play at the shared 900 ms watch speed and can
  only be replayed from the start. A Step button and a scrub bar (the replay is a plain frame
  array, so this is easy) would help someone see *why* a tank lost.
- **The arena and DH's Doctrine share a name root only.** Both have a versioned JSON card and a
  seeded deterministic engine, but nothing is shared in code: `doctrine/` is hex/turn-based,
  `doctrine_arena/` is live ticks. A later pass could put the card *validator* in one place so the
  whitelist/bounds rules cannot drift apart between the two games.
- **The engine is pure Python and runs the whole battle inside one command.** A 31 s 4-bot battle
  is ~1900 ticks and simulates fast, but a much longer match or a much bigger arena would want a
  tick budget so a single command can never hold the shelf for long.
- **`shelf` package name is still claimable** (design, not this lane): games and `kit.py` now load
  `kit.py` by path, but `kit._shelf()` imports `shelf.<name>` through `sys.path`, so a plugin that
  ships its own top-level `shelf` package (in a folder earlier on `sys.path`) could be imported
  instead. Loading the shelf modules by path, or namespacing them, would close the same class of
  collision as `kit`.
- **Optional part of plan 4.2 not done** (by design, only if T7 were green by Nov 8 noon): a short
  hand-kept list with `agent-hold-em` as an Open card, and opening the marketplace page with
  `ctx.os.openExternal` for games that are not installed. Also unverified: what `host.navigate` does
  for an unknown route, which matters before any hand-kept route list is published.
- **Improve my bot shares the 20 s model limit.** It now goes through `kit._bounded` like every other
  seat (that is the point), but it asks for up to 900 tokens of JSON rather than one move, so a slow
  local model can time out twice and the old card is kept. A longer per-call limit for Improve
  (`_bounded(ask, prompt, seconds=…)`) would be the fix; the guard's shared limit is deliberate for now
  so no model call can hold the shelf open.

- **The opponent chooser still needs named Hermes profiles / champions.** `dashboard/plugin_api.py:_opponents`
  lists "The computer" (built-in player, now at Easy / Normal / Hard) and "Your agent" with the model from
  the `Game Shelf opponent` slot. Named profiles come with CH; the page already renders extra entries the
  moment they arrive, so this is data, not UI.
- **Go has no third level.** Go's built-in player judges one move ahead at every level, so Easy/Go differs
  only by the kit's seeded noise; Hard is the same player as Normal. A real win needs an influence or
  territory lookahead before "Hard" means anything in Go.
- **Hex's Hard lookahead is one opponent reply over the top ten candidate moves**, not a search. A proper
  two-ply over more candidates would cost more than the table's patience, so this is a deliberate ceiling.
- **The chosen level is not shown on the game card in the store**, only on the table and in the chooser.
- **`test_lessons_hints.py::test_hint_keeps_the_move_when_the_model_fails` is timing-flaky.** It sets
  `kit.AGENT_SECONDS = 0.05` and asserts the hint returns in under 0.4 s of wall clock, which fails about
  once in a few full-suite runs on a loaded machine (it passes alone in ~1.4 s). A monotonic budget passed
  into the guard, or a wider margin, would make it deterministic.

## From the open-source survey (open-source survey)

- **Write our own perfect Connect Four solver.** The well-known one (Pascal Pons) is AGPL-3.0, so it
  cannot be used, but the algorithm is public knowledge (negamax with a transposition table and a
  bitboard). A 7-ply bot is already there; a solver would make "The computer" unbeatable on Easy's
  opposite end. Not before the freeze.
- **A stronger Go bot.** KataGo is MIT but is a C++/CUDA engine and a neural-network weight file, and
  gomill is Python 2 only. Nothing permissive and small enough to vendor exists, so the only route is
  our own search over the existing 9×9 rules.
- **Checkers rules from pydraughts (MIT)** if our checkers rules ever have to change. It was a no for
  now on purpose: it brings its own move types and notation, and swapping the rules under a game whose
  replay, lessons and Review all read our move strings is the one risk this lane was told to avoid
  before the freeze.
- **A second piece set as a choice.** Maurizio Monge's fantasy / celtic / spatial sets are MIT and would
  vendor the same way chessnut does (`vendor/<set>`, `tools/chess_pieces.py`, one test). It is a feature,
  not a fix, so it waits.
- **Revisit chess.js only if the page ever has to judge moves offline.** Right now the Python rules are
  the single authority and the page replays the server's legal-move list; a second engine on the page
  would be a second authority, and that was rejected.

## Champions and tournaments (not done in this lane)

- **Profile brains.** Hermes's plugin LLM surface has a per-auth-profile override (`llm.profile_override`),
  which picks credentials, not an agent's persona/model; there is no supported public way for a plugin to
  run a model call *as a named Hermes profile*. Champions therefore use this Hermes's model only. If
  Hermes later adds a supported "call as profile" door, add it as a third brain kind behind its capability.
- **Per-champion models in Open Division** are attempted and fall back to the shared model when the host
  has not granted `llm.model_override`. Declaring that capability in `plugin.yaml` (with the consent screen
  that implies) would make Open Division's "any model" literal; it was left out here because it changes
  the install consent for every person, not just tournament players.
- **Champion files as Hermes profile archives.** `hermes profile export/import` exists; a champion could
  also be exported in that shape once a supported plugin API for profile-shaped files exists.
- **Doctrine drafting.** A champion picks one of the four house cards in one model call. Letting the brief
  drive a full card (eight weights) would make Doctrine a much deeper tournament game.
- **Tournament resume.** A tournament that is stopped or crashes keeps its finished games, but there is no
  "continue from here" button yet; starting again replays the whole fixture.
- **Ratings decay and provisional ratings.** Every entrant starts at 1500; a champion with two games can
  outrank one with forty. A provisional flag (K=40 for the first ten games) would be fairer on a fresh
  ladder.
- **Leave a seat after the game ends.** "Leave seat" is only rendered while a game is active, so a seated
  player on a finished table has no way to vacate it from the winner screen; Rematch and Back are the only
  exits. A small "Leave seat" on the result card would free the seat without starting a new game.

## Talking tables (not done in this lane)

- **A Play contract for talking tables.** Task IA landed `shelf/curated.json` and `tools/check_game.py`,
  and the four talking games are not in Play. The checker's Play contract is a two-colour table game: it
  requires `kind: "table"` and a `rules` object (`fresh, legal, play, bot, show, parse`) whose bot-versus-bot
  seeds finish with a winner in `white`/`black`. A talking table is the opposite shape — 2 to 10 seats,
  hidden roles, simultaneous choices in a round robin, phases that are not turns — so making one pass would
  mean writing a fake `rules` module beside the real engine. The checker is IA's file and was not widened
  here. Next step: a second branch in `tools/check_game.py` for `kind: "play"` that drives the game's own
  `command()` the way the browser does (bot-only finish over seeds, a reveal, a saved file that replays),
  then add the four ids to `shelf/curated.json`. Until then they sit in Your games, which is honest but
  buries the lane's headline feature one screen down.
- **The Your games line understates talking tables.** The card in Your games says games there "stay out of
  lobbies, tournaments and ratings", but a champion on a talking table does reach `ratings.json`. The line
  lives in `shelf/catalog.py` (`_your_line`), which belongs to task IA, so it was not edited here; it needs
  a `kind: "play"` variant that says "no lobby; champions and ratings still count".
- **More than one person at a talking table.** Every game is built for one person plus machines. Two people
  in the same room would need a second screen-side seat and a way to hide each seat's view, which is a
  different screen, not a flag.
- **A talking table inside a tournament.** Champions can take seats on a talking table and their results
  reach `ratings.json`, but `shelf/tournament.py` only knows two-seat board games (`play_match` with a
  `rules` module), so a champion round-robin across talking tables is not offered yet.
- **Reasoning models and a small budget.** The local model spends most of a 300-token budget thinking and
  sometimes returns an empty message; the table covers that turn with the built-in player. A host-side
  "answer only" mode, or a per-call budget the game can raise, would cut the covered turns.
- **Watching is silent.** A bots-only table steps every 900 ms with no pause or speed control; a watch
  speed (and a step button) would make a Mafia game easier to follow.
- **One import door per game.** `POST /talk/import` serves four games. A general `/games/import` for any
  game that shares files would retire both it and the Doctrine-specific route.

## First run and quiet match alerts (not done in this lane)

- **The alert source is this Hermes only, on purpose.** `shelf/setup.py:looking_now()` is the one seam
  the online design (task ON) plugs into. Until a website source returns the same rows, "someone wants a
  match" means people on this Hermes referee and the chats it shares; every piece of wording says so and
  nothing in this build calls out. When the online lobby lands, add a second source there (and a
  `source` field per row) rather than a second function.
- **Two copies of the name word filter.** `shelf/who.py` now owns the list that ships (`online/` is out of
  the published plugin), while `online/guard.py` keeps its own for the server. When online is published
  from this repo, move the list to one module both import — two lists drift.
- **The welcome is shown once for everybody, including existing installs.** Someone who already had a
  name still sees it after upgrading. If that proves annoying, seed `seen` for a data folder that already
  has `players.json`.
- **The dismiss rate limit is a constant (30 minutes).** Make it a setting if people want to be told again
  sooner (or never).
- **The badge rebuilds the shelf every 5 s** to turn `connect4` into "Connect Four" (about 47 ms a poll on
  this machine). A small cached id→title map would remove it, and would also make the badge cheap enough
  to poll on a slower laptop.
- **Join opens the table and stops there.** With no networking there is no one to connect to; when the
  online lobby is wired up, Join should offer that person's table (host address, or the website) instead
  of only the local one.
## Play while you wait (WW lane)

- **The online source for Find a match.** The pane's search is the local lobby today
  (`/games looking <game>`, the same list the full page reads). When the online matchmaking
  function from the FR lane lands, add it as a second source behind the same button and keep
  the local list as the fallback.
- **`revealPane` and `runAction` are not in the published SDK page.** The pane is opened with
  `host.revealPane('hermes-gameshelf:pane')` and "Back to chat" uses
  `ctx.runAction('composer.focus')`; both exist in the installed desktop source
  (`apps/desktop/src/sdk/index.ts`) but neither is named in
  `website/docs/developer-guide/desktop-plugin-sdk.md`. They are both feature-detected, with
  `host.navigate('/')` and the layout reveal event as fallbacks. Ask upstream to document them,
  or move to a documented door when one exists.
- **No documented approval state in `host.state`.** The pane learns about an approval from the
  gateway event stream (`approval.request` / `approval.settled`); there is no
  `host.state.awaitingApproval` atom. If one is added, read it instead of the events.
- **The badge polls while it is on.** `PaneBadge` asks `/view` and `/board` every 12 s, but only
  while a game or an alert is saved. A cheap push (a plugin socket frame on turn change) would
  remove the timer.
- **Pane width the board likes.** The board is width-driven (`BoardSvg` keeps its aspect ratio),
  with a 300 px cap. It was proved at 400 px of page width; the 300–560 px range the pane
  declares deserves a look on a real Desktop with the chat column beside it.
- **Notification delivery is unknowable.** `ctx.os.notify` returns nothing (and is documented to
  fire only while Hermes is backgrounded), so the pane records a turn as "told" even when the host
  suppressed the notification. A `Promise<boolean>` or a delivery event on that door would let the
  badge keep the turn unread until it was actually shown.

## Online play and the bot ladder (LP lane)

- **Live tables stay in the browser.** When the queue finds a table, the dock names the opponent and
  hands the room to the system browser; playing inside the pane would need the backend to hold a
  room WebSocket and proxy every move (the ladder already does exactly that with `shelf/ws.py`, so the
  door exists). This matches the owner decision recorded in T8 ("live human games open on
  games.hermesnet.xyz through the existing external link") and avoids a second board renderer.
- **No bot key rotation or deletion.** The ladder bot is created once (`HERMES_GAMESHELF_BOT_KEY`) and
  reused; the server can suspend or delete a bot, but the plugin has no button for either. A "forget my
  ladder bot" row next to Sign out would make the one irreversible-ish step visible.
- **Challenging a listed bot is API-only.** `POST /api/ladder` accepts `{game, white, opponent}`, and
  `shelf/online_source.ladder_challenge` uses it for the proof, but no UI lists the bot leaderboard to
  pick an opponent. The queue is the only route a person can take from the dock.
- **The ladder plays the first legal move when the model is slow.** The table forfeits a silent bot after
  15 seconds, so a call that misses the deadline (12 s) is replaced by a legal move rather than a loss.
  A preference ("stop instead of moving for me") would be more honest for people who care about the
  rating.
- **Online identity is separate from the local `/games` name.** The pane can say "You are Browser QA"
  (this Hermes's lobby name) and "You are Proof Ada online" at once. They are different namespaces on
  purpose (the local lobby is per-profile, the online one is the server account), but one sentence
  explaining that would help.
- **`online/web/sdk-shim.js` is a hand-kept copy of the SDK's named exports.** The website loads
  `desktop/plugin.js` as its board drawing, so every name the module imports must exist in the shim; a
  missing one leaves the site on its boot screen (this happened when the pane added `PANES_AREA` and
  `useValue`, and is now pinned by `tests/test_online_site_assets.py`). Generating the shim from the
  module's import list, or publishing the SDK's door list as data, would remove the trap.
- **The queue's public rate limits are tight for one address.** 30 queue asks a minute per player and
  120 API requests a minute per IP are fine for one person, but the local proof has three clients on
  127.0.0.1, so both the test and the proof server lift the caps. A "same machine" note in
  docs/BOT-API.md would save the next person the 429.
- **A queued person stops polling when the dock closes.** By design, the online source only polls while
  Game Center (or the dock) is open, so a match found after the dock is closed waits on the server until
  the pane is reopened or the entry expires (ten minutes). A background poll or a server push would make
  the queue survive a closed pane, but both go against "poll only while Game Center is active", so this
  is recorded rather than built.
- **Opening the table does not sign the browser in for you.** The match line opens the room in the system
  browser, which has its own session on the website; the dock now says so and tells the person to sign in
  there with the same name and their recovery key. Carrying the identity across automatically would mean
  putting the recovery key in a URL, which lands in browser history and the server's request log — exactly
  what the credential-only rule forbids. A short-lived, single-use hand-off token minted by the lobby and
  accepted by the room page would solve it properly; it needs a server endpoint, so it is recorded here.

## Splitting the desktop module and the dashboard API (CU lane)

- **The dashboard API is still one file.** `dashboard/plugin_api.py` is ~1,500 lines and would read
  better as a package, but Hermes loads it with `importlib.util.spec_from_file_location` under a
  synthetic module name (`hermes_cli/plugin_host_child.py`, `op_asgi`), so there is no package for a
  relative import to resolve against. It already bootstraps `sys.path` once for `shelf.*`, which is
  why the Python side is split and this file is not. A safe split needs either a single importable
  package on that path (for example `dashboard/gameshelf_api/__init__.py` re-exporting `router`, with
  the manifest's `api` pointing at it) or an SDK change that loads the API as a package. Until then
  the file grows by area instead: routes in the same order as the page.
- **The parts are joined, not bundled.** `tools/build_plugin.py` concatenates `desktop/src/NN-name.js`
  in filename order. That keeps the plugin import-free at runtime and needs no Node at build time, but
  it also means a part cannot be loaded on its own in a test without the rest. A real ES module graph
  would need a bundler dependency, which the plan forbids; if the file ever passes ~10,000 lines,
  revisit that trade-off rather than adding a fourth layer of parts.
