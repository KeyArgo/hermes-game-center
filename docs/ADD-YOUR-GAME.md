# Add your game to the Game Center
_Applies to Game Center 1.0.0 · last revised 2026-11-11 (b2a67f2c)_

Another plugin can put its game on the Game Center shelf by shipping a
`game.json`. **Automatic means exactly this:** an installed, enabled plugin
that ships a valid `game.json` appears after a refresh. Nothing else is
promised — a game that is not installed, or whose plugin is disabled, does not
appear.

## Where your game appears

There are two places, and shipping the file only gets you the first one.

- **Experiments** — every installed, enabled plugin's game lands here. It is
  labelled as outside code: the card says *"Opens in its own screen. No lobby or
  matchmaking."*, and the game is never seated at Game Center's table, never put
  in a lobby, and never scored. This is the default, and it is deliberate.
- **Play** — the curated, match-ready shelf at the top of the page. The only way
  in is `shelf/curated.json`, a small list that ships with Game Center and
  changes only by a reviewed commit. Nothing you put in your own `game.json` can
  promote your game to Play, and an id on the list only counts for the game this
  plugin ships, so reusing a curated id does not work either.

So: a card in Experiments is a real release. A card in Play is a promise that the
game has seats, turns, a clear winner, a replay, a computer opponent and a lobby,
and that a person checked it.

The person can add your game to their chat library with `/games install <id>`.
That is the same Get step as every title Game Center does not ship, and it only
affects chat, not the page.

## Getting into Play

The Play contract is the six checks in `tools/check_game.py`:

```bash
python3 tools/check_game.py my-plugin
```

It reads your `game.json`, loads `game.py` the way the shelf does, lists the
opening moves, plays bot-versus-bot games over several seeds, replays the
recorded moves, and feeds the game garbage to see it refuse instead of crash. It
prints one plain PASS or FAIL line per item and changes nothing on disk outside a
throwaway folder.

When every line passes, open a pull request that describes what you tested. A
curated Play card opens Game Center's own table, so a game that goes into Play is
merged into this plugin (or gains a table adapter here) in that reviewed change.
A game that keeps its own screen needs no pull request: its own plugin publishes
it in Experiments. `examples/match-ready-game/` is a complete game that passes the
checker; `examples/hello-game/` is the smallest possible game and deliberately
does not.

`docs/SUBMIT-A-GAME.md` explains the three levels in plain words for people who
are not writing code yet.

## Where the file goes

```
my-plugin/
  plugin.yaml          # name: my-plugin
  game.json            # one game
  game.py
```

Several games in one plugin are fine, one folder each:

```
my-plugin/
  plugin.yaml
  my-game/game.json
  my-game/game.py
```

`game.json` may sit beside `plugin.yaml`, or one level down. The Game Center
reads it from `$HERMES_HOME/plugins/*` and from the folder the Game Center
itself is installed in.

## The fields

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits and dashes, up to 32. Must be unique. |
| `schema_version` | yes for `external` | `1`. |
| `title` | yes | Shown on the card. |
| `summary` | no | One plain sentence. |
| `kind` | no | `table` (default), `external`, `play`, `listen`, `server`. |
| `plugin_id` | yes for `external` | Your plugin's `name:` from `plugin.yaml`. |
| `desktop_route` | yes for `external` | The Desktop path your screen lives at, e.g. `/hello`. |
| `entry` | yes unless `external` | Your game module, e.g. `game.py`. |
| `factory` | no | Function in that module; default `create`. |
| `bots` | no | `true` when a bot may take a seat. |

### A table game: the shelf sends it `/games` lines

```json
{
  "id": "hello",
  "schema_version": 1,
  "plugin_id": "hello-game",
  "title": "Hello",
  "summary": "The smallest Game Center game.",
  "entry": "game.py",
  "factory": "create",
  "kind": "table",
  "bots": false
}
```

`game.py` needs only a factory and a `command` method:

```python
class Hello:
    def command(self, raw, *, source="command", complete=None):
        return f"Hello from {source}. You said: {raw or 'nothing'}."

def create(root, settings=None):
    return Hello()
```

Return a string: it is shown to the person as the answer. Raise nothing for a
normal refusal — return the sentence instead.

### An external game: it opens its own Desktop screen

Use this when your game needs 3+ seats or a board the shelf cannot draw. The
shelf shows the card and an **Open** button; the button navigates the Desktop
to your route with the SDK's `host.navigate`, and your plugin's page does the
rest.

```json
{
  "id": "my-game",
  "schema_version": 1,
  "plugin_id": "my-plugin",
  "title": "My Game",
  "summary": "A game with its own screen.",
  "kind": "external",
  "desktop_route": "/my-game"
}
```

No `entry` is needed for an external game — the shelf never loads your module.
Validate your route: it must start with `/`, use only letters, digits, `.`, `_`,
`-`, `~` and `/`, and contain no `..` or `//`.

## What happens when something is wrong

A broken manifest never breaks the Game Center or the other games:

- A `game.json` that cannot be read, has a bad `id`, or has no `title` is
  skipped, and the reason is recorded in the catalog's `problems` list.
- An `external` game with a bad `plugin_id`, `schema_version` or
  `desktop_route` still shows its card, with the reason in plain words and no
  **Open** button.
- A `game.py` that raises on import, or whose `create()` raises, shows one
  friendly line on its own card ("Hello could not start. …"). Every other
  card keeps working.
- **A fallback that could not do its job says so.** When your game catches an exception and
  carries on with a sensible default — a missing thumbnail, an unwritable file, a socket that will
  not close — log it rather than passing: `log = logging.getLogger(__name__)` at the top, then
  `log.warning("what failed, in plain words", exc_info=True)` in the handler. The player still sees
  the game keep working; the console, and a bug report, get the traceback. `shelf/spinlog.py` is the
  small worked example: it never stops a spin, and it never hides why a spin was not logged.

## Two things that will bite you

- **Do not name a module `kit`.** The shelf loads its own `kit.py` by path under
  a private module name for exactly this reason, but a plain `import kit` in
  your game can still pick up another plugin's module. Give your helpers
  unique names.
- **Ids are permanent in a library.** Changing a game's `id` after people have
  installed it makes their library entry point at a game that no longer
  exists. Add a new id and keep the old card instead.

A complete, tested example lives in `examples/hello-game/`. For one that passes
the Play contract, and is worth copying when you want a table game, see
`examples/match-ready-game/`.
