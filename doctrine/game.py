"""Doctrine: write a bot as a small card, then fight on the hex board.

A battle never calls a model: the engine is seeded and pure. A model is only
asked when a person presses Improve, or names a profile to author a card.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import kit  # noqa: E402
from talktable import common as talking  # noqa: E402

ID = "doctrine"
TITLE = "Doctrine"
EXAMPLE = "play"
HELP = [
    "Write a bot as a card of eight weighted priorities, then send it into a turn-based fight.",
    "You play white by clicking a highlighted hex to move the next unit. Every battle is seeded and replayable.",
]
_PKG = "hermes_gameshelf_doctrine"
_SEEDS = (1, 2, 3, 4, 5)
_REPLAY_LIMIT = 262144
_FRAMES_SHOWN = 240


def _module(name: str):
    """Load doctrine/<name>.py as part of this folder's own package."""
    if _PKG not in sys.modules:
        folder = Path(__file__).resolve().parent
        spec = importlib.util.spec_from_file_location(
            _PKG, folder / "__init__.py", submodule_search_locations=[str(folder)]
        )
        if spec is None or spec.loader is None:
            raise ImportError("Doctrine's package could not be loaded.")
        package = importlib.util.module_from_spec(spec)
        sys.modules[_PKG] = package
        spec.loader.exec_module(package)
    return importlib.import_module(f"{_PKG}.{name}")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(text: object, limit: int = 400) -> str:
    return " ".join(str(text or "").split())[:limit]


