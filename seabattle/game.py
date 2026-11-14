"""Sea Battle: a deterministic, replayable hidden-fleet game."""
from __future__ import annotations

import importlib.util
import random
import sys
import zlib
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
# Load this plugin's own kit.py under a name no other plugin can claim. A plain
# `import kit` would hand us another plugin's module when both ship a kit.py.
_KIT_NAME = "hermes_gameshelf_kit"
if _KIT_NAME not in sys.modules:
    _kit_spec = importlib.util.spec_from_file_location(_KIT_NAME, _ROOT / "kit.py")
    _kit_module = importlib.util.module_from_spec(_kit_spec)
    sys.modules[_KIT_NAME] = _kit_module
    _kit_spec.loader.exec_module(_kit_module)
kit = sys.modules[_KIT_NAME]

ID, TITLE = "seabattle", "Sea Battle"
# Ships are sunk one at a time and the fleets trade shots, so the first fleet to go
# down loses and a draw can never be agreed: the table offers none and the shelf
# stays silent about it.
DRAWS = False
MARKS = ("x", "o")
EXAMPLE = "place carrier a1 h"
HELP = ["Place your five ships, then fire at the opposing fleet.", "Use random or duplicate to place your fleet automatically; use look after handing over the screen."]
MAX_PLIES = 400
# The fleet is laid out by the game's own one-move chooser. That is setup, not play: a model seat
# is not asked ship after ship (one model call per ship, all inside the person's own request).
SETUP_PHASE = "place"
SETUP_MOVES = ("random", "duplicate")
LEVELS = ("beginner", "intermediate", "advanced", "expert")
LEVEL_LABELS = dict(zip(LEVELS, ("Beginner", "Intermediate", "Advanced", "Expert")))
_FLEET = (("carrier", 5), ("battleship", 4), ("cruiser", 3), ("submarine", 3), ("destroyer", 2))
_SIZES = dict(_FLEET)
_FILES = "abcdefghij"
# The ranked duplicate deal: one published fleet for White, mirrored left to
# right for Black. Both players then face the same shape, so a ranked result
# reflects hunting, never the luck of where the ships happened to fall.
_DUPLICATE_PATTERN = (("carrier", "a1", "h"), ("battleship", "a3", "h"),
                      ("cruiser", "a5", "h"), ("submarine", "f2", "v"),
                      ("destroyer", "h7", "v"))


def create(root, settings=None):
    return kit.Table(Path(root), kit.rules(globals()))


def fresh():
    return {"phase": "place", "fleets": {"white": [], "black": []}, "shots": {"white": [], "black": []}, "cover": "", "duplicate": False}


def level_of(state):
    level = state.get("level")
    return level if level in LEVELS else "intermediate"


def _coin(state):
    seed = "|".join(state.get("moves") or []) + "#" + str(state.get("plies") or 0) + "#" + str(state.get("turn") or "")
    return random.Random(zlib.crc32(seed.encode("utf-8")))


def _square(text):
    if not isinstance(text, str) or len(text) < 2 or text[0] not in _FILES or text[1:] not in tuple(str(i) for i in range(1, 11)):
        return None
    return (int(text[1:]) - 1, _FILES.index(text[0]))


def _name(cell):
    return _FILES[cell[1]] + str(cell[0] + 1)


def _cells(name, square, orient):
    pos = _square(square)
    if pos is None or name not in _SIZES or orient not in ("h", "v"):
        return []
    r, c = pos
    cells = [(r + (i if orient == "v" else 0), c + (i if orient == "h" else 0)) for i in range(_SIZES[name])]
    return cells if all(r < 10 and c < 10 for r, c in cells) else []


def parse(words):
    words = [str(w).lower() for w in words]
    if len(words) == 1 and words[0] in ("random", "look", "duplicate"):
        return (words[0],)
    if len(words) == 2 and words[0] == "unplace" and words[1] in _SIZES:
        return ("unplace", words[1])
    if len(words) == 2 and words[0] == "fire" and _square(words[1]) is not None:
        return tuple(words)
    if len(words) in (3, 4) and words[0] == "place" and words[1] in _SIZES and _square(words[2]) is not None:
        orient = words[3] if len(words) == 4 else "h"
        if orient in ("h", "v"):
            return ("place", words[1], words[2], orient)
    return None


def show(move):
    return " ".join(move)


def _other(side):
    return "black" if side == "white" else "white"


