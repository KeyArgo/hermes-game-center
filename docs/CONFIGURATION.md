# Configuration

_Applies to Game Center 1.0.0 · last revised 2026-11-12 (98b7528b)_

Every setting, environment variable and stored preference the code reads, with the default it uses.

## The plugin's config keys

These are declared in `plugin.yaml` and read through `ctx.get_config` in `__init__.py` or `_settings()` in `dashboard/plugin_api.py`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `allow_ai` | bool | `true` | Off means no game may seat an AI. On still requires a person to agree (`/games allow-ai …`) before an AI faces a human. Game Center's own Settings can override this per profile. |
| `doom_wad` | string | `""` | Path to a Doom `.wad`. Empty uses the free Freedoom files when they are installed. |
| `submit_url` | string | `https://games.hermesnet.xyz/submit` | Where **Submit your game** goes. Only an `https` address is used; empty falls back to the guide link. |
| `submit_docs_url` | string | `""` | A web page with the submission guide, shown when `submit_url` is empty. Must be `https`. |
| `lobby_url` | string | `https://games.hermesnet.xyz` | Where online play and match alerts connect. A self-hosted lobby works here. |
| `lobby_key` | secret | `""` | The online recovery key. Stored through Hermes's credential route; also readable from `HERMES_GAMESHELF_LOBBY_KEY`. |
| `bot_key` | secret | `""` | The ladder bot key the lobby issued when the bot was created. Stored through Hermes's credential route; also readable from `HERMES_GAMESHELF_BOT_KEY`. |
| `staff_key` | secret | `""` | The lobby's staff (moderation) key, when the account has one. Stored through Hermes's credential route; also readable from `HERMES_GAMESHELF_STAFF_KEY`. |

All three credential fields are `type: secret`: Hermes shows them in Settings as write-only fields, keeps the value in the person's own credentials, and never prints it back. `tests/test_config_secrets.py` fails if the code stores a credential that the manifest does not declare.

`_settings()` reads each value from the plugin entry's `settings` first, then its `config`, then the default. `apply_choice()` in `shelf/setup.py` lets the person's **Settings → AI seats** choice win over the plugin config in chat too.

## Settings saved in the plugin data folder

| File | Key | Default | What it does |
|---|---|---|---|
| `setup.json` | `seen` | `false` | Whether the first-run welcome was answered or skipped. |
| `setup.json` | `watched` | `{}` | Per-game match-alert switches. |
| `setup.json` | `paused` | `false` | "Pause all of these" on Settings. |
| `setup.json` | `ai` | `null` | `true`/`false` pins the AI-seat choice; `null` follows `allow_ai`. |
| `wallet.json` | `bet` | `25` | The last slot bet (minimum 25 chips). |
| `wallet.json` | `overchat` | `false` | Whether the see-through slot cabinet is shown over the chat. |
| `wallet.json` | `overchat_alpha` | `0.2` | Over-chat opacity; accepted values are 0.05–0.6. |
| `wallet.json` | `overchat_scale` | `1.0` | Over-chat size; accepted values are 0.1–3.0. |
| `wallet.json` | `machine` | `fruit9` | The machine auto-spin plays: `fruit9` (Classic) or the Olympus machine. |
| `online.json` | `on` | `false` | Whether online play is on. |

The rest of `wallet.json` is bookkeeping: chips, points under `bonus`, token counters, spins, streaks, the recent spin feed and which surfaces currently show a machine.

## Environment variables

| Variable | Read by | What it does |
|---|---|---|
| `HERMES_GAMESHELF_LOBBY_KEY` | `shelf/online_source.py` | The online recovery key, through Hermes's credential route. Also the `lobby_key` config field's env name. |
| `HERMES_GAMESHELF_BOT_KEY` | `shelf/online_source.py` | The key for this agent's ladder bot. Created once and reused; there is no rotation or deletion. |
| `HERMES_GAMESHELF_STAFF_KEY` | `shelf/online_source.py` | A staff key for the lobby's moderation views, when the account has one. |
| `HERMES_GAMESHELF_EGG` | `shelf/eggs.py` | Force one Easter egg by id (developer/testing). |
| `HERMES_GAMESHELF_EGG_FORCE_FILE` | `shelf/eggs.py` | The file holding a forced egg id; default `~/.hermes/gameshelf-egg-force`. |
| `HERMES_HOME` | `shelf/catalog.py`, `doctrine/profiles.py` | The Hermes home to scan. Wins outright over the default `~/.hermes`, so a test or a second install stays isolated. |
| `HERMES_PROFILE` | `shelf/catalog.py` | Adds `<home>/profiles/<profile>/plugins` to the plugin scan. |
| `GAMESHELF_IGNORE_SHIP` | `shelf/catalog.py` | `1` ignores the ship gate when listing games (developer). |
| `GAMESHELF_BOT_DETERMINISTIC` | `checkers/game.py`, `reversi/game.py` | `1` drops the bot's per-move clock and runs to the depth cap, for reproducible runs. Slower. |
| `PLAYIT_HOST` | `shelf/directory.py` | A Playit hostname for vendor worlds; stored in `directory.json` when set. |

## Offline server and tool variables

These are for running the lobby or the browser proofs, never for the plugin's normal operation.

| Variable | Used by | What it does |
|---|---|---|
| `CHROME_BIN` | `tests/*.mjs`, `tools/*.mjs` | The Chrome binary for the browser harnesses. Else `/opt/google/chrome/chrome`, else `google-chrome`. |
| `GAMESHELF_REACT_ASSETS` | `tests/browser_table_server.py` | A folder with `react.mjs`, `jsx-runtime.mjs`, `react-dom.mjs`, `client.mjs` and `scheduler.mjs`, so the QA page does not fetch the pinned React modules from the network. `online/web/vendor/` holds a copy. |
| `GAMESHELF_QA_URL` | `tools/browser_drive.mjs` | The URL of an already-running QA page. |
| `GAMESHELF_QA_OUT` | `tests/browser_table_checks.py` | Where browser checks write their screenshots and text. |
| `GAMESHELF_GLM_URL`, `GAMESHELF_GLM_MODEL`, `GAMESHELF_GLM_MAX_TOKENS` | `tests/test_realmodel_play.py` | The live model used only when `pytest --realmodel` is asked for. |

## The online server's flags

`python -m online.server` takes its configuration on the command line, not from these files.

| Flag | Default | What it does |
|---|---|---|
| `--data DIR` | required | Folder for `online.sqlite3` and room tables. |
| `--host` | `127.0.0.1` | Address to bind. |
| `--port` | `8790` | Port to bind. |
| `--trust-proxy` | off | Read the client address from `X-Real-IP` behind nginx. |
| `--signups-per-hour` | `20` | New players allowed per address per hour. |
| `--api-per-minute` | `120` | HTTP API requests allowed per address per minute. |

Back to [docs/README.md](README.md).
