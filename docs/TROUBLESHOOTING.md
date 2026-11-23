# Troubleshooting

_Applies to Game Center 1.0.0 · last revised 2026-11-23 (961c0389)_

Real failure modes the code handles or the README already names, and what to do about each.

## The Games page

| What you see | Why | What to do |
|---|---|---|
| No **Games** entry in the Desktop sidebar | The Desktop app has not reloaded the plugin. | Command palette (Ctrl+K) → **Reload desktop plugins**. If it is still missing, check `hermes plugins list` and run `hermes plugins validate .`. |
| The page sits on **Loading Game Center…** | The page is waiting for `/api/view`; on a cold start the catalogue imports every game module first. | Wait a few seconds. If it never arrives, reload desktop plugins and check the Hermes log for the plugin. |
| **404 Plugin not found** on Windows | Older builds imported `fcntl` unguarded in the wallet. Fixed on 2026-11-11. | Update to this version; the wallet now falls back to `msvcrt` on Windows. |
| A card opens but the board is empty | The game's `game.py` did not import. | The card normally says why in one sentence. Check that the game folder has `game.json` and an entry file inside its own folder. |
| **The table could not be saved** | Another program (a poll, an antivirus scan, a network folder) held the table's `state.json` open for longer than the two-second retry. | Nothing was staked: the chips a bet took are put back and no half-written file is left. Do the move again. Every save — the table state, the wallet, champions, the library, the lobby, tournaments, the playbook and the online source — retries the swap for about two seconds (`shelf/filelock.replace`). |

## AI seats, hints and models

| What you see | Why | What to do |
|---|---|---|
| **Play my agent**, **Hint** or **Improve** does nothing | Those features run through your Hermes model. | Set a model with `hermes model`, or **Settings → Models → Game Shelf opponent**. Any provider works, including a free one. |
| **Your agent needs your yes first** | An agent seat requires explicit consent. | Type `/games <game> allow-ai black=agent` as a person. A tool call cannot give that yes. |
| **Refused (consent_required).** | A model called a consent-only verb. | The person must type `new`, `join`, `allow-ai`, `lesson`, `review`, `hint` and the rest themselves. |
| **Refused (person_required).** | A bot account tried a person-only verb. | A bot may only use `state`, `board` and `help`. |
| **No game in progress** | There is no active table for that game. | Start one: `/games <game> new` or `/games <game> new white=human black=local`. |
| **A match is in progress** | Someone is already seated. | Finish it, or a seated person types `/games <game> abandon`. |
| **Refused (lesson)** | A lesson is open; it has its own verbs. | `/games <game> lesson next`, or start a new game. |
| **The AI moved instead of my model** | The model's answer was not a legal move, twice. | That is the documented fallback; the refusal is kept in the record. Check the model can follow the move format in the prompt. |

## Points, chips and slots

| What you see | Why | What to do |
|---|---|---|
| A bet or spin is refused | The bet is below 25 chips or above the balance. | Lower the bet, or cash points into chips at 75% in the Jackpot panel. |
| Points do not move after a win | The win bonus is 100 per win, never for a draw. | A resignation counts as a win; a draw does not. |
| Token points lag | Points pay one whole point per 100,000 tokens, and the remainder carries. | That is the documented arithmetic; the strip shows both totals. |
| The wallet seems stuck | Every change waits up to 10 seconds for the wallet lock (`shelf/wallet.py`). | Wait and retry. A stale `wallet.lock` is safe to remove when no Hermes process is running. |

## Online play

| What you see | Why | What to do |
|---|---|---|
| No match alerts pop up | This build has `ALERTS_OFF`: the status bar shows a quiet count, no notification is drawn. | The per-game switches in Settings are still saved; alerts are a known gap, not a broken switch. |
| The bot ladder is missing | This build has `PANE_LADDER_OFF`: rated bot-versus-bot is not proven end to end. | Local play and online person-versus-person are unaffected. |
| The dock says the server is down in one sentence | `lobby_url` is unreachable. | Nothing local stops working. Check the address, your network, or turn online play off. |
| Sign-in fails after reinstalling | The recovery key is shown once and kept in Hermes's credential store. | Sign in with the key if you saved it, or create a new player. Game Center never writes the key to its own data folder; only the account file you choose to save holds it, in Downloads. |
| **Let people invite me** is greyed out | The switch is drawn from the lobby socket, so it is held while there is nothing to write to. The sentence beside it says which: "Sign in above first." (no account on this computer) or "Lobby not connected — Retry". | Sign in under **Get online**, then press **Retry** beside the switch — the shelf dials at once, without waiting out a backoff. A sign-in, a Retry and opening the Games page all dial now; until this fix they left a waiting socket alone, so the switch could stay grey for a minute after signing in. |
| A self-hosted lobby is refused | The plugin only sends to the `lobby_url` you set. | Point `lobby_url` at your server and see [HOSTING.md](HOSTING.md). |
| A table or a person looks stuck on a lobby you run | The server can be read without changing it. | [HOSTING.md](HOSTING.md) — Troubleshooting a live server: `tools/gc-server-doctor.sh`, or `/admin/doctor` with the staff key. |

