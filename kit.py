"""Seats, turns, and saved state for Game Shelf titles. No game rules live here."""

from __future__ import annotations

import contextlib
import copy
import inspect
import json
import logging
import os
import queue
import random
import shlex
import threading
import uuid
import zlib
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SIDES = ("white", "black")
# Seats a program plays: the built-in player, or the person's own Hermes agent (their model).
AI_KINDS = {"local", "agent"}
AGENT_TRIES = 2
# How long one model answer may take before the built-in player moves instead.
# Without a limit a stuck provider holds the whole table; a game must never wait.
AGENT_SECONDS = 20.0
# Every model call runs on a helper thread that cannot be killed if it hangs, so
# the number of calls alive at once is capped: past this many the table stops
# asking and plays itself. A call frees its place the moment it answers.
AGENT_CALLS = 4
_LIVE: list[threading.Thread] = []
_LIVE_LOCK = threading.Lock()


class ModelBusy(Exception):
    """Every model slot is taken: that many calls are still running (likely stuck)."""


LESSON_DONE = "lesson_done"


def seat_kind(token: str) -> str:
    text = str(token or "").strip().lower()
    if text in {"", "human"} or text.startswith("human:"):
        return "human"
    if text == "local":
        return "local"
    if text == "agent":
        return "agent"
    return "profile"


def words(raw: str) -> list[str] | None:
    try:
        return shlex.split(raw or "")
    except ValueError:
        return None


def pairs(parts: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}
    for part in parts:
        if "=" in part:
            key, value = part.split("=", 1)
            found[key.lower()] = value
    return found


# ----- difficulty -------------------------------------------------------------
# The built-in player's strength. A level is a depth cap in the game's own
# search, plus a little seeded noise for Beginner so a new player can beat it.
# Intermediate and Advanced are exactly the old Normal and Hard: the shipped
# player is what every old test pins. Expert is a deeper search, benchmarked
# to fit each game's time budget.
LEVELS = ("beginner", "intermediate", "advanced", "expert")
DEFAULT_LEVEL = "intermediate"
LEVEL_LABELS = {"beginner": "Beginner", "intermediate": "Intermediate",
                "advanced": "Advanced", "expert": "Expert"}
# The three old spellings keep working everywhere a level is read: old saved
# games, old `level=hard` command lines and old level.json files all land on
# the right rung of the four.
LEVEL_ALIASES = {"easy": "beginner", "normal": "intermediate", "hard": "advanced"}
# How often Beginner plays some other legal move instead of its best one.
# The other three never guess.
EASY_NOISE = 0.30


def _level_word(state: dict | None) -> str:
    """The level this game asks for, old spellings folded onto the new four."""
    said = str((state or {}).get("level") or "").strip().lower()
    return LEVEL_ALIASES.get(said, said)


def level(state: dict | None, levels: tuple[str, ...] = LEVELS,
          default: str = DEFAULT_LEVEL) -> str:
    """The level this game is playing at; Intermediate when an older saved game has none."""
    said = _level_word(state)
    return said if said in levels else default


# A game may ship its own levels: Sea Battle offers four (Beginner, Intermediate,
# Advanced, Expert) where a search-based game offers three. The table, the chooser
# and the saved choice all read the list from the game, so they can never disagree.
def game_levels(rules) -> tuple[str, ...]:
    said = getattr(rules, "LEVELS", None)
    if not said:
        return LEVELS
    try:
        found = tuple(str(item) for item in said)
    except TypeError:
        return LEVELS
    return found or LEVELS


def game_default_level(rules) -> str:
    found = game_levels(rules)
    said = str(getattr(rules, "DEFAULT_LEVEL", "") or DEFAULT_LEVEL).strip().lower()
    return said if said in found else found[min(1, len(found) - 1)]


def game_level_labels(rules) -> dict[str, str]:
    said = getattr(rules, "LEVEL_LABELS", None)
    return dict(said) if isinstance(said, dict) else dict(LEVEL_LABELS)


def level_depth(state: dict | None, depths: dict[str, int]) -> int:
    """The depth cap for this level from the game's own table of levels."""
    said = _level_word(state)
    if said not in depths:
        said = DEFAULT_LEVEL if DEFAULT_LEVEL in depths else next(iter(depths))
    return int(depths[said])


def level_label(state: dict | None) -> str:
    said = level(state)
    return LEVEL_LABELS.get(said, said.title())


def _level_note(rules, state) -> str:
    """What a game says really powered the last move (chess: Stockfish or built-in).

    Runs on every picture, so a misbehaving game must never break the table.
    """
    note = getattr(rules, "level_note", None)
    if not callable(note):
        return ""
    try:
        return str(note(state) or "")
    except Exception:
        return ""


def _level_choices(levels: tuple[str, ...], labels: dict[str, str] | None = None) -> str:
    # The ids, not the labels: this sentence is read by a person typing a level
    # name ("level=normal"), and by the tests that quote the default three.
    names = [str(item) for item in levels]
    return ", ".join(names[:-1]) + f" or {names[-1]}" if len(names) > 1 else names[0]



def _coin(state: dict) -> random.Random:
    """A stable coin for one position: the same board always gets the same answer.

    Seeded from the position itself (board, turn, moves), never the clock, so a
    replay or a review sees exactly the opponent that was played against.
    """
    try:
        text = json.dumps(state, sort_keys=True, default=str)
    except (TypeError, ValueError):
        text = "|".join(str(state.get(field, "")) for field in ("game", "table_id", "plies", "last"))
    return random.Random(zlib.crc32(text.encode("utf-8")))


def level_pick(state: dict, moves, best, *, odds: float | None = None):
    """Beginner now and then plays another legal move, so a person can beat it.

    Calls are seeded by the position: the same game always sees the same miss.
    The other three levels return ``best`` untouched.
    """
    options = list(moves)
    chance = EASY_NOISE if odds is None else float(odds)
    if level(state) != "beginner" or chance <= 0 or len(options) < 2 or best not in options:
        return best
    rng = _coin(state)
    if rng.random() >= chance:
        return best
    options.remove(best)
    return options[rng.randrange(len(options))]


def remembered_level(root: Path, levels: tuple[str, ...] = LEVELS,
                     default: str = DEFAULT_LEVEL) -> str:
    """The level this game last played at, so the choice is remembered per game."""
    path = Path(root) / "level.json"
    try:
        found = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    said = _level_word(found if isinstance(found, dict) else None)
    return said if said in levels else default


def remember_level(root: Path, chosen: str, levels: tuple[str, ...] = LEVELS) -> None:
    """Save the level for next time. Best effort: a read-only folder keeps the game."""
    if chosen not in levels:
        return
    folder = Path(root)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        temporary = folder / "level.json.tmp"
        temporary.write_text(json.dumps({"level": chosen}), encoding="utf-8")
        os.replace(temporary, folder / "level.json")
    except OSError:
        log.debug("the chosen level could not be remembered", exc_info=True)


def load(root: Path) -> dict | None:
    path = Path(root) / "state.json"
    if not path.is_file():
        return None
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(loaded, dict):
        return None
    loaded["schema_version"] = 2
    loaded.setdefault("table_id", uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())).hex)
    loaded.setdefault("owner_id", next((str(loaded.get(f"{side}_id")) for side in SIDES
                                         if loaded.get(f"{side}_id") and seat_kind(loaded.get(side, "")) == "human"), ""))
    loaded.setdefault("score", {"white": 0, "black": 0, "draws": 0})
    loaded.setdefault("moves", [])
    loaded.setdefault("rematch", {"requested_by": []})
    loaded.setdefault("draw_offer", "")
    return loaded


