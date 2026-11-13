# Security review — 2026-11-09
_Applies to Game Center 1.0.0 · last revised 2026-11-13 (0ad31b96)_

Scope: the whole tree on branch `bughunter/green-clean-secure`, six areas. Every "clean" line below
is a check that was **run**, not an assumption; every "fixed" line names the test that failed before
the fix.

Commands were run from the repository root with `/usr/bin/python3` (pytest 9.1.1).

---

## 1. Subprocess surface — checked, clean

Three launch sites are reachable from the plugin; the rest of the `subprocess` mentions in the tree are
in `tests/`, `tools/`, `proof/` and `.lanes/`.

| Site | argv | Verdict |
|---|---|---|
| `chessboard/analysis.py::_Engine` | `[shutil.which("stockfish")]` | fixed list, no shell; `open_engine()` returns `None` when Stockfish is absent |
| `chessboard/coach.py::_Engine` | `[path]` where `path = shutil.which('stockfish')` | fixed list, no shell |

> **Update, 2026-11-12 (the review before listing).** The third site — `doctrine/profiles.py::_run`,
> which ran `hermes -p <profile> chat … --toolsets ""` — is **gone**. Hermes treats an empty
> `--toolsets` as "not set", so that child inherited the profile's default tools and any
> approval-mode variable in the environment. The card is now written through `ctx.llm.complete`
> (the plugin LLM door: text only, no process, no tool set, no inherited environment), and
> `tests/test_doctrine.py::test_the_author_path_starts_no_process_and_inherits_no_environment` pins
> that no `subprocess` call is left in the authoring path. Counts below are the 2026-11-09 ones.

Nothing is built from a room id, player name, save path or `game.json`.

```
shell=True outside tests/third_party/vendor/tools/proof/.lanes   0
os.system                                                        0
os.popen                                                         0
subprocess.{run,Popen,call,check_output} reachable                3 (the table above)
```

A PATH entry can shadow `stockfish` or `hermes`; that is the same trust the user gives any program they
install, and it is not reachable from game data. Noted, not changed.

## 2. Path handling in rooms and saves — two bugs, both fixed

**a. A `game.json` entry could point outside its own folder.** `shelf/catalog.py` joined
`manifest["entry"]` to the game folder and imported it. `"entry": "../../outside.py"` and an absolute
`"entry": "/tmp/x.py"` both executed a file the installer never vetted (proof: the outside module wrote
a marker file on import). Fixed by `_entry_problem()` — refused at manifest scan (recorded in
`catalog.problems`) and again in `_load` — with both sides resolved, so a symlink that resolves outside
the folder is refused too. `online/rooms.py::table_games()` got the same containment for the networked
path.

- Test: `tests/test_regression_manifest_entry.py` (3 tests).
- Failed before: `assert False` — no problem was recorded, and the marker file appeared.

**b. A room id was joined into a path unguarded.** `Rooms.folder()` built `data_root/rooms/<id>`. Room
ids are minted server-side (`secrets.token_urlsafe`), so this was not reachable through the HTTP API —
but it is the function a future caller reaches for. It now refuses anything that is not a plain folder
name: absolute paths, `..`, separators, empty.

- Test: `tests/test_regression_room_paths.py` (9 cases).
- Failed before: `Failed: DID NOT RAISE ValueError` ×8 with the old body restored.

Saves: every game writes through `kit.py`, which creates the table folder with
`mkdir(parents=True, exist_ok=True)` inside its own data root; no save path is taken from a request.
`exec(`/`eval(` do not appear in `shelf/`, `dashboard/`, `online/`, `kit.py` or any `*/game.py`.

## 3. The online lobby — key flow clean, disclosure fixed, origin accepted risk

