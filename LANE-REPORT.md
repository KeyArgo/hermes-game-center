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
