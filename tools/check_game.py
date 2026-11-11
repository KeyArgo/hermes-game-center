#!/usr/bin/env python3
"""Check one game against the Play contract.

Play is the short curated list that ships with Game Center. A game is only added to
it after it passes this check and a person reviews the change. The check answers six
plain questions, one line each, and never leaves a half-played match behind.

    python3 tools/check_game.py connect4
    python3 tools/check_game.py examples/hello-game --seeds 3

Exit code 0 when every check passed, 1 when any check failed. Nothing is installed,
nothing touches the network, and every match is played in a throwaway folder.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import random
import re
import shutil
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")
_KINDS = {"table", "server", "listen", "install", "play", "external"}
# A game that takes longer than this to finish is not a game anyone waits for.
MAX_PLIES = 400
# Throwaway folders this run made, removed when the check is over.
_TEMP: list[Path] = []


class Report:
    """One plain line per check, and the reason when it fails."""

    def __init__(self) -> None:
        self.failed = 0

    def line(self, ok: bool, label: str, detail: str = "") -> bool:
        mark = "PASS" if ok else "FAIL"
        print(f"  {mark}  {label}" + (f" — {detail}" if detail else ""))
        if not ok:
            self.failed += 1
        return ok


def _manifest(folder: Path) -> tuple[dict[str, Any] | None, str]:
    path = folder / "game.json"
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"game.json could not be read ({type(exc).__name__})"
    if not isinstance(loaded, dict):
        return None, "game.json is not a JSON object"
    return loaded, ""


def _load(folder: Path, entry: str, factory: str) -> tuple[Any, str]:
    """Load the game the way the shelf does: a bare module, its own folder, no sys.modules.

    The factory is called exactly as Game Center calls it — ``create(root, settings)`` —
    so a game that only accepts one argument fails here rather than after it ships.
    """
    path = folder / entry
    name = f"check_game_{folder.name.replace('-', '_')}"
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            return None, f"cannot load {entry}"
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        make = getattr(module, factory, None)
        if not callable(make):
            return None, f"{entry} has no {factory}()"
        root = Path(tempfile.mkdtemp(prefix="check-game-"))
        _TEMP.append(root)
        game = make(root, {"data_root": str(root)})
    except SystemExit:
        return None, f"{entry} stopped the whole program on import or in {factory}()"
    except Exception as exc:  # noqa: BLE001 - a plain reason, never a traceback
        return None, f"{entry} could not load ({type(exc).__name__}: {' '.join(str(exc).split())[:160]})"
    return game, ""


def _state(fresh: Any) -> dict[str, Any]:
    """The state the table starts from, before anyone moves."""
    state = dict(fresh() or {})
    state.update({
        "schema_version": 2,
        "game": "check",
        "turn": "white",
        "status": "active",
        "winner": "",
        "plies": 0,
        "last": "",
        "moves": [],
        "level": "normal",
    })
    return state


def _one(seed: int) -> random.Random:
    return random.Random(f"check-game-{seed}")


SESSION_PLIES = 150


def _is_session(rules: Any) -> bool:
    """A session game (blackjack, slots) settles hands and stays open; it never ends."""
    return bool(getattr(rules, "SESSION", False))


def _session_ok(state: dict[str, Any], settled: int = 3) -> bool:
    """A session game's contract: it keeps dealing, and rounds actually settle.

    ``hands`` is a card table's counter; ``spins`` is a slot machine's.
    """
    return int(state.get("hands") or state.get("spins") or 0) >= settled


def _reset_session_wallet(rules: Any) -> None:
    """A session game keeps chips in a wallet file beside its table.

    Every run of the check starts from the same stack, and a stack big enough for the
    stakes the bot chose. Otherwise the replay of a legal run can hit an empty wallet and
    the same moves stop being legal — which proves nothing about the game.
    """
    if not _TEMP:
        return
    root = Path(_TEMP[-1])
    for path in root.rglob("wallet.json"):
        path.unlink(missing_ok=True)
    rebind = getattr(rules, "use_wallet", None)
    if callable(rebind):
        target = root / "wallet.json"
        target.write_text(json.dumps({"chips": 1000000}), encoding="utf-8")
        rebind(target)


def _play_out(rules: Any, seed: int, opening: int = 2, cap: int | None = None) -> dict[str, Any]:
    """One bot-versus-bot game: a seeded opening, then the game's own bot to the end.

    ``cap`` bounds the bot loop for a session game, which has no end to reach.
    """
    state = _state(rules.fresh)
    start = copy.deepcopy(state)
    shown: list[str] = []
    coin = _one(seed)
    for _ in range(opening):
        choices = list(rules.legal(state))
        if not choices or state.get("status") != "active":
            break
        move = choices[coin.randrange(len(choices))]
        shown.append(rules.show(move))
        rules.play(state, move)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = shown[-1]
    guard = 0
    limit = cap if cap is not None else MAX_PLIES
    while state.get("status") == "active" and guard < limit:
        choices = list(rules.legal(state))
        if not choices:
            break
        move = rules.bot(state)
        if move not in choices:
            raise AssertionError(f"the bot chose {move!r}, which is not a legal move")
        shown.append(rules.show(move))
        rules.play(state, move)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = shown[-1]
        guard += 1
    return {"state": state, "start": start, "shown": shown,
            "status": str(state.get("status") or ""), "winner": str(state.get("winner") or "")}


def _replay(rules: Any, shown: list[str], start: dict[str, Any] | None = None) -> dict[str, Any]:
    """Replay the recorded moves, reading each one back from its text.

    A session game deals from a shuffled shoe that lives in its state, so it is replayed
    from the start state the first run recorded; a board game replays from ``fresh()``.
    """
    state = copy.deepcopy(start) if start is not None else _state(rules.fresh)
    for token in shown:
        move = rules.parse(str(token).split())
        if move is None:
            raise AssertionError(f"{token!r} no longer reads back as a move")
        if move not in rules.legal(state):
            raise AssertionError(f"{token!r} is no longer legal when replayed")
        rules.play(state, move)
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = token
    return {"status": str(state.get("status") or ""), "winner": str(state.get("winner") or ""),
            "hands": int(state.get("hands") or 0)}


def _illegal(rules: Any, game: Any) -> tuple[bool, str]:
    """Garbage must be refused plainly: no exception, no crash, no invented move.

    A game may read a number and hand it to the table (Connect Four reads 999999 as
    a column), so the rule is that garbage never becomes a *legal* move and the table
    answers it in words rather than raising.
    """
    try:
        legal = list(rules.legal(_state(rules.fresh)))
    except Exception as exc:  # noqa: BLE001
        return False, f"legal() raised {type(exc).__name__} on a fresh table"
    for junk in (["nonsense"], ["move", "zzz"], ["999999"], ["-1"], ["\u265e\u2708"]):
        try:
            move = rules.parse(junk)
        except Exception as exc:  # noqa: BLE001
            return False, f"parse({junk!r}) raised {type(exc).__name__}"
        if move is not None and move in legal:
            return False, f"parse({junk!r}) turned garbage into a legal move"
    command = getattr(game, "command", None)
    if not callable(command):
        return False, "the game has no command() to refuse an illegal move"
    try:
        command("new white=human black=human", source="command")
        answered = str(command("move zzz", source="command"))
    except Exception as exc:  # noqa: BLE001
        return False, f"an illegal move raised {type(exc).__name__}"
    if not answered.strip():
        return False, "an illegal move got an empty answer instead of a refusal"
    return True, ""


def check(folder: Path, seeds: int = 3) -> bool:
    """Run every check, then remove the throwaway folders it played the games in."""
    try:
        return _check(folder, seeds)
    finally:
        for path in _TEMP:
            shutil.rmtree(path, ignore_errors=True)
        _TEMP.clear()


def _check(folder: Path, seeds: int = 3) -> bool:
    folder = Path(folder)
    report = Report()
    print(f"Checking {folder}")
    if not folder.is_dir():
        report.line(False, "the plugin folder exists", str(folder))
        return False

    manifest, problem = _manifest(folder)
    if manifest is None:
        report.line(False, "game.json is readable", problem)
        return False

    game_id = str(manifest.get("id") or "")
    entry = str(manifest.get("entry") or "")
    factory = str(manifest.get("factory") or "create")
    kind = str(manifest.get("kind") or "table").strip().lower()
    fields: list[str] = []
    if not _ID.fullmatch(game_id):
        fields.append("id must be lowercase letters, digits and dashes")
    if not str(manifest.get("title") or "").strip():
        fields.append("no title")
    if manifest.get("schema_version") != 1:
        fields.append("schema_version must be 1")
    if kind not in _KINDS:
        fields.append(f"kind {kind!r} is not one of {sorted(_KINDS)}")
    elif kind != "table":
        fields.append(f"kind is {kind!r}; Play is seats and turns, so it must be \"table\"")
    if manifest.get("bots") is not True:
        fields.append("bots must be true: Play needs a computer opponent")
    if not entry:
        fields.append("no entry file")
    elif not (folder / entry).is_file():
        fields.append(f"{entry} is missing")
    report.line(not fields, "game.json describes a table game a person can be seated at", "; ".join(fields))
    if fields:
        return False

    game, problem = _load(folder, entry, factory)
    if game is None:
        report.line(False, "the game loads the way the shelf loads it", problem)
        return False
    rules = getattr(game, "rules", None)
    if rules is None:
        report.line(False, "the game ships table rules (fresh, legal, play, bot, show, parse)",
                    "no rules: this game opens its own screen, so it cannot be in Play")
        return False
    missing = [name for name in ("fresh", "legal", "play", "bot", "show", "parse") if not callable(getattr(rules, name, None))]
    report.line(not missing, "the game ships table rules (fresh, legal, play, bot, show, parse)",
                f"missing {', '.join(missing)}" if missing else "")
    if missing:
        return False

    # Legal moves at the start, and every one of them readable again from its text.
    try:
        opening = list(rules.legal(_state(rules.fresh)))
    except Exception as exc:  # noqa: BLE001
        report.line(False, "there are legal moves at the start", f"legal() raised {type(exc).__name__}")
        return False
    if not report.line(bool(opening), "there are legal moves at the start", f"{len(opening)} to choose from"):
        return False
    bad: list[str] = []
    for move in opening:
        try:
            shown = rules.show(move)
            back = rules.parse(str(shown).split())
        except Exception as exc:  # noqa: BLE001
            bad.append(f"{move!r} raised {type(exc).__name__}")
            continue
        if back != move:
            bad.append(f"{shown!r} read back as {back!r}")
    report.line(not bad, "every legal opening move reads back from its own text", "; ".join(bad[:3]))
    if bad:
        return False

    # Bot versus bot, over several seeds, to a finish.
    games: list[dict[str, Any]] = []
    trouble = ""
    session = _is_session(rules)
    for seed in range(1, seeds + 1):
        try:
            if session:
                _reset_session_wallet(rules)
            played = _play_out(rules, seed, cap=SESSION_PLIES if session else None)
        except Exception as exc:  # noqa: BLE001
            trouble = f"seed {seed} raised {type(exc).__name__}: {' '.join(str(exc).split())[:120]}"
            break
        if session:
            # A session table never ends; its contract is that hands settle and the
            # game keeps dealing instead of stalling.
            if not _session_ok(played["state"]):
                trouble = (f"seed {seed} settled {int(played['state'].get('hands') or 0)} hands "
                           f"in {len(played['shown'])} moves and stalled")
                break
            games.append(played)
            continue
        if played["status"] not in {"win", "draw"}:
            trouble = f"seed {seed} stopped at {played['status'] or 'no status'} after {len(played['shown'])} moves"
            break
        if played["status"] == "win" and played["winner"] not in {"white", "black"}:
            trouble = f"seed {seed} says it was won, but names no winner"
            break
        games.append(played)
    if session:
        report.line(not trouble and len(games) == seeds,
                    f"a session game settles hands and keeps dealing over {seeds} seeds",
                    trouble or ", ".join(f"{int(item['state'].get('hands') or 0)} hands "
                                         f"in {len(item['shown'])} moves" for item in games))
    else:
        report.line(not trouble and len(games) == seeds,
                    f"bot versus bot reaches a clear finish over {seeds} seeds",
                    trouble or ", ".join(f"{item['status']} in {len(item['shown'])} moves" for item in games))
    if trouble or not games:
        return False

    # Replay: the same moves from a fresh table reach the same result.
    mismatched = ""
    for seed, played in zip(range(1, seeds + 1), games):
        try:
            if session:
                _reset_session_wallet(rules)
            again = _replay(rules, played["shown"], played["start"] if session else None)
        except Exception as exc:  # noqa: BLE001
            mismatched = f"seed {seed} raised {type(exc).__name__} on replay: {" ".join(str(exc).split())[:160]}"
            break
        if session:
            first = int(played["state"].get("hands") or 0)
            second = int(again.get("hands") or 0)
            if first != second:
                mismatched = f"seed {seed} settled {first} hands the first time and {second} on replay"
                break
        elif (again["status"], again["winner"]) != (played["status"], played["winner"]):
            mismatched = (f"seed {seed} ended {played['status']}/{played['winner']} the first time "
                          f"and {again['status']}/{again['winner']} on replay")
            break
    report.line(not mismatched, "replaying the recorded moves reaches the same result", mismatched)
    if mismatched:
        return False

    ok, why = _illegal(rules, game)
    report.line(ok, "garbage and illegal moves are refused without a crash", why)
    if not ok:
        return False

    return report.failed == 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Check a Game Center game against the Play contract.")
    parser.add_argument("folder", nargs="?", default=".", help="the plugin folder that holds game.json")
    parser.add_argument("--seeds", type=int, default=3, help="how many bot-versus-bot games to play (default 3)")
    args = parser.parse_args()
    passed = check(Path(args.folder), max(1, args.seeds))
    print()
    if passed:
        print(f"{Path(args.folder).name} meets the Play contract.")
        return 0
    print(f"{Path(args.folder).name} does not meet the Play contract yet. Fix the lines marked FAIL and run this again.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
