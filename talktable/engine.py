"""Talking tables: one adapter that turns a vendored TextArena environment into
a Game Center game.

The environment owns the rules. This object owns the table: who sits where,
what each seat is allowed to see, which seat the human is, how a model is asked
for a line, and what the screen is shown.

Everything it saves is the seed plus the list of actions, so a game can be
replayed exactly and shared as one small file.
"""

from __future__ import annotations

import importlib.util
import inspect
import json
import logging
import random
import sys
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from . import common
from .games import auction, liarsdice, liarsdice_teams, mafia, prisoners

log = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
_KIT_NAME = "hermes_gameshelf_kit"
if _KIT_NAME not in sys.modules:
    _spec = importlib.util.spec_from_file_location(_KIT_NAME, _ROOT / "kit.py")
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[_KIT_NAME] = _module
    _spec.loader.exec_module(_module)
kit = sys.modules[_KIT_NAME]

GAMES = {
    mafia.ID: mafia,
    liarsdice.ID: liarsdice,
    liarsdice_teams.ID: liarsdice_teams,
    prisoners.ID: prisoners,
    auction.ID: auction,
}
GAME_IDS = tuple(GAMES)
SCHEMA = 1

_ACTIONS_TAKES_META: dict[int, bool] = {}


def call_actions(game, env, seat, draft=None, meta=None):
    """Call a game's ``actions()`` with ``meta`` only when that game declares it.

    The game surface is not uniform: ``mafia.actions`` accepts ``meta=`` and the other
    games do not. The engine used to pass it unconditionally, which raised
    ``TypeError: actions() got an unexpected keyword argument 'meta'`` on every machine
    move in a non-mafia game.
    """
    actions = game.actions
    takes = _ACTIONS_TAKES_META.get(id(actions))
    if takes is None:
        takes = _ACTIONS_TAKES_META[id(actions)] = 'meta' in inspect.signature(actions).parameters
    return actions(env, seat, draft, meta=meta) if takes else actions(env, seat, draft)

# Same guarded route as an agent's move on a board table: 20 seconds per try,
# two tries, then the built-in player covers and the table says so.
MODEL_SECONDS = 20.0
MODEL_TRIES = 2
MAX_SAY = common.MAX_SAY
MAX_LOG = 200
MAX_SEATS = 10
# Watch it think: how many pieces of one seat's working are kept, and how long a
# person has to whisper to their own bot when a new round starts.
THINK_KEEP = 6
COACH_SECONDS = 15
COACH_CHARS = 120
# A hard ceiling on model calls for one table, whatever the estimate says.
CALL_CEILING = 400
# The vendored environments seed Python's process-wide random generator while they
# deal roles, roll dice and pick lots. Two replays building at once in the same
# process (two screens, or a screen and a step) would deal each other's games, so
# building a table is serialised here. Reentrant, because a picture builds more
# than one environment.
_REPLAY = threading.RLock()


def _now() -> int:
    return int(time.time())


def _clean(text: Any, limit: int) -> str:
    return common.clean(text, limit)


