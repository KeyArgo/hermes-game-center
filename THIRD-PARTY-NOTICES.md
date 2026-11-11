# Third-party notices

Game Center ships its own code (MIT, see `LICENSE`) plus one vendored artwork set and a vendored
subset of one game framework, both credited below. The projects under "Ideas only" were read, not
copied: no line of their code is in this tree. The projects below influenced the design of
**Doctrine** and are credited here so the provenance of the ideas is clear.

## Vendored files

### TextArena talking games — MIT

- **Path:** `third_party/textarena/` (core, state, the English locale, and the
  SecretMafia, LiarsDice, IteratedPrisonersDilemma and SimpleBlindAuction environments).
- **Author:** Leon Guertler and Bobby Cheng — <https://github.com/TextArena/TextArena>
- **Licence:** MIT, full text in `third_party/textarena/LICENSE`, copied unchanged.
- **Source commit:** `1e3160dea659971f120bf42708fafa8ea3001b81` (upstream version 0.7.3).
- **What changed:** four package files are not upstream's: `third_party/textarena/__init__.py`,
  `envs/__init__.py`, one line of `envs/SecretMafia/env.py` and two blocks of
  `envs/SimpleBlindAuction/env.py`. The two `__init__.py` files upstream import the registration
  table, the online API client, the wrappers and the agents, which pull in `python-chess` (GPL-3.0),
  `openai`, `requests`, `rich` and `nltk`; neither is used by the four games, so both are replaced with
  the minimum that lets the environment modules import. The rule fixes make the mafia's night kill land
  when neither the doctor nor the detective is still alive, refund auction bids that did not win their
  lot, and charge a lot once when a player bids on it twice (upstream did none of these), and each is
  proved by a test. Every other environment module is byte-identical to upstream. Only `locales/en.json`
  is copied from each locales folder (upstream ships ~200 translations).
  `third_party/textarena/README.md` lists every file and every deviation.
- **What it is used for:** the rules for Mafia, Liar's Dice, Prisoner's Dilemma and Blind
  Auction. The package is never installed and nothing is fetched at runtime.
- **The 2v2 Liar's Dice experiment** (`talktable/games/liarsdice_teams.py`) does not copy any of
  this code: it subclasses the vendored `LiarsDiceEnv`, keeps its bid and call rules, and adds a
  shared per-team dice pool and public table talk around them. Its wording comes from the same
  vendored `envs/LiarsDice/locales/en.json` (loaded by path), so no second copy of the strings or
  the licence text is added here.

### chessnut piece drawings — Apache-2.0

- **Path:** `vendor/chessnut/*.svg`, inlined into `desktop/plugin.js` between the two
  `vendored chessnut piece art` markers, because a Desktop plugin loads one ESM file.
- **Author:** Alexis Luengas — <https://github.com/LexLuengas/chessnut-pieces>
- **Licence:** Apache License 2.0, full text in `vendor/chessnut/LICENSE.txt`. The licence text is
  copied unchanged. The SVG source is unchanged; the only change is mechanical: each drawing's
  elements are embedded as React-ready shape data by `tools/chess_pieces.py`, and a test fails if the
  two drift apart.
- **What it replaces:** the board used to draw chess pieces as their letters (K, Q, R…), which read
  as text rather than pieces. Nothing else changed; moves are still judged by the Python rules.

### Kenney tank sprites — CC0 1.0 Universal

- **Path:** embedded as data URIs in `desktop/src/46-arena-sprites.js` (three hull shapes, four
  barrels and three explosion frames per seat colour), because a Desktop plugin loads one ESM file
  and may not read files at runtime.
- **Author:** Kenney — <https://kenney.nl>, "Topdown Tanks Remastered" pack, via the
  <https://github.com/shorepine/kenney> mirror.
