# Testing

_Applies to Game Center 1.0.0 · last revised 2026-11-18 (06ce6970)_

How to run every suite, what each one covers, and the counts measured on this commit.

## Run everything

```bash
python3 -m pytest tests -q -p no:cacheprovider   # the Python suite, offline
python3 tools/build_plugin.py                    # the committed bundle must match desktop/src/
node tests/table_ui_harness.cjs                  # the Desktop page's state machine
node tests/jackpot_overlay_harness.cjs           # the over-chat slot cabinet
node tests/jackpot_overlay_poll_harness.cjs      # how often the over-chat machine asks the shelf
node tests/jackpot2_harness.cjs                  # the Jackpot v2 copy, its switch and the fit
node tests/jackpot2_look_harness.cjs             # the Jackpot v2 tint, and the ink it keeps readable
node tests/inference_autoplay_harness.cjs        # the Inference Slot Machine button, and the backdrop's height
node tests/timers_harness.cjs                    # every surface closes its clocks
node tests/submit_harness.cjs                    # add your own game: the form and the issue it builds
node tests/slot_fit_regression.mjs               # fits the page, in real headless Chrome
scripts/test.sh                                  # all of the above, plus the Chrome fit check
scripts/test.sh --fast                           # skip the Chrome fit check
```

CI (`.github/workflows/tests.yml`) runs the pytest suite and the seven Node harnesses on Python 3.13: `table_ui_harness.cjs`, `jackpot_overlay_harness.cjs`, `jackpot2_harness.cjs`, `jackpot2_look_harness.cjs`, `inference_autoplay_harness.cjs`, `timers_harness.cjs` and `submit_harness.cjs`. `tests/test_inference_autoplay.py` runs the autoplay harness from the suite as well, so it is covered twice. The Chrome fit check is a local/owner check, not a CI step.

## Counts at this commit

Measured on 2026-11-14 at commit `4d49f59` with `python3 -m pytest tests -q -p no:cacheprovider` and the Node harnesses, from a clean checkout.

| Suite | Command | Result |
|---|---|---|
| Python suite | `python3 -m pytest tests -q -p no:cacheprovider` | **1701 passed, 28 skipped** in 1165.65 s (19:25) |
| Desktop page harness | `node tests/table_ui_harness.cjs` | **82 checks passed, 0 failed** |
| Over-chat slot harness | `node tests/jackpot_overlay_harness.cjs` | **7 checks passed, 0 failed** |
| Combined badge count | pytest + the two harnesses | **1790 passing** |
| Slot fit regression (not in CI) | `node tests/slot_fit_regression.mjs` | one headless-Chrome check; see below |
| Over-chat live render | `node tests/overchat_slot_live.mjs` (or `pytest tests/test_overchat_slot_live.py`) | real React: off -> on, resize, off, no status bar, trapped |
| Pane fill (300/320/368/640/720/1000 px) | `node tests/pane_fill_checks.mjs` (or `pytest tests/test_pane_fill.py`) | real layout: the lobby fills the pane, nothing scrolls sideways, the board fills its column |

The 28 skips are opt-in groups and environment-gated tests, reported as skips, not failures — the online suite with no server, the browser checks with no Chrome, and the two advisory-lock tests on Windows. Nothing failed in this run. CI runs the whole suite on Linux, macOS and Windows (`.github/workflows/tests.yml`), so a platform that breaks a test says so on the pull request.

The pane fill check adds one Python test and one Desktop-harness contract to the numbers above.

## What each suite covers