**Recovery key.** Minted with `secrets.token_urlsafe(32)`; stored only as `sha256` hex
(`online/store.py::token_hash`); compared with `hmac.compare_digest`; input capped at 200 characters;
`PLAYER_COLUMNS` excludes `token_hash`, so no response or roster can carry it. Suspended accounts are
excluded from the token lookup, and `me_or_refusal` answers 403 rather than a bare 401.

**"Off until you turn it on" is true in the code.** Every request goes through
`online_source.GameCenter._call`, whose first statement is `if not self.on: return 0, {}`. There is no
second path to the network.

**The disclosure did not match the payload — fixed.** The paragraph said online play sends a named list
and nothing else; the client also posts the strategy cards a person publishes, their reports, their
blocks and their bot challenges. The sentence now names them (`shelf/online_source.py::DISCLOSURE`,
mirrored in `docs/ONLINE-PLAY.md` and `SECURITY.md`).

- Test: `tests/test_regression_disclosure.py` (3 tests).
- Failed before: `the disclosure does not mention: ['strategy', 'report', 'block', 'challenge']`.

**Origin checks — accepted risk, not a bug.** The WebSocket and the JSON API take no `Origin` check and
there is no CORS configuration. Authentication is a `Bearer` token held by the client, never a cookie, so
a page on another origin cannot act as the player: it has nothing to send. An origin allow-list would be
defence in depth, not a missing control. Recorded here so the decision is visible rather than assumed.

## 4. Wallet and bet economy — two bugs fixed, odds verified server-side

**A client cannot set its balance.** The plugin API exposes the bet (checked against `slotplay.BETS`),
the machine (checked against `slotplay.MACHINES`), two booleans, and `spin()` — which takes **no body**.
The reels, the paytable and the payout are computed in `shelf/slotplay.py`; `record_spin()` credits the
payout it is given, and the only caller is the server-side spin.

**a. Two top-ups could both deal a fresh stack.** `topup()` read the balance unlocked, then credited the
gap; a stale read (or two racing calls) paid twice. Proved: `assert 20000 == 10000`. Now the check and
the credit are one locked change.

**b. A held lock could wedge every bet forever.** `flock(LOCK_EX)` blocked with no deadline; a live
holder hung every payout with no error. Now a non-blocking retry loop with `LOCK_TIMEOUT_SECONDS = 10`
and a `TimeoutError` naming the wallet.

- Tests: `tests/test_regression_wallet_lock.py` (3 tests).
- Failed before: `topup paid twice from one stale read`; `has no attribute 'LOCK_TIMEOUT_SECONDS'`
  (then, with the constant added, the thread was still alive after 5 s).

Reads are atomic (`tmp` + `os.replace`), so a reader never sees half a wallet.

## 5. Agent-seat consent — one hardening fix, gate verified

The gate is `shelf/fair.py::blocked`, called by `Catalog.play` for **every** line that does not come
from a typed command. With `allow_ai: false` it refuses `new` with an AI side, `allow-ai`, `solo` and
`step`. A bot account cannot agree: `shelf/commands.py::_bot_refusal` refuses `allow-ai` from a bot.

A third-party `game.json` is data: the manifest carries id, title, summary, entry, factory, kind, route
and schema version — no seats, and it cannot add itself to Play, which reads only `shelf/curated.json`.
Its module is code the person installed deliberately, and it is imported only from inside its own folder
now (area 2a).

**a. A line the gate could not parse was allowed.** `shlex.split` failing on an unbalanced quote returned
`None` — "fine". Not reachable today (`shelf/commands.py::run` refuses unparseable lines first), but the
gate is the documented enforcement point and a game with a looser parser would seat the AI. It now
refuses anything it cannot read, for non-command sources only.

- Test: `tests/test_regression_consent_quoting.py` (3 tests).
- Failed before: `assert None` — an unbalanced quote was treated as harmless.

## 6. Third-party and vendor trees — checked, clean