## The Champions tab and Experimental

| What you see | Why | What to do |
|---|---|---|
| The **Champions** tab says the matches do not run | It is a placeholder in this version. | Nothing to fix. Play and Experimental are unaffected. |
| Every Experimental card is locked | The shelf is a shop window, not a door. | Start the talking tables from chat (`/games mafia new`). A game that is not in `shelf/curated.json` cannot reach Play. |

## The diagnostic log

Game Center keeps its own log, `game-center.log`, in the plugin's data folder — the same folder
its state lives in, never the install folder. That folder is `<Hermes home>/plugin-data/hermes-gameshelf/`:
`~/.hermes/plugin-data/hermes-gameshelf/game-center.log` on Linux and macOS, and
`%LOCALAPPDATA%\hermes\plugin-data\hermes-gameshelf\game-center.log` on Windows
(`%USERPROFILE%\AppData\Local\hermes\plugin-data\hermes-gameshelf\` when `LOCALAPPDATA` is unset).
A profile or `HERMES_HOME` changes `<Hermes home>`, so the exact path is whatever Hermes reports as its
home. It rotates at 1 MB and keeps three older files (`game-center.log.1` … `.3`). Keys and tokens —
tracebacks included — are replaced with `***` as the line is written. Names, lobby addresses and local
paths are **not** masked, so read the file before sharing it. A lobby server you host yourself writes the
same health, slow-request and error lines to its own logger (journald when it runs as a service), not to
this file.

| Line | What it means | What to do |
|---|---|---|
| `health rss=…MB threads=… lobby_sockets=…` | One snapshot every 5 minutes while the plugin runs: the process's resident memory, its thread count, and the lobby sockets it holds open. | Nothing — it is the baseline a problem is measured against. |
| `WARNING … memory keeps growing (+…MB over 6 samples)` | Memory grew on 6 samples in a row (half an hour), more than 50 MB together. Something may be leaking. | Restart Hermes when convenient; if it returns, report it with the log attached. |
| `ERROR … REST handler … failed` + traceback | A request from the Games page or the pane crashed. The page shows its own refusal; the traceback names the cause. | Read the traceback's last line; report it with the log if it repeats. |
| `ERROR … the automatic spin … did not run` / `the win bonus was not awarded` | A chat hook hit an error. It is swallowed: the turn or the game continues. | Only worth reporting if it repeats. |
| `WARNING … slow request … took …s` | One request took longer than 2 seconds. | A cold start or a busy disk explains one; a run of them is worth reporting. |
| `lobby connect …` / `lobby disconnect …` / `lobby reconnect in …s` | The online lobby socket opened, dropped, or is dialing again. | Reconnects after a network drop are normal; only continuous failures mean the server is unreachable. |
| `desktop error: …` / `desktop rejection: …` | A crash inside the Games page or the side pane — only Game Center's own code is reported, never the host app's. At most 20 lines a minute. | The boundary card offers a way out; report the line if the crash repeats. |
| `desktop heap used=…MB` | The browser's JavaScript heap, every 5 minutes while a Game Center surface is open (only where the browser offers `performance.memory`). | A number that climbs without coming down is worth reporting with the log. |

## Sending the log

Attach `game-center.log` (and the numbered backups if the problem started before the current file) to a
GitHub issue using the repository's bug-report template, or to a private report through GitHub's
**Security → Report a vulnerability** form when the problem is a security issue. Include your OS, the
output of `hermes --version`, the version chip text from Settings (click it to copy), and the steps that
reproduced the problem. Never put a working exploit in a public issue.
[CONTRIBUTING.md](../.github/CONTRIBUTING.md) has the full reporting instructions.

## Development and test runs

| What you see | Why | What to do |
|---|---|---|
| The browser QA page never loads | It fetches pinned React modules from the network by default. | Set `GAMESHELF_REACT_ASSETS=online/web/vendor` (a vendored copy ships there) or allow the network. |
| A browser harness cannot find Chrome | The harness looks at `CHROME_BIN`, then `/opt/google/chrome/chrome`, then `google-chrome`. | Install Chrome or set `CHROME_BIN`. |
| A hint-budget test fails by milliseconds | `LIMITS.md` documents a 0.4-second timing margin on a loaded machine. | Re-run it before believing it; if it fails on an idle machine, it is a real bug. |
| A difficulty strength test fails | Checkers and Reversi search against a clock, so a busy box can cut the search short. | `GAMESHELF_BOT_DETERMINISTIC=1` drops the clock for a reproducible run; see [../VERIFY.md](../VERIFY.md). |
| `desktop/plugin.js is out of date` | A part under `desktop/src/` changed without a rebuild. | `python3 tools/build_plugin.py`. |

Back to [docs/README.md](README.md).
