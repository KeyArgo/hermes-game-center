"""Backgammon, with points numbered in white's direction (24 to 1)."""
from __future__ import annotations
import copy
import random
import re
from pathlib import Path
import importlib.util
import sys

_ROOT = Path(__file__).resolve().parent.parent
if 'hermes_gameshelf_kit' not in sys.modules:
    spec = importlib.util.spec_from_file_location('hermes_gameshelf_kit', _ROOT / 'kit.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
kit = sys.modules['hermes_gameshelf_kit']
ID, TITLE, MARKS = 'backgammon', 'Backgammon', ('x', 'o')
EXAMPLE = 'move 24 18 6'
MAX_PLIES = 10000
HELP = ['Move white from 24 toward 1 and black from 1 toward 24. Use both dice when possible.',
        'Enter from the bar first. A point with two opposing checkers is blocked; a blot is hit.',
        'Bear off when all your checkers are in your home board. First to bear off all 15 wins.']

def create(root: Path, settings: dict | None = None):
    return kit.Table(Path(root), kit.rules(globals()))

def roll():
    a, b = random.randint(1, 6), random.randint(1, 6)
    return [a] * 4 if a == b else [a, b]

def fresh():
    points = [0] * 24
    for p, n in [(24, 2), (13, 5), (8, 3), (6, 5), (1, -2), (12, -5), (17, -3), (19, -5)]:
        points[p-1] = n
    dice = roll()
    while len(dice) != 2:
        dice = roll()
    return {'points': points, 'bar': {'white': 0, 'black': 0}, 'off': {'white': 0, 'black': 0}, 'dice': dice}

def parse(words):
    parts = [x for x in re.split(r'[\s\-/:]+', ' '.join(words).lower()) if x]
    if parts == ['pass']: return ('pass',)
    if len(parts) not in (2, 3): return None
    if parts[0] != 'bar' and (not parts[0].isdigit() or not 1 <= int(parts[0]) <= 24): return None
    if parts[1] != 'off' and (not parts[1].isdigit() or not 1 <= int(parts[1]) <= 24): return None
    if len(parts) == 3 and (not parts[2].isdigit() or not 1 <= int(parts[2]) <= 6): return None
    return tuple(parts)

def show(move): return '-'.join(move)

def _steps(s, die):
    side = s['turn']; sign = 1 if side == 'white' else -1
    points = s['points']; bar = s['bar'][side]
    sources = ['bar'] if bar else [str(i+1) for i, n in enumerate(points) if n * sign > 0]
    home = not bar and all(n * sign <= 0 or (i < 6 if sign == 1 else i >= 18) for i, n in enumerate(points))
    for src in sources:
        start = (25 if sign == 1 else 0) if src == 'bar' else int(src)
        dest = start - die * sign
        if 1 <= dest <= 24:
            if points[dest-1] * sign >= -1:
                yield (src, str(dest), str(die))
        elif src != 'bar' and home:
            distance = start if sign == 1 else 25-start
            farther = any(n * sign > 0 and (i+1 > start if sign == 1 else i+1 < start) for i, n in enumerate(points))
            if die == distance or (die > distance and not farther):
                yield (src, 'off', str(die))

def _apply(s, move):
    src, dest, die = move; side = s['turn']; sign = 1 if side == 'white' else -1
    other = 'black' if side == 'white' else 'white'
    if src == 'bar': s['bar'][side] -= 1
    else: s['points'][int(src)-1] -= sign
    if dest == 'off': s['off'][side] += 1
    else:
        i = int(dest)-1
        if s['points'][i] == -sign:
            s['points'][i] = 0; s['bar'][other] += 1
        s['points'][i] += sign
    s['dice'].remove(int(die))

def _sequences(s):
    result = []
    for die in sorted(set(s['dice']), reverse=True):
        for move in _steps(s, die):
            child = copy.deepcopy(s); _apply(child, move)
            tails = _sequences(child)
            result.extend([(move,) + tail for tail in tails] if tails else [(move,)])
    if not result: return []
    longest = max(map(len, result)); result = [x for x in result if len(x) == longest]
    if longest == 1:
        high = max(int(x[0][2]) for x in result)
        result = [x for x in result if int(x[0][2]) == high]
    return result

def legal(state):
    moves = list(dict.fromkeys(seq[0] for seq in _sequences(state)))
    return moves or [('pass',)]

def refusal(state, move): return 'Use an available die and a highlighted destination; you must use as many dice as possible.'

def play(state, move):
    side = state['turn']
    if move != ('pass',): _apply(state, move)
    if state['off'][side] == 15:
        state['status'] = 'win'; state['winner'] = side
        return 'All checkers borne off.'
    if move == ('pass',) or not state['dice'] or legal(state) == [('pass',)]:
        state['turn'] = 'black' if side == 'white' else 'white'
        state['dice'] = roll()
        return 'Turn complete.'
    return ''

def bot(state):
    choices = legal(state)
    if choices == [('pass',)]: return choices[0]
    side = state['turn']; sign = 1 if side == 'white' else -1
    def value(move):
        src, dst, die = move
        before = state['points']
        score = int(die) * .1
        if dst == 'off': score += 8
        else:
            n = before[int(dst)-1] * sign
            if n == -1: score += 7
            if n == 1: score += 4
            if n == 0: score -= 1
        if src != 'bar' and before[int(src)-1] * sign == 2: score -= 2
        return score
    return max(choices, key=value)

def draw(state):
    return [f"Points: {state['points']}", f"Bar: {state['bar']}  Off: {state['off']}  Dice: {state['dice']}"]

def picture(state):
    return {'view': 'backgammon', 'points': state['points'][:], 'bar': dict(state['bar']),
            'off': dict(state['off']), 'dice': state['dice'][:], 'legal': [show(m) for m in legal(state)]}
