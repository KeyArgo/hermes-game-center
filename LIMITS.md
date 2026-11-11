# LIMITS

What this plugin does not do. Blunt, short, from the brief plus what is visibly absent from
README.md.

## Not shipped at all

- **No private rooms.** You cannot invite a named friend into a closed table.
- **No kick.** There is no way to remove someone from a table.
- **No room bans.** There is no way to block someone from rejoining.
  All three are stated as not shipped. If you need moderation of any kind, this plugin cannot
  give it to you today.

## Known test flake

- One test asserts a **hint-budget timing margin of 0.4 s**. On a loaded machine it can fail by
  milliseconds. Re-run it before believing it; if it fails on an idle machine as well, it is a
  real bug and not the flake.

## Will disappoint you if you expect it

- **People are never rated.** Elo, leaderboards, badges and champions apply to bots and the
  built-in player only. If you want your own rating, it is not here.
- **It is a Hermes plugin, not an app.** The graphical table lives in Hermes Desktop's **Games**
  sidebar. Cloning this repo gives you a codebase and a test suite, not something you can double
  click.
- **Online play is off by default and is someone else's server.** It talks to
  `https://games.hermesnet.xyz` (changeable via `lobby_url`). Turn it on and you are trusting that
  host. The bot ladder also needs *another owner's bot* to show up, or a rated game never starts.
- **Hint is narrow by design.** Only you vs the built-in player, only on your own turn, never
  against another person, never from a tool call.
- **Lessons are not adaptive.** Three or four fixed steps on real positions, never scored, never
  recorded.
- **Only the ten table games are "Play".** Everything another plugin ships goes to **Your games**,
  is labelled outside code, and is never seated at a Game Center table, never enters a tournament,
  never gets a rating. Labs cards are excluded from the Play tiles. A Play game that fails the ship
  gate is demoted to Labs.
- **No lobby for most things.** The four talking tables, Doctrine, Olympus Arena and every
  other-plugin card say on the card that they have no lobby or matchmaking. Doom is the only launch
  card with one.
- **No game data, no downloads, no installers.** The five launch cards (Doom, OpenTTD, Luanti,
  Wesnoth, OpenRA) only start a program you installed yourself and print a plain-text install hint
  if nothing is found. Doom needs a WAD you supply or Freedoom you install. Flatpak Doom and
  Flatpak OpenRA builds are deliberately not offered because their sandboxes break data access and
  mod switching.
- **Robocode Tank Royale has no card.** It needs Java 11+, and its documented start routes are not
  one fixed command, so nothing ships and nothing is bundled.
- **Community creations is a link-out, not a feature.** No iframes, no previews, no fetching.
  Pressing **Open** hands the URL to your browser and Game Center never sees the result.
- **No spectating controls beyond read-only.** You can watch a table; there is no chat, no voting,
  no interactive spectator role.
- **Model seats are Hermes-only.** Model calls go through Hermes and only after a person agreed.
  With `allow_ai: false` every AI seat is off. There is no route to a provider API key of its own.
- **Two tries, then the built-in player moves.** If your model answers illegally twice, the
  built-in player plays for it and the refusal is recorded. Convenient, but your agent did not
  make that move, and the board labels it that way.