- **Licence:** Creative Commons Zero (CC0 1.0). No attribution is required; it is given anyway.
- **What changed:** the shapes are unchanged. Each sprite was recoloured to the four arena seat
  colours, quantised, trimmed to the frames the renderer uses, and embedded as base64 PNG.
- **What it is used for:** the Doctrine Arena battle drawing — hulls, turrets and explosions. The
  renderer adds the rotation; the engine and rules are this plugin's own.

## Ideas only (no code copied)

- **DeepMind OpenSpiel — `battleship`** — Apache-2.0. The rules for Sea Battle (a ten-by-ten grid,
  the five-ship fleet with its lengths, one shot per turn, a ship only revealed once every one of its
  cells is hit) were checked against OpenSpiel's battleship game while writing `seabattle/game.py`.
  The engine here is written for this plugin and shares no code with OpenSpiel; nothing is fetched
  at runtime. <https://github.com/google-deepmind/open_spiel>
- **HaliteChallenge/Halite-II** — MIT. The shape of a small, seeded, turn-based arena with several bots
  on one board and a score panel came from reading how Halite organises matches and replays.
  <https://github.com/HaliteChallenge/Halite-II>
- **agent-hold-em** — MIT. The "one profile takes a seat, its model answers through the host's model
  slot" pattern informed how Doctrine asks a person's own model to author or improve a card.
  <https://github.com/nickwongdev/agent-hold-em>
- **NousResearch/atropos** — MIT (repository archived read-only in July 2026). Read for the planned
  RL bridge only; no code is vendored. Its `BaseEnv` contract (one item, grouped rollouts, tokens +
  masks + scores) shaped the plan in `.hermes/plans/2026-11-06-atropos-bridge.md`.
  <https://github.com/NousResearch/atropos>

## Considered and not used

- **cm-chessboard** (MIT) and **react-chessboard** (MIT) were evaluated for the chess board only.
  Both bring their own DOM board and their own drag-and-drop, so chess would have had a second
  interaction layer beside the one every other game shares, and the Python picture (cells, legal
  moves, last move, promotion choices) would need a translation layer in front of it. A Desktop
  plugin loads one ESM file, so either library would also have to be built into `desktop/plugin.js`
  by a committed bundling step. The work was more than the two hours the task allowed for it, so the
  shared board is used for chess too, with the vendored chessnut pieces. Nothing is fetched at
  runtime.

## Linked, not shipped

The Community and Labs shelves name other people's work and open it in the browser. No code, art,
sound or text from these projects is in this tree, and nothing is fetched at runtime — `Open` hands
the address to the system browser. Each entry was opened and read before it was listed, and its
licence is recorded here as it stood on 2026-11-05.

### Community shelf

- **Nous Hermes Arcade**, **The Legends of Nous Research**, **HODL OR DIE: Brother Doge** by
  123mikeyd — <https://hermesarcade.123mikeyd.com/>, <https://123mikeyd.github.io/nrcu-platform-fighter/>,
  <https://123mikeyd.github.io/Brother_Doge_VideoGame/>. Playable web pages; no licence stated on
  the pages themselves, so nothing is reused from them.
- **Clawpocalypse Now** and **ROO GANG** by mojomast — <https://mojomast.github.io/clawpocalypse-now/>,
  <https://slophero.vercel.app/>. Playable web pages; no licence stated on the pages, so nothing is
  reused from them.
- **Misty Mountain / Hermes Community Care Package** by 123mikeyd —
  <https://github.com/123mikeyd/hermes-community-care-package>. A Godot 4 learning prototype
  published as a source zip on its release page. The repository has no licence file (checked
  2026-11-05), so the card says so and nothing from it is reused here.
- **Gladiator** by Runtime Notes — <https://github.com/runtimenoteslabs/gladiator>, MIT. A
  watch-only project page with a demo of two AI companies competing; running it yourself needs
  Postgres, Paperclip and model credentials, so it is a link, never a game this plugin plays.

### Labs — Make games

