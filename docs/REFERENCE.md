# Reference

_Applies to Game Center 1.0.0 · last revised 2026-11-12 (54c502d6)_

Every tool, command, hook, HTTP route and config key the plugin exposes, in tables. The prose for each setting is in [CONFIGURATION.md](CONFIGURATION.md).

## The model tool

Registered in `__init__.py` with `ctx.register_tool`.

| Tool | Toolset | Parameters | Returns |
|---|---|---|---|
| `games_play` | `hermes_gameshelf` | `game` (string, required), `line` (string, required, such as `move e4`) | JSON `{"ok": true, "text": "<reply>"}`; `{"ok": false, "reason": "bad_args"}` for a non-object argument. |

The handler runs the line through `shelf/commands.py` with `source="tool"`. Consent-only verbs (`new`, `join`, `sit`, `leave`, `resign`, `draw`, `rematch`, `abandon`, `allow-ai`, `lesson`, `learn`, `review`, `hint`) are refused for a tool call.

## Chat commands

| Command | Registered by | What it does |
|---|---|---|
| `/games` | `__init__.py` | The shelf. Bare `/games` lists the games; `/games <game> <line>` routes to the game. |
| `/eggs` | `__init__.py`, only when a developer key or an egg-force file is present in the profile's plugin data folder | Developer Easter-egg cheat: `list`, `show <id>`, `clear`, `claim <id>`, `reset`. Not shipped armed. |

### `／games` verbs

The shelf verbs are in `shelf/commands.py`; the table verbs are in `kit.py`.

| Verb | Example | What it does |
|---|---|---|
| `install` / `get` | `/games install connect4` | Add a catalogue title to this profile. |
| `remove` / `uninstall` | `/games remove connect4` | Remove an added title. |
| `name` | `/games name Argo` | Set the local display name. |
| `looking` | `/games looking connect4` | Announce or list who wants a game. `looking stop` clears it. |
| `chat` | `/games chat hello` | Talk in the local lobby. |
| `host` | `/games host …` | Host a vendor world address. |
| `match` | `/games match connect4` | Says matchmaking across games is coming soon. |
| `doom` | `/games doom …` | Doom launch/lobby words, when Doom is installed. |
| `doctrine import` | `/games doctrine import {…}` | Import a Doctrine card as raw JSON. |
| `new` | `/games chess new white=human black=local` | Start a table. Seats are `human`, `local` (built-in player) or `agent` (with `allow-ai`). `level=` picks a level. |
| `join` | `/games chess join` | Take the open seat. |
| `sit` | `/games chess sit black` | Choose a side. |
| `leave` | `/games chess leave` | Open your seat before play. |
| `move` | `/games chess move e2e4` | Make a move. The game decides the notation it accepts. |
| `state` / `board` | `/games chess state` | Show the table and move history. |
| `hint` | `/games chess hint` | One hint; only you vs the built-in player, on your turn. |
| `lesson` / `learn` | `/games chess lesson` then `lesson next` | Walk the lesson. |
| `step` | `/games chess step` | Advance one lesson step. |
| `review` | `/games chess review` | Review one move you could have played better. |
| `resign` | `/games chess resign` | Resign your seat. |
| `draw` | `/games chess draw`, `draw accept` | Offer or accept a draw. |
| `rematch` | `/games chess rematch` | Ask for a rematch (both identified people must agree). |
| `abandon` | `/games chess abandon` | End the table without awarding a win. |
| `allow-ai` | `/games chess allow-ai black=local` or `black=agent` | Consent to an AI seat. `level=beginner\|intermediate\|advanced\|expert` also works. |

## Hooks

