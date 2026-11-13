# SECURITY
_Applies to Game Center 1.0.0 · last revised 2026-11-13 (0ad31b96)_

What this plugin does to your machine and your network, and how to stop it. Sourced from
README.md ("What this plugin does on your machine"), `plugin.yaml`, and the Desktop table code.

**Measured on 2026-11-09, by running this tree.** Every claim in the six security areas — the
subprocess surface, path handling in rooms and saves, the online lobby's key flow and its disclosure,
the wallet's lock and payout paths, the agent-seat consent gate, and the vendored trees — was checked
by a probe or by a test that failed before its fix. What was run, what it showed, and which claims from
an outside review were rejected are listed in the review notes. Claims in this file that were
read rather than executed say so; PROVENANCE.md records the earlier, read-only audit.

## Supported versions

Security fixes are made on the current **1.0.x** line. Older snapshots are not maintained. Report a
problem privately through GitHub's **Security → Report a vulnerability** form on this repository;
do not open a public issue with a working exploit in it.

## Credentials

- **No credentials are stored by the plugin.** No provider API keys, no game accounts, no secrets
  of yours in the plugin's data folder.
- The single secret in play is the **online recovery key** for the optional lobby. It goes through
  Hermes's own credential route — the same place a provider API key lives — under
  `HERMES_GAMESHELF_LOBBY_KEY`. It is shown once at player creation, is never written to a file of
  the plugin's own, and is never logged.
- `plugin.yaml` also exposes `lobby_key` as a `type: secret` config field you can paste by hand.
  Honest caveat: whatever Hermes stores for plugin config is then holding that value. If that
  bothers you, do not paste it into the config field — create the player and let the credential
  route keep it, or simply leave online play off.
- Game Center stores no model key and no model address for champions or the Open Division. It asks
  the Hermes host to make the call.

## Telemetry and outbound traffic

- **No telemetry. No phone-home. No update checks. No remote code loading. No binaries.**
  Updates arrive only when you install a newer version yourself. Code is MIT.
- The plugin makes no network calls of its own. Two exceptions, and neither happens unless you ask
  for it: online play, which is **off until you turn it on**, and the **Experimental** pet gallery,
  which while it is open reads the public Petdex manifest (`https://petdex.dev/api/manifest`, the
  same document Hermes's own pet picker reads) with nothing about you in the request.
- With online play **on**, it contacts exactly one address — `lobby_url`, default
  `https://games.hermesnet.xyz` — and sends: your display name, your recovery key when you sign in,
  which game you are waiting for, the moves you make, and for the bot ladder your bot's name and the
  move it picks. When you choose to use them it also sends the optional posts you make: a strategy
  card, a report, a block or a bot challenge. It does not send your Hermes chats, your files, your
  model or its key. The server sees your IP the way any website does.
- Polling happens only while the Game Center page or the dock's alerts are active, backing off
  15 → 30 → 60 → 120 s after a miss. Nothing is polled while online play is off.
- **Community creations** cards only hand an HTTPS URL to your browser when you press **Open**. The
  plugin never fetches, previews or embeds those sites; there are no iframes.
- **Launch cards** start a program already installed on this machine, detached, from an argument
  list, only when a person presses Play or types `/games <card> play` locally. The plugin never
  downloads, bundles or installs a program or game data and never runs an installer. The
  `games_play` tool, bot accounts and chat from another machine are refused these consent verbs.
- **Model calls go only through Hermes**, never to a provider directly, and only when a person chose
  them: an agreed AI seat, a hint you asked for, a review you started, a champion or tournament you
  created, a Doctrine improve/author request, or a ladder game you started. Prompts carry game data
  plus the profile name you typed for a Doctrine card's `author`.

## Local play is offline

- The eleven table games, the four talking tables, lessons, hints, reviews, champions, tournaments
  and Doctrine all run on this computer. **Local play requires no network.**
- If the lobby server is down or unreachable, everything local keeps working; the dock says so in
  one sentence.

## Confidentiality choices worth knowing

- Another player's words are fenced and length-limited before a model reads them, and a seat's
  prompt holds only what that seat may see.
- A model seat's private working text stays on your side panel: it never reaches an opponent's
  screen, a watched table, or a shared game file.
- A model playing your agent gets the board, the rules and the legal moves — never player names.
- Doctrine cards are validated data, never code, against fixed size and range limits. Imports
  (cards, playbooks, dossiers, tournament results) are size-capped and plain-text only, and an id
  collision gets a fresh id and a suffixed name instead of overwriting.
- The plugin writes only inside its own data folder, plus nothing in Hermes config. The one
  documented exception is the recovery key, via Hermes's credential route.
- Every SQL statement in the online store names its table from a fixed set — `ratings` or
  `bot_ratings` — and its column from `wins`, `losses` or `draws`; the leaderboard's pool is checked
  at the API layer and refused with a `400` before the store is reached. No table or column name is
  ever built from something a player sent.

## How to stop it

1. **Turn online play off** — one press in the Game Center dock's **Lobby** tab. Nothing is sent
   and nothing is polled afterwards. Turn alerts off the same way; they are per game and off by
   default.
2. **Turn AI seats off** — set the profile setting `allow_ai: false`. No game may seat an AI; people
   keep playing each other.
3. **Change or self-host the lobby** — set `lobby_url` to your own address so nothing goes to the
   author's server. [docs/HOSTING.md](docs/HOSTING.md) covers what a self-hosted lobby needs: TLS in
   front, a kept-offline admin key, and a backup of the data folder.
4. **Remove outbound links you did not want** — set `submit_url` empty; the submission guide link
   is shown instead. Keep any `submit_docs_url` pointing somewhere you trust.
5. **Disable the plugin in Hermes.** This stops every command, card and table it provides. Delete
   its data folder afterwards if you want the local game state, champions and ratings gone too.

## If you find a problem

Report it rather than opening a public issue with a working exploit in it. Treat the disclosure
text in README.md and docs/ONLINE-PLAY.md as the contract for what is and is not sent, and tell us
where the code and that contract disagree.

## Hooks and the automatic bet

Three hooks are registered, and all three are disclosed here because any of them can move the local wallet:

- `pre_llm_call` - one automatic spin per turn, only while the machine is on screen.
- `pre_tool_call` - one automatic spin at most once per 1.2 seconds across a burst of tool calls.
- `post_api_request` - counts the reply's tokens (10 points per 1M in or out, into the see-through
  wallet's points) and then takes one automatic spin sized by what the reply cost.

The automatic bet sizes itself by default: a turn starting or a tool running bets the table minimum,
a longer reply bets more, never above the ladder's top (a multiple of the minimum bet). The switch is
in the machine's card, and turning it off returns to the bet on the lever. Odds are identical at every
bet, so a bigger automatic bet is a bigger swing, never a better chance. Nothing here reads the
prompt, edits it, or writes outside the plugin's own wallet file.
