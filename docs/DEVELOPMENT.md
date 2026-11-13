# Development

_Applies to Game Center 1.0.0 · last revised 2026-11-12 (43be8583)_

Repo layout, how to build the Desktop bundle, how to run each suite, and what CI does.

## Layout

| Path | What is in it |
|---|---|
| `__init__.py` | Plugin registration: `/games`, `games_play`, hooks, model slot, win bonus. |
| `kit.py` | The shared table: seats, turns, referee, saves, lessons. |
| `shelf/` | Catalogue and discovery, command router, wallet, jackpot, online client, champions, tournaments. |
| `<game>/` | One folder per game: `game.json`, `game.py`, `learn.json`, `lesson.json`. |
| `desktop/src/` | The Desktop page as numbered `NN-name.js` parts; `desktop/plugin.js` is the built bundle. |
| `dashboard/plugin_api.py` | The FastAPI router behind the page. |
| `online/` | The optional aiohttp lobby and its web client. |
| `talktable/`, `third_party/textarena/` | The talking-table adapter and vendored rules. |
| `tests/` | Pytest files plus the Node UI harnesses and the browser harnesses. |
| `tools/` | The bundle build, the ship gate, the browser proofs and offline generators. |
| `docs/` | This documentation; `docs/doc-map.json` maps each document to the code it describes. |
| `scripts/` | `test.sh` (all checks), `deploy.sh`, `verify-served.py`, `slot-audit.py`. |
| `examples/` | A minimal game plugin and a match-ready game plugin. |

## Build the Desktop bundle

`desktop/plugin.js` is generated. Do not edit it; edit the numbered parts and run:

```bash
python3 tools/build_plugin.py          # write desktop/plugin.js
python3 tools/build_plugin.py --check  # fail if the committed bundle is stale
```

Only `desktop/src/00-header.js` may carry imports, and only the last part may export. `tests/test_plugin_bundle.py` runs `--check` on every test run.

## Run the suites

CI installs the test dependencies with:

```bash
python -m pip install -U pip pytest aiohttp fastapi pillow numpy
```

Then:

```bash
python -m pytest tests -q -p no:cacheprovider   # the Python suite
python3 tools/build_plugin.py                    # the bundle CI grades
node tests/table_ui_harness.cjs                  # Desktop page state machine
node tests/jackpot_overlay_harness.cjs           # over-chat slot cabinet
node tests/jackpot2_harness.cjs                  # Jackpot v2 copy, switch and fit
node tests/jackpot2_look_harness.cjs             # Jackpot v2 tint and contrast
```

`scripts/test.sh` runs the build, every Node harness, the Chrome fit check (unless `--fast`) and the pytest suite in one pass. The Chrome check needs a binary (`CHROME_BIN`, else `google-chrome`, else `/opt/google/chrome/chrome`) and the pinned React modules; `online/web/vendor/` has a copy and `GAMESHELF_REACT_ASSETS` points the QA server at it.

The Python suite is offline: no model, no network, no GPU. Two opt-in groups are skipped unless asked for:

- `pytest --realmodel` needs a reachable model (`GAMESHELF_GLM_URL`, `GAMESHELF_GLM_MODEL`).
- `pytest --browser` drives headless Chrome against the QA page.

Counts and what each suite covers are in [TESTING.md](TESTING.md).

## CI

`.github/workflows/tests.yml` runs on every push and pull request on Python 3.13:

1. install the test dependencies;
2. `python -m pytest tests -q -p no:cacheprovider`;
3. `python3 tools/build_plugin.py`, then `node tests/table_ui_harness.cjs` and `node tests/jackpot_overlay_harness.cjs`.

The Chrome fit regression is not part of CI.

## Documentation stamps

Every document in `README.md`, `SECURITY.md` and `docs/` carries a stamp under its H1:

```text
_Applies to Game Center 1.0.0 · last revised 2026-11-11 (commit)_
```

`docs/doc-map.json` maps each document to the code it describes and to words it must contain. After reviewing a change, run:

```bash
python3 tools/doc_stamp.py --write   # refresh version, date and commit
python3 tools/doc_stamp.py --check   # what CI-style checks enforce
```

`tests/test_docs_current.py` fails when a document is unstamped, behind the manifest, unmapped, missing a marker, or older than the code it describes.

## The ship gate

`tools/ship_gate/` is the release gate: per-surface play, exit, hygiene, clear, looks and button checks. It writes `ship_gate.json`, `shelf/ship.json` and `SHIP-GATE.md`. `tests/test_ship_gate.py` and `tests/test_regression_ship_gate_inventory.py` pin it. See the tool table in `tools/README.md`.

## Commit style

Small, logical commits with a plain prefix: `docs:`, `ci:`, `test:`, `fix:`, `chore:`. Keep a pull request to one change, with a test that fails before it and passes after; never weaken a test to make it pass. New Python dependencies need an upper bound. Changes that touch privacy, network calls or capabilities are reviewed first.

Back to [docs/README.md](README.md).