def _placements(name, occupied):
    for r in range(10):
        for c in range(10):
            for orient in ("h", "v"):
                square = _name((r, c))
                cells = _cells(name, square, orient)
                if cells and not occupied.intersection(cells):
                    yield ("place", name, square, orient)


def duplicate_fleet(side):
    fleet = []
    for name, square, orient in _DUPLICATE_PATTERN:
        cells = _cells(name, square, orient)
        if side == "black":
            cells = [(r, 9 - c) for r, c in cells]
        fleet.append({"name": name, "size": _SIZES[name], "cells": [list(p) for p in sorted(cells)]})
    return fleet


def _valid_pattern():
    for side in ("white", "black"):
        fleet = duplicate_fleet(side)
        cells = [tuple(p) for ship in fleet for p in ship["cells"]]
        assert len(cells) == 17 and len(set(cells)) == 17 and all(0 <= r < 10 and 0 <= c < 10 for r, c in cells)
    assert not {tuple(p) for s in duplicate_fleet("white") for p in s["cells"]} & {tuple(p) for s in duplicate_fleet("black") for p in s["cells"]}


_valid_pattern()


def legal(state):
    if state.get("status", "active") != "active":
        return []
    if state.get("cover"):
        return [("look",)]
    # A position built without seats (the lesson's setup, the engine tests) can
    # always say "look": it is a no-op when there is nothing to uncover, and it
    # lets a scripted setup clear a pass-the-screen cover.
    bare = not state.get("white") and not state.get("black")
    side = state["turn"]
    if state["phase"] == "place":
        fleet = state["fleets"][side]
        occupied = {tuple(p) for ship in fleet for p in ship["cells"]}
        placed = {ship["name"] for ship in fleet}
        moves = [("unplace", ship["name"]) for ship in fleet]
        moves += [m for name, _ in _FLEET if name not in placed for m in _placements(name, occupied)]
        if len(placed) >= 5:
            return moves + ([("look",)] if bare else [])
        # The two automatic placements are first and last so a machine or model
        # seat can lay its whole fleet down in one answer: the first legal move
        # finishes a person's fleet, the last finishes the other seat's.
        return [("random",)] + moves + [("duplicate",)] + ([("look",)] if bare else [])
    shots = {tuple(p) for p in state["shots"][side]}
    moves = [("fire", _name((r, c))) for r in range(10) for c in range(10) if (r, c) not in shots]
    return moves + ([("look",)] if bare else [])


def _human(side, state):
    return kit.seat_kind(str(state.get(side) or "")) == "human"


def _cover(state, mover):
    """A screen to hand over, only when two people share one keyboard.

    A computer seat never needs privacy and never asks for the screen, so a
    game against the computer is never interrupted by a pass card.
    """
    nxt = state["turn"]
    state["cover"] = nxt if _human(mover, state) and _human(nxt, state) and mover != nxt else ""


def _finish_placement(state, side):
    if len(state["fleets"][side]) == 5:
        if side == "white":
            state["turn"] = "black"
        else:
            state["phase"] = "fire"
            state["turn"] = "white"
        _cover(state, side)