| Hook | Handler | What it does |
|---|---|---|
| `pre_llm_call` | `earn_pull` in `__init__.py` | With auto-spin on, takes one spin for a new turn, only while a machine is on screen. One spin per `turn_id`; any failure is swallowed. |
| `pre_tool_call` | `earn_tool` in `__init__.py` | Auto-spin at most once per 1.2 seconds across a burst of tool calls. |
| `post_api_request` | `earn_tokens` in `__init__.py` | Counts tokens from the reply's usage once per `api_request_id`, pays 1 point per 100,000 tokens, and may size an automatic bet from the reply. |

The hooks return no text, so the prompt is untouched. The win bonus is a kit sink (`kit_module.set_bonus_sink`), not a hook: every won game credits 100 points to the local wallet.

## Auxiliary model slot

| Slot | Display name | What it does |
|---|---|---|
| `gameshelf_opponent` | Game Shelf opponent | The model used by **Play my agent**, **Improve** and other model-backed features. Unset, it follows the main model. Registered with `ctx.register_auxiliary_task` when Hermes supports it. |

## Desktop plugin HTTP API

`dashboard/plugin_api.py` defines a FastAPI `APIRouter`; Hermes mounts it under `/api` (the browser QA server also mounts it with `prefix='/api'`). The handler names are the Python functions in that file.

