# Submit your game
_Applies to Game Center 1.0.0 · last revised 2026-11-12 (54c502d6)_

There are three places a game can live, and each one asks for a little more than the
one before it. Start where your game is today.

| Where it appears | What it takes | Who can play it |
| --- | --- | --- |
| **Community creations** | A working web game, a link and a licence | Anyone, in their own browser |
| **Experiments** | A Hermes plugin that ships `game.json` | The person who installs the plugin |
| **Play** | The Play contract below, plus a review | Everyone, with a lobby and a record |

## 1. Community creations: a link to a game you made

If you have a web game that already works in a browser, this is the fastest way in.

You need:

- a working address that starts with `https://` that you are allowed to host;
- a title, your name or handle, and a licence for the game (for example MIT, or
  "all rights reserved" if you are keeping it);
- nothing else. Game Center never loads, frames or runs your page. It hands the
  address to the person's own browser when they press Open, and the card says the
  game is made by the community and not by Game Center or Nous.

Send those three things through **Submit your game** on the Community creations page.
The list itself is `community/games.json` in this plugin, and a reviewed commit adds
your card to it.

Community games are clearly labelled as outside code. They never appear in Play,
never take part in a tournament and never enter a rating.

## 2. Experiments: a Hermes plugin

If you are writing the game as a Hermes plugin, you get a place of its own on the
main page, separate from Community. Ship a `game.json` beside your `plugin.yaml`,
the way `docs/ADD-YOUR-GAME.md` describes, and it appears in **Experiments** once
your plugin is installed and enabled.

Experiments are treated as outside code, by default, for everyone's safety:

- the card shows your title, the plugin it came from, and the plain line
  *"Opens in its own screen. No lobby or matchmaking."*;
- your game opens its own screen (or its own program); Game Center does not seat it
  at its table, put it in a lobby, or score it;
- if a game's own screen cannot be opened, the card says so in one sentence and the
  rest of the page keeps working.

This is a real place to release a game. It is not an endorsement, and it does not
put your game in Play.

## 3. Play: the curated shelf

Play is the short list that ships in `shelf/curated.json`, and only a reviewed
commit changes it. Nothing in a plugin's own manifest can add a game to Play: a
plugin that calls itself curated is still only in Experiments. An id on the list
means that game only when this plugin ships it, so reusing a curated id in your
own `game.json` does not put you in Play either.

A game in Play is match-ready. That means:

- **seats** for two people (and a bot seat if you want one);
- **turns** — one move at a time, in a fixed order;
- **a clear winner** — the game ends in a win or a draw, and says which;
- **a replay** — the same moves from a fresh table reach the same result;
- **computer opponents** — the game's own bot always finds a legal move;
- **lobby-ready** — the game can be listed, joined and watched through Game Center.

Check your game against all of that with the checker that ships here:

```bash
python3 tools/check_game.py my-plugin-folder
```

It prints one plain PASS or FAIL line per item and plays several bot-versus-bot
games in a throwaway folder. It never installs or publishes anything.

When every line passes, submit it through **Submit your game**. A person reviews
it, plays it, and — if it holds up — the game joins the curated list in
`shelf/curated.json`. Play cards open Game Center's own table, so today that
means the game's code is merged into this plugin, under this MIT licence, rather
than staying in a plugin of its own. A game that keeps its own screen stays in
Experiments, however good it is; that is a real place to release, just not Play.

## What we will not take

- A game that loads outside code at runtime, phones home, or collects anything about
  the person playing it.
- A game that crashes the page instead of saying what went wrong.
- A game whose "bot" is a model call with no rules behind it. The engine decides the
  moves; a model may only talk about them.
- Code we cannot license. Play ships in this MIT plugin, so anything added here has
  to be MIT-compatible.

## Questions

If you are not sure which level your game belongs in, submit it as Community and say
what you have. Moving up is easy; the three levels are meant to be a path, not a gate.