def play(state, move):
    side = state["turn"]
    if move == ("look",):
        state["cover"] = ""
        return "Screen uncovered."
    if state["phase"] == "place":
        fleet = state["fleets"][side]
        if move[0] == "unplace":
            fleet[:] = [ship for ship in fleet if ship["name"] != move[1]]
            return f"{move[1].capitalize()} back on the tray."
        if move[0] in ("random", "duplicate"):
            if move[0] == "duplicate":
                state["duplicate"] = True
            if state["duplicate"]:
                # A partially placed fleet cannot be reconciled with the fixed layout;
                # replace it to ensure both players receive the published pattern.
                fleet[:] = duplicate_fleet(side)
            else:
                rng = _coin(state)
                names = [n for n, _ in _FLEET if n not in {s["name"] for s in fleet}]
                rng.shuffle(names)
                for name in names:
                    occupied = {tuple(p) for ship in fleet for p in ship["cells"]}
                    choices = list(_placements(name, occupied))
                    rng.shuffle(choices)
                    if not choices:
                        # Rebuild using backtracking if an earlier random choice trapped us.
                        def fill(pending, used):
                            if not pending:
                                return []
                            for candidate in _placements(pending[0], used):
                                cells = _cells(*candidate[1:])
                                rest = fill(pending[1:], used | set(cells))
                                if rest is not None:
                                    return [candidate] + rest
                            return None
                        remaining = [n for n, _ in _FLEET if n not in {s["name"] for s in fleet}]
                        choices_all = fill(remaining, occupied)
                        if choices_all is None:
                            raise ValueError("No fleet placement possible")
                        for candidate in choices_all:
                            fleet.append({"name": candidate[1], "size": _SIZES[candidate[1]], "cells": [list(p) for p in sorted(_cells(*candidate[1:]))]})
                        break
                    candidate = choices[0]
                    fleet.append({"name": name, "size": _SIZES[name], "cells": [list(p) for p in sorted(_cells(*candidate[1:]))]})
        else:
            name = move[1]
            fleet.append({"name": name, "size": _SIZES[name], "cells": [list(p) for p in sorted(_cells(*move[1:]))]})
        _finish_placement(state, side)
        return "Fleet placed." if len(fleet) == 5 else "Ship placed."
    target = _other(side)
    cell = list(_square(move[1]))
    state["shots"][side].append(cell)
    # Who fired, in order. The shot sets alone cannot answer that once both sides have fired at
    # the same square - a membership test then credits the wrong seat, which is how the enemy's
    # attack came to be drawn on ENEMY WATERS.
    state.setdefault("shot_log", []).append({"side": side, "square": move[1]})
    ship = next ( (s for s in state["fleets"][target] if cell in s["cells"]), None)
    if ship:
        sunk = all(p in state["shots"][side] for p in ship["cells"])
        note = f"Sunk {ship['name']}." if sunk else "Hit."
        if all(all(p in state["shots"][side] for p in s["cells"]) for s in state["fleets"][target]):
            state.update(status="win", winner=side, result_reason="fleet sunk")
            return note
    else:
        note = "Miss."
    state["turn"] = target
    _cover(state, side)
    return note


def _known(state, side):
    shots = {tuple(p) for p in state["shots"][side]}
    # Only shot cells and publicly revealed sunk ships are exposed to the chooser.
    hits, sunk_cells, remaining = set(), set(), []
    for ship in state["fleets"][_other(side)]:
        matched = shots.intersection(map(tuple, ship["cells"]))
        hits.update(matched)
        if len(matched) == ship["size"]:
            sunk_cells.update(matched)
        else:
            remaining.append(ship["size"])
    return shots, hits - sunk_cells, sunk_cells, remaining


def _run_score(cell, hits, longest):
    """How long a line of known hits this cell would extend, on its best axis."""
    best = 0
    for dr, dc in ((1, 0), (0, 1)):
        run = 1
        for sign in (1, -1):
            r, c = cell[0] + sign * dr, cell[1] + sign * dc
            while (r, c) in hits and run < longest:
                run += 1
                r, c = r + sign * dr, c + sign * dc
        if run > 1:
            best = max(best, run)
    return best


def bot(state):
    if state.get("cover"):
        return ("look",)
    if state["phase"] == "place":
        return ("random",)
    side = state["turn"]
    shots, hits, sunk, lengths = _known(state, side)
    unknown = [(r, c) for r in range(10) for c in range(10) if (r, c) not in shots]
    rng = _coin(state)
    level = level_of(state)
    if level == "beginner":
        return ("fire", _name(rng.choice(unknown)))
    if level == "intermediate":
        candidates = {}
        for r, c in unknown:
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = 0
                while (r + (n + 1)*dr, c + (n + 1)*dc) in hits:
                    n += 1
                if n:
                    candidates[(r, c)] = max(candidates.get((r, c), 0), n)
        if candidates:
            best = max(candidates.values())
            choices = [p for p in unknown if candidates.get(p) == best]
        else:
            choices = [p for p in unknown if sum(p) % 2 == 0] or unknown
        return ("fire", _name(rng.choice(choices)))
    misses = shots - hits - sunk
    placements = []
    for length in lengths:
        for r in range(10):
            for c in range(10):
                for dr, dc in ((0, 1), (1, 0)):
                    cells = {(r+i*dr, c+i*dc) for i in range(length)}
                    if all(a < 10 and b < 10 for a, b in cells) and not cells & (misses | sunk):
                        placements.append((cells, length))
    # Target placements touching known hits whenever possible.
    targeted = [(cells, length) for cells, length in placements if cells & hits]
    if targeted:
        placements = targeted
    weights = {p: 0 for p in unknown}
    for cells, length in placements:
        for p in cells:
            if p in weights:
                weights[p] += 1
    if level == "expert":
        # Density decides the shot; a cell that lengthens a line of hits breaks a
        # tie, so a wounded ship is finished before the rest of the board is combed.
        longest = max(lengths or [1])
        scores = {p: weights[p] * 100 + _run_score(p, hits, longest) for p in unknown}
        best = max(scores.values())
        return ("fire", _name(rng.choice([p for p in unknown if scores[p] == best])))
    best = max(weights.values())
    return ("fire", _name(rng.choice([p for p in unknown if weights[p] == best])))