Catalog pages under <https://hermes-agent.nousresearch.com/docs/plugins/>; the licence column was
read from each project's repository on 2026-11-05.

- **game-dev** by 123mikeyd — MIT.
- **gameforge** by DECRUX9812 — MIT.
- **godot-studio** by Foolafroos — no licence file in the repository; the card says so.
- **game-editor** by TakeshiTGAL — MIT.
- **csharp-game-editor** by TakeshiTGAL — MIT.
- **pixel-art** — the official Hermes skill (`official/creative/pixel-art`), MIT, authored by
  dodo-reach, with hardware palettes and animation loops credited in the skill's own ATTRIBUTION.md
  to Synero/pixel-art-studio (MIT).

### Experimental Games — known game plugins (suggestions)

Named in `shelf/known.json`, with a link to each one's catalog page. Licences read 2026-11-05:

- **agent-hold-em** by tony-simons-aiowa — MIT.
- **tamahermes** by ahrazzle — MIT (macOS only).
- **hermes-pets-all** by poponline63 — MIT.
- **hermes-quest** by ap08960695 — MIT.
- **deskrpg** by dandacompany — no licence file in the repository; the card says so.

## Chess Coach opening book — CC0-1.0

- **Path:** `vendor/chess-openings/*.tsv`, compiled by `tools/make_chess_openings.py` into
  `chessboard/openingbook.json` (positions, names, book continuations).
- **Source:** lichess org — <https://github.com/lichess-org/chess-openings>
- **Licence:** CC0-1.0 (public domain). The compiled book derives solely from those TSVs.
- The generator itself runs offline with `python-chess` (GPL-3.0+, dev-only, not shipped) and is
  recorded here because it is an outside tool used to produce committed data.

### Pet Battles — removed, nothing vendored

Pet Battles is no longer part of the product: its rules, save format and drawings were removed with the
game. Nothing third-party was ever vendored for it, so removing it adds and removes no licence
obligation. The paragraph is kept only so a reader of an older release knows what this game never
depended on. The pet battle *genre* was not copied from any game: type rings, damage arithmetic and
turn order are generic mechanics, and no Pokémon (or other) name, sprite, sound or stat table was used.

## Explicitly not used

Doctrine's engine, card validator and UI are written for this plugin. No GPL, AGPL or EPL code was read
into this tree; in particular `thomasahle/sunfish` (GPL-3.0), `niklasf/python-chess` (GPL-3.0) and
`lichess-org/chessground` (GPL-3.0) are not used. `official-stockfish/Stockfish` (GPL-3.0) is never
bundled: the Chess Coach runs the user's own `stockfish` from PATH as a separate UCI process when it
is installed, and labels its own search otherwise.

## Slot machine sound effects

The slot cabinet plays eight short recorded clips (mono 22 kHz Vorbis, embedded in
`desktop/src/08-slot-samples.js` as data URIs so the plugin stays a single file).

Source: [Mixkit](https://mixkit.co/free-sound-effects/slot-machine/) free sound effects, used under the
[Mixkit License](https://mixkit.co/license/#sfxFree): free for personal and commercial use inside a
project, no attribution required (credited here anyway), not redistributed as a stand-alone sound
library. Clips, by Mixkit id and title:

| id | title | used for |
|---|---|---|
| 1939 | Coins handling | coin cascade (`ching`) |
| 1936 | Magical coin win | a win paying into the tray (`cash`) |
| 1935 | Payout award ding | the machine's win chime (`payout`) |
| 1934 | Payout award | longer payouts |
| 1931 | Slot machine win alert | the start of a payout run |
| 1928 | Slot machine win | big wins |
| 1929 | Slot machine win siren | the jackpot alarm |
| 1932 | Slot machine wheel | the reels turning |

Every clip was trimmed to 0.9–2.0 seconds, downmixed to mono and re-encoded at 22 kHz. The synthesised
sounds in `desktop/src/07-sound.js` remain as the fallback when a clip cannot be decoded.
