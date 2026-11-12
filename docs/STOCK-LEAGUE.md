# The Stock League — design and stub
_Applies to Game Center 1.0.0 · last revised 2026-11-11 (b2a67f2c)_

**State: design-only.** `GET /api/stock-league` answers `{"state": "design-only", …}` and the Lobby tab
shows a greyed row badged *Labs · experiment · needs a server-side model*. There is no league to join yet,
and the server makes no model calls.

## What it would be

Every other league on this server referees a decision that arrived from somewhere else — a person's
browser, or a bot running on an owner's own machine. A **stock league** is different: a person picks a
*stock persona* (a named character with a fixed voice and play style) and the **server** plays that
persona. No owner's machine, no owner's key, no owner's model. That is what makes it fairer to rate and
possible to watch, and it is also why it costs money to run.

## What it needs before a single game

1. **A model budget the host controls.** A hard cap per move and per day, with the cost of every game
   recorded next to its result. "Free" stock games paid for by whoever runs the server is not a plan.
2. **A referee-owned move engine per game.** A persona has to choose without a browser or an owner. The
   plugin already has such engines for its beginner levels, but they run inside the plugin; the server
   would need its own copy, or a small portable one.
3. **A data-only persona format.** Weights and voice, no prompts, no URLs, no code. Validated by the
   server exactly like a Doctrine card, and shareable the same way. A persona must never be able to make
   the server fetch or run anything.

## The smallest honest first step

Ship **one game only: Doctrine**, because its engine already runs entirely from data on the server
(`doctrine/engine.py`, eight weights and a seed). A Doctrine stock persona maps onto those eight weights,
so no model is needed at all: the server plays it, the battle is deterministic, and the cost is zero. That
gives a real league — rated, replayable, cheap — before any money is spent on a talking persona.

Then, in order:

1. A persona page: name, voice, weights, a rating, a replay list, and the exact cost of each game.
2. Doctrine Arena personas (same weights idea, different engine).
3. Talking games last, where a persona has to answer in words and the model bill is real.

## What is deliberately not here

- No model calls, no budget code, no network calls: this file and `online/stock.py` are all there is.
- No persona storage yet, so nothing can be uploaded that the server would later have to trust.
- No fake games: the stub refuses to invent a result.

## The pieces that already exist for it

| Piece | Where |
|---|---|
| A deterministic engine run from data | `doctrine/engine.py`, `online/bouts.py` |
| Cards validated and locked by the server | `/api/cards`, `doctrine/card.py` |
| One rating change per paired match | `online/store.py` (`pairs`, `settle_pair_leg`) |
| Replays for every finished game | `/api/card-arena/{id}`, `/api/matches/{room}/{n}` |
| The design banner | `/api/stock-league`, `online/stock.py` |
