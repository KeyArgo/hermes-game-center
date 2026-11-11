"""Deterministic, data-driven Doctrine battle simulation."""
from __future__ import annotations

from collections import deque
from copy import deepcopy
import random

from . import card as card_module

BOARD = 11
MAX_TURNS = 96
SPEED = 2
HP = 3
BEACONS = ("f6", "d8", "h4")
_NEAR = ((-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0))
_SPAWNS = (((1, 1), (1, 2), (2, 1)), ((9, 9), (9, 8), (8, 9)),
           ((1, 9), (1, 8), (2, 9)), ((9, 1), (9, 2), (8, 1)))


def cell_name(pos) -> str:
    """The board name for a (row, column) position."""
    return _name(tuple(pos))


def cell_pos(name: str):
    """The (row, column) position for a board name, or None."""
    return _cell(name)



def _name(pos):
    return f"{chr(97 + pos[1])}{pos[0] + 1}"


def _cell(name):
    if not isinstance(name, str) or len(name) < 2 or name[0] not in "abcdefghijk" or not name[1:].isascii() or not name[1:].isdigit():
        return None
    try:
        row = int(name[1:]) - 1
    except ValueError:
        return None
    if not 0 <= row < BOARD or name != f"{name[0]}{row + 1}":
        return None
    return row, ord(name[0]) - 97


def _neighbors(pos):
    for dr, dc in _NEAR:
        r, c = pos[0] + dr, pos[1] + dc
        if 0 <= r < BOARD and 0 <= c < BOARD:
            yield r, c


def _distance(a, b):
    dr, dc = a[0] - b[0], a[1] - b[1]
    return max(abs(dr), abs(dc), abs(dr + dc))


def _occupied(state, exclude=None):
    return {tuple(u["pos"]) for units in state["units"].values() for u in units if u["hp"] > 0 and u["id"] != exclude}


def _paths(state, unit):
    start = tuple(unit["pos"])
    occupied = _occupied(state, unit["id"])
    paths = {start: [start]}
    queue = deque([start])
    while queue:
        pos = queue.popleft()
        if len(paths[pos]) - 1 >= SPEED:
            continue
        for dest in _neighbors(pos):
            if dest not in occupied and dest not in paths:
                paths[dest] = paths[pos] + [dest]
                queue.append(dest)
    return paths


def _enemies(state, pid):
    return [u for other, units in state["units"].items() if other != pid for u in units if u["hp"] > 0]


def _adjacent(enemies, pos):
    return [u for u in enemies if _distance(pos, tuple(u["pos"])) == 1]


def _policy(state, pid, unit):
    enemies = _enemies(state, pid)
    allies = [u for u in state["units"][pid] if u["hp"] > 0 and u["id"] != unit["id"]]
    occupied = _occupied(state, unit["id"])
    weights = state["cards"][int(pid[1:]) - 1]["weights"]
    candidates = []
    for pos, path in _paths(state, unit).items():
        adjacent = _adjacent(enemies, pos)
        lowest = min((u["hp"] for u in adjacent), default=None)
        for target in [None] + adjacent:
            nearest_enemy = min((_distance(pos, tuple(u["pos"])) for u in enemies), default=10)
            nearest_ally = min((_distance(pos, tuple(u["pos"])) for u in allies), default=10)
            nearest_beacon = min(_distance(pos, _cell(b)) for b in BEACONS)
            # Centre uses Chebyshev distance to (5.5, 5.5). Endurance rewards
            # safety scaled by missing health; healthier units retain some value.
            features = {
                "aggression": 1 if target else max(0, 1 - nearest_enemy / 10),
                "safety": max(0, 1 - len(adjacent) / 3),
                "objective": max(0, 1 - nearest_beacon / 10),
                "focus": int(target is not None and target["hp"] == lowest),
                "cohesion": max(0, 1 - nearest_ally / 10),
                "center": max(0, 1 - max(abs(pos[0] - 5.5), abs(pos[1] - 5.5)) / 10),
                "mobility": sum(p not in occupied for p in _neighbors(pos)) / 6,
                "endurance": (1 - unit["hp"] / (2 * HP)) if not adjacent and target is None else 0,
            }
            score = sum(weights[k] * features[k] for k in card_module.WEIGHTS)
            candidates.append((score, pos, target["id"] if target else "", path, target))
    best = max(item[0] for item in candidates)
    tied = sorted((item for item in candidates if item[0] == best), key=lambda item: (item[1], item[2]))
    chosen = tied[random.Random(f"{state['seed']}:{state['turn']}:{unit['id']}").randrange(len(tied))]
    return chosen[3], chosen[4]