def _extract_json(text: str) -> str:
    """The first balanced JSON object in a model's reply, or ''."""
    found = str(text or "")
    start = found.find("{")
    if start < 0:
        return ""
    depth, in_string, escaped = 0, False, False
    for index in range(start, len(found)):
        char = found[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return found[start:index + 1]
    return ""


class Doctrine:
    """The Doctrine card: command line, saved match, and board picture."""

    def __init__(self, root: Path, settings: dict | None = None) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.settings = dict(settings or {})
        self.complete = None
        self.card_mod = _module("card")
        self.engine = _module("engine")
        self.profiles = _module("profiles")
        self.house = self.card_mod.house_cards()
        stems = sorted(path.stem for path in (Path(__file__).parent / "cards").glob("*.json"))
        self.house_ids = stems
        if len(stems) != len(self.house):
            raise ValueError("Doctrine house cards and their filenames do not match.")

    # -- saved state -----------------------------------------------------

    @property
    def path(self) -> Path:
        return self.root / "state.json"

    def _read(self) -> dict:
        loaded: dict = {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                loaded = data
        except (OSError, ValueError):
            loaded = {}
        loaded.setdefault("your_card", self.house[1])
        loaded.setdefault("match", None)
        loaded.setdefault("lineage", [])
        loaded.setdefault("imports", [])
        loaded.setdefault("ladder", [])
        loaded.setdefault("pending", {})
        loaded.setdefault("notice", "")
        return loaded

    def _save(self, state: dict) -> None:
        with kit.locked(self.root):
            kit.write(self.root, state)

    def _house_id(self, name: str) -> str:
        text = str(name or "").strip().lower()
        for index, card in enumerate(self.house):
            if text in {self.house_ids[index], card["name"].lower(), card["name"].lower().replace(" ", "-")}:
                return self.house_ids[index]
        return ""

    def _house_card(self, name: str) -> dict | None:
        ident = self._house_id(name)
        if ident:
            return self.house[self.house_ids.index(ident)]
        return None

    def _lineage_card(self, ident: str) -> dict | None:
        for entry in self._read()["lineage"]:
            if entry.get("id") == ident:
                return entry.get("card")
        return None

    def _import_card(self, state: dict, ident: str) -> dict | None:
        """An imported card, by its entry id or, failing that, by its name."""
        text = str(ident or "").strip().lower()
        by_name, by_ident = None, None
        for entry in state.get("imports") or []:
            card = entry.get("card") if isinstance(entry, dict) and isinstance(entry.get("card"), dict) else entry
            if not isinstance(card, dict):
                continue
            entry_id = str(entry.get("id") or "") if isinstance(entry, dict) else ""
            if entry_id and entry_id.lower() == text:
                by_ident = card
            if str(card.get("name") or "").lower() == text and by_name is None:
                by_name = card
        return by_ident or by_name

    # -- command line ----------------------------------------------------

    def command(self, raw: str, *, source: str = "command", complete=None, player=None) -> str:
        del player
        self.complete = complete if callable(complete) else None
        parts = kit.words(raw) or []
        if not parts or parts[0].lower() == "help":
            return self.help()
        head, rest = parts[0].lower(), parts[1:]
        if head in {"improve", "author"} and source != "command":
            return "A person asks for that. Type it in Game Center."
        state = self._read()
        if head == "cards":
            return self._cards_text(state)
        if head == "card":
            return self.card_mod.to_json(state["your_card"]).strip()
        if head in {"pick", "choose"}:
            return self._pick(state, " ".join(rest))
        if head in {"start", "play"}:
            return self._start(state, rest)
        if head == "watch":
            return self._watch(state, rest)
        if head == "ladder":
            return self._ladder(state)
        if head == "improve":
            return self._improve(state)
        if head == "author":
            return self._author(state, rest)
        if head == "move":
            return self._move(state, rest)
        if head == "hold":
            return self._end_turn(state)
        if head == "end":
            return self._end_turn(state)
        if head in {"state", "board", "replay"}:
            return self._state_text(state)
        if head == "export":
            return self._export(state, rest)
        if head == "import":
            cut = raw.strip()
            body = cut.split(None, 1)[1].strip() if " " in cut else ""
            return self._import(state, body)
        if head == "tree":
            return self._tree(state)
        if head == "reset":
            state["match"] = None
            state["pending"] = {}
            state["notice"] = "Board cleared."
            self._save(state)
            return "Board cleared. doctrine play starts a new 1v1."
        if head == "profile":
            return self.profiles.problem(" ".join(rest)) or "That profile can author a card: doctrine author <profile>"
        return self.help()

    def help(self) -> str:
        return "\n".join([
            TITLE,
            *HELP,
            "",
            "Usage:",
            "/games doctrine play [opponent] [seed=1]   you against a house card, by clicking",
            "/games doctrine watch [2|3|4]              watch a seeded free-for-all",
            "/games doctrine move <hex>                 move the next unit this turn",
            "/games doctrine end                        hold the rest and finish your turn",
            "/games doctrine cards                      house cards and your saved cards",
            "/games doctrine pick <card>                choose the card you play",
            "/games doctrine card                       show your card as JSON",
            "/games doctrine import <json>              import a small card; the Share panel imports any card or replay",
            "/games doctrine export [replay]            export your card or the last replay",
            "/games doctrine ladder                     your card against all four house cards",
            "/games doctrine improve                    ask your model for a better card",
            "/games doctrine author <profile>           ask a named profile to write a card",
            "/games doctrine tree                       your card's family tree",
            "/games doctrine reset                      clear the board",
        ])

    def _cards_text(self, state: dict) -> str:
        lines = ["House cards:"]
        for index, card in enumerate(self.house):
            lines.append(f"  {self.house_ids[index]}: {card['name']} — {card['personality']}")
        lines.append(f"Your card: {state['your_card']['name']}")
        family = state["lineage"]
        if family:
            lines.append("Your saved cards:")
            for entry in family[-8:]:
                record = entry.get("record") or {}
                lines.append(
                    f"  {entry['id']}: {entry['name']} (generation {entry.get('generation', 1)}; "
                    f"{record.get('wins', 0)}-{record.get('losses', 0)}-{record.get('draws', 0)} against its parent)"
                )
        return "\n".join(lines)

    def _pick(self, state: dict, name: str) -> str:
        found = self._house_card(name) or self._lineage_card(name.strip()) or self._import_card(state, name)
        if not found:
            return f"No card named {name!r}. doctrine cards lists them."
        state["your_card"] = found
        state["ladder"] = []
        state["notice"] = f"Your card is now {found['name']}."
        self._save(state)
        return state["notice"]

    def _seed(self, rest: list[str], default: int = 1) -> tuple[int, list[str]]:
        kept = []
        seed = default
        for token in rest:
            if token.lower().startswith("seed="):
                try:
                    seed = int(token.split("=", 1)[1])
                except ValueError:
                    seed = default
                if not 0 <= seed <= 10 ** 9:
                    seed = default
            else:
                kept.append(token)
        return seed, kept

    def _start(self, state: dict, rest: list[str]) -> str:
        if state.get("match") and (state["match"].get("state") or {}).get("status") == "active":
            return "A match is in progress. doctrine reset clears it."
        seed, rest = self._seed(rest)
        opponent = self._house_card(" ".join(rest)) if rest else self._house_card("Stone Bastion")
        if opponent is None:
            return f"No house card named {' '.join(rest)!r}. doctrine cards lists them."
        match = {
            "mode": "human",
            "seed": seed,
            "started": _now(),
            "opponent": opponent["name"],
            "state": self.engine.new_match([state["your_card"], opponent], seed, self.engine.MAX_TURNS, human="p1"),
        }
        state["match"] = match
        state["pending"] = {}
        state["notice"] = f"{state['your_card']['name']} against {opponent['name']}, seed {seed}. Click a highlighted hex."
        self._save(state)
        return state["notice"]

    def _watch(self, state: dict, rest: list[str]) -> str:
        live = state.get("match")
        if live and live.get("mode") == "human" and (live.get("state") or {}).get("status") == "active":
            return "Your battle is still running. Finish it, or doctrine reset clears it first."
        count = 2
        rest = list(rest)
        if rest and rest[0].isdigit():
            count = max(2, min(4, int(rest[0])))
            rest = rest[1:]
        seed, _ = self._seed(rest)
        cards = self.house[:count]
        played = self.engine.run(self.engine.new_match(cards, seed))
        state["match"] = {"mode": "watch", "seed": seed, "started": _now(),
                          "opponent": ", ".join(card["name"] for card in cards), "state": played}
        state["pending"] = {}
        state["notice"] = f"Seeded match, seed {seed}. Step or auto-play the replay."
        self._save(state)
        return "\n".join([state["notice"], *self.engine.summary(played)])

    def _ladder(self, state: dict) -> str:
        rows = []
        your = state["your_card"]
        for index, card in enumerate(self.house):
            wins = losses = draws = 0
            for seed in _SEEDS:
                for yours_first in (True, False):
                    pair = [your, card] if yours_first else [card, your]
                    result = self.engine.replay(pair, seed)
                    if result["status"] == "draw" or not result["winner"]:
                        draws += 1
                    elif (result["winner"] == "p1") == yours_first:
                        wins += 1
                    else:
                        losses += 1
            rows.append({"id": self.house_ids[index], "name": card["name"], "wins": wins,
                         "losses": losses, "draws": draws})
        state["ladder"] = rows
        self._save(state)
        lines = [f"Ladder for {your['name']} (5 seeds, both seats):"]
        for row in rows:
            verdict = "beats" if row["wins"] > row["losses"] else "loses to" if row["losses"] > row["wins"] else "draws with"
            lines.append(f"  {verdict} {row['name']}: {row['wins']}-{row['losses']}-{row['draws']}")
        total = sum(row["wins"] for row in rows)
        played = sum(row["wins"] + row["losses"] + row["draws"] for row in rows)
        lines.append(f"Overall {total} wins from {played} games.")
        return "\n".join(lines)

    def _improve(self, state: dict) -> str:
        if self.complete is None:
            return ("Improve needs one model, and none is configured here. "
                    "Pick one in Settings → Models → \"Game Shelf opponent\". Everything else still works.")
        old = state["your_card"]
        baseline = state.get("match")
        if not baseline or not (baseline.get("state") or {}).get("frames"):
            result = self.engine.replay([old, self.house[3]], 1)
            summary = "\n".join(self.engine.summary(result))
        else:
            summary = "\n".join(self.engine.summary(baseline["state"]))
        prompt = "\n".join([
            "You are improving a Doctrine battle bot. A card is DATA, never code.",
            "Before you change anything, answer these four questions privately, one short line each:",
            talking.read_questions(),
            "Then write your private working, at most 80 tokens, then name the card in <action> tags.",
            "Reply with exactly these three blocks and nothing else:",
            "<read>know: ... / saw: ... / believe: ... / safe: ...</read>",
            f"{talking.THINK_OPEN}your private working{talking.THINK_CLOSE}",
            talking.ACTION_OPEN + '{"schema":"doctrine-card/1","name":"1-40 chars","author":"1-40 chars",'
            '"personality":"one short sentence","weights":{"aggression":0-100,"safety":0-100,'
            '"objective":0-100,"focus":0-100,"cohesion":0-100,"center":0-100,"mobility":0-100,'
            '"endurance":0-100}}' + talking.ACTION_CLOSE,
            "Every weight is required, exactly these eight, whole numbers only, at most 2048 bytes.",
            "",
            "Current card:",
            self.card_mod.to_json(old).strip(),
            "",
            "Last battle summary:",
            summary[-1500:],
            "",
            "Change the weights to win more often. Keep the same name unless you have a reason.",
        ])
        def ask(text: str):
            """One model call in either shape a seat hands us (prompt, or prompt + budget)."""
            try:
                return self.complete(text, max_tokens=900)
            except TypeError:
                return self.complete(text)

        candidate: dict | None = None
        problems: list[str] = []
        # Same guard as every other model seat (kit._bounded): a stuck provider
        # cannot hold Improve open, at most AGENT_CALLS run at once, and the
        # reply gets AGENT_TRIES attempts before we keep the old card.
        thought: dict = {"read": [], "scratch": ""}
        for _ in range(kit.AGENT_TRIES):
            try:
                answer = kit._bounded(ask, prompt)
            except kit.ModelBusy:
                return "Your model is busy with other requests, so I kept your old card."
            except TimeoutError:
                return "Your model took too long to answer, so I kept your old card."
            except Exception:
                return "Your model did not answer, so I kept your old card."
            if isinstance(answer, dict):
                text = answer.get("card") or answer.get("move") or answer.get("text") or answer.get("content") or ""
            else:
                text = answer
            text = text if isinstance(text, str) else str(text or "")
            if "```" in text:
                text = re.sub(r"```(?:json)?", "", text)
            # The reply may show its working around the card. Only the card is
            # validated; the working is kept for the owner's own panel.
            thought = talking.parse_thinking(text)
            body = thought["action"] or text.strip()
            candidate, problems = self.card_mod.validate(_extract_json(body) or body)
            if not problems:
                break
            prompt += f"\n\nYour last reply was not a valid card ({problems[0]}). Reply with only the JSON object."
        if candidate is None or problems:
            return "Your model's reply was not a valid card: " + "; ".join(problems[:3]) + " I kept your old card."
        # Watch it think, Doctrine flavour: the working that led to this card is
        # kept beside it, for the person whose card it is, and for nobody else.
        state["prep"] = {
            "read": thought.get("read") or [],
            "scratch": str(thought.get("scratch") or ""),
            "at": int(time.time()),
            "name": candidate["name"],
            "action": " · ".join(f"{key} {candidate['weights'][key]}" for key in candidate["weights"]),
        }
        wins = losses = draws = 0
        for seed in _SEEDS:
            for yours_first in (True, False):
                pair = [candidate, old] if yours_first else [old, candidate]
                result = self.engine.replay(pair, seed)
                if result["status"] == "draw" or not result["winner"]:
                    draws += 1
                elif (result["winner"] == "p1") == yours_first:
                    wins += 1
                else:
                    losses += 1
        record = {"wins": wins, "losses": losses, "draws": draws}
        if wins <= losses:
            self._save(state)
            return (f"The new card did not win more: {wins} wins, {losses} losses, {draws} draws "
                    f"in {wins + losses + draws} seeded games. I kept {old['name']}.")
        parents = [entry["id"] for entry in state["lineage"] if entry.get("card") == old]
        parent = parents[-1] if parents else ""
        generation = 1
        if parent:
            generation = next((entry.get("generation", 0) + 1 for entry in state["lineage"] if entry["id"] == parent), 1)
        entry = {"id": uuid.uuid4().hex[:10], "name": candidate["name"], "parent": parent,
                 "generation": generation, "card": candidate, "record": record,
                 "seeds": list(_SEEDS), "created": _now()}
        state["lineage"] = [*state["lineage"], entry][-40:]
        state["your_card"] = candidate
        state["ladder"] = []
        state["notice"] = f"Kept {candidate['name']}: {wins}-{losses}-{draws} against {old['name']}."
        self._save(state)
        return state["notice"]

    def _author(self, state: dict, rest: list[str]) -> str:
        profile = (rest[0] if rest else "").strip().lower()
        if not profile:
            return "Usage: doctrine author <profile>"
        why = self.profiles.problem(profile)
        if why:
            return why
        flavour = " ".join(rest[1:]) or state["your_card"].get("personality", "")
        reply, error = self.profiles.author(profile, self.profiles.prompt(flavour))
        if error:
            return error
        candidate, problems = self.card_mod.validate(_extract_json(reply) or reply.strip())
        if problems:
            return f"{profile}'s reply was not a valid card: " + "; ".join(problems[:3])
        candidate["author"] = profile
        entry = {"id": uuid.uuid4().hex[:10], "name": candidate["name"], "parent": "",
                 "generation": 1, "card": candidate, "record": {}, "seeds": [], "created": _now()}
        state["lineage"] = [*state["lineage"], entry][-40:]
        state["your_card"] = candidate
        state["ladder"] = []
        state["notice"] = f"{profile} wrote {candidate['name']}. It is your card now."
        self._save(state)
        return state["notice"]

    def _move(self, state: dict, rest: list[str]) -> str:
        match = state.get("match")
        if not match or match.get("mode") != "human":
            return "No battle of yours is running. doctrine play starts one."
        engine_state = match["state"]
        if engine_state.get("status") != "active":
            return "That battle is over. " + " ".join(self.engine.summary(engine_state)[-1:])
        cell = (rest[0] if rest else "").strip().lower()
        options = self.engine.human_options(engine_state)
        if not options:
            return "The built-in bot is taking its turn. doctrine state shows the board."
        pending = dict(state.get("pending") or {})
        options = {uid: value for uid, value in options.items() if uid not in pending}
        if not cell or self.engine.cell_pos(cell) is None:
            return "Pick a hex like f6."
        if cell in pending.values():
            return f"Another unit is already going to {cell}. Pick a different hex."
        chosen = next((uid for uid in sorted(options) if cell in options[uid]["cells"]), "")
        if not chosen:
            return f"{cell} is not reachable by a unit still to move this turn."
        pending[chosen] = cell
        if len(pending) < len(options) + len([uid for uid in (state.get("pending") or {})]):
            state["pending"] = pending
            self._save(state)
            return f"{chosen} to {cell}. Pick the next unit, or doctrine end."
        return self._resolve(state, match, pending)

    def _end_turn(self, state: dict) -> str:
        match = state.get("match")
        if not match or match.get("mode") != "human":
            return "No battle of yours is running. doctrine play starts one."
        engine_state = match["state"]
        if engine_state.get("status") != "active":
            return "That battle is over. doctrine watch starts a fresh one."
        options = self.engine.human_options(engine_state)
        if not options:
            return "The built-in bot is taking its turn."
        pending = dict(state.get("pending") or {})
        for uid in options:
            pending.setdefault(uid, "hold")
        return self._resolve(state, match, pending)

    def _resolve(self, state: dict, match: dict, moves: dict[str, str]) -> str:
        try:
            self.engine.human_turn(match["state"], moves)
        except ValueError as failure:
            state["pending"] = {}
            self._save(state)
            return f"That move was refused: {failure} Pick again, or use End turn."
        state["pending"] = {}
        self._save(state)
        lines = self.engine.summary(match["state"])
        return "\n".join(lines[-4:]) if match["state"].get("status") != "active" else "Turn played. Click your next unit's hex."

    def _state_text(self, state: dict) -> str:
        match = state.get("match")
        if not match:
            return "No battle yet. doctrine play starts a 1v1, doctrine watch a free-for-all."
        engine_state = match["state"]
        lines = [f"{match['mode'].title()} match, seed {match.get('seed', 1)}, turn {engine_state.get('turn', 0)}."]
        for row in self.engine.scoreboard(engine_state):
            lines.append(f"  {row['name']}: {row['units']} units, {row['hp']} hp, {row['beacons']} beacons, score {row['score']}")
        lines.extend(self.engine.summary(engine_state)[-3:])
        return "\n".join(lines)

    def _export(self, state: dict, rest: list[str]) -> str:
        if rest and rest[0].lower() in {"replay", "match", "battle"}:
            match = state.get("match")
            if not match:
                return "No replay yet. doctrine watch makes one."
            payload = self.card_mod.envelope("doctrine-replay", match["state"])
        else:
            payload = self.card_mod.envelope("doctrine-card", state["your_card"])
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)

    def _import(self, state: dict, text: str) -> str:
        text = text.strip()
        if not text:
            return "Paste a card or replay JSON: doctrine import {\"kind\":\"doctrine-card\",...}"
        try:
            payload = json.loads(text)
        except ValueError:
            return "That is not valid JSON. Nothing was imported."
        if not isinstance(payload, dict):
            return "A share file is a JSON object. Nothing was imported."
        kind = str(payload.get("kind") or "")
        data = payload.get("data") if kind else payload
        if kind in {"", "doctrine-card"}:
            candidate, problems = self.card_mod.validate(data if kind else payload)
            if problems:
                return "That card was not imported: " + "; ".join(problems[:4])
            state["your_card"] = candidate
            state["ladder"] = []
            name = candidate["name"].lower()
            kept = [entry for entry in state.get("imports") or []
                    if self._import_name(entry).lower() != name]
            state["imports"] = [*kept, {"id": f"import-{uuid.uuid4().hex[:8]}", "card": candidate}][-20:]
            state["notice"] = f"Imported {candidate['name']} as your card."
            self._save(state)
            return state["notice"]
        if kind == "doctrine-replay":
            problems = self._check_replay(data)
            if problems:
                return "That replay was not imported: " + "; ".join(problems[:4])
            state["match"] = {"mode": "shared", "seed": int(data.get("seed") or 0), "started": _now(),
                              "opponent": ", ".join(card["name"] for card in data["cards"]), "state": data}
            state["pending"] = {}
            state["notice"] = "Imported a replay. Step or auto-play it."
            self._save(state)
            return state["notice"]
        return f"Unknown share kind {kind!r}. Nothing was imported."

    def _check_replay(self, data: object) -> list[str]:
        """Problems with an imported replay, or [] when it is safe to show."""
        if not isinstance(data, dict):
            return ["a replay must be an object"]
        if len(json.dumps(data, allow_nan=False)) > _REPLAY_LIMIT:
            return ["a replay must be at most 256 KB"]
        cards = data.get("cards")
        if not isinstance(cards, list) or not 1 <= len(cards) <= 4:
            return ["a replay names one to four cards"]
        for card in cards:
            if self.card_mod.validate(card)[1]:
                return ["a replay contains an invalid card"]
        frames = data.get("frames")
        if not isinstance(frames, list) or not 1 <= len(frames) <= 400:
            return ["a replay needs 1 to 400 frames"]
        if data.get("status") not in {"active", "won", "draw"}:
            return ["a replay needs a known status"]
        for key in ("seed", "turn", "max_turns"):
            if type(data.get(key)) is not int:
                return [f"a replay needs a whole-number {key}"]
        scores = data.get("scores")
        if (not isinstance(scores, dict) or not scores
                or any(key not in {"p1", "p2", "p3", "p4"} or type(value) is not int or value < 0
                       for key, value in scores.items())):
            return ["a replay needs scores"]
        units = data.get("units")
        if not isinstance(units, dict) or not units or any(
                owner not in {"p1", "p2", "p3", "p4"} or not isinstance(rows, list) or len(rows) > 3
                for owner, rows in units.items()):
            return ["a replay needs unit positions"]
        for owner, rows in units.items():
            if int(owner[1:]) > len(cards):
                return ["a replay names a unit for a bot that has no card"]
            seen = set()
            for unit in rows:
                pos = unit.get("pos") if isinstance(unit, dict) else None
                pos_ok = (self.engine.cell_pos(pos) is not None if isinstance(pos, str)
                          else isinstance(pos, (list, tuple)) and len(pos) == 2
                          and all(type(value) is int and 0 <= value < self.engine.BOARD for value in pos))
                if (not isinstance(unit, dict) or not isinstance(unit.get("id"), str)
                        or not unit["id"].startswith(owner + "u") or unit["id"] in seen
                        or type(unit.get("hp")) is not int or not 1 <= unit["hp"] <= 3
                        or not pos_ok):
                    return ["a replay has a malformed unit"]
                seen.add(unit["id"])
        winner = data.get("winner")
        if not isinstance(winner, str) or (winner and (winner not in units or int(winner[1:]) > len(cards))):
            return ["a replay needs a known winner"]
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict):
                return [f"frame {index + 1} is not an object"]
            board = frame.get("board")
            if (not isinstance(board, list) or len(board) != 11
                    or any(not isinstance(row, list) or len(row) != 11 for row in board)):
                return [f"frame {index + 1} is not an 11 by 11 board"]
            if any(not isinstance(mark, str) or mark not in {".", "1", "2", "3", "4"} for row in board for mark in row):
                return [f"frame {index + 1} has an unknown board mark"]
            if not isinstance(frame.get("events"), list) or not all(isinstance(event, str) for event in frame["events"]):
                return [f"frame {index + 1} needs plain-sentence events"]
            if not isinstance(frame.get("actions"), list) or not all(isinstance(action, dict) for action in frame["actions"]):
                return [f"frame {index + 1} needs action objects"]
            units = frame.get("units")
            if not isinstance(units, dict):
                return [f"frame {index + 1} needs unit positions"]
            for owner, rows in units.items():
                if owner not in {"p1", "p2", "p3", "p4"} or not isinstance(rows, list) or len(rows) > 3:
                    return [f"frame {index + 1} has an unknown unit owner"]
                for unit in rows:
                    if (not isinstance(unit, dict) or not isinstance(unit.get("id"), str)
                            or type(unit.get("hp")) is not int or self.engine.cell_pos(unit.get("pos")) is None):
                        return [f"frame {index + 1} has a malformed unit"]
            scores = frame.get("scores")
            if not isinstance(scores, dict) or any(type(value) is not int or value < 0 for value in scores.values()):
                return [f"frame {index + 1} has malformed scores"]
            beacons = frame.get("beacons")
            if beacons is not None and (not isinstance(beacons, dict)
                                        or any(type(value) is not int or value < 0 for value in beacons.values())):
                return [f"frame {index + 1} has malformed beacon counts"]
        return []

    # -- picture ---------------------------------------------------------

    @staticmethod
    def _import_name(entry: object) -> str:
        """The card name inside an imports entry (or the card itself, for old saves)."""
        card = entry.get("card") if isinstance(entry, dict) and isinstance(entry.get("card"), dict) else entry
        return str((card or {}).get("name") or "") if isinstance(card, dict) else ""

    @staticmethod
    def _import_body(entry: object) -> dict:
        if isinstance(entry, dict) and isinstance(entry.get("card"), dict):
            return entry["card"]
        return entry if isinstance(entry, dict) else {}

    def _card_choices(self, state: dict) -> list[dict]:
        """Every card "Your card" can switch to, with the token ``pick`` accepts.

        House cards come first, then the person's own saved, improved and
        imported cards. A house card and a personal card may share a name, so
        the label says which is which, and ``current`` marks the one in play.
        """
        your = state.get("your_card") or {}
        rows: list[dict] = [
            {"id": self.house_ids[index], "name": str(card["name"]),
             "personality": str(card.get("personality") or ""), "origin": "house",
             "current": bool(your) and card == your}
            for index, card in enumerate(self.house)
        ]
        house_names = {row["name"].lower() for row in rows}
        own: list[dict] = []
        for entry in state.get("lineage") or []:
            card = entry.get("card") or {}
            name = str(card.get("name") or "")
            if name and entry.get("id"):
                own.append({"id": str(entry["id"]), "name": name,
                            "personality": str(card.get("personality") or ""), "origin": "yours",
                            "current": bool(your) and card == your})
        for entry in state.get("imports") or []:
            card = self._import_body(entry)
            name = str(card.get("name") or "")
            if name:
                ident = str(entry.get("id") or "") if isinstance(entry, dict) else ""
                own.append({"id": ident or name, "name": name,
                            "personality": str(card.get("personality") or ""), "origin": "yours",
                            "current": bool(your) and card == your})
        if your and str(your.get("name") or "") and not any(row["current"] for row in rows + own):
            # A card that is not in the tree and not an import yet (an older
            # save): pick accepts its name.
            own.append({"id": str(your["name"]), "name": str(your["name"]),
                        "personality": str(your.get("personality") or ""), "origin": "yours",
                        "current": True})
        own.sort(key=lambda row: not row["current"])
        seen: set[str] = set()
        for row in own:
            key = row["name"].lower()
            if key in seen:
                continue  # one entry per name; the card in play and the tree come first
            seen.add(key)
            if key in house_names:
                row["name"] = f"{row['name']} (yours)"
            rows.append(row)
        return rows

    def _board(self, engine_state: dict) -> list[list[str]]:
        """The 11 by 11 marks for the current units, for a match with no frames yet."""
        grid = [["." for _ in range(self.engine.BOARD)] for _ in range(self.engine.BOARD)]
        for owner, units in (engine_state.get("units") or {}).items():
            for unit in units:
                if int(unit.get("hp") or 0) > 0:
                    row, col = unit["pos"]
                    grid[row][col] = owner[1:]
        return grid

    def picture(self, complete=None) -> dict:
        ready = callable(complete) or callable(self.complete)
        state = self._read()
        match = state.get("match")
        your = state["your_card"]
        base = {
            "view": "hex", "game": ID, "files": "abcdefghijk",
            "ranks": list(range(1, self.engine.BOARD + 1)),
            "cells": [["." for _ in range(self.engine.BOARD)] for _ in range(self.engine.BOARD)],
            "legal": [], "last_to": None,
        }
        doctor: dict = {
            "mode": "idle", "status": "idle", "turn": 0, "max_turns": self.engine.MAX_TURNS,
            "frames": [], "frame_count": 0, "scoreboard": [], "can_move": False,
            "id": "",
            "legal_units": {}, "sentence": "", "events": [], "result": [],
            "your_card": your, "card_json": self.card_mod.to_json(your).strip(),
            "house": [{"id": self.house_ids[index], "name": card["name"], "personality": card["personality"]}
                      for index, card in enumerate(self.house)],
            # Everything "Your card" can switch to: the house cards, the cards
            # this person saved or improved, and any card they imported.
            "cards": self._card_choices(state),
            "improve_ready": ready,
            "improve_note": "" if ready
            else "Improve needs one model. Pick one in Settings → Models → \"Game Shelf Opponent\".",
            "tree": self._tree(state), "ladder": state.get("ladder") or [],
            # The working that led to the current card, for the person whose
            # card it is. Nobody else's screen ever carries it.
            "prep": state.get("prep") or None,
            "pending": state.get("pending") or {}, "notice": state.get("notice") or "",
            "seed": 0,
        }
        if match:
            engine_state = match["state"]
            frames = engine_state.get("frames") or []
            board = frames[-1]["board"] if frames else self._board(engine_state)
            base["cells"] = [list(row) for row in board]
            options = self.engine.human_options(engine_state) if match.get("mode") == "human" else {}
            pending = state.get("pending") or {}
            options = {uid: value for uid, value in options.items() if uid not in pending}
            legal = sorted({cell for value in options.values() for cell in value["cells"]})
            if match.get("mode") == "human" and engine_state.get("status") == "active":
                base["legal"] = legal
            if frames:
                last = frames[-1]["actions"][-1] if frames[-1]["actions"] else None
                if last and last.get("to"):
                    spot = self.engine.cell_pos(last["to"])
                    base["last_to"] = {"row": spot[0], "col": spot[1], "name": last["to"]} if spot else None
            doctor.update({
                "mode": match.get("mode", "idle"),
                "status": engine_state.get("status", "idle"),
                "id": str(match.get("started") or ""),
                "turn": int(engine_state.get("turn") or 0),
                "max_turns": int(engine_state.get("max_turns") or self.engine.MAX_TURNS),
                "frames": frames[:_FRAMES_SHOWN],
                "frame_count": len(frames),
                "scoreboard": [
                    {**row, "you": row["id"] == "p1" and match.get("mode") == "human"}
                    for row in self.engine.scoreboard(engine_state)
                ],
                "can_move": bool(options) and match.get("mode") == "human",
                "legal_units": options,
                "sentence": (frames[-1]["events"][-1] if frames and frames[-1]["events"] else ""),
                "events": [event for frame in frames[-6:] for event in frame["events"]][-6:],
                "result": self.engine.summary(engine_state)[-3:],
                "seed": int(match.get("seed") or 0),
            })
        base["doctrine"] = doctor
        base["turn"] = "white" if doctor["can_move"] else ""
        base["status"] = "active" if doctor["status"] == "active" else doctor["status"]
        return base

    def _tree(self, state: dict) -> str:
        entries = state.get("lineage") or []
        if not entries:
            return f"{state['your_card']['name']} is a house-style card with no family yet. Improve my bot starts one."
        known = {entry["id"]: entry for entry in entries}
        children: dict[str, list[dict]] = {}
        roots = []
        for entry in entries:
            parent = entry.get("parent") or ""
            if parent in known:
                children.setdefault(parent, []).append(entry)
            else:
                roots.append(entry)
        lines = []

        def walk(entry: dict, depth: int) -> None:
            record = entry.get("record") or {}
            tail = (f" — {record.get('wins', 0)}-{record.get('losses', 0)}-{record.get('draws', 0)} vs parent"
                    if record else "")
            lines.append(f"{'  ' * depth}└─ {entry['name']} (generation {entry.get('generation', 1)}){tail}")
            for child in sorted(children.get(entry["id"], []), key=lambda item: item.get("created", "")):
                walk(child, depth + 1)

        for root in sorted(roots, key=lambda item: item.get("created", "")):
            walk(root, 0)
        return "\n".join(lines[:24])

    def close(self) -> None:
        """Nothing to release; kept for a uniform game object."""


def create(root: Path, settings: dict | None = None) -> Doctrine:
    """The shelf's factory: one Doctrine card rooted in its own data folder."""
    return Doctrine(Path(root), settings)
