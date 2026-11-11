"""Opening facts and a shallow, local chess review."""

import importlib.util
import json
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path

_BOOK = None
_GAME = None


def _game():
    global _GAME
    if _GAME is None:
        spec = importlib.util.spec_from_file_location('chess_coach_rules', Path(__file__).with_name('game.py'))
        _GAME = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_GAME)
    return _GAME


def _book():
    global _BOOK
    if _BOOK is None:
        try:
            value = json.loads(Path(__file__).with_name('openingbook.json').read_text(encoding='utf-8'))
            valid = isinstance(value, dict) and all(
                isinstance(key, str) and isinstance(entry, dict) and
                all(isinstance(entry.get(field, []), list) and
                    all(isinstance(item, list) and len(item) == 2 and
                        all(isinstance(part, str) for part in item)
                        for item in entry.get(field, [])) for field in ('n', 'm'))
                for key, entry in value.items())
            _BOOK = value if valid else {}
        except (OSError, ValueError):
            _BOOK = {}
    return _BOOK


def replay(keys_module, moves):
    state = keys_module.fresh()
    for ply, move in enumerate(moves, 1):
        state = keys_module._child(state, move)
        yield ply, keys_module._key(state), state


def live(moves):
    game = _game()
    book = _book()
    state = game.fresh()
    left = None
    visited = False
    history = []
    for ply, move in enumerate(moves, 1):
        entry = book.get(game._key(state), {})
        if left is None and entry:
            if move not in [item[0] for item in entry.get('m', [])]:
                left = ply
            else:
                visited = True
        elif left is None and visited:
            left = ply
        state = game._child(state, move)
        history.append(book.get(game._key(state), {}))
        if left is None and visited and not history[-1]:
            left = ply
    entry = book.get(game._key(state), {})
    # The start position sits at the root of every entry in the book, so it carries
    # every name in it and belongs to none: an opening begins with the first move.
    # Naming one anyway told a player on a freshly rematched board they were playing
    # the Amar Opening at move 0 (the bug hunt's picky newcomer).
    names = [] if not moves else entry.get('n', [])
    # A name repeated along the actual path has the longest known path in this index.
    def path_length(name):
        count = 0
        for previous in reversed(history[:-1]):
            if name not in previous.get('n', []):
                break
            count += 1
        return count
    name = max(names, key=path_length) if names else None
    continuations = [item[0] for item in entry.get('m', [])]
    legal = set(game.legal(state)) if entry and left is None else set()
    return {'opening': {'eco': name[0], 'name': name[1]} if name else None,
            'alt': max(0, len(names) - 1), 'book': [m for m in continuations if m in legal][:3],
            'in_book': bool(entry) and left is None, 'left_ply': left}


def _san(game, state, move):
    board = state['board']
    fr, ff = game._spot(move[:2])
    tr, tf = game._spot(move[2:4])
    piece = board[fr][ff]
    if piece.lower() == 'k' and abs(tf - ff) == 2:
        text = 'O-O' if tf > ff else 'O-O-O'
    else:
        capture = board[tr][tf] != '.' or (piece.lower() == 'p' and ff != tf)
        text = '' if piece.lower() == 'p' else piece.upper()
        if piece.lower() != 'p':
            rivals = [m for m in game.legal(state) if m != move and m[2:4] == move[2:4]
                      and board[game._spot(m[:2])[0]][game._spot(m[:2])[1]] == piece]
            if rivals:
                starts = [m[:2] for m in rivals]
                text += move[0] if all(s[0] != move[0] for s in starts) else (move[1] if all(s[1] != move[1] for s in starts) else move[:2])
        elif capture:
            text += move[0]
        text += ('x' if capture else '') + move[2:4]
        if len(move) == 5:
            text += '=' + move[4].upper()
    child = game._child(state, move)
    if game._in_check(child['board'], child['turn'] == 'white'):
        text += '+' if game.legal(child) else '#'
    return text


