# Troubleshooting

_Applies to Game Center 1.0.0 · last revised 2026-11-11 (b2a67f2c)_

Real failure modes the code handles or the README already names, and what to do about each.

## The Games page

| What you see | Why | What to do |
|---|---|---|
| No **Games** entry in the Desktop sidebar | The Desktop app has not reloaded the plugin. | Command palette (Ctrl+K) → **Reload desktop plugins**. If it is still missing, check `hermes plugins list` and run `hermes plugins validate .`. |
| The page sits on **Loading Game Center…** | The page is waiting for `/api/view`; on a cold start the catalogue imports every game module first. | Wait a few seconds. If it never arrives, reload desktop plugins and check the Hermes log for the plugin. |
| **404 Plugin not found** on Windows | Older builds imported `fcntl` unguarded in the wallet. Fixed on 2026-11-11. | Update to this version; the wallet now falls back to `msvcrt` on Windows. |
| A card opens but the board is empty | The game's `game.py` did not import. | The card normally says why in one sentence. Check that the game folder has `game.json` and an entry file inside its own folder. |

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
| Sign-in fails after reinstalling | The recovery key is shown once and kept in Hermes's credential store. | Sign in with the key if you saved it, or create a new player. Game Center never writes the key to its own file. |
| A self-hosted lobby is refused | The plugin only sends to the `lobby_url` you set. | Point `lobby_url` at your server and see [HOSTING.md](HOSTING.md). |

## The Champions tab and Experimental

| What you see | Why | What to do |
|---|---|---|
| The **Champions** tab says the matches do not run | It is a placeholder in this version. | Nothing to fix. Play and Experimental are unaffected. |
| Every Experimental card is locked | The shelf is a shop window, not a door. | Start the talking tables from chat (`/games mafia new`). A game that is not in `shelf/curated.json` cannot reach Play. |

## Development and test runs

| What you see | Why | What to do |
|---|---|---|
| The browser QA page never loads | It fetches pinned React modules from the network by default. | Set `GAMESHELF_REACT_ASSETS=online/web/vendor` (a vendored copy ships there) or allow the network. |
| A browser harness cannot find Chrome | The harness looks at `CHROME_BIN`, then `/opt/google/chrome/chrome`, then `google-chrome`. | Install Chrome or set `CHROME_BIN`. |
| A hint-budget test fails by milliseconds | `LIMITS.md` documents a 0.4-second timing margin on a loaded machine. | Re-run it before believing it; if it fails on an idle machine, it is a real bug. |
| A difficulty strength test fails | Checkers and Reversi search against a clock, so a busy box can cut the search short. | `GAMESHELF_BOT_DETERMINISTIC=1` drops the clock for a reproducible run; see [../VERIFY.md](../VERIFY.md). |
| `desktop/plugin.js is out of date` | A part under `desktop/src/` changed without a rebuild. | `python3 tools/build_plugin.py`. |

Back to [docs/README.md](README.md).
