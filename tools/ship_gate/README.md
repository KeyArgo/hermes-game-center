# Ship gate

Every game and surface must earn its place. `python -m tools.ship_gate` checks the whole
shelf and writes `SHIP-GATE.md`, `ship_gate.json` and `shelf/ship.json`; a surface that fails
any check is flagged `"ship": false`, leaves Play and appears on the Labs shelf instead.

    python -m tools.ship_gate                 # every surface, full pass (slow: real browsers)
    python -m tools.ship_gate --game connect4 # one surface, merges into the existing reports
    python -m tools.ship_gate --list          # the surface inventory
    python -m tools.ship_gate --url http://127.0.0.1:PORT  # use a running QA page instead of booting one
    python -m tools.ship_gate --apply-flags   # also write "ship" into each game.json

## The checks

1. **play** — real-mouse play to a finish against the computer at the gentle and the hard
   end of the level buttons, plus one bot-vs-bot watch, with the result overlay shown and
   Rematch/New game/Back working. Board games go through `tools/browser_drive.mjs` with
   `--level`, `--watch` and `--lesson`; the other playable surfaces go through their own
   proof drivers (`ld_proof.mjs`, `mafia-town-proof.mjs`, `petbattles-proof.mjs`,
   `champions_proof.mjs`, `browser_lobby_proof.mjs`).
2. **exit** — Back, Esc on a dialog, pane Close/Minimize where the surface has them, at
   desktop and side-pane widths, and an overlap scan: no control may cover another control's
   centre.
3. **hygiene** — no console errors or uncaught exceptions, no debug strings, no
   "local"/placeholder labels, Human/Bot/Computer badges present where seats exist.
4. **clear** — the How to play card or lesson exists and completes (the board games' lesson
   is walked step by step with real moves). The gate then writes
   `proof/ship_gate/<id>/comprehension-prompt.txt`; a different-family model (Gemini Argon
   via `agy`) is shown the first-screen screenshot and that card, and its verbatim answer is
   recorded in `comprehension-verdict.json`.
5. **looks** — the Impeccable detector (`taste-skill/scripts/inspect.mjs`, the same tool GG's
   pass used) scores a signed-in DOM snapshot of the real screen. The bar is GG's: zero FAIL
   findings on a main screen.
6. **buttons** — every visible control is pressed once with a real mouse event; a control
   must change the screen or be disabled with a visible reason.

A surface ships only when all six pass. A check the gate cannot perform is `skip` with the
reason — never a silent pass.

## Rules it keeps

- Real mouse only: `elementFromPoint` at the control's centre, then CDP
  `Input.dispatchMouseEvent` press/release. Reading the DOM is fine; `element.click()` is not
  the proof.
- Muted headless Chrome, its own temporary profile and debug port, stopped at the end.
  The QA page (`tests/browser_table_server.py`) runs on a free loopback port and is stopped
  with SIGTERM after checking `ps -o args= -p PID`.
- No new dependencies: Python stdlib and Node stdlib only.
- Progress and reports are written after every surface, so a killed run still leaves results.

## The release switch

`shelf/ship.json` is the gate's verdict per surface. `shelf/catalog.py` reads it: a game with
`"ship": false` is dropped from `play_cards()` and added to `labs_games()` with the failure
reasons, so the dev build shows it under Labs, badged, and a release build has it off Play.
`--apply-flags` also writes the flag into each game's `game.json`.

## Honest limits

- The Desktop's own pane chrome (Close/Minimize) cannot be seen by the QA page, so the pane
  part of `exit` is a `skip` on the browser surfaces.
- The Impeccable detector scores a snapshot of the first screen only, not every screen.
- The model comprehension arm is run by the caller (the gate leaves `skip: model pass
  pending` until a verdict file exists), so the gate never claims a model saw the screen when
  it did not.
