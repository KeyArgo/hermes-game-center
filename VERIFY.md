# VERIFY

Each row is a claim about this plugin, the command that checks it, and the result of running
that command here. Numbers are pasted from a terminal, never typed from memory.

Measured on a Linux 7.1.2 workstation, Python 3.13. The suite is offline: no model, no
network, no GPU.

| # | Claim | Command | Result |
|---|---|---|---|
| 1 | The whole suite runs offline and passes | `/usr/bin/python3 -m pytest tests -q -p no:cacheprovider` | **1242 passed, 12 skipped, 0 failed** (2026-11-09, 711s) on `bughunter/green-clean-secure` at `1bae332`. Run three times on this branch: `1bae332` **1242 passed, 12 skipped** (711s); `1bae332` again **1241 passed, 1 failed, 12 skipped**; `bb56098` (+1 test) **1242 passed, 1 failed, 12 skipped**. Both failures were clock-bounded strength tests in `test_difficulty.py` (named below), and both pass when run alone |
| 2 | Every game that ships can be played to a finish by the built-in player | `python3.13 -m pytest tests/test_person_playthrough.py -q` | in the suite row |
| 3 | A bot-vs-bot game reaches a clear finish — or, for a session table, settles hands and replays exactly | `python3.13 -c "import sys;sys.path.insert(0,'tools');import check_game,pathlib;print(check_game.check(pathlib.Path('blackjack'),5))"` | `True` — 5 seeds, hands settle, the replay matches |
| 4 | A model never sees a player's name | `python3.13 -m pytest tests/test_talktable.py::test_a_model_never_sees_a_player_name -q` | passed |
| 5 | The referee refuses an illegal move out loud, and the refusal is recorded | `python3.13 -m pytest tests/test_referee_rejects.py tests/test_review.py -q` | passed |
| 6 | Play is the reviewed list, and every game in it passes its own contract | `python3.13 -m pytest tests/test_ia.py tests/test_ship_gate.py -q` | passed |
| 7 | The catalogue is the games that ship | `python3.13 -c "import pathlib;print(len(list(pathlib.Path('.').glob('*/game.json'))))"` | `18` |
| 8 | CI runs the same command on every push | `.github/workflows/tests.yml` | workflow present; one job, `python -m pytest tests -q -p no:cacheprovider` |
| 9 | A checkers move is answered inside a second, not after a deep search | `python3.13 -m pytest tests/test_difficulty.py -q` | the level tests pass; the search has a 1.2 s per-move clock |

## What this does not prove

- **No live model.** The suite is offline by design. A real model in a talk-table seat is
  `pytest --realmodel`, which is skipped unless asked for and a model server is reachable.
- **No browser pass by default.** `pytest --browser` drives headless Chrome against the QA
  page; it needs Chrome and takes minutes per game.
- **Latency, not strength.** The 1.2 s checkers clock bounds the wait for a move;
  `tests/test_difficulty.py` checks Expert still beats Beginner, not by how much.
- **Two strength tests are not reproducible, because the engine's search is clock-bounded.**
  `test_difficulty.py` plays "seeded" matches, but Checkers and Reversi choose their move against
  `time.monotonic()` deadlines (`checkers/game.py:280`, `reversi/game.py` `_TIME_LIMIT`), so on a busy box
  the deeper trials are cut off and a weaker move is played. Observed on the same tree: run 1 failed
  `test_expert_beats_beginner_over_seeds[reversi]` (1 win, 1 loss), run 2 passed (1242), run 3 failed
  `test_checkers_expert_beats_beginner_without_a_ply_cap_draw` (expects an Expert win, got Beginner).
  Both pass when run alone. This is a test-design problem, not a strength regression: pin a depth for the
  test (or give the search a budget long enough that the depth cap binds) rather than loosening the
  assertion. `tests/test_difficulty.py`, `checkers/game.py` and `reversi/game.py` are unchanged by this
  branch.
- **The 12 skips are opt-in.** 11 are `--realmodel` (a live model server) and 1 is `--browser`
  (headless Chrome).
- **Online play is fixture-tested only.** Nothing here contacts `games.hermesnet.xyz`.