def picture(state, player=None):
    status = str(state.get("status") or "idle")
    finished = status in {"win", "draw", "resigned", "lesson_done"}
    pid = getattr(player, "id", None) if player is not None else None
    if isinstance(player, dict):
        pid = player.get("id")
    white_id, black_id = state.get("white_id"), state.get("black_id")
    side = ""
    if not finished and player is not None:
        # One person on one keyboard holds both seats: the kit leaves the second seat unbound, so
        # follow the turn rather than pinning the viewer to white, and the pass-the-screen cover
        # reaches whoever is actually there.
        #
        # Only when BOTH seats are human. Against an agent the unbound seat is the machine's, and
        # following the turn flipped the viewer's side on every ply - the boards swapped, so the
        # person's own hits were drawn on ENEMY WATERS and their water showed the machine's marks,
        # and nothing on either board looked like it had landed.
        seat_kind = getattr(kit, "seat_kind", None)
        both_human = bool(seat_kind) and all(
            seat_kind(str(state.get(who) or "")) == "human" for who in ("white", "black")
        )
        shared = both_human and (not black_id or white_id == black_id)
        if shared and (not white_id or pid == white_id):
            side = state["turn"]
        elif pid is not None and pid == white_id:
            side = "white"
        elif pid is not None and pid == black_id:
            side = "black"
        elif not white_id and state.get("white") == "human":
            # Against the computer the human seat is never bound to an id; the viewer holds it.
            side = "white"
    if not side and pid is not None:
        # A finished game still belongs to whoever was seated in it: without this, the end-of-game
        # review had no fleet to draw on the person's own board.
        if pid == white_id:
            side = "white"
        elif pid == black_id:
            side = "black"
    if not side:
        # A finished game, or a read with no player attached, still has to know whose fleet this
        # is. Without it every shot looked like the enemy's: a sinking was announced as theirs
        # and the player never heard or saw their own hit. One human seat is the person; one
        # machine seat means the other side is the person; two human seats stay colourless.
        humans = [seat for seat in ("white", "black") if kit.seat_kind(str(state.get(seat) or "")) == "human"]
        if len(humans) == 1:
            side = humans[0]
        elif not humans:
            machines = [seat for seat in ("white", "black") if kit.seat_kind(str(state.get(seat) or "")) in kit.AI_KINDS]
            if len(machines) == 1:
                side = _other(machines[0])
    own = side or "white"
    enemy = _other(own)
    own_shots = {tuple(p) for p in state["shots"][own]}
    enemy_shots = {tuple(p) for p in state["shots"][enemy]}
    own_hull = {tuple(p) for s in state["fleets"][own] for p in s["cells"]}
    enemy_hull = {tuple(p) for s in state["fleets"][enemy] for p in s["cells"]}
    sunk = [s for s in state["fleets"][enemy] if all(tuple(p) in own_shots for p in s["cells"])]
    sunk_cells = {tuple(p) for s in sunk for p in s["cells"]}
    boards = [[['.' for _ in range(10)] for _ in range(10)] for _ in range(2)]
    for r in range(10):
        for c in range(10):
            p = (r, c)
            if p in enemy_shots:
                boards[0][9-r][c] = 'H' if p in own_hull else 'M'
            elif p in own_hull and (side or finished):
                boards[0][9-r][c] = 'S'
            if p in own_shots:
                boards[1][9-r][c] = 'X' if p in sunk_cells else ('H' if p in enemy_hull else 'M')
            elif p in enemy_hull and finished:
                boards[1][9-r][c] = 'S'
    def describe(ship):
        return {"name": ship["name"], "size": ship["size"], "cells": [_name(p) for p in ship["cells"]]}
    own_ships = []
    if side:
        for ship in state["fleets"][own]:
            info = describe(ship)
            info["hits"] = sum(tuple(p) in enemy_shots for p in ship["cells"])
            info["sunk"] = info["hits"] == ship["size"]
            own_ships.append(info)
    # At the end, both fleets are shown whole: every ship with whether it went down, so the review
    # can draw five hulls a side with the killed ones red. While the game is running the enemy's
    # fleet stays hidden - only what has been sunk is published.
    reveal = []
    if finished:
        for ship in state["fleets"][enemy]:
            info = describe(ship)
            info["hits"] = sum(tuple(p) in own_shots for p in ship["cells"])
            info["sunk"] = info["hits"] == ship["size"]
            reveal.append(info)
    placed = {s["name"] for s in state["fleets"][own]}
    cover_side = state.get("cover", "")
    cover = None
    if cover_side and (not side or side == cover_side):
        cover = {"side": cover_side, "name": state.get(cover_side + "_name") or kit.seat_line(state, cover_side)}
    # History records which side fired even when a look follows it. A human's shot and the
    # computer's answer arrive in the same request, so the newest shot alone is always the
    # computer's: the board could never show or sound the player's own hit. Keep the last few.
    # The log records the shooter per shot. Older saves have no log, so fall back to the move list
    # and a membership test - correct until both seats fire at the same square, which is exactly the
    # case the log exists for.
    log = [row for row in (state.get("shot_log") or []) if isinstance(row, dict)]
    if log:
        entries = [(str(row.get("side") or ""), str(row.get("square") or "")) for row in log[-4:]]
    else:
        moves = state.get("moves") or []
        fire_moves = [m for m in moves if m.startswith("fire ")]
        entries = []
        for move in fire_moves[-4:]:
            square = move.split()[1]
            p = _square(square)
            key = [p[0], p[1]] if p else None
            shooter = "white" if key in state["shots"]["white"] else ("black" if key in state["shots"]["black"] else "")
            entries.append((shooter, square))
    last_shots = []
    for shooter, square in entries:
        p = _square(square)
        if p is None or shooter not in ("white", "black"):
            continue
        ship = next((s for s in state["fleets"][_other(shooter)] if list(p) in s["cells"]), None)
        is_sunk = ship and all(q in state["shots"][shooter] for q in ship["cells"])
        last_shots.append({"side": shooter, "square": square, "result": "sunk" if is_sunk else ("hit" if ship else "miss"), "ship": ship["name"] if is_sunk else ""})
    last_shot = last_shots[-1] if last_shots else None
    return {"view": "seabattle", "legal": [show(move) for move in legal(state)], "phase": "over" if finished else state["phase"], "your_side": side, "files": _FILES, "ranks": list(range(10, 0, -1)), "own_cells": boards[0], "enemy_cells": boards[1], "own_ships": own_ships, "enemy_ships": [describe(s) for s in sunk], "enemy_fleet": reveal, "tray": [{"name": n, "size": size} for n, size in _FLEET if side and n not in placed], "shots": {"you": len(own_shots), "them": len(enemy_shots), "your_hits": len(own_shots & enemy_hull), "their_hits": len(enemy_shots & own_hull)}, "ships_left": {"you": 5 - sum(all(tuple(p) in enemy_shots for p in s["cells"]) for s in state["fleets"][own]), "them": 5 - len(sunk)}, "last_shot": last_shot, "last_shots": last_shots, "cover": cover, "notice": "", "levels": [{"id": x, "label": LEVEL_LABELS[x]} for x in LEVELS]}


def draw(state):
    side = state["turn"]
    own = {tuple(p) for s in state["fleets"][side] for p in s["cells"]}
    other = _other(side)
    theirs = {tuple(p) for s in state["fleets"][other] for p in s["cells"]}
    shots = {tuple(p) for p in state["shots"][side]}
    incoming = {tuple(p) for p in state["shots"][other]}
    sunk = {tuple(p) for s in state["fleets"][other] if all(tuple(p) in shots for p in s["cells"]) for p in s["cells"]}
    lines = [f"{state['phase']} — {side} to move", "    " + " ".join(_FILES) + "       " + " ".join(_FILES)]
    for r in range(9, -1, -1):
        a = ['x' if (r,c) in incoming and (r,c) in own else 'o' if (r,c) in incoming else '#' if (r,c) in own else '~' for c in range(10)]
        b = ['#' if (r,c) in sunk else 'x' if (r,c) in shots and (r,c) in theirs else 'o' if (r,c) in shots else '.' for c in range(10)]
        lines.append(f"{r+1:2}  {' '.join(a)}   {r+1:2}  {' '.join(b)}")
    return lines