def write(root: Path, state: dict) -> None:
    """Replace state.json. Call inside locked() or through save()."""
    folder = Path(root)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / "state.json.tmp"
    temporary.write_text(json.dumps(state), encoding="utf-8")
    os.replace(temporary, folder / "state.json")


_FILELOCK_IMPORT_LOCK = threading.Lock()


def _file_lock():
    """Load shelf/filelock.py beside this file, however kit itself was loaded."""
    import importlib.util
    import sys

    name = "hermes_gameshelf_filelock"
    found = sys.modules.get(name)
    if found is not None:
        return found.file_lock
    with _FILELOCK_IMPORT_LOCK:
        # Another thread may have finished the load while we waited.
        found = sys.modules.get(name)
        if found is not None:
            return found.file_lock
        path = Path(__file__).resolve().parent / "shelf" / "filelock.py"
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        # Publish only after a successful exec so another thread can never see
        # a half-loaded module.
        spec.loader.exec_module(module)
        sys.modules[name] = module
        return module.file_lock


@contextlib.contextmanager
def locked(root: Path):
    folder = Path(root)
    folder.mkdir(parents=True, exist_ok=True)
    with _file_lock()(folder / ".lock"):
        yield


def save(root: Path, state: dict) -> None:
    with locked(root):
        write(root, state)


def clear(root: Path) -> None:
    path = Path(root) / "state.json"
    if path.is_file():
        path.unlink()


def shared_keyboard(player: object) -> bool:
    """One keyboard can play both seats. Two people on a chat platform cannot."""
    if player is None:
        return True
    return str(getattr(player, "platform", "") or "") in {"", "local", "cli", "tui", "desktop"}


def claim(state: dict, side: str, player: object) -> str | None:
    """Bind an open human seat to this person, or refuse if it is someone else's turn."""
    identity = str(getattr(player, "id", "") or "")
    if not state.get(f"{side}_id"):
        others_seated = any(
            state.get(f"{seat}_id") not in {None, "", identity}
            and seat_kind(state.get(seat, "")) == "human"
            for seat in SIDES
        )
        if others_seated or (state.get("owner_id") and (
            identity != state["owner_id"] or not shared_keyboard(player)
        )):
            return f"Take a seat first: sit {side}."
    if player is None:
        if state.get(f"{side}_id"):
            return "Only the seated player can move."
        return None
    if seat_kind(str(state.get(side) or "")) != "human":
        return None
    bound = str(state.get(f"{side}_id") or "")
    other = "black" if side == "white" else "white"
    other_id = str(state.get(f"{other}_id") or "")
    player_id = str(getattr(player, "id", "") or "")
    player_name = str(getattr(player, "name", "") or "You")
    if bound and bound != player_id:
        return f"It's {state.get(f'{side}_name') or 'the other player'}'s turn."
    if not bound and state.get("schema_version") == 2 and not shared_keyboard(player):
        return f"Take a seat first: sit {side}."
    if not bound and other_id == player_id and not shared_keyboard(player):
        return f"You are {player_name}. The other person plays the open seat."
    if not bound:
        state[f"{side}_id"] = player_id
        state[f"{side}_name"] = player_name
        state[side] = "human"
    return None


def sit(state: dict, side: str, player: object, kind: str = "human") -> None:
    state[side] = kind
    if kind == "local":
        state[f"{side}_id"] = "local"
        state[f"{side}_name"] = "Local"
        return
    if kind == "agent":
        state[f"{side}_id"] = "agent"
        state[f"{side}_name"] = "Your agent"
        return
    if player is None:
        state[f"{side}_id"] = ""
        state[f"{side}_name"] = ""
        return
    state[f"{side}_id"] = str(getattr(player, "id", "") or "")
    state[f"{side}_name"] = str(getattr(player, "name", "") or "You")


def side_words(rules) -> dict:
    """The two sides in the words this game actually uses.

    Most tables really do play White against Black. Connect Four plays red discs
    against yellow ones and Kalah counts seeds in pits and stores, so those two say
    so themselves instead of a newcomer reading chess vocabulary off a drop game.
    """
    words = dict(getattr(rules, "SIDE_WORDS", {}) or {})
    return {"white": str(words.get("white") or "White"), "black": str(words.get("black") or "Black")}


def seat_words(rules) -> dict:
    """The seat row's phrase per side: the side word plus what it owns."""
    words = dict(getattr(rules, "SEAT_WORDS", {}) or {})
    sides = side_words(rules)
    return {"white": str(words.get("white") or f"{sides['white']} pieces"),
            "black": str(words.get("black") or f"{sides['black']} pieces")}


def seat_line(state: dict, side: str) -> str:
    name = str(state.get(f"{side}_name") or "")
    if name:
        return name
    if not state.get(side):
        return "waiting"
    if state.get(side) == "local":
        return "Local"
    return side


def _pick(text: str, by_name: dict, rules, legal: list):
    """A legal move named in a model's reply, or None."""
    cleaned = text.strip().strip("`*\"'.").lower()
    if cleaned in by_name:
        return by_name[cleaned]
    tokens = [token.strip("`*\"'.,:;()[]") for token in cleaned.split()]
    if tokens and tokens[0] == "move":
        tokens = tokens[1:]
    for token in tokens:
        if token in by_name:
            return by_name[token]
    with contextlib.suppress(Exception):
        move = rules.parse(tokens)
        if move is not None and move in legal:
            return move
    return None


def _bounded(call, prompt: str, seconds: float | None = None):
    """Ask the model, but never wait longer than ``seconds`` for the answer.

    The model runs on a helper thread so a stuck provider cannot freeze the
    table: when the limit passes we give up and the caller falls back. The
    helper thread is a daemon, so even a call that never returns cannot keep
    the process alive, and at most ``AGENT_CALLS`` calls may be alive at once,
    so an outage cannot pile up threads or provider requests.
    """
    limit = AGENT_SECONDS if seconds is None else seconds
    box: queue.Queue = queue.Queue(maxsize=1)

    with _LIVE_LOCK:
        _LIVE[:] = [item for item in _LIVE if item.is_alive()]
        if len(_LIVE) >= AGENT_CALLS:
            raise ModelBusy("every model slot is still running")
        worker: threading.Thread

        def run() -> None:
            try:
                answer = call(prompt)
            except BaseException as exc:  # the model is untrusted: every failure is a fallback
                found: tuple = ("error", exc)
            else:
                found = ("answer", answer)
            finally:
                # Free the slot before the answer is handed over, so a fast
                # answer never blocks the next request for a moment.
                with _LIVE_LOCK:
                    if worker in _LIVE:
                        _LIVE.remove(worker)
            box.put(found)

        worker = threading.Thread(target=run, daemon=True, name="gameshelf-model")
        _LIVE.append(worker)
        worker.start()
    try:
        kind, value = box.get(timeout=limit)
    except queue.Empty:
        raise TimeoutError("the model did not answer in time") from None
    if kind == "error":
        raise value
    return value


def lesson_steps(rules) -> list[dict]:
    """The game's lesson (lesson.json beside game.py), or [] when it has none."""
    path = Path(str(getattr(rules, "__file__", "") or "")).with_name("lesson.json")
    try:
        found = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    steps = found.get("steps") if isinstance(found, dict) else None
    return [step for step in steps if isinstance(step, dict)] if isinstance(steps, list) else []


def lesson_position(rules, step: dict) -> dict:
    """A step's position: the start, then its setup moves replayed through the game's own rules."""
    state = {"turn": "white", "status": "active", "winner": "", "plies": 0, "moves": [], "last": ""}
    state.update(rules.fresh())
    for token in step.get("setup") or []:
        move = rules.parse(str(token).split())
        if move is None or move not in rules.legal(state):
            raise ValueError(f"setup move {token!r} is not legal")
        rules.play(state, move)
        shown = rules.show(move)
        state["plies"] += 1
        state["moves"].append(shown)
        state["last"] = shown
        if state.get("status") != "active":
            raise ValueError(f"the game ended during setup at {token!r}")
    return state