def new_match(cards: list[dict], seed: int, max_turns: int = MAX_TURNS, human: str = "") -> dict:
    """Create a new match with fixed seat positions."""
    if not isinstance(cards, list) or not 1 <= len(cards) <= 4:
        raise ValueError("Choose one to four cards.")
    checked = []
    for raw in cards:
        valid, problems = card_module.validate(raw)
        if problems:
            raise ValueError("Invalid card: " + "; ".join(problems))
        checked.append(valid)
    if type(max_turns) is not int or max_turns < 1:
        raise ValueError("Turn limit must be a positive whole number.")
    units = {f"p{i+1}": [{"id": f"p{i+1}u{j+1}", "hp": HP, "pos": pos} for j, pos in enumerate(_SPAWNS[i])] for i in range(len(cards))}
    return {"seed": seed, "turn": 1, "actor": 0, "max_turns": max_turns, "cards": checked,
            "beacons": list(BEACONS), "units": units, "scores": {pid: 0 for pid in units},
            "events": [], "frames": [], "status": "active", "winner": "", "human": human}


def _act(state, pid, unit, path, target, events):
    origin = tuple(unit["pos"])
    unit["pos"] = path[-1]
    killed = False
    name = state["cards"][int(pid[1:])-1]["name"]
    if target:
        target["hp"] -= 1
        events.append(f"Turn {state['turn']}: {name}'s {unit['id']} hit {target['id']} for 1.")
        if target["hp"] <= 0:
            victim = target["id"][:2]
            victim_name = state["cards"][int(victim[1:])-1]["name"]
            state["units"][victim].remove(target)
            state["scores"][pid] += 3
            killed = True
            events.append(f"Turn {state['turn']}: {name}'s {unit['id']} eliminated {victim_name}'s {target['id']}.")
            if not state["units"][victim]:
                events.append(f"Turn {state['turn']}: {victim_name} is out of units.")
    return {"unit": unit["id"], "from": _name(origin), "to": _name(path[-1]),
            "path": [_name(p) for p in path], "attack": target["id"] if target else "",
            "damage": int(target is not None), "killed": killed}


def _control(state, beacon):
    pos = _cell(beacon)
    counts = {pid: sum(u["hp"] > 0 and _distance(pos, tuple(u["pos"])) <= 1 for u in units) for pid, units in state["units"].items()}
    highest = max(counts.values(), default=0)
    leaders = [pid for pid, count in counts.items() if count == highest]
    return leaders[0] if highest and len(leaders) == 1 else ""


def _finish_if_last(state):
    living = [pid for pid, units in state["units"].items() if any(u["hp"] > 0 for u in units)]
    if len(state["units"]) > 1 and len(living) == 1:
        state["status"], state["winner"] = "won", living[0]
        return True
    return False


def _after_turn(state, pid, actions, events):
    name = state["cards"][int(pid[1:])-1]["name"]
    for beacon in BEACONS:
        if _control(state, beacon) == pid:
            state["scores"][pid] += 1
            events.append(f"Turn {state['turn']}: {name} controls beacon {beacon}.")
    state["turn"] += 1
    if not _finish_if_last(state) and state["turn"] > state["max_turns"]:
        highest = max(state["scores"].values())
        leaders = [p for p, score in state["scores"].items() if score == highest]
        state["status"] = "won" if len(leaders) == 1 else "draw"
        state["winner"] = leaders[0] if len(leaders) == 1 else ""
    if state["status"] == "active":
        for offset in range(1, len(state["units"]) + 1):
            actor = (state["actor"] + offset) % len(state["units"])
            if any(u["hp"] > 0 for u in state["units"][f"p{actor+1}"]):
                state["actor"] = actor
                break
    state["events"].extend(events)
    grid = [["." for _ in range(BOARD)] for _ in range(BOARD)]
    for owner, units in state["units"].items():
        for u in units:
            if u["hp"] > 0:
                r, c = u["pos"]
                grid[r][c] = owner[1:]
    control = {other: sum(_control(state, b) == other for b in BEACONS) for other in state["units"]}
    state["frames"].append({"turn": state["turn"] - 1, "actor": pid, "name": state["cards"][int(pid[1:])-1]["name"],
                            "actions": actions, "scores": deepcopy(state["scores"]), "beacons": control,
                            "units": _display_units(state),
                            "events": events[:], "board": grid})


def _display_units(state):
    return {pid: [{"id": u["id"], "hp": u["hp"], "pos": _name(u["pos"])} for u in units if u["hp"] > 0] for pid, units in state["units"].items()}