- `third_party/textarena/` — MIT, `LICENSE` copied unchanged, upstream commit pinned, every deviation
  listed in `THIRD-PARTY-NOTICES.md` and `third_party/textarena/README.md`. It is **not** installed as a
  package: `talktable/ta_envs.py` puts `third_party/` on `sys.path`, drops any `textarena` another
  package already claimed, and raises `ImportError` if the module that loads is not the vendored copy.
- `vendor/chessnut/*.svg` — Apache-2.0, credited, inlined into the bundle between markers.
- `vendor/chess-openings/*.tsv` — CC0-1.0, compiled offline into `chessboard/openingbook.json` by
  `tools/make_chess_openings.py` (python-chess is GPL-3.0+ and is a dev-only tool, not shipped).
- No GPL/AGPL/EPL code in the tree.

## Lane claims that were not acted on

Each was read against the code or reproduced, then dismissed:

| Claim | Verdict |
|---|---|
| Sign-in "echoes the recovery key" and leaks it | Dismissed: the client sent that value in the same request, so the response adds no exposure. |
| Sending `sha256(key)` authenticates | False: `verify_secret` hashes its input, so a hash of a hash never matches. |
| `me_or_refusal`'s second query races the first | Dismissed: that query is the designed 403 path — the `suspended = 0` filter is deliberately absent there. |
| A huge `Bearer` header forces a hash of megabytes | Dismissed: aiohttp 3.14.3 caps a header field at 8190 bytes (`max_field_size`), so the handler never sees it. |
| `add_tokens` can spin a long loop under the lock | Not reachable in practice: the count is a per-reply usage report. Left as is. |
| `allow_ai` defaults to `True`, so AI seats bypass consent | Dismissed: `allow_ai` is the profile floor; consent is the per-table gate in `fair.py`, which the default does not skip. |

## Still open

- The `kalah` renderer, its preview branch and its entry in several tool lists remain in the tree after
  the game was removed. Removing them touches `tests/table_ui_harness.cjs` and four other test files, so
  it belongs in its own change rather than inside a security fix. Low severity: no code path produces
  `view: "kalah"` any more.

## Second round — four more, all fixed

A second pass with the lane models and the agent CLIs (Claude Code, Codex, Cursor/Grok, AGY/Argon) found
these, each reproduced before the fix:

1. **The lobby named people to signed-out callers.** `GET /api/lobby` returned `waiting`,
   `bots_waiting` and the `presence` roster — display names and ratings — to anyone with the URL. Tables,
   counts and the ladder stay public; names now need a sign-in.
   `tests/test_regression_lobby_roster.py` failed with Ada's name and rating in an anonymous payload.
2. **The jackpot leaderboard trusted its `limit`.** `int()` on a query value turned `?limit=abc` into a
   500, and a negative value is SQLite's "no limit", so `?limit=-1` returned the whole ledger with a
   correlated COUNT per row. Clamped to 1..500. `tests/test_regression_leaderboard_limit.py`.
3. **The helper cache keyed on the modification time alone.** Two different files with the same mtime
   (a copy, an archive with preserved times) made one file's module run under another's name. The key is
   now the resolved path plus the stamp. `tests/test_regression_fresh_cache.py`.
4. **A non-web address reached the operating system's handler.** `openInBrowser` passed the lobby setting
   or server data straight to `ctx.os.openExternal`, and `openTable` in the leagues tab did the same. Only
   `http(s)` may open now; anything else is refused with one sentence. `tests/table_ui_harness.cjs`
   (two assertions) failed while the guard was reverted.

Checked clean in the same round: the client builds every element as text (no `innerHTML`,
`dangerouslySetInnerHTML`, `outerHTML`, `insertAdjacentHTML` anywhere in `online/web` or `desktop/src`);
the arcade tile URL and repo are validated server-side; the WebSocket token arrives as the first message,
not in the URL; seat ownership, off-turn moves and unseated moves are refused (probe); `settle_pair_leg`
is idempotent per leg and the winner comes from the recorded state.
