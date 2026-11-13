# Game Center documentation

_Applies to Game Center 1.0.0 · last revised 2026-11-12 (54c502d6)_

Index of every document. Start with the README if you just want to play; start with ARCHITECTURE if you are changing the code.

## Using it

| Document | What it answers |
|---|---|
| [../README.md](../README.md) | What Game Center is, the games, install and quick start. |
| [USAGE.md](USAGE.md) | A walkthrough of each user-facing feature, with screenshots. |
| [FAQ.md](FAQ.md) | Short answers about models, data, points and online play. |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | What to do when a screen or a command does not work. |
| [../LIMITS.md](../LIMITS.md) | What the plugin deliberately does not do. |

## Building on it

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data flow, and where data lives on disk. |
| [CONFIGURATION.md](CONFIGURATION.md) | Every config key, environment variable and default the code reads. |
| [REFERENCE.md](REFERENCE.md) | Tools, commands, hooks, HTTP routes and config keys in tables. |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Repo layout, build, test suites and CI. |
| [ADD-YOUR-GAME.md](ADD-YOUR-GAME.md) | Put another plugin's game on the shelf. |
| [SUBMIT-A-GAME.md](SUBMIT-A-GAME.md) | The three places a game can live. |
| [TESTING.md](TESTING.md) | How to run every suite, with counts. |

## Running the online parts

| Document | What it covers |
|---|---|
| [ONLINE-PLAY.md](ONLINE-PLAY.md) | Exactly what online play sends, and when. |
| [HOSTING.md](HOSTING.md) | Run the lobby on your own server. |
| [BOT-API.md](BOT-API.md) | The WebSocket protocol a bot speaks. |
| [STOCK-LEAGUE.md](STOCK-LEAGUE.md) | The design-only stock league. |

## Experiments and records

| Document | What it covers |
|---|---|
| [LABS.md](LABS.md) | What lives on the Experimental shelf. |
| [SECURITY-REVIEW-2026-11-09.md](SECURITY-REVIEW-2026-11-09.md) | The six-area security review and what it proved. |
| [../SECURITY.md](../SECURITY.md) | Credentials, traffic, storage and how to stop each. |
| [../VERIFY.md](../VERIFY.md) | Claims and the commands that check them. |
| [../PROVENANCE.md](../PROVENANCE.md) | How the repository came to be, and what is unverified. |
| [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) | Vendored code and artwork, with licences. |
| [../CHANGELOG.md](../CHANGELOG.md) | Release history. |
| [../BACKLOG.md](../BACKLOG.md) | Known work and what is deliberately not built. |
| [../SHIP-GATE.md](../SHIP-GATE.md) | The release gate and its per-surface checks. |

The documentation stamps are checked by `tests/test_docs_current.py`; run `python3 tools/doc_stamp.py --write` after reviewing a change, then `--check` before a release.