class Table:
    """One talking table, saved in ``root``/state.json."""

    def __init__(self, root: Path, game_id: str, settings: dict | None = None) -> None:
        if game_id not in GAMES:
            raise KeyError(game_id)
        self.root = Path(root)
        self.game = GAMES[game_id]
        self.id = game_id
        self.settings = dict(settings or {})
        self.complete = None
        data_root = self.settings.get("data_root")
        self.data_root = Path(data_root) if data_root else self.root.parent

    # ------------------------------------------------------------------ state

    def _load(self) -> dict | None:
        return kit.load(self.root)

    def _save(self, state: dict) -> None:
        kit.write(self.root, state)

    def _cap(self, state: dict) -> int:
        return int(state.get("calls", {}).get("cap") or 0)

    # ------------------------------------------------------------------ build

    def _seat_rows(self, state: dict, player) -> list[dict]:
        """Seat 1 is the person; champions next, then their agent, then computers.

        A game may say which seats those turn into, in order (``FILL_ORDER``: the
        second seat handed out may be the partner's, not the next number), so a
        team game can put the person and their guest on the same side.
        """
        count = int(state["seat_count"])
        identity = str(getattr(player, "id", "") or "")
        name = _clean(getattr(player, "name", "") or "You", 32) or "You"
        slots: list[int] = []
        try:
            slots = [int(value) for value in (getattr(self.game, "FILL_ORDER", ()) or ())]
        except (TypeError, ValueError):
            slots = []
        slots = [value for value in slots if 0 <= value < count]
        if sorted(slots) != list(range(count)):
            slots = list(range(count))
        rows: list[dict] = []

        def place(kind: str, ident: str, label: str, avatar: str, colour: str,
                  brief: str = "", champion: str = "") -> None:
            seat = slots[len(rows)]
            rows.append({
                "seat": seat, "kind": kind, "id": ident, "name": label,
                "avatar": avatar, "colour": colour, "brief": brief, "champion": champion,
            })

        if state.get("all_bots"):
            # A table with nobody in a person's seat: the whole field is machines,
            # and the watcher is shown only what every seat heard.
            place("local", "bot-normal", common.seat_name(slots[0]),
                  common.avatar_for(slots[0]), common.colour_for(slots[0]))
        else:
            place("human", identity, name, common.avatar_for(slots[0]), common.colour_for(slots[0]))
        for champion in state.get("champion_rows") or []:
            if len(rows) >= count:
                break
            seat = slots[len(rows)]
            place("champion", str(champion.get("id") or ""),
                  _clean(champion.get("name"), 32) or "Champion",
                  str(champion.get("glyph") or common.avatar_for(seat)),
                  str(champion.get("colour") or common.colour_for(seat)),
                  _clean(champion.get("brief"), 600), str(champion.get("id") or ""))
        if state.get("agent") and len(rows) < count:
            seat = slots[len(rows)]
            place("agent", "agent", "Your agent",
                  common.avatar_for(seat), common.colour_for(seat))
        while len(rows) < count:
            seat = slots[len(rows)]
            place("local", "bot-normal", common.seat_name(seat),
                  common.avatar_for(seat), common.colour_for(seat))
        return rows[:count]

    # ------------------------------------------------------------------ env

    def _env(self, state: dict, upto: int | None = None, strict: bool = False):
        """Build a table under the replay lock (see ``_REPLAY``)."""
        with _REPLAY:
            return self._env_locked(state, upto=upto, strict=strict)

    def _env_locked(self, state: dict, upto: int | None = None, strict: bool = False):
        """Rebuild the environment by replaying the saved actions.

        Returns ``(env, index, trace)`` for the session at ``upto`` (default: the
        current one). ``trace`` is every observation the environment handed out,
        tagged with the seat it went to, which is how the screen decides what a
        viewer may read. With ``strict`` a replay that the rules refuse (an action
        taken out of turn, or one the environment silently dropped) raises instead
        of quietly producing a different game; a shared file is checked that way.
        """
        sessions = state["sessions"]
        index = int(state.get("current") or 0) if upto is None else upto
        index = max(0, min(index, len(sessions) - 1))
        session = sessions[index]
        env = self.game.build(len(session["seats"]))
        # The rules deal before any watcher can exist: the state object itself is made
        # inside reset. So the deal happens first and what it told each seat is copied
        # into the trace below; without that, a first-round prompt would carry no dice.
        self.game.reset(env, session["seats"], int(session["seed"]))
        # A game that offers levels keeps the chosen one on the environment, so its
        # built-in player plays at that strength on every rebuild of the table.
        levels = list(getattr(self.game, "LEVELS", ()) or ())
        if levels:
            chosen = str(state.get("level") or getattr(self.game, "DEFAULT_LEVEL", levels[0]))
            setattr(env, "level", chosen if chosen in levels else levels[0])
        trace: list[dict] = []
        state_object = env.state
        original = state_object.add_observation

        def told_of(text, kind) -> str:
            """The rules' own words, in the table's naming. A player's typed line is theirs."""
            spoken = getattr(kind, "name", "") == "PLAYER_ACTION"
            told = str(text)
            # A game may count its players differently from the way this table names
            # them (Mafia's rules count from zero). Its own words are translated once,
            # here, so the log, every prompt and the reveal agree.
            translate = getattr(self.game, "words", None)
            if not spoken and callable(translate):
                try:
                    told = str(translate(told))
                except Exception:
                    told = str(text)
            # A player action is a machine token ("[Bid: 2, 5]") wearing the seat's
            # name. A game that can say it in plain words does, so the log reads like
            # the buttons that made the move.
            if spoken:
                plain = getattr(self.game, "label", None)
                if callable(plain):
                    try:
                        told = plain(told)
                    except Exception:
                        told = str(text)
                # A move token can carry a seat number instead of a name ("[3]").
                # A game that knows how to say it in the table's naming does so
                # here, before the trace is kept, so the log and any shared file
                # agree on the same plain words.
                named = getattr(self.game, "narrate_action", None)
                if callable(named):
                    try:
                        told = str(named(
                            told,
                            lambda env_p: self._name_of(state, index, env_p),
                            self.game.phase(env).get("label", "")))
                    except Exception:
                        told = str(told)
            return told

        def record(to_id, sender, text, kind) -> None:
            trace.append({
                "to": None if to_id == -1 else int(to_id),
                "from": int(sender) if isinstance(sender, int) else -1,
                "text": told_of(text, kind),
                "kind": getattr(kind, "name", "") or "",
            })

        def watched(*args, **kwargs):
            result = original(*args, **kwargs)
            try:
                _from, text = state_object.logs[-1]
            except (AttributeError, IndexError, TypeError):
                return result
            to_id = kwargs.get("to_id", -1)
            if to_id == -1 and len(args) >= 4:
                to_id = args[3]
            kind = kwargs.get("observation_type")
            if kind is None and len(args) >= 2:
                kind = args[1]
            record(to_id, _from, text, kind)
            return result

        state_object.add_observation = watched
        # What the deal told each seat belongs in the trace too (Liar's Dice rolls
        # every seat its own dice during reset). The role prompt is left out: the
        # brief carries it, and it would otherwise be drawn in the log.
        for seat_id, entries in (getattr(state_object, "observations", {}) or {}).items():
            for entry in entries or []:
                try:
                    _from, text, kind = entry
                except (TypeError, ValueError):
                    continue
                if getattr(kind, "name", "") == "PROMPT":
                    continue
                record(seat_id, _from, text, kind)
        for entry in session.get("actions") or []:
            before = 0
            if strict and self.game.done(env):
                # A shared file must stop where the game stopped: a move recorded
                # after the result would be applied to a finished environment.
                raise ValueError("an action follows the end of the match")
            if strict and not self.game.done(env):
                seat = int(entry.get("seat", -1))
                if seat != self.game.current(env):
                    raise ValueError("an action is out of turn")
                before = int(getattr(env.state, "turn", 0))
            env.step(str(entry.get("raw") or ""))
            if strict and not self.game.done(env) and int(getattr(env.state, "turn", 0)) == before:
                # The environment only counts a turn it accepted. A refusal here
                # means the recorded move is not legal in this position.
                raise ValueError("the environment refused a recorded action")
        return env, index, trace

    def _session_finished(self, state: dict, index: int) -> bool:
        try:
            env, _index, _trace = self._env(state, index)
        except Exception:
            return False
        return bool(self.game.done(env))

    def _standings(self, state: dict, env=None, index: int | None = None) -> dict[int, float]:
        totals = {seat["seat"]: 0.0 for seat in state["seats"]}
        current = int(state.get("current") or 0) if index is None else index
        for position, session in enumerate(state["sessions"]):
            if position > current:
                break
            scores = session.get("result")
            if not scores and env is not None and position == current:
                scores = self._scores(env, session)
            for pid, value in (scores or {}).items():
                try:
                    seat = session["seats"][int(pid)]
                except (KeyError, IndexError, TypeError, ValueError):
                    continue
                totals[seat] = round(totals.get(seat, 0.0) + float(value), 3)
        return totals

    def _scores(self, env, session) -> dict[int, float]:
        return self.game.scores(env, session["seats"], None)

    def _meta(self, state: dict) -> dict:
        return {seat["seat"]: seat for seat in state["seats"]}

    def _settle(self, state: dict, env, index: int) -> None:
        """Record a finished session, and finish the table when the last one ends."""
        if not self.game.done(env):
            return
        session = state["sessions"][index]
        if not session.get("done"):
            session["done"] = True
            session["result"] = {str(pid): float(value)
                                 for pid, value in self._scores(env, session).items()}
        if index + 1 < len(state["sessions"]):
            state["current"] = index + 1
            if state.get("status") == "active":
                state.setdefault("notes", []).append(
                    f"Match {index + 1} finished. Match {index + 2} of "
                    f"{len(state['sessions'])} starts.")
            return
        if state.get("status") != "done":
            state["status"] = "done"
            state["ended_at"] = _now()
            state["result"] = self._result(state, env)
            self._rate(state)

    def _result(self, state: dict, env) -> dict:
        final = state["sessions"][-1]
        reveal = {}
        try:
            reveal = self.game.reveal(env, final["seats"], self._meta(state))
            reveal = self._to_field_seats(final, reveal)
        except Exception:
            reveal = {}
        standings = self._standings(state, env=env, index=len(state["sessions"]) - 1)
        best = max(standings.values()) if standings else 0
        winners = [seat for seat, value in standings.items() if best and value == best]
        return {
            "standings": {str(seat): value for seat, value in standings.items()},
            "winner_seats": winners,
            "reveal": reveal,
            "matches": [
                {"seats": session["seats"], "result": session.get("result") or {}}
                for session in state["sessions"]
            ],
        }

    @staticmethod
    def _to_field_seats(session: dict, reveal: dict) -> dict:
        """Rewrite a reveal's environment player numbers as seats at the table.

        The last match of a round-robin is played by two seats out of the field,
        so its own player 0 is not table seat 0. The screen names seats, so the
        reveal has to be translated or it would name the wrong people.
        """
        if not isinstance(reveal, dict):
            return reveal
        seats = list(session.get("seats") or [])

        def field(value):
            if isinstance(value, bool) or not isinstance(value, int):
                return value
            return seats[value] if 0 <= value < len(seats) else value

        out = dict(reveal)
        for key in ("roles", "dice", "points", "worth"):
            rows = out.get(key)
            if isinstance(rows, list):
                out[key] = [{**row, "seat": field(row.get("seat"))}
                            if isinstance(row, dict) and "seat" in row else row for row in rows]
        if isinstance(out.get("winners"), list):
            out["winners"] = [field(value) for value in out["winners"]]
        lots = out.get("lots")
        if isinstance(lots, list):
            out["lots"] = [{**row, "winner": field(row.get("winner"))}
                           if isinstance(row, dict) and "winner" in row else row for row in lots]
        return out

    # ------------------------------------------------------------------ model

    def _prompt(self, state: dict, env, seat: int, trace: list[dict], index: int,
                coach: str = "") -> str:
        # ``seat`` is the environment's player number for this match; the table's
        # seat (and its champion brief) is the session's mapping of it.
        meta = self._meta(state)
        field = self._field_of(state, index, seat)
        row = meta.get(field if field is not None else seat, {})
        # What this seat may read is its own observations, and only those. They are
        # read from the trace, which holds them already translated into the table's
        # naming (Mafia's rules count players from zero), so the brief, the log and
        # the buttons count the same way and a model cannot be told two identities.
        seen = common.trace_lines(trace, seat)
        own = env.state.observations.get(seat, [])
        said = common.speech_from(own, seat)
        brief = self.game.brief(env, seat)
        translate = getattr(self.game, "words", None)
        if callable(translate):
            brief = str(translate(brief))
        if row.get("brief"):
            brief = f"{brief}\nYour own voice, in your own words: {row['brief']}"
        instruction, shape = self.game.instruction(env, seat, meta=meta) if "meta" in inspect.signature(self.game.instruction).parameters else self.game.instruction(env, seat)
        return common.talking_prompt(
            title=self.game.TITLE, seat=seat, seats=len(state["seats"]),
            brief=brief, seen=seen, said=said, instruction=instruction, shape=shape,
            # Only the owner's own seats are asked for their working; the panel
            # that shows it is filtered to those seats again in picture().
            read_block=common.read_questions(), coach=coach)

    def _parse_answer(self, env, seat: int, text: str, allowed: list[dict]):
        """A model's answer: free wording first, then the exact click ids."""
        free = getattr(self.game, "parse_free", None)
        if callable(free):
            raw = free(env, seat, text)
            if raw:
                return ("act", raw)
        return self.game.parse(env, seat, text, allowed, None)

    def _ask(self, state: dict, env, seat: int, trace: list[dict], allowed: list[dict],
             index: int = 0) -> tuple[str | None, str, int]:
        """One model call with the guarded route. Returns (raw action, why-not, tokens)."""
        calls = state.setdefault("calls", {"used": 0, "cap": 1, "illegal": 0, "fallbacks": 0,
                                          "tokens": 0, "ms": 0})
        if self.complete is None:
            return None, "no model is set up", 0
        coach = self._coach_text(state)
        prompt = self._prompt(state, env, seat, trace, index, coach=coach)
        why = "gave no legal action"
        tokens = 0
        for attempt in range(MODEL_TRIES):
            # The cap is checked before every attempt, not once per turn: a retry
            # is another call and must not slip past it.
            if int(calls.get("used", 0)) >= self._cap(state):
                why = "the model call cap for this table is used up"
                break
            started = time.time()
            try:
                answer = kit._bounded(self.complete, prompt, MODEL_SECONDS)
            except kit.ModelBusy:
                # No request reached the model, so it does not count against the cap.
                why = "your model is busy with other requests"
                break
            except TimeoutError:
                # The request was made and may still be running, so it counts: a model
                # that always times out must not get a fresh request every turn.
                self._spend(state, seat, index, ms=int((time.time() - started) * 1000))
                why = "your model took too long to answer"
                break
            except Exception:
                self._spend(state, seat, index, ms=int((time.time() - started) * 1000))
                why = "your model could not be reached"
                break
            calls["used"] = int(calls.get("used", 0)) + 1
            calls["ms"] = int(calls.get("ms", 0)) + int((time.time() - started) * 1000)
            text = str(answer.get("move") if isinstance(answer, dict) else answer or "")
            spent = 0
            if isinstance(answer, dict):
                try:
                    spent = int(answer.get("tokens") or 0)
                except (TypeError, ValueError):
                    spent = 0
            tokens += spent
            calls["tokens"] = int(calls.get("tokens", 0)) + spent
            # The reply may carry the seat's private working around its action.
            # Only the action is ever played; the working goes to the owner's panel.
            thought = common.parse_thinking(text)
            parsed = self._parse_answer(env, seat, thought["action"], allowed)
            if isinstance(parsed, tuple) and parsed and parsed[0] == "act" and parsed[1]:
                self._record_think(state, index, seat, thought, str(parsed[1]), coach=coach)
                if coach:
                    stored = state.get("coach")
                    if isinstance(stored, dict):
                        stored["applied"] = int(time.time())
                self._spend(state, seat, index, tokens=spent, answered=True,
                            ms=int((time.time() - started) * 1000))
                return parsed[1], "", tokens
            calls["illegal"] = int(calls.get("illegal", 0)) + 1
            self._spend(state, seat, index, tokens=spent, answered=True,
                        ms=int((time.time() - started) * 1000), illegal=1)
            why = "sent nothing usable" if not thought["action"].strip() else "gave no legal action"
            if attempt + 1 < MODEL_TRIES:
                meta = self._meta(state)
                instr_shape = self.game.instruction(env, seat, meta=meta) if "meta" in inspect.signature(self.game.instruction).parameters else self.game.instruction(env, seat)
                prompt = prompt + (
                    f"\n\nYour last answer was {common.clean(text, 80)!r}, which the rules do not "
                    f"accept. Reply with {instr_shape[1]} only.")
        return None, why, tokens

    def _record_think(self, state: dict, index: int, seat: int, thought: dict, action: str,
                      *, coach: str = "", fallback: bool = False) -> None:
        """Keep one seat's own working, for its owner's panel and for nobody else.

        The store is keyed by the table's seat number, and ``picture`` reads it
        back only when the viewer is a person sitting at this table, and only for
        that person's own agent and champion seats.
        """
        field = self._field_of(state, index, seat)
        if field is None:
            return
        store = state.get("think")
        if not isinstance(store, dict):
            store = state["think"] = {}
        rows = store.get(str(field))
        if not isinstance(rows, list):
            rows = []
        seq = int(state.get("think_seq") or 0) + 1
        state["think_seq"] = seq
        rows = (rows + [{
            "read": [dict(row) for row in thought.get("read") or []],
            "scratch": str(thought.get("scratch") or ""),
            "action": str(action or ""),
            "coach": str(coach or ""),
            "at": int(time.time()),
            "seq": seq,
            "fallback": bool(fallback),
        }])[-THINK_KEEP:]
        store[str(field)] = rows

    # ------------------------------------------------------------- corner coach

    def _beat(self, env) -> str:
        """The name of the round the table is in, for the coach window.

        A game says where its rounds end (``beat``); anything else falls back to
        its phase line, which is honest but coarser.
        """
        finder = getattr(self.game, "beat", None)
        if callable(finder):
            try:
                return str(finder(env))
            except Exception:
                log.debug("beat could not describe this round", exc_info=True)
        try:
            return str(self.game.phase(env).get("label") or "")
        except Exception:
            return ""

    def _coach_seat(self, state: dict) -> int | None:
        for row in state.get("seats") or []:
            if row.get("kind") in {"agent", "champion"}:
                return int(row["seat"])
        return None

    def _coach_open(self, state: dict) -> None:
        """Open one 15-second window at each new round.

        A whisper belongs to the round it was sent in: when the round moves on,
        an unread one is dropped rather than surfacing three rounds later.
        """
        seat = self._coach_seat(state)
        if seat is None or state.get("status") != "active":
            return
        try:
            env, index, _trace = self._env(state)
        except Exception:
            return
        beat = self._beat(env)
        coach = state.get("coach")
        if not isinstance(coach, dict):
            coach = state["coach"] = {}
        window = coach.get("window") or {}
        if str(window.get("key") or "") == beat:
            return
        now = int(time.time())
        coach["window"] = {"key": beat, "opened": now, "until": now + COACH_SECONDS}
        coach["round"] = beat
        coach["seat"] = seat
        coach["text"] = ""
        coach["at"] = 0
        coach["applied"] = 0
        if not isinstance(coach.get("whispers"), list):
            coach["whispers"] = []

    def _coach_text(self, state: dict) -> str:
        """The whisper waiting to be read, if it has not been read yet."""
        coach = state.get("coach") or {}
        text = str(coach.get("text") or "")
        if not text or int(coach.get("applied") or 0):
            return ""
        return text

    def _coach(self, state: dict, text: str, player) -> str:
        """One sentence of advice from the person whose bot it is."""
        identity = str(getattr(player, "id", "") or "")
        if state.get("status") != "active":
            return "The game is over, so there is nobody left to coach."
        if not self._may_manage(state, player) or self._human_seat(state, identity) is None:
            return "Only the person whose bot this is can whisper to it."
        self._coach_open(state)
        coach = state.get("coach") or {}
        window = coach.get("window") or {}
        now = int(time.time())
        if not window or now > int(window.get("until") or 0):
            return "The whisper window has closed."
        # The sentence is measured before it is cleaned, so an over-long one is
        # refused plainly instead of being cut in half without being told.
        flat = " ".join(common.clean(text, 1000).split())
        if not flat:
            return "Write one sentence first."
        if len(flat) > COACH_CHARS:
            return f"Keep it to one sentence, {COACH_CHARS} characters or less."
        stored_whispers = coach.get("whispers")
        whispers = [item for item in stored_whispers if isinstance(item, dict)] \
            if isinstance(stored_whispers, list) else []
        if any(item.get("round") == window.get("key") for item in whispers[-4:]):
            return "You have already whispered this round."
        seat = int(coach.get("seat") or 0)
        row = (self._meta(state).get(seat) or {})
        whispers.append({"text": flat, "at": now, "seat": seat, "round": window.get("key")})
        coach["whispers"] = whispers[-8:]
        coach["text"] = flat
        coach["at"] = now
        coach["applied"] = 0
        self._save(state)
        return f"Whispered. {row.get('name') or 'Your bot'} will read it before its next move."


    def _spend(self, state: dict, seat: int, index: int, *, tokens: int = 0,
               illegal: int = 0, ms: int = 0, answered: bool = False) -> None:
        """Record one seat's own tokens, refusals and thinking time.

        The table-wide counters above are what the screen shows; these are what the
        Champions ratings read, because a champion must not be charged for another
        seat's wrong answer.
        """
        calls = state.setdefault("calls", {"used": 0, "cap": 1, "illegal": 0, "fallbacks": 0,
                                           "tokens": 0, "ms": 0})
        field = self._field_of(state, index, seat)
        if field is None:
            return
        by_seat = calls.get("by_seat")
        if not isinstance(by_seat, dict):
            by_seat = calls["by_seat"] = {}
        row = by_seat.get(str(field))
        if not isinstance(row, dict):
            row = by_seat[str(field)] = {"tokens": 0, "illegal": 0, "ms": 0}
        for key, value in (("tokens", tokens), ("illegal", illegal), ("ms", ms)):
            try:
                row[key] = int(row.get(key, 0)) + int(value)
            except (TypeError, ValueError):
                row[key] = 0
        # A timeout or a refused connection is a request the cap has to count. A call
        # that answered is already counted by ``_ask`` — even when the provider sends
        # no usage, which many of them omit for a short answer.
        if not answered and tokens == 0 and illegal == 0:
            calls["used"] = int(calls.get("used", 0)) + 1
            calls["ms"] = int(calls.get("ms", 0)) + int(ms)

    # ------------------------------------------------------------------ people

    def _draft(self, state: dict, seat: int) -> list:
        found = state.get("draft") or {}
        value = found.get(str(seat))
        return value if isinstance(value, list) else []

    def _set_draft(self, state: dict, seat: int, value: list) -> None:
        found = dict(state.get("draft") or {})
        found[str(seat)] = value
        state["draft"] = found

    def _human_turn(self, state: dict, env, player, index: int) -> bool:
        identity = str(getattr(player, "id", "") or "")
        seat = self._human_seat(state, identity)
        if seat is None or self.game.done(env):
            return False
        return self._field_of(state, index, self.game.current(env)) == seat

    def _human_seat(self, state: dict, identity: str) -> int | None:
        for row in state["seats"]:
            if row["kind"] == "human" and str(row.get("id") or "") in {identity, ""}:
                return int(row["seat"])
        return None

    def _field_of(self, state: dict, index: int, env_pid: int) -> int | None:
        """The seat at the table for one position in the current match.

        A round-robin plays two seats at a time, so the environment's player 0 is
        not the table's seat 0: the session's own seat list is the mapping.
        """
        try:
            session = state["sessions"][index]
            return int(session["seats"][int(env_pid)])
        except (KeyError, IndexError, TypeError, ValueError):
            return None

    def _name_of(self, state: dict, index: int, env_pid: int) -> str:
        """The table name of one environment player, or "" when there is none."""
        field = self._field_of(state, index, env_pid)
        if field is None:
            return ""
        row = self._meta(state).get(field)
        return str(row["name"]) if row else ""

    def _env_of(self, state: dict, index: int, field_seat: int) -> int | None:
        try:
            return state["sessions"][index]["seats"].index(int(field_seat))
        except (KeyError, IndexError, TypeError, ValueError):
            return None

    def _machine_turn(self, state: dict, env, index: int) -> int | None:
        """The environment player that is a machine's, or None."""
        if self.game.done(env):
            return None
        env_pid = self.game.current(env)
        field = self._field_of(state, index, env_pid)
        if field is None:
            return None
        row = self._meta(state).get(field)
        if row and row["kind"] in {"local", "agent", "champion"}:
            return int(env_pid)
        return None

    # ------------------------------------------------------------------ play

    def _apply(self, state: dict, env, index: int, env_pid: int, raw: str) -> None:
        # The record holds the environment's own player number: that is what a
        # replay hands back to the environment.
        state["sessions"][index].setdefault("actions", []).append({"seat": int(env_pid), "raw": str(raw)})
        env.step(str(raw))
        self._settle(state, env, index)

    def _advance_machine(self, state: dict, env, index: int, trace: list[dict]) -> str:
        seat = self._machine_turn(state, env, index)
        if seat is None:
            return "It is not a machine seat's turn."
        meta = self._meta(state)
        row = meta[self._field_of(state, index, seat)]
        allowed = call_actions(self.game, env, seat, self._draft(state, seat), meta)
        history = [(entry.get("seat"), entry.get("raw"))
                   for entry in state["sessions"][index].get("actions") or []]
        rng = random.Random(f"{state.get('table_id')}:{len(history)}")
        note = ""
        raw = None
        # The environments draw from Python's process-wide generator. A model call can
        # take twenty seconds, and anything that drew from that generator in the
        # meantime (another table, a slow call left running) would change the dice or
        # the night order this action lands on. The state the replay left behind is put
        # back before the move is applied, so a recorded move always meets the state it
        # was played against.
        drawn = random.getstate()
        if row["kind"] in {"agent", "champion"}:
            raw, why, _tokens = self._ask(state, env, seat, trace, allowed, index)
            if raw is None:
                note = f"{row['name']} {why}; the built-in player played that turn."
                state["calls"]["fallbacks"] = int(state["calls"].get("fallbacks", 0)) + 1
        if raw is None:
            try:
                raw = self.game.bot(env, seat, rng, history)
            except TypeError:
                raw = self.game.bot(env, seat, rng)
        random.setstate(drawn)
        if raw is None or raw == "":
            return f"{row['name']} had nothing to play."
        self._apply(state, env, index, seat, raw)
        if state.get("learn") and row["kind"] not in {"agent", "champion"}:
            # In a guided game the machine seat says what it did, in the rules' own
            # words, so the person learns why the bid went up.
            try:
                logs = list(getattr(env.state, "logs", None) or [])
                last = str(logs[-1][1]) if logs and len(logs[-1]) > 1 else ""
            except Exception:
                last = ""
            if last:
                translate = getattr(self.game, "words", None)
                if callable(translate):
                    # The rules count seats their own way; the table counts from one.
                    try:
                        last = str(translate(last))
                    except Exception:
                        last = str(last)
                state["coach_note"] = last
        if row["kind"] in {"agent", "champion"} and note:
            # The model's answer was unusable, so the built-in player covered it.
            # The owner's panel says so plainly instead of pretending otherwise.
            self._record_think(state, index, seat,
                               {"read": [], "scratch": "", "action": str(raw)},
                               str(raw), coach="", fallback=True)
        if note:
            state.setdefault("notes", []).append(note)
            return note
        return f"{row['name']} played."

    def command(self, raw: str, *, source: str = "command", complete=None, player=None) -> str:
        self.complete = complete if callable(complete) else None
        self.player = player
        # A shared game file is JSON: its own spaces and quotes are part of the
        # document, so it is never split into words.
        text = str(raw or "").strip()
        if text[:6].lower() == "import":
            if getattr(player, "bot", False):
                return "Refused (person_required)."
            with kit.locked(self.root):
                state = self._load()
                if (state is not None and state.get("status") == "active"
                        and not self._may_manage(state, player)):
                    return "Someone else is at this table. Only they can open a game here."
                return self._import(text[6:].strip(), player)
        pieces = text.split(None, 1)
        head = pieces[0].lower() if pieces else ""
        # "say" is speech, not shell words: "I don't trust you" must reach the
        # table whole, apostrophe and all.
        parts = [head, pieces[1]] if head == "say" and len(pieces) > 1 else kit.words(raw)
        if parts is None:
            return f"Could not read that. Try /games {self.id} new"
        if not parts or parts[0].lower() in {"help", "?"}:
            return self.help()
        head, rest = parts[0].lower(), parts[1:]
        if getattr(player, "bot", False) and head not in {"state", "help"}:
            return "Refused (person_required)."
        # Both locks: the table's own, and the replay lock, because applying an
        # action may roll dice with the process-wide generator.
        with kit.locked(self.root), _REPLAY:
            state = self._load()
            if head == "new":
                # A live table belongs to the person who set it up: a second person
                # pressing "New table" would throw their game away.
                if (state is not None and state.get("status") == "active"
                        and not self._may_manage(state, player)):
                    return "Someone else is at this table. Only they can start a new one."
                return self._new(rest, player)
            if head == "import":
                if (state is not None and state.get("status") == "active"
                        and not self._may_manage(state, player)):
                    return "Someone else is at this table. Only they can open a game here."
                return self._import(" ".join(rest), player)
            if state is None:
                return f"No table yet. /games {self.id} new"
            if head in {"state", "board"}:
                return self.draw(state)
            if head == "abandon":
                if not self._may_manage(state, player):
                    return "Only the person who set the table can close it."
                state["status"] = "abandoned"
                self._save(state)
                return "Table closed."
            if head == "rematch":
                return self._rematch(state, player)
            if head == "learn":
                if rest and rest[0].lower() == "undo":
                    return self._learn_undo(state, player)
                return f"Usage: /games {self.id} learn undo"
            if head == "export":
                # The help has always offered this; the command table now answers it.
                if state.get("status") != "done":
                    return "The game is not over yet, so there is nothing to save."
                return json.dumps(self.share(state))
            if head in {"act", "do", "say"}:
                return self._move(state, head, " ".join(rest), player)
            if head == "coach":
                return self._coach(state, pieces[1] if len(pieces) > 1 else "", player)
            if head == "step":
                return self._step(state, player)
        return self.help()

    def _learn_undo(self, state: dict, player) -> str:
        """Take the person's last move back in a guided game (the Learn button).

        The table keeps every action and rebuilds the game by replaying them, so
        undoing is truncating the log: the dice come from the session's seed and
        land exactly where they did before.
        """
        if not state.get("learn"):
            return "This is not a guided game. Press Learn, then Play & Learn."
        if not self._may_manage(state, player):
            return "Only someone at this table can take a move back."
        if state.get("status") == "abandoned":
            return "That table is closed."
        _env, index, _trace = self._env(state)
        session = state["sessions"][index]
        actions = session.get("actions") or []
        if not actions:
            return "Nothing to take back yet."
        mine = self._human_seat(state, str(getattr(player, "id", "") or ""))
        human_env = None
        if mine is not None:
            human_env = self._env_of(state, index, mine)
        cut = None
        for position in range(len(actions) - 1, -1, -1):
            if human_env is None or int(actions[position].get("seat", -1)) == int(human_env):
                cut = position
                break
        if cut is None:
            return "Nothing to take back yet."
        session["actions"] = actions[:cut]
        session["done"] = False
        session["result"] = None
        state["status"] = "active"
        state["result"] = None
        state["coach_tip"] = ""
        state["coach_note"] = ""
        env, index, _trace = self._env(state)
        self._settle(state, env, index)
        self._coach_open(state)
        self._save(state)
        return "Took that move back. Try a different one."

    def _may_manage(self, state: dict, player) -> bool:
        identity = str(getattr(player, "id", "") or "")
        if not state.get("owner_id") or state.get("owner_id") == identity:
            return True
        if self._human_seat(state, identity) is not None:
            return True
        # A table with nobody in a person's seat is a watch: any viewer at this
        # machine may nudge the machine seats along. Nothing private is drawn.
        return not any(row.get("kind") == "human" for row in state.get("seats") or [])

    def _move(self, state: dict, head: str, text: str, player) -> str:
        if state.get("status") in {"done", "abandoned"}:
            return "That table is finished. Start a rematch to play again."
        env, index, trace = self._env(state)
        seat = self._human_seat(state, str(getattr(player, "id", "") or ""))
        if seat is None:
            return "You are not sitting at this table."
        if self.game.done(env):
            return "That game is over."
        env_pid = self._env_of(state, index, seat)
        if env_pid is None:
            return "That match is between other seats; yours is next."
        if self.game.current(env) != env_pid:
            field = self._field_of(state, index, self.game.current(env))
            row = self._meta(state).get(field, {})
            return f"It is {row.get('name') or 'another seat'}'s turn."
        meta = self._meta(state)
        allowed = call_actions(self.game, env, env_pid, self._draft(state, seat), meta)
        if head == "say":
            if not self.game.can_say(env, env_pid):
                return "There is nothing to say right now; the game is not in a talking phase."
            said = _clean(text, MAX_SAY)
            if not said:
                return "Nothing to say."
            self._apply(state, env, index, env_pid, said)
            self._coach_open(state)
            self._save(state)
            return "Said."
        if head == "do":
            # A typed word ("cooperate", "call") goes through the same parser as a click.
            text = text.strip()
        # The whole rest of the line goes to the parser: a target is often more than
        # one word ("Player 3"), and every game's parser reads what it needs.
        parsed = self.game.parse(env, env_pid, text.strip(), allowed, self._draft(state, seat))
        if parsed is None:
            return "That is not one of the actions on the table right now."
        if parsed[0] == "refuse":
            return str(parsed[1])
        if parsed[0] == "draft":
            self._set_draft(state, seat, parsed[1])
            self._save(state)
            return "Bids updated."
        if not parsed[1]:
            return "Nothing was sent."
        # In a guided game the rules get one honest word about the move just made —
        # public information and the person's own dice only, never a hidden roll.
        tip = ""
        if state.get("learn"):
            hook = getattr(self.game, "learn_tip", None)
            if callable(hook):
                try:
                    tip = str(hook(env, int(env_pid), str(parsed[1])) or "")
                except Exception:
                    tip = ""
        self._apply(state, env, index, env_pid, parsed[1])
        if state.get("learn"):
            state["coach_tip"] = tip
        self._coach_open(state)
        self._save(state)
        return "Played."

    def _step(self, state: dict, player) -> str:
        if state.get("status") != "active":
            return "There is no game in progress."
        if not self._may_manage(state, player):
            return "Only someone at this table can let the machine seats play."
        env, index, trace = self._env(state)
        if self.game.done(env):
            return "That game is over."
        if self._human_turn(state, env, player, index):
            return "It is your turn."
        answer = self._advance_machine(state, env, index, trace)
        self._coach_open(state)
        self._save(state)
        return answer

    # ------------------------------------------------------------------ setup

    def _new(self, rest: list[str], player) -> str:
        wanted = {}
        for part in rest:
            if "=" in part:
                key, value = part.split("=", 1)
                wanted[key.lower()] = value
        # AI off is the profile floor: a talking table is always a person plus
        # built-in or model seats, so there is no one to sit down with. Refusing
        # here too means the setting cannot be walked around by asking for an
        # agent seat and then stepping it.
        if not bool(self.settings.get("allow_ai", True)):
            return ("AI is off for this profile, so there is nobody to sit at this table with "
                    "you. Turn it back on in Game Center settings to play a talking table.")
        count = self.game.DEFAULT_SEATS
        try:
            if "seats" in wanted:
                count = int(wanted["seats"])
        except ValueError:
            return "Seats must be a number."
        count = max(self.game.MIN_SEATS, min(self.game.MAX_SEATS, count))
        agent = str(wanted.get("agent", "0")).lower() in {"1", "yes", "true", "on"}
        all_bots = str(wanted.get("bots", "0")).lower() in {"1", "yes", "true", "on"}
        levels = list(getattr(self.game, "LEVELS", ()) or ())
        level = str(wanted.get("level") or getattr(self.game, "DEFAULT_LEVEL", "")).strip().lower()
        if level and levels and level not in levels:
            return "That is not one of the levels this table offers."
        seed = 0
        if "seed" in wanted:
            try:
                seed = int(wanted["seed"])
            except ValueError:
                return "Seed must be a number."
        else:
            seed = random.SystemRandom().randrange(1, 1_000_000)
        champions = [item for item in str(wanted.get("champions", "")).split(",") if item]
        learning = any(part.lower() == "learn" for part in rest)
        if learning:
            # A guided first game (the Learn button): one real game against the rules'
            # own weakest built-in player, which explains its moves in the margin and
            # lets a mistake be taken back. Levels and model seats are not the point
            # of a lesson, so both are pinned here rather than argued about later.
            if levels:
                level = levels[0]
            agent = False
            all_bots = False
            champions = []
        rows = self._champion_rows(champions, count)
        guests = int(getattr(self.game, "MAX_GUESTS", count - 1) or (count - 1))
        if len(rows) > guests:
            rows = rows[:guests]
        if agent and len(rows) >= guests:
            agent = False
        if len(rows) > count - 1:
            rows = rows[:count - 1]
        state = {
            "schema_version": SCHEMA,
            "game": self.id,
            "table_id": uuid.uuid4().hex,
            "owner_id": str(getattr(player, "id", "") or ""),
            "status": "active",
            "created_at": _now(),
            "seat_count": count,
            "agent": agent,
            "all_bots": all_bots,
            "level": level or None,
            "champion_rows": rows,
            "seed": seed,
            "sessions": [],
            "current": 0,
            "draft": {},
            "notes": [],
            "result": None,
            "rated": False,
        }
        if learning:
            state["learn"] = True
        state["seats"] = self._seat_rows(state, player)
        sessions = self.game.sessions(count)
        for index, seat_ids in enumerate(sessions):
            state["sessions"].append({
                "seats": list(seat_ids), "seed": seed + index, "actions": [],
                "done": False, "result": None,
            })
        model_seats = sum(1 for row in state["seats"] if row["kind"] in {"agent", "champion"})
        guess = int(self.game.estimate(count, model_seats))
        state["calls"] = {"used": 0, "cap": min(CALL_CEILING, max(20, guess * 2)), "illegal": 0,
                          "fallbacks": 0, "tokens": 0, "ms": 0}
        state["estimate"] = guess
        note = ""
        if model_seats and self.complete is None:
            note = (" No model is set up here, so those seats will be played by the built-in "
                    "player instead.")
        self._coach_open(state)
        self._save(state)
        if not model_seats:
            return (f"Table set: {count} seats. You are Player 1. Every other seat is the "
                    f"built-in player, so this game uses no model calls at all.")
        return (f"Table set: {count} seats. You are Player 1. "
                f"{model_seats} seat(s) would use a model. This game asks a model about "
                f"{guess} time(s); the cap is {state['calls']['cap']}.{note}")

    def _champion_rows(self, ids: list[str], count: int) -> list[dict]:
        """Champion briefs for the seats that asked for them, read from this plugin's store."""
        if not ids:
            return []
        rows = []
        try:
            store = kit._shelf("champions").ChampionStore(self.data_root)
        except Exception:
            return []
        for champion_id in ids[: max(0, count - 1)]:
            found = store.get(champion_id)
            if not isinstance(found, dict):
                continue
            try:
                glyph = kit._shelf("champions").avatar_glyph(found)
                colour = kit._shelf("champions").color_hex(found)
            except Exception:
                glyph, colour = common.avatar_for(len(rows) + 1), common.colour_for(len(rows) + 1)
            rows.append({"id": found.get("id"), "name": found.get("name"),
                         "brief": found.get("brief"), "glyph": glyph, "colour": colour})
        return rows

    def _rematch(self, state: dict, player) -> str:
        if not self._may_manage(state, player):
            return "Only the person who set the table can start a rematch."
        seed = random.SystemRandom().randrange(1, 1_000_000)
        state["seed"] = seed
        state["sessions"] = []
        for index, seat_ids in enumerate(self.game.sessions(int(state["seat_count"]))):
            state["sessions"].append({"seats": list(seat_ids), "seed": seed + index,
                                      "actions": [], "done": False, "result": None})
        state["current"] = 0
        state["status"] = "active"
        state["result"] = None
        state["rated"] = False
        state["draft"] = {}
        state["notes"] = []
        state["calls"] = {"used": 0, "cap": state.get("calls", {}).get("cap", 20),
                          "illegal": 0, "fallbacks": 0, "tokens": 0, "ms": 0}
        self._save(state)
        return "New game, same seats."

    # ------------------------------------------------------------------ share

    def share(self, state: dict) -> dict:
        return {
            "schema": SCHEMA,
            "plugin": "hermes-gameshelf",
            "game": self.id,
            "title": self.game.TITLE,
            "seed": state.get("seed"),
            "level": state.get("level") or "",
            "seats": [{key: row.get(key) for key in ("seat", "kind", "name", "avatar", "colour")}
                      for row in state.get("seats") or []],
            "sessions": [{"seats": session["seats"], "seed": session["seed"],
                          "actions": session.get("actions") or []}
                         for session in state.get("sessions") or []],
            "result": state.get("result"),
            "created_at": state.get("created_at"),
        }

    def _import(self, text: str, player) -> str:
        text = (text or "").strip()
        if not text:
            return "Nothing to import."
        try:
            data = json.loads(text)
        except ValueError:
            return "That is not a shared game file."
        bad = self._check_share(data)
        if bad:
            return bad
        state = {
            "schema_version": SCHEMA,
            "game": self.id,
            "table_id": uuid.uuid4().hex,
            "owner_id": str(getattr(player, "id", "") or ""),
            "status": "done",
            "created_at": int(data.get("created_at") or _now()),
            "ended_at": _now(),
            "seat_count": len(data["seats"]),
            "agent": False,
            "champion_rows": [],
            "seed": int(data.get("seed") or 0),
            "level": str(data.get("level") or "") or None,
            "sessions": [{"seats": list(session["seats"]), "seed": int(session["seed"]),
                          "actions": list(session["actions"]), "done": True, "result": None}
                         for session in data["sessions"]],
            "current": len(data["sessions"]) - 1,
            "draft": {},
            "notes": ["Imported from a shared file."],
            "result": None,
            "rated": True,
            "calls": {"used": 0, "cap": 20, "illegal": 0, "fallbacks": 0, "tokens": 0, "ms": 0},
        }
        state["seats"] = []
        for index, row in enumerate(data["seats"]):
            try:
                seat_no = int(row.get("seat", index))
            except (TypeError, ValueError):
                seat_no = index
            if not 0 <= seat_no < len(data["seats"]) or any(item["seat"] == seat_no for item in state["seats"]):
                seat_no = index
            state["seats"].append({
                "seat": seat_no,
                "kind": "human" if row.get("kind") == "human" else str(row.get("kind") or "local"),
                # The person who opens the file sits in the seat the person's seat was:
                # the name stays as the shared record has it, but a rematch has to be
                # playable, and the seat is only playable by the id that holds it.
                "id": (str(getattr(player, "id", "") or "") if row.get("kind") == "human"
                       else str(row.get("kind") or "local")),
                "name": _clean(row.get("name"), 32) or common.seat_name(index),
                "avatar": str(row.get("avatar") or common.avatar_for(index)),
                "colour": str(row.get("colour") or common.colour_for(index)),
                "brief": "", "champion": "",
            })
        # Replaying proves the file: every action must still be legal in turn, and
        # every match in it must be a finished one — a half-played earlier match
        # would leave the standings short of the field.
        try:
            for position in range(len(state["sessions"])):
                env, _index, _trace = self._env(state, position, strict=True)
                if not self.game.done(env):
                    return "That game file stops before the end of the game."
                state["sessions"][position]["result"] = {
                    str(pid): float(value) for pid, value in self._scores(env, state["sessions"][position]).items()}
        except Exception:
            return "That game file does not replay."
        env, _index, _trace = self._env(state, len(state["sessions"]) - 1)
        if not self.game.done(env):
            return "That game file stops before the end of the game."
        state["result"] = self._result(state, env)
        self._save(state)
        return "Imported a finished game. You can watch it here."

    def _check_share(self, data: Any) -> str:
        if not isinstance(data, dict):
            return "That is not a shared game file."
        if data.get("game") != self.id:
            return f"That file is a {data.get('game', 'different')} game."
        if data.get("schema") != SCHEMA:
            return "That game file is from a different version."
        seats = data.get("seats")
        sessions = data.get("sessions")
        # The header numbers are turned into ints when the table is built, so a file
        # with "created_at": "invalid" has to be refused here, not raised later.
        for key in ("created_at", "seed"):
            value = data.get(key)
            if value in (None, ""):
                continue
            try:
                int(value)
            except (TypeError, ValueError):
                return f"That game file has a broken {key.replace('_', ' ')}."
        if not isinstance(seats, list) or not (self.game.MIN_SEATS <= len(seats) <= self.game.MAX_SEATS):
            return "That game file has the wrong number of seats."
        for row in seats:
            if not isinstance(row, dict):
                return "That game file has a broken seat."
        if not isinstance(sessions, list) or not sessions or len(sessions) > 64:
            return "That game file has no matches."
        # The matches are the game's own pairings, dealt in its own order: a file that
        # repeats one match and drops another would show standings for a tournament
        # that was never played.
        pattern = [[int(seat) for seat in pair] for pair in self.game.sessions(len(seats))]
        played = []
        for session in sessions:
            if not isinstance(session, dict) or not isinstance(session.get("seats"), list):
                return "That game file has a broken match."
            try:
                played.append([int(seat) for seat in session["seats"]])
            except (TypeError, ValueError):
                return "That game file has a broken match."
        if played != pattern:
            return "That game file is missing a match or repeats one."
        for session in sessions:
            if not isinstance(session.get("actions"), list) or len(session["actions"]) > 600:
                return "That game file has a broken match."
            for entry in session["actions"]:
                if not isinstance(entry, dict) or not isinstance(entry.get("raw"), str):
                    return "That game file has a broken move."
                if len(entry["raw"]) > 400:
                    return "That game file has a move that is too long."
            try:
                int(session.get("seed"))
            except (TypeError, ValueError):
                return "That game file has a broken seed."
        return ""

    # ------------------------------------------------------------------ ratings

    def _rate(self, state: dict) -> None:
        """Feed the Champions ratings: every pair of rated seats, head to head."""
        if state.get("rated"):
            return
        state["rated"] = True
        rated = [row for row in state["seats"] if row["kind"] in {"champion", "local"} and row.get("id")]
        champions = [row for row in rated if row["kind"] == "champion"]
        if len(champions) < 1 or len(rated) < 2:
            return
        standings = {int(seat): value for seat, value in (state.get("result") or {}).get("standings", {}).items()}
        calls = state.get("calls") or {}
        try:
            ratings = kit._shelf("tournament").Ratings(self.data_root)
        except Exception:
            return
        # Each champion is charged only its own tokens, refusals and thinking time: the
        # table-wide totals would hand one seat's wrong answer to another.
        by_seat = calls.get("by_seat") if isinstance(calls.get("by_seat"), dict) else {}

        def own(row, key):
            entry = by_seat.get(str(row["seat"]))
            try:
                return int((entry if isinstance(entry, dict) else {}).get(key) or 0)
            except (TypeError, ValueError):
                return 0

        tokens = {row["id"]: own(row, "tokens") for row in rated}
        illegal = {row["id"]: own(row, "illegal") for row in rated}
        think = {row["id"]: own(row, "ms") for row in rated}
        done: set[tuple[str, str]] = set()
        # A champion in a field of six is recorded against several opponents. Its own
        # tokens and refusals belong to it once, not once per opponent, so they are
        # handed over on the first pairing only.
        paid: set[str] = set()

        for first in rated:
            for second in rated:
                if first["seat"] >= second["seat"]:
                    continue
                if "champion" not in {first["kind"], second["kind"]}:
                    continue
                # Two computer seats share one name, so a pair is recorded once.
                one, two = str(first["id"]), str(second["id"])
                pair = (one, two) if one <= two else (two, one)
                if pair in done or pair[0] == pair[1]:
                    continue
                done.add(pair)
                a = standings.get(int(first["seat"]), 0)
                b = standings.get(int(second["seat"]), 0)
                result = 1.0 if a > b else 0.0 if a < b else 0.5
                costs = {}
                for key, table in (("illegal", illegal), ("tokens", tokens), ("think_ms", think)):
                    costs[key] = {entrant: value for entrant, value in table.items() if entrant not in paid}
                try:
                    ratings.record(self.id, one, two, result,
                                   illegal=costs["illegal"], tokens=costs["tokens"],
                                   think_ms=costs["think_ms"])
                except Exception:
                    continue
                paid.update({one, two})

    # ------------------------------------------------------------------ text

    def draw(self, state: dict) -> str:
        try:
            env, index, trace = self._env(state)
        except Exception:
            return f"{self.game.TITLE}: this table could not be replayed."
        lines = [f"{self.game.TITLE} · {self.game.phase(env)['label']}"]
        rows = self._meta(state)
        for session_no, session in enumerate(state["sessions"], start=1):
            seats = ", ".join(rows[seat]["name"] for seat in session["seats"])
            marker = " (playing now)" if session_no - 1 == index else ""
            result = session.get("result")
            tail = ""
            if isinstance(result, dict) and result:
                tail = " -> " + ", ".join(f"{rows[session['seats'][int(pid)]]['name']} {value:g}"
                                          for pid, value in result.items() if int(pid) < len(session["seats"]))
            lines.append(f"Match {session_no}: {seats}{marker}{tail}")
        if state.get("status") == "done":
            result = state.get("result") or {}
            winners = [rows[seat]["name"] for seat in result.get("winner_seats", [])]
            lines.append(("Winners: " + ", ".join(winners)) if winners else "Game over.")
        else:
            env_seat = self.game.current(env)
            field_seat = self._field_of(state, index, env_seat)
            viewer = self._viewer()
            my_seat = self._human_seat(state, viewer) if viewer else None
            my_env = self._env_of(state, index, my_seat) if my_seat is not None else None
            tells = getattr(self.game, "turn_is_private", None)
            hidden = False
            if callable(tells):
                try:
                    hidden = bool(tells(env, env_seat, my_env))
                except Exception:
                    hidden = False
            if hidden:
                # A night turn is the role; the text may not name who is acting.
                lines.append("A seat is acting.")
            else:
                name = rows.get(field_seat, {}).get("name") if field_seat is not None else ""
                if not name:
                    name = f"Player {env_seat + 1}"
                lines.append(f"{name} to act.")
        return "\n".join(lines)

    def help(self) -> str:
        return "\n".join([
            self.game.TITLE,
            self.game.BLURB,
            "",
            "Usage:",
            f"/games {self.id} new [seats={self.game.DEFAULT_SEATS}] [agent=1] [champions=id,id]",
            f"/games {self.id} act <what the screen offers>",
            f"/games {self.id} say <one line>",
            f"/games {self.id} coach <one sentence, 120 characters, once per round>",
            f"/games {self.id} step",
            f"/games {self.id} state",
            f"/games {self.id} rematch",
            f"/games {self.id} export",
            f"/games {self.id} import <shared file>",
            f"/games {self.id} abandon",
        ])

    # ------------------------------------------------------------------ screen

    def _log(self, state: dict, trace: list[dict], env_pid: int | None, index: int) -> list[dict]:
        """What one viewer may read.

        The trace records the environment's own player numbers, so the viewer has
        to be that number too: in a round-robin the table's seat 0 is not the same
        person as the current match's player 0.
        """
        rows = self._meta(state)
        found = []
        for entry in trace[-MAX_LOG:]:
            if entry["to"] is not None and entry["to"] != env_pid:
                continue
            speaker = entry["from"]
            spoken = entry["kind"] == "PLAYER_ACTION"
            name = ""
            if speaker is not None and speaker >= 0:
                field = self._field_of(state, index, speaker)
                row = rows.get(field) if field is not None else None
                name = row["name"] if row else f"Player {speaker + 1}"
                if env_pid is not None and speaker == env_pid:
                    name = f"{name} (you)"
            text = common.clean(entry["text"], 400)
            # The rules narrate in their own player numbers; at the table a seat is
            # its name, so a game that can trade the numbers for names does (a
            # typed line is the person's own words and is left exactly as said).
            narrate = getattr(self.game, "narrate", None)
            if not spoken and callable(narrate):
                try:
                    told = str(narrate(text, lambda env_p: self._name_of(state, index, env_p)))
                    if told:
                        text = common.clean(told, 400)
                except Exception:
                    text = common.clean(entry["text"], 400)
            found.append({
                "seat": self._field_of(state, index, speaker) if speaker is not None and speaker >= 0 else None,
                "name": name,
                "text": text,
                "kind": "say" if spoken else "game",
            })
        return found

    def picture(self, complete=None, player=None) -> dict | None:
        if callable(complete):
            self.complete = complete
        self.player = player
        state = self._load()
        if state is None or state.get("status") == "abandoned":
            return self._preview()
        try:
            env, index, trace = self._env(state)
        except Exception as exc:
            return {"schema_version": 2, "view": self.id, "game": self.id, "title": self.game.TITLE,
                    "status": "idle", "error": f"This table could not be replayed ({type(exc).__name__}).",
                    "places": [], "log": [], "actions": []}
        rows = self._meta(state)
        viewer = self._viewer()
        seat = self._human_seat(state, viewer) if viewer else self._human_seat(state, "")
        # A watcher has no seat, so the log below keeps only what every seat saw.
        session = state["sessions"][index]
        phase = self.game.phase(env)
        turn_env = None if self.game.done(env) else self.game.current(env)
        turn_field = self._field_of(state, index, turn_env) if turn_env is not None else None
        turn_row = rows.get(turn_field) if turn_field is not None else None
        human_env = self._env_of(state, index, seat) if seat is not None else None
        # Some phases have a secret turn: at night in Mafia the acting seat *is* the
        # role, so only that seat may be told it is playing.
        hidden_turn = False
        tells_turn = getattr(self.game, "turn_is_private", None)
        if turn_env is not None and callable(tells_turn):
            try:
                hidden_turn = bool(tells_turn(env, turn_env, human_env))
            except Exception:
                hidden_turn = False
        mine = {}
        if human_env is not None:
            # Only the seat that is actually playing this match may see its private
            # numbers: in a round-robin the person may be watching another pair.
            try:
                private = getattr(self.game, "private", None)
                mine = private(env, human_env) if callable(private) else {}
            except Exception:
                mine = {}
        table = {}
        try:
            table = self.game.table(env, session["seats"], rows) or {}
        except Exception:
            table = {}
        standings = self._standings(state, env=env, index=index)
        places = []
        for position, place in enumerate(table.get("places") or []):
            env_pid = int(place.get("seat", position))
            field_seat = session["seats"][env_pid] if env_pid < len(session["seats"]) else env_pid
            row = rows.get(field_seat, {})
            places.append({
                "seat": field_seat,
                "env_seat": env_pid,
                "name": row.get("name") or common.seat_name(field_seat),
                "avatar": row.get("avatar") or common.avatar_for(field_seat),
                "colour": row.get("colour") or common.colour_for(field_seat),
                "kind": row.get("kind") or "local",
                "you": field_seat == seat,
                "role": "",
                "out": bool(place.get("out")),
                "note": str(place.get("note") or ""),
                "score": standings.get(field_seat, 0),
                "playing": (turn_env is not None and env_pid == turn_env
                            and (not hidden_turn or env_pid == human_env)),
                "in_match": True,
            })
        # A tournament plays two seats at a time, but the whole field sits at the
        # table: add the seats whose match has finished or has not started.
        seated = {place["seat"] for place in places}
        for field_seat, row in sorted(rows.items()):
            if field_seat in seated:
                continue
            places.append({
                "seat": field_seat,
                "env_seat": None,
                "name": row.get("name") or common.seat_name(field_seat),
                "avatar": row.get("avatar") or common.avatar_for(field_seat),
                "colour": row.get("colour") or common.colour_for(field_seat),
                "kind": row.get("kind") or "local",
                "you": field_seat == seat,
                "role": "",
                "out": False,
                "note": "",
                "score": standings.get(field_seat, 0),
                "playing": False,
                "in_match": False,
            })
        places.sort(key=lambda place: place["seat"])
        active = state.get("status") == "active" and not self.game.done(env)
        # Watch it think: a person may read their own bot's working, and only that.
        # A watcher, a stranger, and an opponent's screen all get an empty list.
        mine_think = []
        if seat is not None:
            for key, records in sorted((state.get("think") or {}).items()):
                try:
                    field_seat = int(key)
                except (TypeError, ValueError):
                    continue
                if not isinstance(records, list) or not records:
                    continue
                who = rows.get(field_seat) or {}
                if who.get("kind") not in {"agent", "champion"}:
                    continue
                latest = records[-1]
                mine_think.append({
                    "seat": field_seat,
                    "name": who.get("name") or common.seat_name(field_seat),
                    "avatar": who.get("avatar") or common.avatar_for(field_seat),
                    "read": [dict(item) for item in latest.get("read") or []],
                    "scratch": str(latest.get("scratch") or ""),
                    "action": str(latest.get("action") or ""),
                    "coach": str(latest.get("coach") or ""),
                    "at": int(latest.get("at") or 0),
                    "fallback": bool(latest.get("fallback")),
                })
        stored_coach = state.get("coach")
        coach_state = stored_coach if isinstance(stored_coach, dict) else {}
        coach_window = coach_state.get("window")
        if not isinstance(coach_window, dict):
            coach_window = {}
        beat_now = self._beat(env)
        now = int(time.time())
        same_round = str(coach_window.get("key") or "") == beat_now
        until = int(coach_window.get("until") or 0) if same_round else 0
        used_round = bool(same_round and any(
            item.get("round") == beat_now for item in coach_state.get("whispers") or []))
        coach_seat = self._coach_seat(state)
        coach_place = rows.get(coach_seat) if coach_seat is not None else None
        coach_view = {
            "open": bool(active and same_round and until > now and not used_round),
            "until": until,
            "seconds_left": max(0, until - now) if same_round else 0,
            # The pending sentence is the owner's alone: the window is visible
            # to the table, but what was whispered into it is not.
            "text": str(coach_state.get("text") or "") if (same_round and seat is not None) else "",
            "used_round": used_round,
            "round": beat_now,
            "seat": coach_seat,
            "name": (coach_place or {}).get("name", ""),
            "available": bool(active and seat is not None and coach_seat is not None),
        }
        log_rows = self._log(state, trace, human_env, index)
        if seat is not None:
            # The whisper is between the owner and their own bot: only this
            # viewer's log carries it, and it is never put in the trace.
            for whisper in coach_state.get("whispers") or []:
                log_rows.append({
                    "seat": whisper.get("seat"),
                    "name": "Coach",
                    "text": f'whispered: "{whisper.get("text") or ""}"',
                    "kind": "coach",
                })
        allowed = []
        can_say = False
        watching = not any(row.get("kind") == "human" for row in state["seats"])
        meta = self._meta(state)
        if active and human_env is not None and self.game.current(env) == human_env:
            allowed = call_actions(self.game, env, human_env, self._draft(state, seat), meta)
            can_say = self.game.can_say(env, human_env)
        returns = {
            # Whatever the game draws in the middle of its table (Liar's Dice's bid,
            # the auction's lots on the block) travels with the picture; the screen
            # reads these straight off it.
            **{key: value for key, value in (table or {}).items() if key != "places"},
            "schema_version": 2,
            "view": self.id,
            "game": self.id,
            "title": self.game.TITLE,
            "table_id": state.get("table_id"),
            "owner_id": state.get("owner_id"),
            "viewer_id": viewer,
            "status": "active" if active else "done",
            # Guided-game margin notes (the Learn button): the rules' words about the
            # machine's last move, a tip on a risky human move, and the Undo door.
            "learn": bool(state.get("learn")),
            "coach_note": str(state.get("coach_note") or ""),
            "coach_tip": str(state.get("coach_tip") or ""),
            "preview": False,
            "phase": phase["label"],
            "phase_kind": phase["kind"],
            "match": {"index": index + 1, "count": len(state["sessions"]),
                      "seats": session["seats"]},
            "turn_seat": None if hidden_turn else turn_field,
            "turn_name": "" if hidden_turn else (turn_row or {}).get("name", ""),
            "your_seat": seat,
            "watching": watching,
            "your_turn": bool(active and seat is not None and turn_field == seat),
            "places": places,
            "log": log_rows,
            "notes": list(state.get("notes") or [])[-6:],
            "think": mine_think,
            "coach": coach_view,
            "mine": mine,
            "draft": self._draft(state, seat) if seat is not None else [],
            "can_say": can_say,
            "level": state.get("level") or "",
            "max_invites": int(getattr(self.game, "MAX_GUESTS", int(state.get("seat_count") or 4) - 1)
                               or (int(state.get("seat_count") or 4) - 1)),
            "can_move": bool(active and seat is not None and turn_field == seat),
            "can_step": bool(active and turn_field is not None and (turn_row or {}).get("kind") in {"local", "agent", "champion"}),
            "actions": [{"id": item.get("id"), "label": item.get("label"), "hint": item.get("hint", ""),
                         "on": bool(item.get("on")), "group": item.get("group", ""),
                         "disabled": bool(item.get("disabled"))} for item in allowed],
            "calls": {key: int((state.get("calls") or {}).get(key, 0))
                      for key in ("used", "cap", "illegal", "fallbacks", "tokens", "ms")},
            "estimate": int(state.get("estimate") or 0),
            "reveal": (state.get("result") or {}).get("reveal") if state.get("status") == "done" else None,
            "standings": [{"seat": seat_no, "name": rows.get(seat_no, {}).get("name", ""),
                           "score": value}
                          for seat_no, value in sorted(self._standings(state, env=env, index=index).items())],
            "share": self.share(state) if state.get("status") == "done" else None,
            "permissions": {
                "can_manage": self._may_manage(state, SimpleNamespace(id=viewer)),
                "can_rematch": self._may_manage(state, SimpleNamespace(id=viewer)),
                "can_step": bool(active and turn_field is not None
                                 and (turn_row or {}).get("kind") in {"local", "agent", "champion"}),
                "can_move": bool(active and seat is not None and turn_field == seat),
            },
            "setup": {"seats": state.get("seat_count"), "agent": bool(state.get("agent")),
                      "level": state.get("level") or "",
                      "champions": [row.get("id") for row in state.get("champion_rows") or []],
                      # The seed rebuilds every hidden deal. It is handed out only once
                      # the game is over; a live table never sends it to the screen.
                      **({"seed": state.get("seed")} if state.get("status") == "done" else {})},
        }
        if not self._has_model():
            returns["no_model"] = True
        return returns

    def _has_model(self) -> bool:
        return self.complete is not None

    def _viewer(self) -> str:
        return str(getattr(getattr(self, "player", None), "id", "") or "")

    def _viewer_platform(self) -> str:
        return str(getattr(getattr(self, "player", None), "platform", "") or "")

    def _preview(self) -> dict:
        """The setup screen: what a new table would look like."""
        count = self.game.DEFAULT_SEATS
        seats = [{
            "seat": 0, "name": "You", "avatar": common.avatar_for(0),
            "colour": common.colour_for(0), "kind": "human", "you": True, "out": False,
            "note": "", "role": "", "score": 0, "playing": False,
        }]
        for index in range(1, count):
            seats.append({
                "seat": index, "name": common.seat_name(index), "avatar": common.avatar_for(index),
                "colour": common.colour_for(index), "kind": "local", "you": False, "out": False,
                "note": "", "role": "", "score": 0, "playing": False,
            })
        return {
            "schema_version": 2,
            "view": self.id,
            "game": self.id,
            "title": self.game.TITLE,
            "status": "idle",
            "preview": True,
            "phase": "Not started",
            "phase_kind": "setup",
            "places": seats,
            "seats": seats,
            "log": [],
            "actions": [],
            "can_say": False,
            "can_move": False,
            "can_step": False,
            "your_seat": None,
            "watching": False,
            "your_turn": False,
            "turn_seat": None,
            "turn_name": "",
            "mine": {},
            "draft": [],
            "notes": [],
            "calls": {"used": 0, "cap": 0, "illegal": 0, "fallbacks": 0, "tokens": 0, "ms": 0},
            "estimate": int(self.game.estimate(count, 0)),
            "reveal": None,
            "standings": [],
            "share": None,
            "blurb": self.game.BLURB,
            "limits": {"min": self.game.MIN_SEATS, "max": self.game.MAX_SEATS, "default": count},
            "max_invites": int(getattr(self.game, "MAX_GUESTS", count - 1) or (count - 1)),
            "levels": [{"id": name, "label": getattr(self.game, "LEVEL_WORDS", {}).get(name, name.title())}
                       for name in getattr(self.game, "LEVELS", ()) or ()],
            "baseline": count,
            "champions": self._champion_list(),
            "permissions": {"can_manage": True, "can_rematch": False, "can_step": False, "can_move": False},
        }

    def _champion_list(self) -> list[dict]:
        try:
            store = kit._shelf("champions").ChampionStore(self.data_root)
        except Exception:
            return []
        found = []
        try:
            for champion_id in store.ids():
                champion = store.get(champion_id)
                if isinstance(champion, dict):
                    found.append({"id": champion.get("id"), "name": champion.get("name"),
                                  "glyph": champion.get("avatar"), "colour": champion.get("color")})
        except Exception:
            return found
        return found[:8]


def create(root: Path, game_id: str, settings: dict | None = None) -> Table:
    return Table(Path(root), game_id, settings)
