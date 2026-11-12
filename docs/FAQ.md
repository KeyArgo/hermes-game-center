# FAQ

_Applies to Game Center 1.0.0 · last revised 2026-11-11 (b2a67f2c)_

Short answers to the questions the code raises.

## Does it need a model to work?

No. The eleven Play games, their lessons, hints from the built-in player and the whole shelf run without a model. A model is needed only when you ask for one: **Play my agent**, **Improve** on a Doctrine card, a model seat at a talking table or the bot ladder. Those calls go through Hermes, never to a provider directly.

## Does it need a server?

No. Everything local runs on this computer. Online play is a separate service at `https://games.hermesnet.xyz` (or the `lobby_url` you set), is off until you turn it on, and everything local keeps working when it is down.

## What does online play send?

The display name you pick, your recovery key when you sign in, which game you are waiting for, the moves you make, your chip and point totals, and for the ladder your bot's name and the move it picks. It also sends the optional things you choose to post: a strategy card, a report, a block or a bot challenge. It does not send your chats with Hermes, your files, your model or its key, or any telemetry. The full disclosure is in the lobby and in [ONLINE-PLAY.md](ONLINE-PLAY.md).

## Where is my recovery key kept?

In Hermes's own credential store, under `HERMES_GAMESHELF_LOBBY_KEY`. It is shown once when you create a player, is never written to a Game Center file and is never logged. You can also paste it into the plugin's `lobby_key` config field by hand.

## Where are my chips and points?

In `wallet.json` under Game Center's plugin data folder. **Chips** are play money for Blackjack and Slots. **Points** are the account currency: 100 per win and 10 per 1,000,000 tokens your chats use. Points cash into chips at 75%. Delete the data folder to remove both; see [ARCHITECTURE.md](ARCHITECTURE.md).

## Why is the Champions tab empty?

It is a placeholder in this version. Champions and tournaments have machinery in `shelf/champions.py` and `shelf/tournament.py`, but the matches they need do not run here, so the page says so and nothing is created. Play and Experimental are unaffected. [BACKLOG.md](../BACKLOG.md) tracks the work.

## Why are the Experimental cards locked?

The Experimental shelf is a shop window, not a door: everything that is not curated Play stays visible with no way in. The four talking tables can still be started from chat. A game that is not in `shelf/curated.json` never reaches Play, a tournament or a rating.

## How do I add my own game?

Ship a `game.json` and a `game.py` in a plugin. See [ADD-YOUR-GAME.md](ADD-YOUR-GAME.md) and the examples in `examples/hello-game` and `examples/match-ready-game`. Another plugin's game appears in **Your games**, labelled as outside code; it never becomes Play.

## Why did the referee refuse my move?

The referee names the move and the reason in one sentence. Common reasons: the move is not legal for that piece, the square holds your own piece, it is not your turn, or the other person has not joined yet. The refusal is kept in the game record. Fix the move and go again.

## Is a move ever made for me?

Only when you agreed to an AI seat with `/games allow-ai <game> black=local` or `black=agent`, or when you started a game against the computer. A move never silently takes a person's seat; the other person must join or sit first.

## Why does the hint do nothing?

A hint works only for one person against the built-in player, on their own turn. It is never available against another person and never from a tool call. If the hint needs your model and no model is set, set one with `hermes model` or **Settings → Models → Game Shelf opponent**.

## What platforms does it run on?

It runs where Hermes Desktop runs. The backend loads on Linux, macOS and Windows; the tests run on Python 3.13. Windows support was fixed on 2026-11-11 (the wallet no longer imports `fcntl` unguarded), and `tests/test_windows_import.py` guards it.

## Where are the screenshots from?

Every screenshot in the README and docs is captured from this commit's real page by a headless Chrome harness, against a scratch data folder. `tools/referee_refusal_shot.mjs` regenerates the refusal shot from the real recorded refusal, and `tools/browser_drive.mjs` drives the other screens. Nothing personal is in them.

Back to [docs/README.md](README.md).
