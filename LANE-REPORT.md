# LANE REPORT — Lane B (T5, T6 client half, T10 client)

Worktree `/home/dev/wt/polish/gc-lanes/tnb`, branch `lane/tnb`. Three commits, one per item:

| Item | Commit | Subject |
|---|---|---|
| T5 | `effd928` | T5 Get online card: one block for the sign-in steps, with rename, key and account file |
| T10 client | `0d24789` | T10 client: a #games post stays on the screen for 30 days |
| T6 client half | `7bcacdc` | T6 client half: the #games chat goes to the lobby or takes no line |

`desktop/plugin.js` is **not** in any commit (rebuilt locally only, then `git checkout desktop/plugin.js`;
the tree is clean now). No push, no gateway/profile/sentinel/remote change, nothing restarted.

Test runner note for whoever follows: the `python3` on PATH here is the Hermes install venv and has **no
pytest**. Every Python run below used `/usr/bin/python3 -m pytest` (3.13.13, pytest 9.1.1, aiohttp+fastapi
present). Node is v26.

---

## T5 — "Get online" card at the top of the Games page

### Files changed
- `desktop/src/62-pane-state.js` — the one shared block: `useOnlineFields`, `useOnlineSuggest`,
  `onlineAccountBlock`, `useOnlineCheck`, `onlineCheckBlock` (and `KEY_MASK`). The online state is still
  `/view`'s `online` answer (one source); only the form fields live in the hook.
- `desktop/src/65-wait-pane.js` — the pane's online section now draws `onlineAccountBlock` instead of its
  own copy of the same steps; its local `keyToCopy` / `onlineName` / `onlineKey` are gone, and its separate
  "Turn online play off" link moved into the block (so an unlinked person can still turn it off).
- `desktop/src/70-home.js` — `OnlineGetOnlineCard`, mounted as the first content of the Games page (right
  under the Games/Champions tabs). Connection line from `host.connections()` / `host.activeConnectionId()`
  and `host.navigate('/settings?tab=gateway')`, guarded so an older desktop gets plain words.
- `desktop/src/72-lobby.js` — the Hall's Check online now uses the shared `useOnlineCheck` +
  `onlineCheckBlock` (same rows in both places).
