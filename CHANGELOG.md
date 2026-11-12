# Changelog — Game Center

Versions follow `VERSIONING-STANDARD.md`: `plugin.yaml` names the release target, and every build
carries the real identity (version · commit · date · dirty) from `version_stamp.py`, surfaced at the
top of Game Center's Settings and at `GET /v1/version`.

## Unreleased

- **A flaky test is now deterministic.** The blackjack seating test dealt a random shoe; when a natural ended the hand early, the dealer's model was never asked to play, about one run in ten. It now deals a fixed hand.
- **The checkers strength test measures search, not the clock.** On a busy CI runner the clock-bounded expert could lose a seeded game; that test now runs the bot's deterministic node budget.
- **Corrected docs:** `SECURITY.md` lists all three hooks, and `LIMITS.md` counts eleven Play games.
- **The version chip tells a release from a development build.** A catalog install of the pinned commit, or a checkout at the release tag, reads `X.Y.Z`; any other build reads `X.Y.Z-dev`. `tools/release_check.py` and the release workflow keep the version, the changelog, the tag and the GitHub release in step.
- **Documentation:** a rebuilt README with a recorded demo and current Hermes Desktop screenshots, and a full docs set (usage, reference, architecture, configuration, troubleshooting, FAQ, development and testing).
- **Project files:** contributing guide, code of conduct, security policy, issue and pull request templates, and CODEOWNERS.

## 1.0.0 — 2026-11-11

First public release.

- **Eleven curated Play games:** Connect Four, Reversi, Checkers, Breakthrough, Gomoku, Chess, Go, Hex, Sea Battle, Blackjack and Slots. Each has seats, turns, a clear winner, a replay and a computer opponent.
- **A referee that says no.** Every move goes through the game's own rules engine, whether it comes from you, the built-in player or a model.
- **Your Hermes model as an opponent.** Give a seat to your own model. It gets the board and the legal moves and must answer with one legal move. Any provider works.
- **Play beside your work.** In Hermes Desktop, **Games** opens the graphical table, and a game can sit next to the chat while Hermes works.
- **Lessons and hints** on real positions, replayed through the game's own rules, so a lesson can never teach an illegal move.
- **Online play is optional and off by default.** One shared lobby with chat and play requests when you turn it on. Everything else works offline.
- **People play first.** A model calling the tool can never take a seat for someone. The other person joins with `/games <game> join`.

## Development history (before 1.0.0)

The notes below were written during development, before the first public release.

