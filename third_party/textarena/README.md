# TextArena — vendored subset (MIT)

Upstream: <https://github.com/TextArena/TextArena>
Source commit: `1e3160dea659971f120bf42708fafa8ea3001b81` (main, 2026-10-05)
Upstream version: 0.7.3
Licence: MIT — full text in `LICENSE`, copied unchanged. Copyright (c) 2025
Leon Guertler and Bobby Cheng.

The package is **not** installed. Its dependencies include `python-chess`
(GPL-3.0) and a live API client (openai, requests), so only the files the four
chosen environments actually need are copied here, and the plugin's own code
imports them from this folder.

## What was copied

| Path | Upstream | Changed |
|---|---|---|
| `core.py` | `textarena/core.py` | no |
| `state.py` | `textarena/state.py` | no |
| `utils/locales/__init__.py`, `localeloader.py`, `en.json` | same paths | no |
| `envs/SecretMafia/{__init__,env}.py` | same paths | one rule fix (below); renderer.py not copied: nothing imports it, and it carries zero-width joiners |
| `envs/LiarsDice/{__init__,env,renderer}.py`, `locales/en.json` | same paths | no |
| `envs/IteratedPrisonersDilemma/{__init__,env,renderer}.py`, `locales/en.json` | same paths | no |
| `envs/SimpleBlindAuction/{__init__,env,renderer}.py` | same paths | one rule fix (below) |
| `envs/__init__.py` | `textarena/envs/__init__.py` | **emptied** |
| `__init__.py` | `textarena/__init__.py` | **rewritten** |

Only the English locale file is copied. Upstream ships ~200 translations per
folder; the locale loader reads one language on demand, so the rest is dead
weight.

`envs/__init__.py` upstream registers ~100 environments and imports
`textarena.wrappers` and `textarena.agents`, which need rich, nltk, requests
and openai. `__init__.py` upstream imports the same plus the online API client.
Both are replaced by the minimum that lets the four environments import; the
environment modules themselves are byte-identical to upstream.

Nothing is fetched at runtime: this folder is the whole dependency.

## The rule fixes

1. `envs/SecretMafia/env.py`, in `_after_player_action`: upstream resolves the
   night's kill only when the phase ends at `NIGHT_DOCTOR` or `NIGHT_DETECTIVE`.
   If both the doctor and the detective are already dead, the mafia's phase goes
   straight to day and the chosen victim is never eliminated — the mafia can no
   longer kill for the rest of the game. The check now includes `NIGHT_MAFIA`, so
   the kill lands in every case; when a doctor or detective is alive the behaviour
   is unchanged (the phase after the mafia's is theirs, not day).

   Proved by `test_the_mafia_can_still_kill_when_doctor_and_detective_are_dead`,
   which fails on the upstream line and passes with the fix.

2. `envs/SimpleBlindAuction/env.py`, in `_determine_auction_results`: upstream
   takes every bid out of a player's capital when it is submitted and only records
   the *winning* bid as spent, so a bid that loses (or ties) still shrinks the
   bidder's capital and net worth — and net worth is what decides the winner. Every
   bid that did not win its lot is now refunded before profit and net worth are
   worked out, so only the winner pays.

   Proved by `test_a_losing_auction_bid_is_refunded`, which fails on the upstream
   line and passes with the fix.

3. `envs/SimpleBlindAuction/env.py`, in `_handle_bidding_action`: a second bid on
   the same lot replaces the first in the record but upstream docked the capital
   for both. One lot now keeps the higher bid, and only that amount is taken.

   Proved by `test_one_bid_per_lot_is_all_that_is_charged`.

Nothing else in the four environments is edited.

## Why these four

Secret Mafia, Liar's Dice, Iterated Prisoner's Dilemma and Simple Blind Auction
are turn-based talking games with small rule sets, so a person can play one
round of each with clicks alone, and every move can be checked against the
environment's own parser.

## Directories the code still opens

`build_locale` looks for a `locales/` folder beside the environment class's
source file and reads `<lang>.json` from it. Any extra language chosen at
runtime would be missing here; the plugin always runs these environments in
English, and `en.json` is present for every environment that needs one.