- `desktop/src/05-primitives.js` — `field()` accepts `disabled` (used by the closed chat box in T6).
- `shelf/online_source.py` — `downloads_folder()` (XDG user-dirs on Linux, `~/Downloads` on Windows),
  `Online.rename()` (server's own 409/429 sentence, untouched), `Online.account_file()`
  (`GameCenter-<name>.json` = `{name, key, server, saved_at}`), `_file_safe()`.
- `dashboard/plugin_api.py` — `POST /online/rename`, `GET /online/key` (loopback only, never in a
  snapshot), `POST /online/account-file`, `_downloads_dir()`, `_from_this_computer()`, and a defensive
  `from fastapi import Request` (a bare host without it still imports).
- `tests/test_online_account.py` (new), `tests/table_ui_harness.cjs` (pane assertions re-worded + new
  `getOnlineCardContract`), `tests/test_online_lobby_chat.py` + `tests/test_center.py` (wording),
  `docs/ONLINE-PLAY.md`, `docs/USAGE.md`, `CHANGELOG.md` (+ `doc_stamp.py --write`).

### Tests
`tests/test_online_account.py::` `test_a_rename_takes_effect_and_a_second_one_keeps_the_servers_words`,
`test_a_name_someone_else_holds_is_refused_in_the_servers_own_sentence`,
`test_the_rename_route_does_not_rewrite_the_servers_sentence`,
`test_the_key_is_readable_on_this_computer_and_nowhere_else`,
`test_the_key_is_never_in_a_snapshot_or_an_online_answer`,
`test_the_account_file_holds_the_four_fields_and_says_where_it_went`,
`test_a_name_that_is_not_a_file_name_still_gives_one_file`,
`test_downloads_is_the_plain_folder_each_system_uses`,
`test_the_account_file_route_writes_into_downloads_and_says_where`.
`tests/table_ui_harness.cjs::getOnlineCardContract` → `get online card: connection, switch, name, rename,
key, check: passed` (8 states: off, on+no player, generator present/absent, sign-in with a saved key,
signed in + rename refused in the server's words, masked key + account file, Check online, collapsed line +
Manage, remote connection + Open connection settings).

### FAIL (before)
```
$ /usr/bin/python3 -m pytest tests/test_online_account.py -q -p no:cacheprovider
AttributeError: module 'shelf.online_source' has no attribute 'downloads_folder'
AttributeError: <module 'dashboard.plugin_api' ...> has no attribute '_downloads_dir'
AttributeError: 'Online' object has no attribute 'rename' / 'account_file'
8 failed, 1 passed in 7.35s
```
UI half (bundle built from HEAD's sources + this harness, in a scratch copy of the tree):
```
$ node tests/table_ui_harness.cjs        # HEAD bundle
AssertionError [ERR_ASSERTION]: and a returning person can paste their key
    at onlineContract (.../table_ui_harness.cjs:4001:10)
```
and the card itself does not exist in a HEAD bundle: `grep -c OnlineGetOnlineCard` → `0` (HEAD) vs `2` (this
branch's bundle), `onlineAccountBlock` → `0` vs `4`, so `getOnlineCardContract` cannot pass there at all.
While developing the card contract it also failed for real reasons, each fixed in code or test: a press on
a *disabled* Create button still posted `/online/signup` (now guarded in the handler), the working card
hides its own steps (collapsed test now presses Manage first), a cross-realm `deepEqual` (now JSON compare),
the harness's `host` being replaced by an earlier contract (the connection test installs and restores its
own host object).

### PASS (after)
```
$ /usr/bin/python3 -m pytest tests/test_online_account.py -q -p no:cacheprovider
.........                                                                [100%]
9 passed in 6.92s

$ node tests/table_ui_harness.cjs     # whole harness, rebuilt bundle
... get online card: connection, switch, name, rename, key, check: passed
harness exit=0
```
Related suites, all green: `test_online_source.py`, `test_online_lobby.py`, `test_online_lobby2.py`,
`test_online_hall.py`, `test_online_account.py` → **80 passed in 75.69s**; `test_online_lobby_chat.py`,
`test_center.py`, `test_table_ui_contract.py`, `test_online_account.py` → **38 passed in 54.37s**;
`test_harness_crlf.py`, `test_table_ui_contract.py`, `test_owner_feedback.py` → **16 passed in 38.16s**;
`test_docs_consistency.py`, `test_docs_current.py` → 17 passed (with `test_plugin_bundle.py`, which fails
**only** because the bundle is rebuilt once at merge — see "UNSURE / known").

### UNSURE (T5)
1. **"Suggest a name" route path is a guess.** Lane A adds `plugin_api.suggest_a_name()` in *their* tree
   (only `tests/test_name_generator.py` existed when I looked, no route yet). I probe `GET /suggest-name`
   (`SUGGEST_PATH`, one constant in `62-pane-state.js`) and accept `{ok, name}` or `{ok, suggested_name}`.
   If lane A names the route differently at merge, the failure mode is the button staying hidden — change
   that one constant to match.
2. **"Game Center on <host>"** shows the lobby host from `online.url` (e.g. `games.hermesnet.xyz`), not the
   gateway machine name: the gateway "hostname" for a local connection is `127.0.0.1`/profile-local and is
   not meaningful on this card, and no route exposes the machine's name. "Which PC" is answered by the
   connection line ("This window runs Game Center on <label>" / "… on this computer"). Say the word if you
   want the machine name instead — it needs one new field on `/about`.
3. **"…in the status bar"** is the brief's wording, kept verbatim. On this desktop the connection switcher
   lives in the Sessions sidebar (the status bar has no connection control), so the sentence may point one
   place wrong.
4. **`GET /online/key` is loopback-only** (`request.client.host` is a loopback address). Behind a reverse
   proxy or a Tailscale-served dashboard the client address is the proxy's, so even the person at the
   machine would be refused; the fallback is the account file, which is written by the server side and is
   not gated. Also, if a host's FastAPI could not inject `Request`, the parameter would be read as a query
   param — the defensive import covers an old host, not a strange one.
5. **Copy changes ripple into the pane** (`I have a key` → `I have a player`, `Sign out here` → `Sign out`,
   `You are <name> online.` → no full stop) and into `tools/leagues_proof.mjs`, which presses
   `'Sign out here'` and `'Create my player'`. I did **not** run or edit that proof script — it will need
   the new label when it is next used.

---

## T6 (client half) — the #games chat is the lobby's, or it takes no line

### Files changed
- `dashboard/plugin_api.py` — `_lobby_say`: a `chat say …` line is now **always** answered, never `None`
  (so it can never fall through to the local lobby). Signed out / online off → `{"ok": False, "text":
  "Sign in to online play to chat."}`.
- `shelf/online_source.py` — `CHAT_DOWN = "The online server isn't answering; your message wasn't sent."`
  (the brief's sentence; `say_lobby` and `_lobby_say` both use it).
- `desktop/src/72-lobby.js` — the column: `signedIn = online.on && online.linked`; the box is closed with
  placeholder `Sign in to online play to chat`, Send is disabled, `sendChat` returns early, the posts list
  is only drawn when `lobby.shared` (the local lines are no longer painted as if they were the chat), and
  `data-lobby-chat-where` is `online` / `signed-out` (was `local`).
- `desktop/src/05-primitives.js` — `field(..., {disabled})`.
- Tests: `tests/test_online_lobby_chat.py` (new `test_signed_out_the_games_chat_takes_no_line_and_saves_nothing`,
  `test_a_message_the_server_never_got_says_it_was_not_sent`; the old "stays on this computer" assertion
  inverted), `tests/test_center.py` (the desktop `chat say` path), `tests/table_ui_harness.cjs`
  (`lobbyColumnContract`: signed-in view marked `linked`, new signed-out case; `lobbyAsksContract` view
  marked `shared`+`linked`).
- Docs: `docs/ONLINE-PLAY.md` ("The lobby posts"), `CHANGELOG.md`.

### FAIL (before)
```
$ /usr/bin/python3 -m pytest tests/test_online_lobby_chat.py tests/test_center.py -q
E  AssertionError: {'text': 'Pick a name first with /games name Argo. …', 'ok': True}   # local save still happening
E  IndexError: list index out of range            # the old test read the local lobby line
4 failed, 19 passed in 34.09s

$ node tests/table_ui_harness.cjs
AssertionError [ERR_ASSERTION]: a chat with no online sign-in says what it needs
    at lobbyColumnContract (.../table_ui_harness.cjs:4591:10)
```

### PASS (after)
```
$ /usr/bin/python3 -m pytest tests/test_online_lobby_chat.py tests/test_center.py -q -p no:cacheprovider
.......................                                                  [100%]
23 passed in 52.83s

$ node tests/table_ui_harness.cjs    → harness exit=0
```

### UNSURE (T6)
1. **The desktop has no local #games chat any more** — that is what the brief asks ("never a silent local
   save"), but it also means `/games chat say …` typed in the Hermes chat window while signed out now
   answers "Sign in to online play to chat." instead of writing to the local lobby file. The local lobby
   (and `shelf/lobby.py`) is untouched and still used for "looking" rows.
2. **The pane's own chat box (65-wait-pane.js) was left alone** (the brief names `72-lobby.js` and
   `_lobby_say`). Its placeholder still says "Set a name first" when the local player is unnamed, and a
   press now shows the refusal sentence from the route. Worth aligning in a later pass.
3. `data-lobby-chat-where` values changed from `local` to `signed-out`; nothing in the repo keyed off the
   old value except the test I updated.

---

## T10 (client) — `LOBBY_POST_MS` = 30 days

### Files changed
- `desktop/src/72-lobby.js` — `LOBBY_POST_MS = 30 * 24 * 3600 * 1000` with the comment pointing at the
  server's own window; the posts comment no longer says "last day".
- `tests/table_ui_harness.cjs` — chat-window check at the top of `lobbyColumnContract` (a 21-day-old post
  is drawn, a 31-day-old one is not), and `lobbyAsksContract`'s "older than a day" case moved to 31 days.
- `docs/ONLINE-PLAY.md`, `CHANGELOG.md`.

### FAIL (before)
```
$ node tests/table_ui_harness.cjs
AssertionError [ERR_ASSERTION]: the chat window matches the server’s 30 days
+ actual - expected
+ 86400000
- 2592000000
```

### PASS (after)
```
$ node tests/table_ui_harness.cjs    → harness exit=0  (whole harness, incl. get online card)
```

### UNSURE (T10)
1. The **server** constant (`CHAT_DAYS`) is lane C's (T10-server). My docs now say "30 days" — if lane C
   lands a different number, the doc line and `LOBBY_POST_MS` need aligning at merge.
2. `LOBBY_HOURS` still filters open rooms on the server; untouched here (lane C).

---

## Known, expected failures in this tree (not caused by this lane)
- `tests/test_plugin_bundle.py::test_the_committed_bundle_is_what_the_parts_build_today` — fails because
  `desktop/plugin.js` is deliberately not rebuilt until the merge (COMMON.md). Re-run after the one merge
  build.
- `tests/test_pane_fill.py::test_the_pane_fills_its_frame_at_320_and_1000_px` — **3 failures on this base**:
  "the board fills its column at 640 / 720 / 1000 px — drawn board 300 px of a 739 px column". Reproduced
  with the committed (HEAD) bundle and no changes of mine (`git checkout desktop/plugin.js` →
  `node tests/pane_fill_checks.mjs`), so it is pre-existing on this worktree's base, not from this lane.

## Anything else worth knowing
- The card collapses only when `online.on && online.linked && !online.offline`; **Manage** opens it again and
  **Hide** folds it.
- No host DOM is read or styled anywhere: the card uses only `host.connections()`,
  `host.activeConnectionId()`, `host.navigate()` and `ctx.rest()`, each behind a `typeof` guard.
- No new dependencies; `python3 tools/doc_stamp.py --write` was run before each docs-bearing commit.

---

# LANE REPORT — Lane D (D1, D2)

Worktree `/home/dev/wt/polish/gc-lanes/tnd`, branch `lane/tnd`, from `ecc08a0`. Two commits, one per item:

| Item | Commit | Subject |
|---|---|---|
| D1 | `c4a2d75` | D1: Sea Battle placements stay with the person who made them |
| D2 | `6b940bf` | D2: Blackjack can be asked for in Find match |

`desktop/plugin.js` is in **no** commit: it was built locally once (for `tests/table_ui_harness.cjs`) and
then `git checkout desktop/plugin.js`. The tree is clean, nothing was pushed, and no gateway, profile,
sentinel or remote was touched. `python3 tools/doc_stamp.py --write` was run before the docs-bearing
commit (it restamped the 19 doc headers; the only content change is in `docs/ONLINE-PLAY.md`).

Runner note (same as lane B found): the `python3` on PATH is the Hermes venv with no pytest, so every
Python run below is `/usr/bin/python3 -m pytest` (3.13.13). Node is v26.

---

## D1 — Sea Battle placements leak through the move list

### Files changed
- `kit.py` — three helpers beside `_level_note` (`_public_hook`, `_public_move`, `_public_refusal`) and
  `Table.picture` now:
  * reads the game's optional `public_move(text) -> bool`;
  * drops every ply it calls private from `moves`, blanks `last` when `last` is private;
  * drops a refusal record whose `played` move or any proposed move is private;
  * gives a **named** viewer who is not the seat to move only the public entries of `legal` (the mover's
    own list is untouched, and a viewer-less read is untouched — see UNSURE 2);
  * a hook that raises counts as "not public" (fail closed) and logs at debug.
  Games with no hook keep exactly the picture they had.
- `seabattle/game.py` — `public_move(text)` returns True for `fire …` only. Placements, `unplace`,
  `random`, `duplicate` and `look` are private.
- `tests/test_seabattle_private_moves.py` (new) — two tests.
- `docs/ONLINE-PLAY.md` (the "Sea Battle's fleet stays with the seat that laid it" paragraph),
  `CHANGELOG.md`.

### Tests
`tests/test_seabattle_private_moves.py::test_the_other_seat_and_a_watcher_never_see_a_placement` —
Black's and a watcher's picture mid-placement (White has laid three ships by hand): `json.dumps(picture)`
contains no `place `, no `S` hull on either board, `own_ships`/`enemy_ships`/`enemy_fleet` empty, and none
of White's hull squares drawn; White's own picture still lists her three ships, draws her hull, and still
offers her next placements in `legal`.
`tests/test_seabattle_private_moves.py::test_shots_are_listed_for_both_people_and_placements_never_are` —
both fleets laid by hand, White fires: `fire b2` is in the move list of both seats **and** the watcher,
and `place ` is in none of the three pictures.

### FAIL (before) — `ecc08a0`
```
$ /usr/bin/python3 -m pytest tests/test_seabattle_private_moves.py -q
E       AssertionError: Black's picture carries White's placements
E       assert 'place ' not in '{"view": "s...labels": []}'
E         'place ' is contained here:
E           ndom", "unplace carrier", "unplace battleship", "unplace cruiser", "place submarine f1 h", ...
E           "place submarine f2 h", "place submarine g2 h", ... (the whole legal list)
2 failed in 3.96s
```
The first run of the second test also failed for a test-side reason of mine (a room keeps three words of
a move, so `["place", name, square, "v"]` is cut to three words and placed horizontally); the fixtures
now lay every ship left to right, and from then on both tests failed on the leak itself — the second one
on `"Ada's picture carries a placement"`, with the full placement list quoted out of `moves`.

### PASS (after)
```
$ /usr/bin/python3 -m pytest tests/test_seabattle_private_moves.py -q
..                                                                       [100%]
2 passed in 4.25s

$ ... test_seabattle.py test_seabattle_board.py test_seabattle_placement.py \
      test_seabattle_attribution.py test_seabattle_review.py test_online_viewer_pictures.py -q
66 passed, 15 skipped in 24.65s

$ ... test_online_rooms.py test_online_table.py test_match_lifecycle.py test_seabattle_model_seat.py -q
114 passed in 35.84s

$ ... test_person_playthrough.py -q          → 42 passed in 47.66s
$ ... test_browser_click_play.py test_table_ui_contract.py -q → 6 passed, 1 skipped
$ ... test_check_game_session.py test_ia.py test_windows_import.py -q → 27 passed
```
`test_person_playthrough.py` failed on the first cut of the fix (three seabattle cases, "hinted 'random',
not a legal move") because those tests read a picture with **no** player; the `legal` filter now needs a
named viewer, which is exactly the distinction UNSURE 2 describes. All green after that.

### Outward paths searched (D1)
- `kit.py` `Table.picture` — `moves`, `last`, `refusals` and (for a non-mover) `legal`: **fixed**.
- `online/rooms.py` — `Rooms.picture` hands the viewer to the table, so the server's picture is the filtered
  one. `room_summary`/`state()` are not involved. No other picture, history or replay path here.
- `online/server.py` — `broadcast` sends `room_summary` + `picture` + `matches` + presence; `room_summary`
  carries status/plies/seats/ratings/labels and **no** move text (there is no "last move" field in the room
  list at all). `get_room`, `lobby`, `live_bot_rooms`, `spectate` all go through `room_summary`. The only
  move text over HTTP is `GET /api/matches/{room}/{no}` (see UNSURE 4).
- `online/store.py` — `record_match` writes `state["moves"]` into the `matches` row (called only when a match
  is finished, `rooms.py:436-438`); `recent_matches` (sent on every broadcast) selects no moves.
- `online/web/app.js` — draws `picture.moves` (now filtered server-side); `REQUESTABLE_GAMES` updated for D2.
- `dashboard/plugin_api.py` — `/board` → `shelf.catalog.picture` → `kit.Table.picture` with the desktop
  player (the local owner's table, now filtered the same way). The review/replay/`tournament/import` code
  around 2367-2400 builds pictures from local state on the owner's own machine.
- `shelf/review.py`, `shelf/ladder.py`, `shelf/tournament.py`, `shelf/tutorials.py` — read `state["moves"]`
  locally, never send them anywhere.
- `shelf/online_source.py`, `shelf/online_hall.py` — carry no moves; the desktop only proxies server frames.
- `desktop/src` — `30-game-page.js` draws `picture.moves` (filtered); `73-online-table.js` draws no move list.
- `online/presence.py`, `matchqueue.py`, `arcade.py`, `bouts.py`, `league.py` — no move text.
- The Sea Battle picture itself (checked, left alone): a watcher gets no `own_ships`/`tray`/`enemy_fleet`;
  a seat sees its own fleet; `last_shot(s)` are shots (public); at a finished game both fleets are shown.

---

## D2 — Blackjack by "Find match"

### Files changed
- `online/requests.py` — `blackjack` added to `REQUESTABLE`, and the comment now says why (two people at
  one table, each against the dealer; slots has no table to sit at).
- `desktop/src/72-lobby.js` — `['blackjack', 'Blackjack']` in `LOBBY_GAMES`; the two stale chat comments
  now name the server's real constant (`CHAT_KEEP_DAYS`) and the thirty days it keeps.
- `online/web/app.js` — `['blackjack', 'Blackjack']` in `REQUESTABLE_GAMES`.
- `tests/test_online_requests.py` — new
  `test_a_blackjack_request_is_accepted_and_seats_two_people_against_the_dealer`;
  `test_blackjack_and_slots_refused` becomes `test_slots_cannot_be_requested` (the old assertion encoded
  the behaviour this item removes).
- `tests/test_online_lobby2.py` — new `test_find_match_can_seat_a_blackjack_table`;
  `test_find_match_takes_every_game_at_once` now uses `slots` as its refused example.
- `tests/table_ui_harness.cjs` — the Hall switch list and the "one chip per game, plus All games" count.
- `docs/ONLINE-PLAY.md` (a Find match sentence under the blackjack paragraph), `CHANGELOG.md`.

`online/requests.py:483` already creates the room as `rooms.create(game, white, True, "two")`, and T9's
`Rooms.create`/`Rooms.table` already turn a blackjack "two" room into `players=2` with
`table_chips: True`, so nothing in the room path needed changing — the item was the missing list entry.

### Tests
`tests/test_online_requests.py::test_a_blackjack_request_is_accepted_and_seats_two_people_against_the_dealer`
— Ada asks Bea for blackjack, Bea accepts: one `seated` frame pair and one room; `state["players"] == 2`,
`white_id` = the asker, `black_id` = the person who accepted; each person's picture has two `human` seats,
`table_players == 2`, `table_chips is True`, their own `your_seat`, a 10,000-chip stack for their seat, no
player at the table using a wallet, `can_manage` only for the host, `can_move` for the host's first bet,
and no `wallet.json` in the room folder.
`tests/test_online_lobby2.py::test_find_match_can_seat_a_blackjack_table` — both PCs look for blackjack,
the offer names `blackjack`, and accepting it seats both people at one two-seat table.
`tests/test_online_lobby2.py::test_hermes_lobby_lists_every_game_the_server_can_seat` /
`::test_the_website_lobby_lists_every_game_the_server_can_seat` — the existing mirrors.
`tests/table_ui_harness.cjs` — the Hall switches and the Find match chips.

### FAIL (before)
```
$ /usr/bin/python3 -m pytest tests/test_online_requests.py::test_a_blackjack_request_is_accepted_and_seats_two_people_against_the_dealer \
    tests/test_online_lobby2.py::test_find_match_can_seat_a_blackjack_table -q
E       AssertionError: That game cannot be requested.
E       assert False        (find match: "That game cannot be chosen.")
2 failed in 7.68s
```
Then, with `blackjack` in `REQUESTABLE` **only** (the mirror guard doing its job):
```
$ ... test_hermes_lobby_lists_every_game_the_server_can_seat
E       AssertionError: ['connect4', 'reversi', ... 'seabattle']
E       assert [...] == ['blackjack', 'breakthrough', ...]
$ ... test_the_website_lobby_lists_every_game_the_server_can_seat
E       assert [...] == [...]
2 failed in 4.35s
```
and the built-bundle harness, before `LOBBY_GAMES` gained blackjack:
```
$ node tests/table_ui_harness.cjs
AssertionError [ERR_ASSERTION] at lobbyAsksContract:6766
  + 'seabattle',
-   'blackjack'
```
and, with the switch list fixed but the chip count not:
```
AssertionError [ERR_ASSERTION]: a chip per game, plus All games
11 !== 10
```

### PASS (after)
```
$ /usr/bin/python3 -m pytest tests/test_seabattle_private_moves.py tests/test_online_requests.py tests/test_online_lobby2.py -q
43 passed in 9.59s

$ ... test_online_hall.py test_online_table.py test_online_blackjack.py test_online_lobby.py \
      test_online_chat_retention.py -q                    → 40 passed in 13.50s
$ ... test_online_table_stage.py test_online_viewer_pictures.py test_online_admin_http.py -q
                                                          → 20 passed in 5.70s
$ ... test_online_site_assets.py test_online_static.py test_coming_soon.py test_brand_copy.py -q
                                                          → 9 passed in 3.34s
$ ... test_online_server.py -q                            → 8 passed in 3.52s
$ ... test_online_lobby_chat.py test_center.py test_docs_consistency.py test_docs_current.py -q
                                                          → 29 passed in 16.65s
$ node tests/table_ui_harness.cjs                         → exit=0 (whole harness, built bundle)
```
`desktop/plugin.js` was restored with `git checkout desktop/plugin.js` after the harness run.

---

## UNSURE

1. **White's own placements leave her own move list too.** `public_move` is viewer-independent by design
   (the brief's shape), so the mover does not see her own `place …` lines either. Nothing is lost that
   matters — her fleet is drawn, and the command answers "Ship placed." — but if you want the mover to keep
   her own lines, the hook needs a viewer parameter.
2. **`legal` is filtered only for a *named* viewer who is not the seat to move.** A picture read with no
   player (`kit.picture()`) keeps the mover's full legal list, because `tests/test_person_playthrough.py`
   reads tables that way and a viewer-less read can only come from the machine that owns `state.json`.
   Online always names the viewer (a websocket connection always has a player id), so no online path is
   left open.
3. **Refusal records naming a private proposal are dropped for everyone**, including the person whose
   agent proposed it. A model seat that proposes a bad placement gets no badge for it.
4. **`GET /api/matches/{room}/{no}` still returns a finished match's moves, placements included.** It is
   recorded only when a match is finished, and a finished Sea Battle already shows both fleets in the
   picture (`finished` → `enemy_fleet` and `S` on both boards), so this is the game's own end-of-game
   reveal rather than a new leak. Left as it is; say the word if a replay should be filtered too.
5. **`last` no longer carries a placement,** so the desktop's "a new move arrived" reset
   (`desktop/src/30-game-page.js:531`, keyed on `pictured.last`) does not fire on each placement; the board
   still redraws from `own_cells` and the ship appears. Worth a look in the live test.
6. **A Find match offer has no asker**, so either person may be seat 1; the test asserts the two people are
   the two seats and each is in their own seat, not a fixed order. An explicit *request* always puts the
   asker in the first seat (asserted).
7. **"Both owners right"** I read as: both seats are human, each person holds their own seat and their own
   stack, and the table owner is the host (`can_manage` only for them). `permissions.can_resign` /
   `can_draw` still read true for a blackjack seat even though `Rooms.run` refuses resign at a blackjack
   table — presentation hints only, `Table.command` is the boundary. Unchanged.
8. The slots line in `online/requests.py`'s comment and the doc wording say slots has no table to sit at;
   if slots ever gets a table, `REQUESTABLE` and both lists need the same one-line change.