- **Python suite (`tests/`).** The rules engines, the referee and refusals, the table lifecycle, seats and consent, the wallet and points arithmetic, the jackpot and slot odds, lessons and tutorials, the catalogue and curated list, the ship gate, the online client and server, the talking tables, the dashboard API, the page's data contracts, docs stamps and the bundle build. It is offline: no model, no network, no GPU. Three files keep the shelf's own promises: `tests/test_catalog_review_guards.py` (the catalog review's five fixes, each a scan or a seam that fails if the defect returns), `tests/test_corrupt_state.py` (a state file that is not UTF-8, or holds the right keys with the wrong types) and `tests/test_resilience.py` (random legal play in every turn-based game, hostile input to every game, four threads on one table, and a scan that no state file is written in place).
- **Desktop page harness (`tests/table_ui_harness.cjs`).** The built `desktop/plugin.js` is imported and its pure helpers and rendered contracts are checked: shelves, seats, referee badges, talking tables, the lobby, the model picker, the library and the version chip.
- **Over-chat slot harness (`tests/jackpot_overlay_harness.cjs`).** The see-through cabinet is drawn only over the conversation, its settings persist, the size slider scales, and there is one centered layer.
- **Over-chat poll harness (`tests/jackpot_overlay_poll_harness.cjs`).** Mounts the status chip on a fake clock with a fake host that can say whether the focused chat is working, and counts the reads instead of waiting for them: a resting 5 s while nothing happens, 600 ms while a turn runs (and one read the moment it starts), the same 600 ms for three seconds after the turn ends, no reads at all while the window is hidden, one read the moment it comes back, the unchanged `message.start` pull and its 400 ms follow-up, a new spin on the feed watched while the reels run, no timer or visibility listener left behind on close, and exactly the old 600 ms on a host with no busy state.
- **Inference Slot Machine harness (`tests/inference_autoplay_harness.cjs`, run by `tests/test_inference_autoplay.py`).** The Games page draws the button above the Play shelf, one press posts `/jackpot/autoplay` on and sets the `jackpot2.overchat` switch, a second press turns both off, a refused request leaves the button in its real state with a one-line note, and the button is on only while both switches are. It also pins the backdrop's room (60% of a 1000 px window is 600 px), that 100% draws 640 px (twice the old 320 px copy) and 50% the old size, that 160% draws a taller one, and that Small / Medium / Large set 0.5 / 1 / 1.6. The same module scans `desktop/src` for the old over-chat wording.
- **Slot fit regression (`tests/slot_fit_regression.mjs`).** Real headless Chrome checks that the cabinet fits the Games page. Needs Chrome; not run by CI.
- **Over-chat live render (`tests/overchat_slot_live.mjs`).** The one check a stubbed-hooks harness cannot make: it opens the pane with both see-through switches off, clicks the cabinet's own switch (a real React state change, no reload), expects the machine inside the composer slot at a visible size, resizes narrower than the height cap and back, then turns it off. It also opens `/pane?nobar=1` (no status bar, as in Simple mode: the titlebar stand-in must draw at the top, one copy only) and `/pane?trap=1` (a trapped status bar and no titlebar: the in-slot fallback). `tests/test_overchat_slot_live.py` runs it from the suite and skips — naming the missing piece — when there is no node, no Chrome or no `uvicorn` for the QA server. GitHub's runner has the first two but not `uvicorn`, so CI skips it; a developer machine runs it.
- **Pane fill (`tests/pane_fill_checks.mjs`).** The pane beside the chat opens at 368 px and drags from 300 px to 1200 px, so its contents must answer to the pane's own width and not the window's. Headless Chrome lays the real pane out at 300, 320, 368, 640, 720 and 1000 px and measures it: the pane root is its own query container, the game view and the lobby each use at least 90% of the pane, nothing scrolls sideways, the sections sit in two columns once the container is 640 px wide and stack below that, the game tiles fill their column, and the board fills its column with the turn beside it. `tests/test_pane_fill.py` runs it from the ordinary suite (about 25 s) and skips, naming the missing piece, when there is no node, no Chrome or no `uvicorn`. `paneFillContract` in `tests/table_ui_harness.cjs` pins the same rules on the rendered tree — the container declaration, the wide rules on the pane's own classes, and that no element caps its own width in pixels.

## Opt-in suites

```bash
pytest --realmodel   # a live model in a talking-table seat; needs GAMESHELF_GLM_URL
pytest --browser     # headless Chrome against the QA page
```

`--realmodel` uses `GAMESHELF_GLM_URL` (default `http://127.0.0.1:8888/v1`), `GAMESHELF_GLM_MODEL` and `GAMESHELF_GLM_MAX_TOKENS`; skip it if no model server is reachable. The browser group uses `CHROME_BIN` and the QA server in `tests/browser_table_server.py`.

## Known non-reproducible checks

Two things are clock-bounded and can change answer on a busy machine:

- one hint-budget test asserts a 0.4-second margin; re-run it before believing a failure;
- `tests/test_difficulty.py` plays seeded matches while Checkers and Reversi search against a deadline, so a loaded box can cut a search short. `GAMESHELF_BOT_DETERMINISTIC=1` drops the clock for a reproducible run.

[VERIFY.md](../VERIFY.md) lists the claims each command proves; [DEVELOPMENT.md](DEVELOPMENT.md) covers the build and CI. Back to [docs/README.md](README.md).