class _Engine:
    def __init__(self, path):
        self.proc = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.label = 'Stockfish'
        try:
            self.send('uci')
            lines = self.until('uciok')
            for line in lines:
                if line.startswith('id name '):
                    words = line[8:].split()
                    if words and words[0].lower() == 'stockfish' and len(words) > 1:
                        self.label = 'Stockfish ' + words[1]
            self.send('isready')
            self.until('readyok')
        except Exception:
            self.close()
            raise

    def _read(self):
        for line in self.proc.stdout:
            self.lines.put(line.strip())
        self.lines.put(None)

    def send(self, command):
        self.proc.stdin.write(command + '\n')
        self.proc.stdin.flush()

    def until(self, token):
        deadline = time.monotonic() + 2
        lines = []
        while True:
            line = self.lines.get(timeout=max(0, deadline - time.monotonic()))
            if line is None:
                raise RuntimeError('engine stopped')
            lines.append(line)
            if line.split()[:1] == [token]:
                return lines

    def evaluate(self, moves):
        self.send('position startpos' + (' moves ' + ' '.join(moves) if moves else ''))
        self.send('go depth 12')
        lines = self.until('bestmove')
        score = None
        best_depth = -1
        for line in lines:
            words = line.split()
            if words[:1] == ['info'] and 'score' in words and 'depth' in words:
                try:
                    depth = int(words[words.index('depth') + 1])
                    i = words.index('score')
                    if depth >= best_depth and 'lowerbound' not in words and 'upperbound' not in words:
                        number = int(words[i + 2])
                        if words[i + 1] == 'cp':
                            score, best_depth = number, depth
                        elif words[i + 1] == 'mate':
                            score, best_depth = (100000 - abs(number) if number > 0 else -100000 + abs(number)), depth
                except (ValueError, IndexError):
                    pass
        best = lines[-1].split()[1]
        if score is None:
            raise ValueError('engine gave no centipawn score')
        return score, best

    def close(self):
        try:
            self.send('quit')
            self.proc.wait(timeout=0.2)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()
            self.proc.wait()
        finally:
            self.proc.stdin.close()
            self.proc.stdout.close()


def _own(game, state):
    value, move = game._root(game._Pos(state), 1, float('inf'))
    if move is None:
        return (-game._MATE if game._in_check(state['board'], state['turn'] == 'white') else 0), ''
    return int(value), game._text(move)


def coach_mistake(rules, moves, side):
    if side not in ('white', 'black'):
        return None
    engine = None
    path = shutil.which('stockfish')
    if path:
        try:
            engine = _Engine(path)
        except (OSError, RuntimeError, queue.Empty):
            pass
    try:
        # If the external engine fails, restart the whole review with one consistent evaluator.
        try:
            return _review(rules, moves, side, engine)
        except (OSError, RuntimeError, ValueError, IndexError, queue.Empty, BrokenPipeError):
            return _review(rules, moves, side, None) if engine else None
    finally:
        if engine:
            engine.close()


def _review(game, moves, side, engine):
    state = game.fresh()
    worst = None
    def evaluate(prefix, position):
        return engine.evaluate(prefix) if engine else _own(game, position)
    for index, move in enumerate(moves):
        if move not in game.legal(state):
            return None
        child = game._child(state, move)
        if state['turn'] == side:
            before, better = evaluate(moves[:index], state)
            if better and better != move and better in game.legal(state):
                after, _ = evaluate(moves[:index + 1], child)
                after = -after
                loss = before - after
                if loss >= 120 and (worst is None or loss > worst[0]):
                    worst = (loss, index, before, after, better, _san(game, state, move), _san(game, state, better))
        state = child
    if worst is None:
        return None
    loss, index, before, after, better, played_san, better_san = worst
    facts = live(moves)
    details = {'engine': engine.label if engine else 'built-in search', 'opening': facts['opening'],
               'alt': facts['alt'], 'left_ply': facts['left_ply'], 'ply': index + 1,
               'played': moves[index], 'played_san': played_san, 'better': better,
               'better_san': better_san, 'before': before, 'after': after}
    opening = ''
    if facts['left_ply'] is not None:
        last = live(moves[:facts['left_ply'] - 1])['opening']
        label = f" ({last['name']})" if last else ''
        opening = f"You left the book at ply {facts['left_ply']}{label}. "
    say = f'{opening}Move {(index // 2) + 1} ({played_san}) lost {loss} cp; {better_san} was better.'
    return {'say': say, 'setup': list(moves[:index]), 'goal': [better], 'wins': False,
            'tip': f'{better_san} was better.', 'praise': 'That is the one.', 'coach': details}