def lesson_passes(rules, step: dict, state: dict, move) -> bool:
    goal = [str(item).lower() for item in step.get("goal") or []]
    if goal and str(rules.show(move)).lower() not in goal:
        return False
    if step.get("wins"):
        trial = copy.deepcopy(state)
        rules.play(trial, move)
        return trial.get("status") == "win"
    return True


def rules(namespace: dict):
    """A game's module globals as the rules object. The shelf loads games without sys.modules."""
    import types

    return types.SimpleNamespace(**namespace)


def _refused(rules, state: dict, text: str) -> dict:
    """One refused proposal from a model, in plain words."""
    proposed = text.strip()[:40] or "(nothing)"
    reason = "That isn't a move in this game."
    with contextlib.suppress(Exception):
        move = rules.parse([token.strip("`*\"'.,:;()[]") for token in proposed.lower().split()])
        if move is not None:
            reason = refusal_reason(rules, state, move)
    return {"proposed": proposed, "reason": reason}


def refusal_reason(rules, state: dict, move) -> str:
    """Why the rules refused this move, in one short sentence.

    A game that knows its own board supplies ``refusal(state, move)``. The
    fallback is still a plain sentence rather than the old bare code.
    """
    hook = getattr(rules, "refusal", None)
    if callable(hook):
        try:
            reason = str(hook(state, move) or "").strip()
        except Exception:
            reason = ""
        if reason:
            return reason
    return "That move isn't allowed."


def refusal_message(record: dict) -> str:
    """One plain sentence for a refusal record: {"proposals": [{"proposed","reason"}], "played": str}.

    Returns "" when there are no proposals. Never raises on missing keys.
    """
    proposals = record.get("proposals") if isinstance(record, dict) else None
    if not isinstance(proposals, list):
        return ""
    said = []
    for item in proposals:
        if not isinstance(item, dict):
            continue
        proposed = item.get("proposed")
        reason = item.get("reason")
        if not isinstance(proposed, str) or not proposed.strip():
            continue
        if not isinstance(reason, str):
            reason = ""
        # The reasons are already plain sentences; a trailing period goes before the join.
        said.append(f"Illegal move: {proposed.strip()} — {reason.strip().rstrip('.')}".strip())
    if not said:
        return ""
    played = record.get("played")
    if not isinstance(played, str) or not played.strip():
        return "; ".join(said) + "."
    return f"{'; '.join(said)}. Playing {played.strip()} instead."


def _shelf(name: str):
    """Import shelf/<name> beside this file, however kit itself was loaded."""
    import sys

    root = Path(__file__).resolve().parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    import importlib

    return importlib.import_module(f"shelf.{name}")


# Set once by the plugin (see __init__.register): called with the finished state of every
# won game, so the person's bonus points are credited without kit knowing any wallet.
BONUS_SINK = None


def set_bonus_sink(fn) -> None:
    global BONUS_SINK
    BONUS_SINK = fn


