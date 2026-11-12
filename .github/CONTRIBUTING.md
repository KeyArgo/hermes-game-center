# Contributing to Game Center

Thanks for helping. Bug reports, small focused fixes and new ideas are all welcome.

## Report a bug or ask for a feature

Open an issue with the template. For a bug, include your OS, your Hermes Agent version (`hermes --version`), the Game Center version shown in the plugin, the steps, and what you expected.

Security problems must not be public issues. Use GitHub's **Security → Report a vulnerability** form on this repository; see [SECURITY.md](../SECURITY.md).

## Set up a checkout

```bash
git clone https://github.com/KeyArgo/hermes-game-center
cd hermes-game-center
python -m pip install -U pip pytest aiohttp fastapi pillow numpy
python3 tools/build_plugin.py --check   # the committed bundle must match desktop/src/
```

The plugin runs inside Hermes Desktop; a checkout gives you the code and the tests, not a standalone app. To try the real page in a browser, use the isolated QA server:

```bash
GAMESHELF_REACT_ASSETS=online/web/vendor \
  python3 tests/browser_table_server.py --root /tmp/gameshelf-qa --port 18798
node tools/browser_drive.mjs --url http://127.0.0.1:18798/ --out /tmp/gameshelf-shots --game chess --level Beginner
```

The QA server uses a scratch data folder; it never reads the owner's `~/.hermes` data.

## Run the checks

```bash
python3 -m pytest tests -q -p no:cacheprovider
python3 tools/build_plugin.py
node tests/table_ui_harness.cjs
node tests/jackpot_overlay_harness.cjs
hermes plugins validate .
```

`scripts/test.sh` runs the whole set, including the headless-Chrome fit check (`--fast` skips that check). Counts and the opt-in suites are in [TESTING.md](../docs/TESTING.md).

## Send a change

1. Fork, then branch from `main`.
2. Keep the pull request to one logical change, with a test that fails before it and passes after. Never weaken a test to make it pass.
3. If you changed a part under `desktop/src/`, rebuild `desktop/plugin.js` with `python3 tools/build_plugin.py` and commit the bundle.
4. If you changed a document, run `python3 tools/doc_stamp.py --write` and add any new document to `docs/doc-map.json`.
5. Describe what changed and why. If the change touches privacy, network calls or capabilities, say so in the description — those are reviewed first.

## Ground rules

- Plugins extend Hermes only through public hooks, `ctx.register_*` APIs and the Desktop SDK.
- Game rules live in the game's own `game.py`; do not teach the shelf to judge a move.
- New Python dependencies need an upper bound (`>=X,<Y`).
- Do not put personal data, secrets or a real recovery key in a test, a screenshot or a fixture.
- By contributing you agree your work is released under this repository's MIT licence.
- Be kind; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