def step_turn(state: dict) -> dict:
    """Play a complete automated turn and return the same state."""
    if state["status"] != "active":
        raise ValueError("The match has already finished.")
    pid = f"p{state['actor']+1}"
    if not any(u["hp"] > 0 for u in state["units"][pid]):
        for offset in range(1, len(state["units"]) + 1):
            actor = (state["actor"] + offset) % len(state["units"])
            if any(u["hp"] > 0 for u in state["units"][f"p{actor+1}"]):
                state["actor"] = actor
                pid = f"p{actor+1}"
                break
    actions, events = [], []
    if not _finish_if_last(state):
        for unit in sorted(state["units"][pid], key=lambda u: u["id"]):
            if unit["hp"] > 0:
                path, target = _policy(state, pid, unit)
                actions.append(_act(state, pid, unit, path, target, events))
                if _finish_if_last(state):
                    break
    _after_turn(state, pid, actions, events)
    return state


def run(state: dict) -> dict:
    """Play automated turns until the match ends."""
    while state["status"] == "active":
        step_turn(state)
    return state


def replay(cards, seed, max_turns=MAX_TURNS) -> dict:
    """Create and play a deterministic match."""
    return run(new_match(cards, seed, max_turns))


def human_options(state: dict) -> dict:
    """List reachable destinations for the active human's living units."""
    pid = f"p{state['actor']+1}"
    if state["status"] != "active" or state["human"] != pid:
        return {}
    return {u["id"]: {"cells": [_name(pos) for pos in sorted(_paths(state, u))], "can_hold": True}
            for u in sorted(state["units"][pid], key=lambda u: u["id"]) if u["hp"] > 0}


def human_turn(state: dict, moves: dict[str, str]) -> dict:
    """Apply a complete human turn, then play until the human acts again."""
    pid = f"p{state['actor']+1}"
    if state["status"] != "active" or state["human"] != pid:
        raise ValueError("It is not the human player's turn.")
    if not isinstance(moves, dict):
        raise ValueError("Moves must name each living unit.")
    units = {u["id"]: u for u in state["units"][pid] if u["hp"] > 0}
    if set(moves) != set(units):
        raise ValueError("Moves must include exactly the living units; check missing or unknown units.")
    # Validate against the evolving board in a copy, so invalid input is atomic.
    trial = deepcopy(state)
    actions, events = [], []
    finished = _finish_if_last(trial)
    for uid in sorted(units):
        unit = next(u for u in trial["units"][pid] if u["id"] == uid)
        dest = tuple(unit["pos"]) if moves[uid] == "hold" else _cell(moves[uid])
        paths = _paths(trial, unit)
        if dest not in paths:
            raise ValueError(f"Illegal destination for {uid}.")
        if not finished:
            adjacent = _adjacent(_enemies(trial, pid), dest)
            target = min(adjacent, key=lambda u: (u["hp"], u["id"]), default=None)
            actions.append(_act(trial, pid, unit, paths[dest], target, events))
            finished = _finish_if_last(trial)
    _after_turn(trial, pid, actions, events)
    state.clear()
    state.update(trial)
    while state["status"] == "active" and f"p{state['actor']+1}" != state["human"]:
        step_turn(state)
    return state


def snapshot(state: dict) -> dict:
    """Return an independent snapshot of the current match."""
    return deepcopy({key: state[key] for key in ("turn", "actor", "status", "winner", "units", "scores", "beacons")})


def frame(state: dict) -> dict:
    """Return the latest frame or a snapshot before any turns."""
    return deepcopy(state["frames"][-1]) if state["frames"] else snapshot(state)


def scoreboard(state: dict) -> list[dict]:
    """Return one score and living-unit summary per bot."""
    result = []
    for index, (pid, units) in enumerate(state["units"].items()):
        living = [u for u in units if u["hp"] > 0]
        result.append({"id": pid, "name": state["cards"][index].get("name") or f"Bot {index+1}",
                       "units": len(living), "hp": sum(u["hp"] for u in living), "score": state["scores"][pid],
                       "beacons": sum(_control(state, b) == pid for b in BEACONS)})
    return result


def summary(replay: dict) -> list[str]:
    """Summarize key battle events and the final result."""
    moments, seen = [], set()
    for turn_frame in replay["frames"]:
        for event in turn_frame["events"]:
            if " eliminated " in event or " is out of units" in event:
                moments.append(event)
            elif " controls beacon " in event:
                beacon = event.rsplit(" ", 1)[-1]
                if beacon not in seen:
                    seen.add(beacon)
                    moments.append(event)
    scores = "-".join(str(value) for value in replay["scores"].values())
    turns = len(replay["frames"])
    if replay["winner"]:
        name = replay["cards"][int(replay["winner"][1:])-1]["name"]
        final = f"{name} wins {scores} after {turns} turns."
    elif replay["status"] == "draw":
        final = f"The match is a draw {scores} after {turns} turns."
    else:
        final = f"The match is active at {scores} after {turns} turns."
    return moments[:18] + [final]