| Method | Path | Handler |
|---|---|---|
| `GET` | `/api/setup` | `setup_state` |
| `POST` | `/api/setup` | `setup_save` |
| `POST` | `/api/settings` | `settings_save` |
| `GET` | `/api/alerts` | `alerts` |
| `POST` | `/api/alerts/dismiss` | `alerts_dismiss` |
| `GET` | `/api/about` | `about` |
| `GET` | `/api/v1/version` | `version_route` |
| `GET` | `/api/view` | `view` |
| `GET` | `/api/jackpot` | `jackpot` |
| `POST` | `/api/jackpot/autoplay` | `jackpot_autoplay` |
| `POST` | `/api/jackpot/autobet` | `jackpot_autobet` |
| `POST` | `/api/jackpot/machine` | `jackpot_machine` |
| `POST` | `/api/jackpot/bet` | `jackpot_bet` |
| `POST` | `/api/jackpot/prefs` | `jackpot_prefs` |
| `POST` | `/api/jackpot/visible` | `jackpot_visible` |
| `POST` | `/api/jackpot/spin` | `jackpot_spin` |
| `POST` | `/api/jackpot/cashin` | `jackpot_cashin` |
| `GET` | `/api/eggs` | `eggs` |
| `POST` | `/api/eggs/claim` | `eggs_claim` |
| `POST` | `/api/jackpot/bailout` | `jackpot_bailout` |
| `POST` | `/api/jackpot/points/cash` | `jackpot_points_cash` |
| `GET` | `/api/learn` | `learn` |
| `GET` | `/api/board` | `board` |
| `POST` | `/api/command` | `command` |
| `POST` | `/api/doctrine/import` | `doctrine_import` |
| `POST` | `/api/talk/import` | `talk_import` |
| `GET` | `/api/online` | `online_view` |
| `POST` | `/api/online/on` | `online_on` |
| `POST` | `/api/online/off` | `online_off` |
| `POST` | `/api/online/signup` | `online_signup` |
| `POST` | `/api/online/signin` | `online_signin` |
| `POST` | `/api/online/forget` | `online_forget` |
| `POST` | `/api/online/table/open` | `online_table_open` |
| `GET` | `/api/online/table` | `online_table_view` |
| `POST` | `/api/online/table/cmd` | `online_table_cmd` |
| `POST` | `/api/online/table/chat` | `online_table_chat` |
| `POST` | `/api/online/table/close` | `online_table_close` |
| `GET` | `/api/online/hall` | `online_hall_view` |
| `POST` | `/api/online/hall/prefs` | `online_hall_prefs` |
| `POST` | `/api/online/hall/looking` | `online_hall_looking` |
| `POST` | `/api/online/hall/request` | `online_hall_request` |
| `POST` | `/api/online/hall/respond` | `online_hall_respond` |
| `POST` | `/api/online/hall/cancel` | `online_hall_cancel` |
| `POST` | `/api/online/queue` | `online_queue` |
| `POST` | `/api/online/queue/stop` | `online_queue_stop` |
| `POST` | `/api/online/match/close` | `online_match_close` |
| `POST` | `/api/online/alerts` | `online_alert` |
| `GET` | `/api/online/ladder` | `online_ladder` |
| `POST` | `/api/online/ladder` | `online_ladder_start` |
| `GET` | `/api/online/league` | `online_league` |
| `POST` | `/api/online/challenge` | `online_challenge` |
| `POST` | `/api/online/challenge/decline` | `online_challenge_decline` |
| `POST` | `/api/online/cards` | `online_card_save` |
| `POST` | `/api/online/bout` | `online_bout` |
| `GET` | `/api/online/cards/public` | `online_cards_public` |
| `GET` | `/api/online/bout/replay` | `online_bout_replay` |
| `GET` | `/api/online/staff` | `online_staff` |
| `POST` | `/api/online/staff` | `online_staff_set` |
| `POST` | `/api/online/staff/clear` | `online_staff_clear` |
| `GET` | `/api/online/admin/overview` | `online_admin_overview` |
| `GET` | `/api/online/admin/reports` | `online_admin_reports` |
| `GET` | `/api/online/admin/user` | `online_admin_user` |
| `GET` | `/api/online/admin/users` | `online_admin_users` |
| `GET` | `/api/online/admin/audit` | `online_admin_audit` |
| `POST` | `/api/online/admin/action` | `online_admin_action` |
| `POST` | `/api/online/report` | `online_report` |
| `GET` | `/api/online/blocks` | `online_blocks` |
| `POST` | `/api/online/blocks` | `online_blocks_add` |
| `POST` | `/api/online/blocks/remove` | `online_blocks_remove` |
| `GET` | `/api/champions` | `champions_view` |
| `POST` | `/api/champions/save` | `champions_save` |
| `POST` | `/api/champions/delete` | `champions_delete` |
| `POST` | `/api/champions/export` | `champions_export` |
| `POST` | `/api/champions/import` | `champions_import` |
| `POST` | `/api/tournament/start` | `tournament_start` |
| `GET` | `/api/tournament/status` | `tournament_status` |
| `POST` | `/api/tournament/stop` | `tournament_stop` |
| `POST` | `/api/tournament/export` | `tournament_export` |
| `GET` | `/api/tournament/replay` | `tournament_replay` |
| `POST` | `/api/tournament/import` | `tournament_import` |
| `GET` | `/api/models` | `models_view` |
| `GET` | `/api/playbook` | `playbook_view` |
| `POST` | `/api/playbook/save` | `playbook_save` |
| `POST` | `/api/playbook/select` | `playbook_select` |
| `POST` | `/api/playbook/test` | `playbook_test_start` |
| `GET` | `/api/playbook/test` | `playbook_test_status` |
| `GET` | `/api/pet` | `pet_view` |
| `GET` | `/api/pet/cells` | `pet_cells` |
| `GET` | `/api/pet/gallery` | `pet_gallery` |
| `GET` | `/api/pet/thumb` | `pet_thumb` |
| `POST` | `/api/online/slots/spin` | `slots_spin` |
| `GET` | `/api/online/slots/balance` | `slots_balance` |
| `GET` | `/api/online/slots/leaderboard` | `slots_leaderboard` |


## Online server HTTP API

`online/server.py` is an aiohttp application. It is a separate service, started with `python -m online.server --data DIR`; the plugin only talks to it when online play is on. `/api/admin/{path:.*}` is a wildcard into `online/admin.py`.