class Table:
    """Two seats, white moves first. ``rules`` is a module with the game's rules.

    rules must provide ID, TITLE, MARKS (white, black), EXAMPLE, HELP, MAX_PLIES and
    fresh() -> dict, parse(words) -> move | None, legal(state) -> list,
    play(state, move) -> note, bot(state) -> move, show(move) -> str, draw(state) -> list[str].
    play() sets state turn, status ("active", "win", "draw") and winner.
    """

    def __init__(self, root: Path, rules) -> None:
        self.root = Path(root)
        self.rules = rules
        self.complete = None

    def command(self, raw: str, *, source: str = "command", complete=None, player=None) -> str:
        # Asks the person's own Hermes model for a move. None outside Hermes (the web server).
        self.complete = complete if callable(complete) else None
        rules = self.rules
        parts = words(raw)
        if parts is None:
            return f"Could not read that. Try /games {rules.ID} {rules.EXAMPLE}"
        if not parts or parts[0].lower() == "help":
            return self.help()
        head, rest = parts[0].lower(), parts[1:]
        if getattr(player, "bot", False) and head not in {"state", "board", "help"}:
            return "Refused (person_required)."
        if source != "command" and head in {
            "new", "join", "sit", "leave", "resign", "draw", "rematch", "abandon", "allow-ai", "allow_ai",
            "lesson", "learn", "review", "hint",
        }:
            return "Refused (consent_required)."
        with locked(self.root):
            state = load(self.root)
            if head == "new":
                return self._new(state, rest, player)
            if head in {"allow-ai", "allow_ai"}:
                return self._allow(state, rest, source, player)
            if head == "lesson":
                return self._lesson(state, rest, player)
            if state is None or state.get("status") == "abandoned":
                return f"No game in progress. /games {rules.ID} new"
            if head in {"state", "board"}:
                return self.draw(state)
            if state.get("lesson") and head in {"join", "sit", "leave", "step", "resign", "draw", "rematch", "review"}:
                # A review remembers the finished game, so its Rematch can put
                # the same opponent and series back on the table.
                if not (head == "rematch" and state.get("review_of")):
                    return f"Refused (lesson). This is a lesson: /games {rules.ID} lesson next, or start a new game."
            if head == "learn" and rest and rest[0].lower() == "undo":
                return self._undo(state, player, lesson=False)
            if head == "join":
                return self._join(state, player)
            if head == "sit":
                return self._sit(state, rest, player)
            if head == "leave":
                return self._leave(state, player)
            if head == "move":
                return self._move(state, rest, source, player)
            if head == "hint":
                return self._hint(state, player)
            if head == "step":
                return self._step(state, source, player)
            if head == "resign":
                return self._resign(state, rest, player)
            if head == "draw":
                return self._draw_offer(state, rest, player)
            if head == "rematch":
                return self._rematch(state, player)
            if head == "abandon":
                return self._abandon(state, player)
            if head == "review":
                return self._review(state, player)
        return self.help()

    def help(self) -> str:
        rules = self.rules
        lines = [rules.TITLE, *rules.HELP, "", "Usage:"]
        lines += [
            f"/games {rules.ID} new",
            f"/games {rules.ID} join",
            f"/games {rules.ID} sit white|black",
            f"/games {rules.ID} leave",
            *([f"/games {rules.ID} draw [offer|accept]"] if getattr(rules, "DRAWS", True) else []),
            f"/games {rules.ID} rematch",
            f"/games {rules.ID} review",
            f"/games {rules.ID} allow-ai black=local",
            f"/games {rules.ID} allow-ai black=agent",
            f"/games {rules.ID} allow-ai black=local level=beginner|intermediate|advanced|expert",
            f"/games {rules.ID} {rules.EXAMPLE}",
            f"/games {rules.ID} state",
            f"/games {rules.ID} resign",
            f"/games {rules.ID} abandon",
        ]
        return "\n".join(lines)

    def _busy(self, state: dict | None, player) -> str | None:
        if not state or state.get("status") != "active":
            return None
        player_id = str(getattr(player, "id", "") or "")
        others = [
            str(state.get(f"{side}_name") or side)
            for side in SIDES
            if str(state.get(f"{side}_id") or "") not in {"", "local", "agent", player_id}
        ]
        if not others:
            return None
        return (
            f"{self.rules.TITLE} is in progress with {' and '.join(others)}. "
            f"A seated player types /games {self.rules.ID} abandon first."
        )

    def _new(self, state: dict | None, rest: list[str], player, agreed: bool = False,
             level: str = "", learning: bool = False) -> str:
        rules = self.rules
        busy = self._busy(state, player)
        if busy:
            return busy
        if state and state.get("status") == "active" and state.get("plies", 0) and not state.get("lesson"):
            return "A match is in progress. Finish or resign before starting a new game."
        seats = pairs(rest)
        # The level is not a seat: `allow-ai black=local level=hard`.
        said = str(seats.pop("level", "") or seats.pop("difficulty", "") or level or "").strip().lower()
        said = LEVEL_ALIASES.get(said, said)  # old easy/normal/hard land on the new four
        offered = game_levels(rules)
        if said and said not in offered:
            # A game with its own level list still answers to the four words by
            # position: gentlest, middle, second-toughest, toughest.
            positions = {LEVELS[0]: 0, LEVELS[1]: 1, LEVELS[2]: -2, LEVELS[3]: -1}
            if said in positions and len(offered) >= 2:
                said = offered[positions[said]]
            else:
                return f"Choose a level: {_level_choices(offered, game_level_labels(rules))}. (You said {said!r}.)"
        # A level is not a seat, so a misspelled seat is still reported even when
        # a level came with it.
        if rest and (not seats.get("white") or not seats.get("black")):
            named = [item for item in rest if item.split("=", 1)[0].lower() not in {"level", "difficulty"}]
            if named:
                return f"Usage: /games {rules.ID} new white=human black=human"
        white = seats.get("white", "human")
        black = seats.get("black", "human")
        if "profile" in {seat_kind(white), seat_kind(black)}:
            return f"The AI here is the built-in player. /games {rules.ID} allow-ai black=local"
        if "agent" in {seat_kind(white), seat_kind(black)}:
            if not agreed:
                return f"Your agent needs your yes first. /games {rules.ID} allow-ai black=agent"
            if seat_kind(white) == seat_kind(black):
                return "Your agent plays one seat. Put a person or the built-in player in the other."
            if self.complete is None:
                return "Your own agent can play only inside Hermes. Here the AI is the built-in player."
        fresh = {
            "schema_version": 2,
            "table_id": (state or {}).get("table_id") or uuid.uuid4().hex,
            "owner_id": str(getattr(player, "id", "") or ""),
            "score": {"white": 0, "black": 0, "draws": 0},
            "moves": [],
            "rematch": {"requested_by": []},
            "draw_offer": "",
            "game": rules.ID,
            "turn": "white",
            "white": white,
            "black": black,
            "status": "active",
            "winner": "",
            "plies": 0,
            "last": "",
            "result_detail": "",
        }
        fresh.update(rules.fresh())
        if learning:
            fresh["learn"] = True
        if seat_kind(white) in AI_KINDS:
            sit(fresh, "white", None, seat_kind(white))
        elif player is not None:
            sit(fresh, "white", player, "human")
        if seat_kind(black) in AI_KINDS:
            sit(fresh, "black", None, seat_kind(black))
        elif player is not None and seat_kind(white) in AI_KINDS:
            sit(fresh, "black", player, "human")
        elif player is not None and not shared_keyboard(player):
            fresh["black"] = ""
            fresh["black_id"] = ""
            fresh["black_name"] = ""
        bot_sides = [side for side in SIDES if seat_kind(fresh.get(side, "")) in AI_KINDS]
        if bot_sides:
            fresh["ai_consent"] = {"by": fresh["owner_id"], "seats": bot_sides}
            # The level belongs to the built-in player. Naming one remembers it
            # for this game; otherwise the last level chosen here applies, and a
            # game that was never set up plays Normal.
            chosen = said or remembered_level(self.root, offered, game_default_level(rules))
            fresh["level"] = chosen
            if said:
                remember_level(self.root, said, offered)
        else:
            fresh.pop("level", None)
        return self._finish(fresh, [])

    def _allow(self, state: dict | None, rest: list[str], source: str, player) -> str:
        rules = self.rules
        if source != "command":
            return "Refused (consent_required)."
        learning = any(item.lower() == "learn" for item in rest)
        rest = [item for item in rest if item.lower() != "learn"]
        seats = pairs(rest)
        said = str(seats.pop("level", "") or seats.pop("difficulty", "") or "").strip().lower()
        # The seats, with the level tokens taken out: `allow-ai local level=hard`
        # is the same shorthand as `allow-ai local`.
        named = [item for item in rest if item.split("=", 1)[0].lower() not in {"level", "difficulty"}]
        if not seats and len(named) == 1:
            seats = {"black": named[0]}
        white = seats.get("white", "human")
        black = seats.get("black", "")
        if not black and seat_kind(white) in AI_KINDS:
            black = "human"
        if not black:
            return f"Usage: /games {rules.ID} allow-ai black=local"
        if "profile" in {seat_kind(white), seat_kind(black)}:
            return f"The AI here is the built-in player. /games {rules.ID} allow-ai black=local"
        if seat_kind(white) not in AI_KINDS and seat_kind(black) not in AI_KINDS:
            return f"Name the AI seat. /games {rules.ID} allow-ai black=local (or black=agent)"
        if learning and sorted([seat_kind(white), seat_kind(black)]) != ["human", "local"]:
            return "Name one built-in player for learn mode."
        return self._new(state, [f"white={white}", f"black={black}"], player, agreed=True,
                         level="easy" if learning else said, learning=learning)

    def _join(self, state: dict, player) -> str:
        if player is not None:
            mine = self._mine(state, player)
            if mine:
                return self.draw(state)
        for side in SIDES:
            if seat_kind(state.get(side, "")) == "human" and not state.get(f"{side}_id"):
                return self._sit(state, [side], player)
        return "Both seats are taken."

    def _mine(self, state: dict, player) -> list[str]:
        identity = str(getattr(player, "id", "") or "")
        return [side for side in SIDES if identity and state.get(f"{side}_id") == identity
                and seat_kind(state.get(side, "")) == "human"]

    def _sit(self, state: dict, rest: list[str], player) -> str:
        if len(rest) != 1 or rest[0] not in SIDES:
            return "Usage: sit white|black"
        side = rest[0]
        if not getattr(player, "id", ""):
            return f"Join from your own chat. /games {self.rules.ID} join"
        if state.get(f"{side}_id") == player.id:
            return self.draw(state)
        if state.get(f"{side}_id") or seat_kind(state.get(side, "")) != "human":
            return "That seat is taken."
        if self._mine(state, player) and not shared_keyboard(player):
            return "You already hold a seat."
        sit(state, side, player, "human")
        state["rematch"] = {"requested_by": []}
        state["draw_offer"] = ""
        write(self.root, state)
        return self.draw(state)

    def _leave(self, state: dict, player) -> str:
        mine = self._mine(state, player)
        if not mine:
            return "Only a seated player can leave."
        if state.get("status") == "active" and state.get("plies", 0):
            self._resign(state, [mine[0]], player)
        for side in mine:
            sit(state, side, None)
        state["rematch"] = {"requested_by": []}
        state["draw_offer"] = ""
        write(self.root, state)
        return self.draw(state)

    def _move(self, state: dict, rest: list[str], source: str, player) -> str:
        rules = self.rules
        if state.get("status") != "active":
            return self.draw(state)
        side = state["turn"]
        kind = seat_kind(str(state.get(side) or ""))
        if kind == "local":
            return f"It's the built-in player's turn. /games {rules.ID} step"
        if kind == "agent":
            return f"It's your agent's turn. /games {rules.ID} step"
        if source != "command":
            return "Refused (human_turn)."
        refused = claim(state, side, player)
        if refused:
            return refused
        move = rules.parse(rest)
        legal = rules.legal(state)
        if move is None or move not in legal:
            return f"Refused: {refusal_reason(rules, state, move)}"
        shown = rules.show(move)
        if state.get("lesson"):
            return self._lesson_move(state, move, shown)
        if state.get("learn"):
            before = copy.deepcopy(state)
            before.pop("learn_before", None)
            state["learn_before"] = before
        if state.get("draw_offer") != side:
            state["draw_offer"] = ""
        note = rules.play(state, move)
        self._count(state, shown)
        if state.get("learn"):
            token = ""
            if state.get("status") == "active" and callable(getattr(rules, "wins_next", None)):
                try:
                    token = rules.wins_next(state, state["turn"])
                except Exception:
                    log.debug("wins_next could not answer for this position", exc_info=True)
            state["coach_tip"] = f"The computer can win next with {rules.show(token)}. Undo and stop it." if token else ""
        return self._finish(state, [f"Played {shown}." + (f" {note}" if note else "")])

    def _step(self, state: dict, source: str = "command", player=None) -> str:
        if source != "command":
            return "Refused (consent_required)."
        if state.get("owner_id") and str(getattr(player, "id", "") or "") != state["owner_id"]:
            return "Only the table owner can advance the built-in players."
        if state.get("status") != "active":
            return self.draw(state)
        if seat_kind(str(state.get(state["turn"]) or "")) not in AI_KINDS:
            return "Refused (human_turn)."
        return self._finish(state, [])

    def _resign(self, state: dict, rest: list[str], player) -> str:
        if state.get("status") != "active":
            return self.draw(state)
        if state.get("owner_id") and not self._mine(state, player) and str(getattr(player, "id", "") or "") != state["owner_id"]:
            return "Only a seated player can resign."
        bound_humans = any(state.get(f"{side}_id") and seat_kind(state.get(side, "")) == "human" for side in SIDES)
        if bound_humans or (player is not None and not shared_keyboard(player)):
            mine = self._mine(state, player)
            if not mine:
                return "Only a seated player can resign."
            side = mine[0] if len(mine) == 1 else state["turn"]
        else:
            side = rest[0].lower() if rest else state["turn"]
            if side not in SIDES:
                return f"Usage: /games {self.rules.ID} resign white"
        state["status"] = "resigned"
        state["winner"] = "black" if side == "white" else "white"
        state["result_reason"] = "resignation"
        state["result_detail"] = "resignation"
        self._score(state)
        write(self.root, state)
        return self.draw(state)

    def _score(self, state: dict) -> None:
        if state.get("status") not in {"win", "draw", "resigned"} or state.get("result_recorded"):
            return
        # A won game is worth bonus points to the person who won it. Draws are not a win.
        # The sink is set once by the plugin, so kit stays free of any one wallet.
        if state.get("winner") and BONUS_SINK is not None:
            try:
                BONUS_SINK(dict(state))
            except Exception:
                log.debug("the win-bonus sink raised", exc_info=True)
        score = state.setdefault("score", {"white": 0, "black": 0, "draws": 0})
        key = state.get("winner") or "draws"
        score[key] += 1
        state["result_recorded"] = True
        state["result_reason"] = state.get("result_reason") or "rules"
        state["draw_offer"] = ""

    def _draw_offer(self, state: dict, rest: list[str], player) -> str:
        # A game whose rules cannot end level has nothing to offer: Hex always joins
        # one pair of sides, Breakthrough always gets a pawn home, and Go's komi is a
        # half point, so no score ties. The button is gone from those screens too; this
        # is the backstop for a typed line. Starts with "Only " on purpose: the online
        # layer tells a refusal from a result by its opening words.
        if getattr(self.rules, "DRAWS", True) is False:
            title = getattr(self.rules, "TITLE", self.rules.ID)
            return f"Only games that can be drawn can agree one: {title} has no draw, it always has a winner."
        if state.get("status") != "active":
            return self.draw(state)
        mine = self._mine(state, player)
        if not mine:
            return "Only a seated player can offer or accept a draw."
        side = state["turn"] if state["turn"] in mine else mine[0]
        other = "black" if side == "white" else "white"
        if rest == ["accept"]:
            if state.get("draw_offer") != other:
                return "No opponent draw offer to accept."
            state.update(status="draw", winner="", result_reason="agreement", result_detail="agreement")
            self._score(state)
        elif rest in ([], ["offer"]):
            if not state.get(f"{other}_id") or seat_kind(state.get(other, "")) != "human":
                return "A human opponent must be seated to agree a draw."
            if state.get("draw_offer") not in {"", None, side}:
                return "The opponent offered a draw. Use draw accept."
            state["draw_offer"] = side
        else:
            return "Usage: draw [offer|accept]"
        write(self.root, state)
        return self.draw(state)

    def _abandon(self, state: dict, player) -> str:
        if state.get("owner_id") and not self._mine(state, player) and str(getattr(player, "id", "") or "") != state["owner_id"]:
            return "Only a seated player can abandon this game."
        if any(state.get(f"{side}_id") and seat_kind(state.get(side, "")) == "human" for side in SIDES):
            player_id = str(getattr(player, "id", "") or "")
            bound = [str(state.get(f"{side}_id") or "") for side in SIDES]
            people = [item for item in bound if item and item not in {"local", "agent"}]
            if people and player_id not in people:
                return "Only a seated player can abandon this game."
        state["status"] = "abandoned"
        write(self.root, state)
        return "Game abandoned."

    def _rematch(self, state: dict, player) -> str:
        if state.get("review_of") and state.get("lesson"):
            return self._rematch_review(state, player)
        if state.get("status") not in {"win", "draw", "resigned"}:
            return "Finish the current game before requesting a rematch."
        mine = self._mine(state, player)
        has_bot = any(seat_kind(state.get(side, "")) in AI_KINDS for side in SIDES)
        identity = str(getattr(player, "id", "") or "")
        owner = bool(identity and identity == state.get("owner_id"))
        # A shared-keyboard table is one person at both seats: their identity is
        # the table's, not the seats', so consent runs through the owner.
        both = shared_keyboard(player) and all(state.get(f"{side}_id") for side in SIDES) \
            and len({state[f"{side}_id"] for side in SIDES}) == 1
        if not mine and not both and not (has_bot and owner):
            return "Only seated players can request a rematch."
        if any(not state.get(f"{side}_id") for side in SIDES):
            return "Both seats must be occupied for a rematch."
        requested = state.setdefault("rematch", {"requested_by": []})["requested_by"]
        if identity not in requested:
            requested.append(identity)
        required = {state[f"{side}_id"] for side in SIDES if seat_kind(state.get(side, "")) == "human"}
        if both:
            # Both human seats are the same person: no second consent exists.
            required = {state["white_id"]} if state["white_id"] == state["black_id"] else required
            required.add(state.get("owner_id") or identity)
        if has_bot:
            if not state.get("owner_id"):
                return "A named table owner must give fresh AI consent."
            required.add(state["owner_id"])
        if not required.issubset(set(requested)):
            write(self.root, state)
            return "Rematch requested; waiting for the other player."
        fresh = {**state, **self.rules.fresh(), "turn": "white", "status": "active",
                 "winner": "", "plies": 0, "last": "", "moves": [],
                 "rematch": {"requested_by": []}, "draw_offer": "", "result_recorded": False,
                 "result_reason": "", "result_detail": ""}
        # A lesson (or a review lesson) never follows the board into a new game:
        # no step text, no metadata, no "this move is a lesson move" judgement.
        fresh.pop("lesson", None)
        if has_bot:
            fresh["ai_consent"] = {"by": state["owner_id"],
                                   "seats": [side for side in SIDES if seat_kind(state.get(side, "")) in AI_KINDS]}
        return self._finish(fresh, [])

    def _rematch_review(self, state: dict, player) -> str:
        """Rematch after Review My Game: the same opponent and the same series.

        The review sits on its own one-step board, so a plain rematch would
        hand back a game against the built-in player with the score reset.
        ``review_of`` keeps what the finished game really was.
        """
        review = state.get("review_of") or {}
        identity = str(getattr(player, "id", "") or "")
        owner = str(state.get("owner_id") or "")
        if owner and identity != owner:
            return "Only the player who reviewed this game can start the rematch."
        fresh = {**state, **self.rules.fresh(), "turn": "white", "status": "active",
                 "winner": "", "plies": 0, "last": "", "moves": [],
                 "rematch": {"requested_by": []}, "draw_offer": "",
                 "result_recorded": False, "result_reason": "", "result_detail": "",
                 "score": dict(review.get("score") or state.get("score")
                               or {"white": 0, "black": 0, "draws": 0})}
        for side in SIDES:
            fresh[side] = str(review.get(side) or "human")
            fresh[f"{side}_id"] = str(review.get(f"{side}_id") or "")
            fresh[f"{side}_name"] = str(review.get(f"{side}_name") or "")
        fresh.pop("lesson", None)
        fresh.pop("review_of", None)
        if isinstance(review.get("ai_consent"), dict):
            fresh["ai_consent"] = dict(review["ai_consent"])
        return self._finish(fresh, [])

    def _count(self, state: dict, shown: str) -> None:
        state["plies"] = int(state.get("plies") or 0) + 1
        state["last"] = shown
        state["moves"] = [*state.get("moves", []), shown][-self.rules.MAX_PLIES:]
        if state.get("status") == "active" and state["plies"] >= self.rules.MAX_PLIES:
            state["status"] = "draw"
            state["winner"] = ""
            state["result_detail"] = "move_limit"

    def _both_local(self, state: dict) -> bool:
        return all(seat_kind(str(state.get(side) or "")) in AI_KINDS for side in SIDES)

    def _finish(self, state: dict, notes: list[str]) -> str:
        rules = self.rules
        guard = 0
        # Human vs bot: the local seat answers at once. Bots vs bots: one ply
        # so a person can watch (Desktop sends step). Dumping 42 moves is not a game.
        burst = 1 if self._both_local(state) else rules.MAX_PLIES + 1
        while (
            state.get("status") == "active"
            and seat_kind(str(state.get(state["turn"]) or "")) in AI_KINDS
            and guard < burst
        ):
            agent = seat_kind(str(state.get(state["turn"]) or "")) == "agent"
            move, fallback = self._agent_move(state) if agent else (rules.bot(state), "")
            shown = rules.show(move)
            note = rules.play(state, move)
            self._count(state, shown)
            if state.get("learn") and not agent:
                explanation = ""
                if callable(getattr(rules, "explain", None)):
                    try:
                        explanation = str(rules.explain(move, state) or "")
                    except Exception:
                        log.debug("explain could not describe this move", exc_info=True)
                state["coach_note"] = explanation or f"The computer plays {shown}."
            who = "Agent" if agent else "Local"
            notes.append(f"{who} played {shown}." + (f" {note}" if note else "") + fallback)
            guard += 1
        self._score(state)
        write(self.root, state)
        if len(notes) > 6:
            notes = [*notes[:1], f"… {len(notes) - 4} more moves …", *notes[-3:]]
        drawn = self.draw(state)
        return "\n".join([*notes, drawn]) if notes else drawn

    def single_player(self, state: dict) -> bool:
        """One person against the built-in player, mid-game. The only place hints are allowed."""
        kinds = sorted(seat_kind(str(state.get(side) or "")) for side in SIDES)
        return (kinds == ["human", "local"] and state.get("status") == "active" and not state.get("lesson")
                and seat_kind(str(state.get(state.get("turn", "")) or "")) == "human")

    def _hint(self, state: dict, player) -> str:
        rules = self.rules
        if not self.single_player(state):
            return "Hints are only for games against the computer, on your turn."
        lesson = state.get("lesson")
        if lesson and isinstance(lesson, dict):
            return self._lesson_hint(state, lesson, player)
        side = state["turn"]
        bound = str(state.get(f"{side}_id") or "")
        if bound and bound != str(getattr(player, "id", "") or ""):
            return "Only the player whose turn it is can ask for a hint."
        # A hint is advice, so it comes from the shipped player (Intermediate),
        # never from Beginner's deliberate guesses. Intermediate is also the fast
        # search: a hint must answer at once, not sit on a deeper clock.
        probe = copy.deepcopy(state)
        probe["level"] = DEFAULT_LEVEL
        move = rules.bot(probe)
        shown = rules.show(move)
        reason = self._explain(state, shown)
        return f"Hint: try {shown}." + (f" {reason}" if reason else "")

    def _lesson_hint(self, state: dict, lesson: dict, player) -> str:
        """A hint inside a lesson teaches the lesson's move, at the lesson's position.

        The review lesson's Why link lands here, too: it asks about the better
        move at the reviewed position, whatever the table's turn now is.
        """
        rules = self.rules
        if str(getattr(player, "id", "") or "") != str(state.get("owner_id") or ""):
            return "Only the person taking this lesson can ask for a hint."
        step = lesson.get("custom") if isinstance(lesson.get("custom"), dict) else None
        if step is None:
            steps = lesson_steps(rules)
            number = int(lesson.get("step") or 1)
            step = steps[number - 1] if 0 < number <= len(steps) else None
        # The position the question is about: the replayed setup when there is
        # one (a review), else the table as it stands.
        probe = None
        shelf = _shelf("review")
        for token in (step or {}).get("setup") or []:
            move = rules.parse(str(token).split())
            if move is None:
                probe = None
                break
            probe = probe or shelf.start(rules)
            rules.play(probe, move)
        if probe is None:
            probe = copy.deepcopy(state)
            probe.pop("lesson", None)
            probe["status"] = "active"
        shown = ""
        for token in (step or {}).get("goal") or []:
            candidate = rules.parse(str(token).split())
            if candidate is not None and candidate in rules.legal(probe):
                shown = rules.show(candidate)
                break
        if not shown:
            probe["level"] = DEFAULT_LEVEL
            move = rules.bot(probe) if self.single_player(probe) or not probe.get("white_id") else None
            shown = rules.show(move) if move else ""
        if not shown:
            return "No hint for this position."
        reason = self._explain(probe, shown) or str((step or {}).get("tip") or "")
        return f"Hint: try {shown}." + (f" {reason}" if reason else "")

    def _explain(self, state: dict, shown: str) -> str:
        """One short reason from the person's own model, or "" (no model, or a bad answer)."""
        if self.complete is None:
            return ""
        rules = self.rules
        side = state["turn"]
        prompt = "\n".join([
            f"You are a friendly {rules.TITLE} teacher for a beginner playing {side}.",
            *rules.HELP,
            "",
            "Board:",
            *rules.draw(state),
            "",
            f"The suggested move is {shown}. In one short sentence (under 25 words), say why it is a good idea.",
            "Talk only about this move and this board. Do not suggest other moves.",
        ])
        try:
            answer = _bounded(self.complete, prompt)
        except Exception:  # a slow, broken or empty model must cost the hint nothing
            return ""
        text = " ".join(str(answer.get("move") if isinstance(answer, dict) else answer or "").split())
        return text[:200] if text else ""

    def _lesson(self, state: dict | None, rest: list[str], player) -> str:
        rules = self.rules
        steps = lesson_steps(rules)
        if not steps:
            return f"No lesson for {rules.TITLE} yet."
        if rest and rest[0].lower() == "undo":
            return self._undo(state, player, lesson=True)
        current = int((state or {}).get("lesson", {}).get("step") or 0) if state else 0
        word = rest[0].lower() if rest else ""
        number = current + 1 if word == "next" else int(word) if word.isdigit() else 1
        if number > len(steps):
            return f"That was the last step. Play the computer: /games {rules.ID} allow-ai black=local"
        if not 1 <= number <= len(steps):
            return f"Lesson steps are 1 to {len(steps)}."
        if (state or {}).get("lesson"):
            if str(getattr(player, "id", "") or "") != str(state.get("owner_id") or ""):
                return "Only the person taking this lesson can change it."
        else:
            busy = self._busy(state, player)
            if busy:
                return busy
            if state and state.get("status") == "active" and state.get("plies", 0) and not self.single_player(state):
                return "A match is in progress. Finish or resign before starting a lesson."
        step = steps[number - 1]
        position = lesson_position(rules, step)
        learner = position["turn"]
        other = "black" if learner == "white" else "white"
        fresh = {
            "schema_version": 2,
            "table_id": (state or {}).get("table_id") or uuid.uuid4().hex,
            "owner_id": str(getattr(player, "id", "") or ""),
            "score": {"white": 0, "black": 0, "draws": 0},
            "rematch": {"requested_by": []},
            "draw_offer": "",
            "game": rules.ID,
            **position,
            "lesson": {"step": number, "of": len(steps), "say": str(step.get("say") or ""), "note": ""},
        }
        sit(fresh, learner, player, "human")
        sit(fresh, other, None, "local")
        fresh["ai_consent"] = {"by": fresh["owner_id"], "seats": [other]}
        write(self.root, fresh)
        return "\n".join([f"Lesson {number} of {len(steps)}: {fresh['lesson']['say']}", self.draw(fresh)])

    def _lesson_move(self, state: dict, move, shown: str) -> str:
        rules = self.rules
        lesson = state["lesson"]
        steps = lesson_steps(rules)
        number = int(lesson.get("step") or 1)
        # A review lesson carries its own single step; normal lessons read lesson.json.
        step = lesson.get("custom") if isinstance(lesson.get("custom"), dict) else None
        if step is None:
            step = steps[number - 1] if 0 < number <= len(steps) else {}
        if not lesson_passes(rules, step, state, move):
            lesson["note"] = str(step.get("tip") or "Not quite. Try again.")
            write(self.root, state)
            return f"{shown} is legal, but not this lesson's move. {lesson['note']}"
        before = copy.deepcopy(state)
        before["lesson"].pop("before", None)
        lesson["before"] = before
        note = rules.play(state, move)
        self._count(state, shown)
        state["status"] = LESSON_DONE
        state["winner"] = ""
        last = number >= int(lesson.get("of") or len(steps) or 1)
        lesson["note"] = str(step.get("praise") or "Well done!") + (
            " That was the last step. Now play the computer." if last else " Next step when you're ready.")
        write(self.root, state)
        return "\n".join([f"Played {shown}." + (f" {note}" if note else ""), lesson["note"], self.draw(state)])

    def _undo(self, state: dict | None, player, *, lesson: bool) -> str:
        if state and str(getattr(player, "id", "") or "") != str(state.get("owner_id") or ""):
            return "Only the table owner can undo."
        snapshot = ((state or {}).get("lesson") or {}).get("before") if lesson else (state or {}).get("learn_before")
        if not snapshot or (not lesson and not (state or {}).get("learn")):
            return "Nothing to undo yet."
        if lesson:
            snapshot["lesson"]["note"] = ""
        write(self.root, snapshot)
        return self.draw(snapshot)

    def _review(self, state: dict, player) -> str:
        """Review My Game: the last clear one-move mistake, replayed as a one-step lesson.

        Only a finished game (won or drawn), only against the computer or the
        player's own agent, only by the person who played. The review itself
        never touches the score.
        """
        rules = self.rules
        if state.get("status") not in {"win", "draw"}:
            return "The game has to be finished first: win or draw, then ask for the review."
        humans = [side for side in SIDES if seat_kind(str(state.get(side) or "")) == "human"]
        if len(humans) != 1:
            return "Review is for a game against the computer or your own agent, not player against player."
        side = humans[0]
        me = str(getattr(player, "id", "") or "")
        played_id = str(state.get(f"{side}_id") or "")
        owner_id = str(state.get("owner_id") or "")
        bound = played_id or owner_id
        if me != bound:
            return "Only the player who played this game can review it."
        review = _shelf("review")
        hook = getattr(rules, "coach_mistake", None)
        found = hook(state.get("moves") or [], side) if callable(hook) else review.find_mistake(rules, state.get("moves") or [], side)
        if not found:
            return f"I couldn't find a clear one-move mistake. Want a lesson instead? /games {rules.ID} lesson"
        step = {key: found[key] for key in ("say", "setup", "goal", "wins", "tip", "praise") if key in found}
        if "coach" in found:
            step["coach"] = found["coach"]
        lessons = _shelf("lessons")
        broken = [item for item in lessons.problems(rules, [step]) if "steps; use 3 to 7" not in item]
        if broken:
            return f"Review unavailable for this game ({broken[0]})."
        position = lesson_position(rules, step)
        fresh = {
            "schema_version": 2,
            "table_id": state.get("table_id") or uuid.uuid4().hex,
            "owner_id": played_id or me or owner_id,
            # The finished result stays on the scoreboard; the review never scores.
            "score": dict(state.get("score") or {"white": 0, "black": 0, "draws": 0}),
            "result_recorded": state.get("result_recorded", False),
            "result_reason": state.get("result_reason", ""),
            "rematch": {"requested_by": []},
            "draw_offer": "",
            "game": rules.ID,
            **position,
            "level": level(state),
            "lesson": {"step": 1, "of": 1, "say": str(found["say"]), "note": "", "custom": step},
        }
        other = "black" if side == "white" else "white"
        # A rematch after the review must put this same game back on the table:
        # the same seats (including your agent), the same series score, and the
        # same level for the built-in player.
        fresh["review_of"] = {
            **{key: state.get(key) for key in SIDES},
            **{f"{key}_id": state.get(f"{key}_id", "") for key in SIDES},
            **{f"{key}_name": state.get(f"{key}_name", "") for key in SIDES},
            "level": level(state),
            "score": dict(state.get("score") or {"white": 0, "black": 0, "draws": 0}),
            "ai_consent": dict(state["ai_consent"]) if isinstance(state.get("ai_consent"), dict) else {},
        }
        if player is not None:
            sit(fresh, side, player, "human")
        else:  # no identity here: keep the seat as the person who played it
            fresh[side] = "human"
            fresh[f"{side}_id"] = played_id
            fresh[f"{side}_name"] = str(state.get(f"{side}_name") or "")
        sit(fresh, other, None, "local")
        fresh["ai_consent"] = {"by": fresh["owner_id"], "seats": [other]}
        write(self.root, fresh)
        return "\n".join([f"Review, move {found.get('ply', found.get('coach', {}).get('ply'))}: {found['say']}", self.draw(fresh)])

    def _agent_move(self, state: dict) -> tuple[Any, str]:
        """The person's own model picks from the legal moves. Two tries, then the built-in move."""
        rules = self.rules
        legal = list(rules.legal(state))
        by_name = {str(rules.show(move)).lower(): move for move in legal}
        side = state["turn"]
        mark = rules.MARKS[0] if side == "white" else rules.MARKS[1]
        # Board and rules only: player names never reach the model.
        prompt = "\n".join([
            f"You are playing {rules.TITLE} as {side} ({mark}).",
            *rules.HELP,
            "",
            "Board:",
            *rules.draw(state),
            "",
            "Moves so far: " + (" ".join(state.get("moves", [])[-20:]) or "none"),
            "Legal moves: " + ", ".join(by_name),
            "Reply with exactly one legal move from that list and nothing else.",
        ])
        why = "has no model set up"
        refused: list[dict] = []
        if self.complete is not None:
            why = "gave no legal move"
            for _ in range(AGENT_TRIES):
                try:
                    answer = _bounded(self.complete, prompt)
                except ModelBusy:
                    why = "is busy with other requests"
                    break
                except TimeoutError:
                    why = "took too long to answer"
                    break
                except Exception:
                    why = "could not reach your model"
                    break
                text = str(answer.get("move") if isinstance(answer, dict) else answer or "")
                move = _pick(text, by_name, rules, legal)
                if move is not None:
                    return move, ""
                why = "sent an empty reply" if not text.strip() else "gave no legal move"
                refused.append(_refused(rules, state, text))
                prompt += f"\n\n{text.strip()[:40]!r} is not a legal move. Pick one from the list exactly."
        # The built-in player covering for a model answers at Intermediate: the
        # level is the person's choice for the computer's own seat, not a
        # sloppier stand-in.
        stand_in = copy.deepcopy(state)
        stand_in["level"] = DEFAULT_LEVEL
        move = rules.bot(stand_in)
        if not refused:
            return move, f" (Your agent {why}; the built-in player chose.)"
        # The referee's refusals are part of the story, not something to hide: name each
        # proposal and its reason, and keep a record the table can show as a badge.
        refusal_record = {
            "ply": len(state.get("moves") or []),
            "side": side,
            "proposals": refused,
            "played": str(rules.show(move)),
        }
        # The sentence comes last, so it is built from the finished record.
        refusal_record["message"] = refusal_message(refusal_record)
        state.setdefault("refusals", []).append(refusal_record)
        said = "; ".join(f"{item['proposed']} ({item['reason'][:1].lower()}{item['reason'][1:].rstrip('.')})" for item in refused)
        return move, f" (Your agent {why}; the built-in player chose. The referee refused {said}.)"

    def draw(self, state: dict) -> str:
        rules = self.rules
        white_mark, black_mark = rules.MARKS
        words = side_words(rules)
        # A mark that repeats the side's own word ("bottom (bottom)") says it twice.
        white_label = words["white"] if white_mark.lower() == words["white"].lower() else f"{words['white']} ({white_mark})"
        black_label = words["black"] if black_mark.lower() == words["black"].lower() else f"{words['black']} ({black_mark})"
        lines = list(rules.draw(state))
        lines.append(
            f"{white_label}: {seat_line(state, 'white')}    "
            f"{black_label}: {seat_line(state, 'black')}"
        )
        status = state.get("status")
        if status == "active":
            who = words["white"] if state["turn"] == "white" else words["black"]
            lines.append(f"{who} to move.")
        elif state.get("winner"):
            winner = state["winner"]
            name = seat_line(state, winner)
            lines.append(f"Game over ({status}): {words.get(winner, str(winner)).lower()}."
                         + (f" {name} wins." if name not in {winner, 'waiting'} else ""))
        elif status == LESSON_DONE:
            lines.append("Lesson step done.")
        else:
            lines.append(f"Game {status}.")
        return "\n".join(lines)

    def picture(self, player=None) -> dict | None:
        """Structured board for the Desktop. Does not write state.

        ``player`` is handed to a game that hides information per seat (Sea
        Battle's two fleets); a game with no such parameter is called as before.
        """
        fn: Any = getattr(self.rules, "picture", None)
        if not callable(fn):
            return None
        state = load(self.root)
        preview = state is None or state.get("status") == "abandoned"
        if preview:
            state = {
                "game": self.rules.ID,
                "turn": "white",
                "white": "human",
                "black": "human",
                "status": "idle",
                "winner": "",
                "plies": 0,
                "last": "",
            }
            state.update(self.rules.fresh())
        assert state is not None
        params = inspect.signature(fn).parameters
        pictured: dict = dict(fn(state, **({"player": player} if "player" in params else {})))
        offered = game_levels(self.rules)
        pictured.update({
            "schema_version": 2,
            "table_id": state.get("table_id", ""),
            "owner_id": state.get("owner_id", ""),
            "plies": int(state.get("plies") or 0),
            "moves": list(state.get("moves", [])),
            # The moves the referee refused, so the table can badge the ply where
            # the built-in player had to move for a model.
            "refusals": [dict(record) for record in state.get("refusals") or []],
            "score": dict(state.get("score", {"white": 0, "black": 0, "draws": 0})),
            "rematch": state.get("rematch", {"requested_by": []}),
            "draw_offer": state.get("draw_offer", ""),
            "seats": [
                {"side": side, "kind": seat_kind(state.get(side, "")),
                 "id": str(state.get(f"{side}_id") or ""),
                 "name": str(state.get(f"{side}_name") or ""),
                 "open": seat_kind(state.get(side, "")) == "human" and not state.get(f"{side}_id")}
                for side in SIDES
            ],
            "game": self.rules.ID,
            "title": getattr(self.rules, "TITLE", self.rules.ID),
            # The table shows which level the built-in player is at, and the
            # chooser marks the level this game remembers.
            "level": (level(state, offered, game_default_level(self.rules))
                      if any(seat_kind(state.get(side, "")) in AI_KINDS for side in SIDES) else ""),
            "remembered_level": remembered_level(self.root, offered, game_default_level(self.rules)),
            "levels": [{"id": name, "label": game_level_labels(self.rules).get(name, name.title()),
                        "line": f"allow-ai {self.rules.ID} black=local level={name}"}
                       for name in offered],
            "level_note": _level_note(self.rules, state),
            "preview": preview,
            "turn": str(state.get("turn") or "white"),
            "status": str(state.get("status") or "idle"),
            "winner": str(state.get("winner") or ""),
            "result_reason": str(state.get("result_reason") or ""),
            # The game's own words for how it ended ("checkmate", "repetition"), so the
            # result overlay can say the deciding thing instead of a bare "Game over".
            "result_detail": str(state.get("result_detail") or ""),
            # False for a game that cannot end level (Hex, Breakthrough, Go with komi).
            "draws_allowed": bool(getattr(self.rules, "DRAWS", True)),
            "last": str(state.get("last") or ""),
            "white": "White" if preview else seat_line(state, "white"),
            "black": "Black" if preview else seat_line(state, "black"),
            # The plain words for the two sides, so the table can say "Red pieces" in
            # a red-versus-yellow drop game instead of borrowing chess's vocabulary.
            "side_words": side_words(self.rules),
            "seat_words": seat_words(self.rules),
        })
        pictured["lesson"] = None
        if state.get("lesson"):
            lesson = state["lesson"]
            steps = lesson_steps(self.rules)
            number = int(lesson.get("step") or 1)
            step = lesson.get("custom") if isinstance(lesson.get("custom"), dict) else (steps[number - 1] if 0 < number <= len(steps) else {})
            pictured["lesson"] = {key: value for key, value in lesson.items() if key != "before"}
            pictured["lesson"]["goal"] = [str(item).lower() for item in step.get("goal") or []]
            pictured["lesson"]["undo"] = bool(lesson.get("before"))
        pictured["learn"] = bool(state.get("learn"))
        pictured["coach_note"] = str(state.get("coach_note") or "")
        pictured["coach_tip"] = str(state.get("coach_tip") or "")
        pictured["has_lesson"] = bool(lesson_steps(self.rules))
        pictured["hint_ok"] = not preview and self.single_player(state)
        # A game that always has a winner (Hex) has no draw to offer, so the
        # table draws no button for one.
        pictured["draws"] = getattr(self.rules, "DRAWS", True) is not False
        if preview or pictured.get("status") != "active":
            pictured["legal"] = []
        return pictured
