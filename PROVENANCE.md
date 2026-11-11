# PROVENANCE

How this repository came to be, said without marketing.

## Who did what

- **Agents wrote the code.** Implementation across the shelf, the game rule engines, the Desktop
  page and the tests was produced by AI coding agents.
- **A human set direction and reviewed.** Scope, the ship gate, what counts as a lie to a player,
  and the plain-language wording rules were decided by a person, and the output was reviewed by
  that person. Agents did not self-approve what ships.
- **This evidence set was written by a coding agent** working from README.md, `plugin.yaml`,
  `shelf/kitref.py` and `desktop/src/30-game-page.js`, plus a short list of stated facts. No
  commands were executed while producing it.

## What that means you should assume

- Comments in this codebase describe intent as its authors understood it. They are useful, not
  proof.
- Docstrings and the README make behavioural promises ("no model call during a battle", "no
  network calls of its own"). Treat each as a claim until you have run something. VERIFY.md lists
  the commands.
- The curated list in `shelf/curated.json` is presented as reviewer-controlled ("only a reviewed
  commit changes that list"). Who reviewed which commit is a git-history question, and this
  document did not consult git history. Unverified here.

## Explicitly unverified

These were stated to us and are **not** confirmed by anything in the four files we were allowed to
read:

- **The 1,200+ test count.** We did not run pytest. The figure is approximate by its own
  description. Whether the suite passes today, on this machine, is unknown to this document.
- **The 0.4 s hint-budget margin** and which test file asserts it. We did not open the tests.
- **`refusal_message` living in `shelf/kitref.py`.** The copy of `shelf/kitref.py` we read contains
  only the kit loader (`KIT_NAME = "hermes_gameshelf_kit"`, `kit_module()`, `kit = kit_module()`)
  and no `refusal_message`. It loads `kit.py` by file path, so the referee wording most plausibly
  lives in `kit.py` — a file we were not permitted to read. The refusal *rendering* is confirmed:
  `desktop/src/30-game-page.js` builds the banner from `pictured.refusals` (`refusalBanner`,
  `refusalBadge`, `refusalLine`, a 2500 ms auto-dismiss timer, `role="status"`).
- **"Ten games with rule engines."** README.md's table lists ten (Connect Four, Reversi, Checkers,
  Breakthrough, Gomoku, Kalah, Chess, Go, Hex, Sea Battle) and says each has its own referee. *(Since
  this audit the README describes the catalogue that ships: Kalah and Pet Battles were removed and the
  table no longer lists them. The audit record below is quoted as written.)* We
  did not open a single game module, so engine correctness is unverified — including the specific
  draw rules README states (80-ply checkers rule, 7.5 komi in Go, fifty-move in chess).
- **No credentials stored.** Reconciled below, not measured. We ran no filesystem inspection.
- **Local play needs no network.** Consistent with README.md and `plugin.yaml` (online is opt-in,
  `lobby_url`/`lobby_key`), but no network-isolated run was performed here.
- **Licence and third-party terms.** `plugin.yaml` says MIT and README.md says MIT. README also
  says the four talking tables use TextArena rules, MIT, vendored in `third_party/textarena/` and
  not installed. `LICENSE` and `third_party/` were not read for this document, so the vendoring
  claim is unverified here.

## What we did read

`README.md`, `plugin.yaml`, `shelf/kitref.py`, `desktop/src/30-game-page.js`. Nothing else in the
repository, no git history, no other branches or lanes. Statements above that go beyond those four
files are marked unverified rather than smoothed over.
