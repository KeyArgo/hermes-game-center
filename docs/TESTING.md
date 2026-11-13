# Testing

_Applies to Game Center 1.0.0 · last revised 2026-11-12 (54c502d6)_

_Applies to Game Center 1.0.0 · last revised 2026-11-11 (b2a67f2)_

How to run every suite, what each one covers, and the counts measured on this commit.

## Run everything

```bash
python3 -m pytest tests -q -p no:cacheprovider   # the Python suite, offline
python3 tools/build_plugin.py                    # the committed bundle must match desktop/src/
node tests/table_ui_harness.cjs                  # the Desktop page's state machine
node tests/jackpot_overlay_harness.cjs           # the over-chat slot cabinet
node tests/jackpot2_harness.cjs                  # the Jackpot v2 copy, its switch and the fit
node tests/jackpot2_look_harness.cjs             # the Jackpot v2 tint, and the ink it keeps readable
node tests/slot_fit_regression.mjs               # fits the page, in real headless Chrome
scripts/test.sh                                  # all of the above, plus the Chrome fit check
scripts/test.sh --fast                           # skip the Chrome fit check
```

CI (`.github/workflows/tests.yml`) runs the pytest suite and the four Node harnesses on Python 3.13. The Chrome fit check is a local/owner check, not a CI step.

## Counts at this commit

Measured locally on 2026-11-11 with `python3 -m pytest tests -q -p no:cacheprovider --durations=15` and the two Node harnesses from a clean checkout.

| Suite | Command | Result |
|---|---|---|
| Python suite | `python3 -m pytest tests -q -p no:cacheprovider` | **1554 passed, 28 skipped, 1 failed** in 1036.29 s (17:16) |
| Desktop page harness | `node tests/table_ui_harness.cjs` | **81 checks passed, 0 failed** |
| Over-chat slot harness | `node tests/jackpot_overlay_harness.cjs` | **7 checks passed, 0 failed** |
| Combined badge count | pytest + the two harnesses | **1642 passing** |
| Slot fit regression (not in CI) | `node tests/slot_fit_regression.mjs` | one headless-Chrome check; see below |

The 28 skips are opt-in groups and environment-gated tests, reported as skips, not failures. The one failure in this tree is `tests/test_blackjack_table.py::test_the_table_controls_seat_the_computer_and_the_model`, the red blackjack test a separate lane is fixing; it passes when run alone and fails in the full run. No other test failed.

## What each suite covers

- **Python suite (`tests/`).** The rules engines, the referee and refusals, the table lifecycle, seats and consent, the wallet and points arithmetic, the jackpot and slot odds, lessons and tutorials, the catalogue and curated list, the ship gate, the online client and server, the talking tables, the dashboard API, the page's data contracts, docs stamps and the bundle build. It is offline: no model, no network, no GPU.
- **Desktop page harness (`tests/table_ui_harness.cjs`).** The built `desktop/plugin.js` is imported and its pure helpers and rendered contracts are checked: shelves, seats, referee badges, talking tables, the lobby, the model picker, the library and the version chip.
- **Over-chat slot harness (`tests/jackpot_overlay_harness.cjs`).** The see-through cabinet is drawn only over the conversation, its settings persist, the size slider scales, and there is one centered layer.
- **Slot fit regression (`tests/slot_fit_regression.mjs`).** Real headless Chrome checks that the cabinet fits the Games page. Needs Chrome; not run by CI.

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