| Method | Path | Handler |
|---|---|---|
| `GET` | `/` | `index` |
| `GET` | `/t/{room}` | `index` |
| `GET` | `/b/{bot}` | `index` |
| `GET` | `/board.js` | `board_js` |
| `GET` | `/api/health` | `health` |
| `ROUTE` | `*` | `` |
| `POST` | `/api/reports` | `report` |
| `GET` | `/api/blocks` | `blocks` |
| `POST` | `/api/blocks` | `blocks` |
| `DELETE` | `/api/blocks/{player}` | `blocks` |
| `GET` | `/api/availability` | `availability` |
| `POST` | `/api/availability` | `availability` |
| `GET` | `/api/requests` | `play_requests` |
| `POST` | `/api/requests` | `play_requests` |
| `POST` | `/api/requests/{id}` | `play_request` |
| `POST` | `/api/session` | `session` |
| `GET` | `/api/me` | `get_me` |
| `POST` | `/api/me` | `post_me` |
| `GET` | `/api/games` | `games` |
| `GET` | `/api/lobby` | `lobby` |
| `GET` | `/api/lobby/socket` | `hub.socket` |
| `GET` | `/api/lobby/chat` | `lobby_chat` |
| `POST` | `/api/lobby/chat` | `lobby_chat` |
| `GET` | `/api/leaderboard` | `leaderboard` |
| `GET` | `/api/leaderboard/jackpot` | `jackpot_leaderboard` |
| `GET` | `/api/bots` | `list_bots` |
| `GET` | `/api/bots/{bot}` | `bot_career` |
| `GET` | `/api/passports` | `passports` |
| `POST` | `/api/ladder` | `ladder` |
| `GET` | `/api/ladder` | `ladder_summary` |
| `GET` | `/api/open-league` | `open_league` |
| `GET` | `/api/spectate` | `spectate` |
| `GET` | `/api/matches/{room}/{no}` | `match_replay` |
| `GET` | `/api/stock-league` | `stock_league` |
| `GET` | `/api/challenges` | `challenges` |
| `POST` | `/api/bots/{bot}/challenge` | `challenge_bot` |
| `POST` | `/api/challenges/{challenge}/decline` | `decline_challenge` |
| `GET` | `/api/cards` | `strategy_cards` |
| `POST` | `/api/cards` | `strategy_cards` |
| `POST` | `/api/card-arena` | `card_arena` |
| `GET` | `/api/card-arena/{bout}` | `card_bout` |
| `GET` | `/api/cards/public` | `public_cards` |
| `GET` | `/api/queue` | `queue_endpoint` |
| `POST` | `/api/queue` | `queue_endpoint` |
| `DELETE` | `/api/queue` | `queue_endpoint` |
| `GET` | `/api/alerts` | `alerts` |
| `POST` | `/api/alerts` | `alerts` |
| `GET` | `/api/balance` | `balance` |
| `POST` | `/api/balance` | `balance` |
| `POST` | `/api/bots` | `create_bot` |
| `DELETE` | `/api/bots/{bot}` | `delete_bot` |
| `GET` | `/api/arcade` | `arcade_list` |
| `POST` | `/api/arcade/remove` | `arcade_remove` |
| `POST` | `/api/arcade/check` | `arcade_check` |
| `POST` | `/api/rooms` | `create_room` |
| `GET` | `/api/rooms/{room}` | `get_room` |
| `GET` | `/ws/{room}` | `socket` |
| `GET` | `/app.js` | `` |
| `GET` | `/sdk-shim.js` | `` |
| `GET` | `/style.css` | `` |
| `GET` | `/hall.css` | `` |
| `GET` | `/icon.svg` | `` |
| `GET` | `/favicon.ico` | `` |
| `*` | `/api/admin/{path:.*}` | `online/admin.py` wildcard |


## Stored keys

The full list with defaults is in [CONFIGURATION.md](CONFIGURATION.md). The config keys declared in `plugin.yaml` are `allow_ai`, `doom_wad`, `submit_url`, `submit_docs_url`, `lobby_url` and `lobby_key`.

Back to [docs/README.md](README.md).