- **Game Center loads on Windows (owner's report, 2026-11-11).** A fresh Windows install answered every
  Game Center call with 404 "Plugin not found": `shelf/wallet.py` imported `fcntl`, which Windows does not
  have, so the backend never loaded. The wallet now takes the same one-byte `msvcrt` lock that
  `shelf/filelock.py` already uses there; Linux and macOS keep the identical `flock` path.
  `tests/test_windows_import.py` loads the dashboard API with `fcntl` blocked and moves chips through the
  Windows lock path.
- **Close Game Center sits top right (owner's ask, 2026-11-11)**, level with the Games / Champions tabs, and
  floats top right on the other screens instead of the bottom-right corner. The lobby column's name and
  chat boxes take the full width with their button under them.
- **Game Center page lobby column is only the lobby (owner's report, 2026-11-11).** The Lobby / Game tab
  row is gone: the Game tab was cut off at the column's edge and the page has no table of its own. A
  match the lobby makes shows as one card with **Play here** on top of the lobby; the name and chat rows
  wrap in the narrow column.
- **Sea Battle tells you when you sink their ship (owner's report, 2026-11-11).** The computer fires back
  at once, so your sinking shot arrived with its reply miss behind it and the banner spoke only the
  newest shot. It now speaks the biggest news among the new shots: a sinking, then a hit, then a miss.
- **Backgammon is hidden for now (owner's call, 2026-11-11).** It fails the game contract the other Play
  games pass (replayable dice, a Hermes model seat, lessons, ship-gate entry), so it is off Play and off
  every list: `backgammon/game.json` is renamed `game.json.future` (see `backgammon/HIDDEN.md`). Its code,
  the moving-pieces fix, the dice roll and the cover art stay for when it comes back.
- **Backgammon has a cover of its own (owner's ask, 2026-11-11).** Every Play tile draws its own
  board into the same 130 px stage, but Backgammon was the one game with no starting picture: its
  tile fell through to the dark stand-in scene an unknown id gets. `startingPicture('backgammon')`
  now hands back the standard opening position (the same one `backgammon/game.py` deals), and
  `coverArt` draws it with a new `backgammonCover()` — the table's own brown board, twenty-four
  points, the bar and the fifteen-plus-fifteen checkers, as a plain SVG with no controls and no
  clicks. The other games' tiles are untouched; a grid game still goes through `BoardSvg`.
- **One row of links out to the project on the Game Center main screen (owner's ask, 2026-11-11).**
  Under the header, beside **Experimental · Settings · Community creations**, sit three quiet links:
  **Report a problem** (the repository's new-issue page), **Contribute** (the repository) and **Add
  your own game** (`docs/SUBMIT-A-GAME.md` on GitHub). Each is the shared `textLink`, so a keyboard
  reaches it like any other control, and each click goes through the same `openInBrowser` door the
  Submit button and the community shelf already use — the address is handed to the person's own
  browser and nothing is ever framed or navigated inside Hermes.
- **The version chip is click-to-copy (owner's ask, 2026-11-11).** One press on the chip — or
  Enter/Space from the keyboard, the chip is now a real control with a tab stop — puts the full chip
  text (`v1.0.0-dev.N · YYYY-MM-DD · abcdef12`) on the clipboard through
  `navigator.clipboard.writeText`, with a hidden textarea and `execCommand('copy')` as the fallback
  where that door is missing. The chip wears **Copied** for 1.5 s and its tooltip ends with **Click
  to copy the version**, so a bug report can quote the exact build without anyone retyping it.
- **The side pane deals only against the opponent you name, and says who is thinking (owner's ask,
  2026-11-11).** Four findings from the pane-redesign review are fixed in one pass. **Start over** is one
  door with a real pair of radios inside it — **( ) Computer** and **( ) Your Hermes model** — with
  *nothing* pre-selected: **Start** stays disabled until a choice is made, the strength row
  (Beginner … Expert) belongs to the Computer choice, the shared searchable **ModelPicker** belongs to the
  model choice, **Cancel** keeps the game exactly as it is, and the sentence above the radios names the
  pick ("…deals a new one against your Hermes model.") — it can no longer say "the computer" for a model
  game. A **strength press only sets the strength**: it never deals and never resigns, so no game starts
  from a difficulty button. The wait line under the board is now written once, for the pane and the full
  table alike: a Hermes model's seat reads **"Hermes is thinking… 12s"** the moment the board says it is
  that seat's turn (the model works outside the person's own request), the built-in player reads
  **"Computer is thinking… 12s"** only while a reply is actually in flight and **"Waiting for the
  computer… 12s"** otherwise, another person reads **"Waiting for <name>…"**, and the count starts at
  **0s** so a wait never looks frozen. The model is still named on the "You vs …" chip and on the wait
  line's hover. Four controls the pane cannot honour are **off the pane**, each behind a dated
  `FUTURE(2026-11-11)` note with its code kept in the bundle: the **bot ladder**, **Bots & leagues**
  (leagues, watching, passports, the open league), the **online-alert checkbox** (its system notification
  is a no-op) and the **Stock league "Read the design"** stub. `tests/table_ui_harness.cjs` pins each:
  radios unchecked with Start disabled, the Computer choice dealing a computer seat, the model choice
  dealing an agent seat, Cancel sending nothing, a strength press dealing nothing, the pane's clock
  ticking past 0s, and the four hidden items absent. The full page's own "Choose how to play" panel is
  untouched: it names its opponent and its strength on the controls that start a game, so it carries no
  silent default — reordering it (online first) is the next slice.

- **The over-chat copy can be placed and coloured (owner's ask, 2026-11-11).** The panel that already
  holds **Show over chat**, **See-through** and **Size** now carries two more rows. **Position** is a
  **Left-right** and an **Up-down** slider plus a **Centre** button: both are offsets from the place
  the copy has always had — centred over the chat column — so the default is byte-for-byte the geometry
  it had before these sliders existed (the offset of 0 hands the old answer straight back), and the
  travel is clamped so the whole machine stays inside the conversation and never lies over the
  composer. **Colour** is six swatches (the cabinet's own teal first, the default) plus a hue slider
  and a **Gradient** choice of four — teal (the current flat frost), violet→teal, sunset, mono — which
  tints the frost, the border and the glow of the frosted frame. The tint is one static rule scoped to
  the cabinet's root element inside our own stage, so **the reels and the symbol art keep their own
  colours**, and it never touches the cabinet's text shadow: the tint only rotates the frame's hue at
  the frost's own saturation and lightness, and `tests/jackpot2_look_harness.cjs` measures that the
  cabinet's ink keeps **7:1 or better (AAA)** against every frost at every hue — the worst case is
  7.9:1. A **Reset look** button puts see-through, size, position and colour back (the over-chat switch
  is not a look and is left alone). All seven settings (`.overchat`, `.alpha`, `.size`, `.posx`,
  `.posy`, `.hue`, `.gradient`) are written through `ctx.storage` and read live, so the copy follows a
  slider with no reload, in the cabinet's panel, both Settings views and the status bar's switch alike.
  Nothing of the mechanism this feature floats on was changed: not the chat-column finder, not the
  mount. `tests/jackpot2_harness.cjs` pins the default geometry against the pre-existing answer, the
  clamp at the edges, the composer rule, the six swatches and the gradient, and that the colour default
  is the teal the cabinet already draws, to the last digit.
- **The side pane is "Play while you code", and the way in is one you can see (owner's ask,
  2026-11-11).** The right-hand pane and its command-palette command were named *Play while you
  wait*, and once × had taken the pane off the screen the only way back was Ctrl+K. Both now read
  **Play while you code** — the pane's own title, the strip's tooltip, the palette label and its
  keywords — while the internal ids (`id: 'pane'`, `hermes-gameshelf.wait`) are unchanged. Two
  doors now carry it: a button in the Game Center header beside the chips and points, and a
  status-bar item on the right wearing a small game icon and the same words while the pane is
  closed (it hides while the pane is open, and no version chip is added to the status bar). Both
  read one state, `paneOnScreen`, announced on the pane's own `gameshelf:pane-chrome` event — so
  ×, Minimize, the palette and the page handoff are followed at once — and both press the pane's
  own two functions: one press calls `openWaitPane()`, and while the pane is open the header
  button reads **Close side pane** and calls `closeWaitPane()`. New tests pin the rename, the two
  doors and the state they share (`tests/table_ui_harness.cjs`, `tests/test_play_pane.py`).
  `desktop/plugin.js` is built from `desktop/src/` with `tools/build_plugin.py`.
- **The Jackpot cabinet spins itself while Hermes works, says so, and shows what it pays (owner's ask,
  2026-11-11).** *"auto-spin is NOT working"* was true, and the cause was not the hook path: the shelf
  spins on it — one spin for each inference reply, one for each tool call — only while a machine reports
  itself on screen, and the only surface that ever did was the ORIGINAL copy over the chat
  (`19-jackpot-overlay.js` posts `/jackpot/visible`). With Jackpot v2 up — the wait pane, the Games page,
  or its own over-chat copy, and the original copy off — nothing reported visibility, so
  `slotplay.autospin()` refused every hook and the reels sat still through a whole conversation.
  Visibility is now per SURFACE: `wallet.set_visible(on, source)` keeps a named flag for each (`slots`
  for the original copy, `jackpot2` for the cabinet), `visible` is true while any of them is drawn, and
  an older wallet file with one boolean still reads as the original copy's. Closing one surface can
  therefore no longer switch the automatic spin off while the other is still on screen. Nothing else
  about the feed changed — the same three hooks, the same `shelf/autobet.py` stake sizing, no idle timer
  — and the cabinet carries the owner's sentence for it in full, with the same words as its tooltip. The
  **points** side is a choice now instead of an all-in press: a slider, a number and **Max** turn the
  slice the person picked into chips at the shelf's own rate (four points buy three chips, read off the
  payload's new `points_rate`, not a copy typed into the cabinet), a line under it says what spending the
  ranking costs, and a conversion is reported to `/api/balance` at once rather than at the next lobby
  poll. **What it pays** opens over the reels from the header: every combination and its payout at the
  bet on the table, jackpot row marked, generated from the live pay table the shelf is playing.
- **The win rate is the owner's number, and the return is on target instead of over it (owner's ask,
  2026-11-11).** Every machine now wins about half its spins — 0.50-0.52 of them pay at least the bet
  back — and returns its target rather than a number above it. Measured before the change: only 32.3% of
  a usual fruit9 session's spins gave the stake back (0.3484 with the machine's own strips, 0.3229 with
  the session's), and the solved returns were 1.1345 (fruit9) and 1.2231 (robot3) against a 1.10 target.
  The dilution is per reel now — one blank on every reel moves the hit rate about three points, wider
  than the two-point band the owner asked for, so the coarse ladder is refined by a blank on ONE reel —
  and the paytable is solved for the largest everyday multiple whose jackpot still stands 25% above the
  best everyday pay, after which the jackpot is solved to add exactly the remainder, rounded up so a
  session is never a chip under its own promise. Every pay in both tables is at or above the stake the
  paylines share, which is what makes the published hit rate and *"pays at least the bet"* the same
  number; the dead `7` row on the fruit reels (a symbol no strip carries any more) is gone with it.
  Measured after: fruit9 0.5025-0.5069 with a return of 1.1001, robot3 0.5033 with 1.1000, both inside
  the band for every session seed sampled, with the everyday pays alone above 1.0 so a session that
  never hits the jackpot is still ahead. `tests/test_slot_win_rate.py` re-derives the hit rate from
  `reels.result()` spin by spin and holds both numbers to the spec; `.q-autospin-report.txt` carries the
  before/after table. The acceptance test is the exact enumeration, deliberately: a 200,000-spin sample
  pins the hit rate (0.5031 fruit9, 0.5025 robot3, both against 0.5025/0.5033 enumerated) but cannot
  resolve the return to a hundredth on robot3, where one 981-chip jackpot in a few thousand spins is
  ±0.005 of the return on its own.
- **The automatic spin is the hook path, pinned (owner's ask, 2026-11-11).** `tests/test_jackpot_autospin.py`
  drives the real `register()` hooks — the reply spins, the tool call spins, the turn spins, a shut
  machine spins nothing while the points still count, and a wallet under the smallest bet spins nothing
  and loses nothing — and proves the plugin schedules no work of its own, so time passing cannot spin.
  `tests/jackpot2_harness.cjs` pins the cabinet's side: it reports itself on screen under its own name,
  reports when it goes away, never posts a spin of its own, carries both lines, and opens the pay table
  from the live answer.
- **The lobby is everyone who is online, and find match is the games you picked (owner's asks,
  2026-11-11).** Five things, one lobby. **(1) Everyone shows.** A signed-in person is in the roster from
  their first lobby connection — not because they queued, said hello or opened a page: the roster is the
  lobby socket (`presence.py`), and the Hermes connection is now kept up by *any* poll of the online side
  while online play is on, not only by the lobby page being open (`plugin_api._online_payload_unsafe`).
  The only way off the list is **Appear offline**, the first switch at the top of the lobby: it is saved
  per account (`availability.invisible`), the roster hides it from everyone but its owner, and requests to
  *or from* an appearing-offline person are refused with the same sentence a block gets — so the roster
  and the refusals never say which of the two is behind it. **(2) The request switches are per game.** One
  master switch plus one switch for each of the nine games the server can seat, labelled and tooltipped,
  reading the same `availability` the asks already used. **(3) Find match.** A row of chips — one game,
  several, or All games (the server's own `all`, so a game added later is covered) — and **nothing is
  picked for you**: the old button acted on whatever game happened to be selected, which is exactly how it
  came to say *"looking for blackjack"* when the person wanted Connect 4. Looking lives in a `looking`
  table, lasts until the person stops it (one tap) or is seated, survives a reconnect, and is dropped when
  someone leaves the lobby. A pass over it pairs two people who want the same game *right now* — someone
  else looking for it, or someone merely open to requests for it — and only when both are **online, visible
  and not already at a table** (`status() == 'online'`); a seated player is never invited anywhere and stays
  listed as *playing*. One offer per person at a time, and a pair that declined one is left alone for the
  ten minutes the direct-ask cooldown already used. The offer is one `play_requests` row with `offer = 1`,
  **either side may Join it or say Not now** (`_may_answer`), and Join runs the same private-unrated-table
  path a request takes. It reaches the person as a **dialog** ("X wants to play Connect 4 — Join / Not now")
  and as one dim grey line on the panel: the plugin has no non-context chat-line notice (the SDK offers
  toasts, silent OS notifications and model-addressed transcript directives, and nothing that writes a
  greyed line into the transcript that the model does not read), so the line is drawn by Game Center itself
  in the lobby's own notice area and never goes near the chat — **reported here as the fallback the ask
  names**. **(4) Half the width.** The lobby panel is `minmax(110px, 140px)` on the Games screen — half what
  it was — and the width it gives up buys one more column of game cards (`minmax(min(100%, 200px), 1fr)`).
  **(5) Posts are stamped and kept a day.** Every lobby post carries its date and time on both surfaces,
  nothing older than 24 hours is drawn, and the server's janitor **deletes** the old ones
  (`store.purge_lobby_posts`; the Hermes-local `lobby.json` drops undated and stale lines when it loads).
  The disclosure sentence now names appearing-offline and find-match among what the lobby socket carries.
  Tests: `tests/test_online_lobby2.py` (invisible, roster-from-the-socket, pairing by the chosen games,
  either side joining, no invite while playing, one offer at a time, the decline cooldown, seating clearing
  the pool, the janitor's sweep and find-match tidy-up, the hall kept up by any poll, and both UIs listing
  every seatable game) plus a new **lobby asks** section in `tests/table_ui_harness.cjs` (the offline switch
  and what it posts, one switch per game, chips that guess nothing, the offer dialog and its line, stamped
  posts and the 24-hour filter).

- **The original slot machine's copy over the chat comes back, and two machines can share one
  conversation (release blocker, 2026-11-11).** Owner's report: with **Show over chat** ticked nothing
  appears over the conversation, on either machine. Jackpot v2 was repaired in the entry below by
  restoring the mechanism that worked; this is the same repair for the *original* Slots, and the same
  class of cause. `SlotsOverChat` always mounted — the **show logic** was the defect: since 2026-11-10
  the copy was suppressed whenever a laid-out `.games-center-layout` was in the document, and Hermes
  keeps the Game Center page mounted *behind* the conversation, so the copy was hidden over the very
  screen it exists for (the same symptom the owner had already reported once: *"there was a faint copy
  but it disappeared and wont come back"*). The show logic is 9433891's again, hardened: the route
  decides first — the Games page has a route of its own, `/games`, and now sits in the denylist — and the
  Games *page* is only trusted when the conversation is **not** on screen. A composer outside the games
  (a textarea that is in neither a play table, the wait pane, nor the Game Center page) *is* the
  conversation, so a Games page that is merely still mounted can no longer hide the copy from it, while
  a Games page holding the main area still gets no copy over it. The copy is also drawn without the
  `visibility: hidden` gate that waited for a measurement that may never arrive: the numbers are measured
  in the status item itself before the first paint (`useLayoutEffect` where the host has one, `useEffect`
  in the harnesses) with 9433891's chat-column rule — the first textarea's first ancestor wider than half
  the window, the window itself when the shell exposes no column — and every path that cannot measure
  looks again instead of leaving the copy out. The machine's look (the full cabinet with its points card
  and controls), the size slider, the opacity and the `lane/q-slotfit` cabinet sizing are unchanged, and
  neither the odds window nor the status chip prints a win chance or a return on this machine either
  (the bundle-wide check in `tests/jackpot2_harness.cjs` pins that for both machines). **Both machines
  may now be on at once, and they share the conversation instead of covering each other**: the original
  keeps the **left half** of the chat column from its top-left corner, Jackpot v2 the **right half** from
  its bottom-right, each on its own switch (`gameshelf.slots.overchat` and `jackpot2.overchat`) — two
  copies that each stay inside their own half of the column cannot touch, whatever size they draw at.
  Harness: `tests/jackpot_overlay_harness.cjs` pins the mount with the switch on and no Games page, the
  "a mounted Games page does not hide it" regression, the route rule, the left/right halves, the
  no-overlap rule and that neither switch moves the other; `tests/jackpot2_fit.mjs` proves the same
  things in a real headless Chrome (both switches on, two real boxes, no intersection, the original on
  the left); `tests/slot_fit_regression.mjs` now asserts the copy is *drawn* over the conversation beside
  the pane instead of merely reporting it, and the QA pane page gained the real composer that check needs.

- **The Jackpot cabinet really floats over the conversation, and neither machine quotes odds any
  more (release blocker, 2026-11-11).** In real Hermes the v2 cabinet drew in *Play while you wait*
  and NOTHING appeared over the chat. The cause was a dependency: `Jackpot2StatusItem` took its
  geometry from `jp2LApply()`, which only measures after `jp2LEnsureLayer()` has created and appended
  a div to `document.body` — so on a host where that div cannot be created (or where only the status
  item's own tree renders) the copy was never drawn at all. The three independent analyses in
  `.q/overchat-why/` agree on the mechanism, and `desktop/src/19-jackpot2-layer.js` now does what the
  proven pre-rewrite machine did: it measures the frame itself (the chat column via the old
  `JP_chatColumn` method — first `textarea`, then the first ancestor wider than half the window; the
  right third of the window when there is no column, so the Hermes start screen works too) on mount, on
  window resize and on a `ResizeObserver` of the column, and draws the v2 stage as a `position:fixed`
  child of its own status span. No body node, no `createRoot` and no `createPortal` is needed; when a
  host react-dom *can* fill the layer div the machine is drawn there instead — one mounted machine
  either way, and all three host shapes are pinned by `tests/jackpot2_harness.cjs`. The copy is never
  zero-sized and never fully transparent (frame floored at 240×200, alpha floor raised to 0.25), and it
  says which frame it chose once on `console.info` as `[jackpot2] over chat: frame …` so the owner can
  see why. A clear **Show over chat** switch with the size and see-through sliders now also sits inside
  the cabinet's own panel beside Auto-spin/Auto-bet and in Settings (the full screen and the
  play-while-you-wait pane, which is one component) — all of them, and the status-bar toggle, read and
  write the same `jackpot2.overchat` / `.alpha` / `.size` keys. Separately, **every win-chance and
  return percentage is off the screen of BOTH machines** (`18-slot-machine.js` and
  `18-jackpot2-machine.js`): no “53% win this session”, no “113.5% back promised this session”, no odds
  window percentages and no percentage beside a session mood. The mechanics are untouched — the shelf
  still draws and pays the same odds, and its own tests still pin them — and the picker still names a
  bonus or cold session in a word.

- **The version chip lives in Settings, and nowhere else.** It was one small chip too many in the
  status bar, so it became `GamesVersionChip` (`desktop/src/79-version.js`) and moved first to the Games
  header and the pane's foot; the owner's call is now the final one — *everything* stays in the status
  bar except this chip, and the chip belongs to Settings. It is mounted exactly once, at the top of
  `SettingsPanel` (`desktop/src/60-settings-and-alerts.js`): the same `/v1/version` source, the same
  `v<version> · <date> · <8-char commit>` line (plus `· modified` on a dirty install), the same hover
  explanation and click-to-copy. Both Settings views are that one panel, so both carry it: the
  full-screen Settings screen (the header's own Settings link) and the play-while-you-wait pane, which
  gains a small gear in its header that opens the very same rows — no second copy of the switches, no
  new storage keys, and its way back labelled for the pane. The Games header's version row and the
  pane's version footer are gone; every other status-bar item (status, jackpot, jackpot2) is untouched.
  `tests/test_about_version.py` and `tests/table_ui_harness.cjs` pin the chip at the top of Settings in
  both views and its absence from the status bar, the header and the pane's foot.

- **Every table says who you are playing, and Blackjack can change opponent.** The seats the table already
  carries now name the other side on the playing surface itself: `opponentWords()` /
  `OpponentLine` in `desktop/src/30-game-page.js` read `seat.kind` and say **"vs Computer (Beginner)"**
  with the engine note in the tooltip, **"vs Hermes model: <model>"** when a model holds the seat, and
  **"vs Computer (the dealer)"** on a house table, where a strength would be a lie because the dealer
  plays the table's own rules. The chip sits above the board on the full page and in *Play while you
  wait*, and Blackjack draws the same line on its felt (`desktop/src/17-blackjack.js` takes `against`).
  A solo table that seats an AI side — Blackjack's dealer — now offers the same two ways on as every
  board game: **New game vs computer** (`allow-ai blackjack black=local level=…`) and **Play my Hermes
  model** (`allow-ai blackjack black=agent`). The side pane had no way to start a new Blackjack game at
  all; both surfaces now send `abandon` first when hands are already on the felt, because the table
  itself refuses a new setup over a session in play (two presses, never a surprise). Slots, which seats
  nobody, still offers one Play button. `tests/table_ui_harness.cjs` pins the words, the tooltip, the
  felt label and both button lines on both surfaces; `tests/test_blackjack_table.py` proves the same
  lines against the real table, including that a model seated as the dealer really plays its turns.

- **A move in the side pane lands when it is made.** The pane drew the board only from the read that
  followed the move, and that read came after the computer's whole search — so at Expert chess the
  person's own piece sat still for about two seconds. The pane now hands the move to `BoardSvg`'s own
  `pending` draw (`desktop/src/12-board-input.js`, `pendingCells`), paints the board from the command's
  own reply (`/command` already answers with `picture`), and skips the second `/board` read when the
  reply carries that board. Measured on this machine (load ~2): `GET /view` 73–86 ms, `GET /board`
  130–147 ms, a move line 75 ms (Connect Four, Normal) to 1.9 s (chess, Expert — the engine's own clock).
  `tests/test_move_latency.py` measures the phases and pins the two facts the redraw rests on, and the
  harness proves the move lands with no read behind it at all.

- **The table found online has its own chat, inside Hermes.** `shelf/online_table.py` keeps the last 50
  messages the socket carries — the `hello` frame opens with the list, every later `{"t":"chat"}` appends
  one — in the snapshot, and `say(text)` sends `{"t":"chat","text":…}` capped at the server's own 300
  characters; `POST /online/table/chat {text}` is the one door on the dashboard.
  `desktop/src/73-online-table.js` draws the table and `desktop/src/74-online-chat.js` the **Table chat**
  panel beside the board (under it in a narrow window): the
  server's own list with who said it and their role, a box, **Send**, and Enter, with the cap and the
  sharing said on hover. Nothing is drawn before the table's own feed has it, so the panel can no more
  invent a message than the board can invent a move; a message the server turns down — muted by the
  host, silenced, or too fast — arrives as a result no command is waiting on, is kept in the snapshot
  as `chat_error {text, sent, at}`, and the panel shows it in the server's own words and puts the
  refused words back in the box, so nothing typed in the dock is ever swallowed. `tests/test_online_table.py`
  chats both ways through a real in-process server
  and pins the last-50 trim, the 300-character cap, the exact frame and the server's own refusal — as
  does a fake socket without a server in the way for the frame; `tests/table_ui_harness.cjs` pins the
  panel, the one route, Enter, the refusal shown once from the feed, and the empty box. Both are
  mutation-checked (dropping the trim, the cap, the frame name, the hello list, the Enter handler, the
  refusal branch or its surface fails them).

- **The slot cabinet fits the page it is given.** Inside Game Center the machine keeps one drawn width
  (1183 px) and scales down to fit, with a 45% floor on the height term and a 20% hard bound so a short
  or hidden page never renders an invisible machine; the width term still wins on narrow pages so nothing
  is clipped sideways, and the fit re-runs when the person switches machines. `tests/slot_fit_regression.mjs`
  proves it in headless Chrome at eight window sizes, including a machine switch, and is mutation-tested:
  restoring the old `width: 100%` wrapper or a zero floor makes it fail.
- **The odds panel quotes the window the session actually drew.** `slotplay.odds()["range"]` published the
  usual 50–55% whatever the draw was, so a bonus (60%) or cold (40%) session showed a promise contradicted
  by the number beside it. It now publishes `reels.chance_window()`. The four tests that assumed a usual
  draw — and read `shelf.reels`, a second module copy with its own seed — now read `slotplay.reels`; a run
  that failed about one time in five is stable across 20 identical runs, and `tests/test_session_draws.py`
  forces bonus, cold and usual draws by seed instead of waiting for luck.

- **The build states its own identity.** `dashboard/version_stamp.py` (vendored from the suite
  template) resolves `BUILD_INFO.json` → live `git` → `plugin.yaml`; `GET /v1/version` reports
  version, commit, commit date, install time, dirty state and channel, and `GET /about` returns the
  same data from the same function.
- The version chip reads `v1.0.0-dev.N · 2026-11-09 · 19f7a2c`, turns amber and says `modified` when the
  installed copy came from a dirty tree, and copies the line on click for a bug report. It fetches the
  route rather than carrying a number in the bundle, and it is drawn at the top of Settings, never in the
  status bar (see 1.0.0, above).
- `scripts/deploy.sh` rebuilds the bundle, installs, stamps and ends in `scripts/verify-served.py`,
  which fails when what Hermes will run is not this tree.
- `tests/test_about_version.py` covers the contract: the stamp is vendored, never invents a commit,
  `BUILD_INFO.json` is gitignored, the bundle carries the badge, and both routes agree with the
  manifest.
- **A failed fallback is a logged failure, not a silent one.** Seventeen `except …: pass` blocks and
  empty `catch` blocks across the shelf, the dashboard and the table games now write a warning with
  the traceback instead of discarding it — the engine quit, board read-back, dossier note, lobby
  socket close, lock and temp-file cleanup, thumbnail build, key-file permissions, state save and the
  spin log. Behaviour is unchanged: every one of them still falls back rather than raising.
- **The spin log reports its own failures.** `shelf/spinlog.py` keeps one JSON line per spin so a
  payout can be re-derived rather than argued about; a log that could not be written (or a
  rollover that could not happen) now says so at warning level. `tests/test_regression_spinlog_logging.py`
  pins both, and the healthy path stays silent.
- **`online/store.py`'s standalone import path works.** It imported `league`, which it never used,
  and never imported `guard`, which it calls — `guard.skeleton()` raised `NameError` on that path.
  `tests/test_regression_store_fallback.py` fails on the old code.
- Dead code removed where the scanner had proof nothing used it: an unused `importlib` import in
  mafia, a team-dice read whose value the total already supplies, a game-state read in `reveal`, an
  empty dict in setup that was never merged, and numeric regex flags on an f-string with no
  placeholders. Gomoku's greedy level now takes an argmax instead of sorting.
- **The scanner config says what it skips, and why.** `.aislop/config.yml` names every exclusion
  (generated bundle, developer harness, recorded evidence) and silences exactly four cross-part
  JavaScript rules inside `desktop/src`, where parts are concatenated by the build. Coverage goes up,
  not down: 192 → 236 files, and `.aislop/ci-baseline.json` makes CI fail on new findings only.
- **A table found online can be played in Hermes.** `desktop/src/73-online-table.js` draws the lobby
  server's own per-seat picture with the same `BoardSvg` the local table uses, reads `GET
  /online/table` every 400 ms and sends every click as `POST /online/table/cmd {action:'move',args}` —
  there is no local game behind it, so it can never post a local move, and the turn line is the owner's
  wording (*Your turn* / *Waiting for …* / *Reconnecting…*), never a claimed model. **Play here** on a
  matched table (dock and lobby column) opens the room in Hermes with `POST /online/table/open`, the
  browser stays as a small secondary link, resign asks once, and **Close table** posts
  `/online/table/close` without ending the match. `tests/table_ui_harness.cjs` pins the online turn
  line, the command route, the locked board while a move is out, and that the local agent seat still
  says it is thinking.
