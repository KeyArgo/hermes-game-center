# tools/

Everything here is a **developer or release tool**. None of it is imported by the
plugin at runtime, and nothing here is a game. Three kinds live in this folder;
the `pytest` suite touches only the first two.

## 1. Release path — the build and the gate

| File | What it is |
|---|---|
| `build_plugin.py` | Concatenates `desktop/src/NN-*.js` into `desktop/plugin.js`. Pinned by `tests/test_plugin_bundle.py`. |
| `ship_gate/` | The release gate: per-surface play/exit/hygiene/clear/looks/buttons checks, writing `ship_gate.json`, `shelf/ship.json` and `SHIP-GATE.md`. Pinned by `tests/test_ship_gate.py` and `tests/test_regression_ship_gate_inventory.py`. |

## 2. Developer harness — code shipped, run by hand or by a test

| File | What it is |
|---|---|
| `browser_drive.mjs` | Drives the real page in muted headless Chrome over CDP; used by `tests/browser_table_checks.py` and `tests/test_browser_click_play.py`. |
| `check_game.py` | Checks one game against the Play contract; used by `tests/test_ia.py` and `tests/test_check_game_session.py`. |
| `chess_pieces.py` | Regenerates the inline piece art from the vendored chessnut SVGs; pinned by `tests/test_piece_art.py`. |
| `playthrough.py` | Plays every game to the end through the dashboard API — the same path the desktop page uses. |
| `make_learn.py` | Writes each game's `learn.json` from the content in the script. |
| `make_chess_openings.py` | Builds `chessboard/openingbook.json` from the vendored lichess TSV openings (offline; python-chess is GPL-3.0+ and is not shipped). |
| `agent_seat_check.py` | Asks whether "Play my agent" really runs and falls back cleanly on a bad model answer. |
| `realmodel_summary.py` | Summarises the ledgers `tests/test_realmodel_play.py` writes. |

## 3. One-off browser proofs — history, not a command anyone should expect to work

These prove a surface once, with a real headless Chrome and real pointer events,
against a URL you pass in. They are kept because `docs/history/*.md` quotes their
output and `tools/ship_gate` names some of them as drivers. They are not
collected by `pytest`, they are not part of the build, and several need a local
lobby (`leagues_proof_prep.py`, `ob_proof_prep.py`) or a browser on the box.

`ad_desktop_proof.mjs`, `ad_proof.mjs`, `browser_lobby_proof.mjs`,
`browser_open_in_browser_proof.mjs`, `champions_proof.mjs`, `coach_proof.mjs`,
`gg_arena_proof.mjs`, `gg_room_proof.mjs`, `ld_proof.mjs`, `leagues_proof.mjs`,
`mafia-town-proof.mjs`, `owner_fixes_drive.mjs`, `seabattle_drive.mjs`,
`sp_pane_proof.mjs`, `think_proof.mjs`, `tu_learn_proof.mjs`, `ux_tour.sh`,
`coach_mover.py`, `coach_sanity.py`, `leagues_proof_prep.py`, `ob_proof_prep.py`.

**`petbattles-proof.mjs` is the exception that proves the point:** Pet Battles was
removed from the product, so this script can no longer prove anything. It is kept
only because `docs/history/` cites it; the ship gate no longer lists Pet Battles
as a surface.

## Not here any more

`build_trial/` (415 files of a past model-versus-build experiment) moved to
`docs/history/build_trial/`. It was never a tool; it was evidence for numbers in
`docs/history/RESULTS.md`, and it made `tools/` look fifteen times larger than the
build actually is.
