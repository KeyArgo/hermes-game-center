"""Chess opening facts and review integration."""

import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from shelf.kitref import kit
from shelf import review


def load():
    spec = importlib.util.spec_from_file_location('coach_chessboard', ROOT / 'chessboard' / 'game.py')
    game = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(game)
    return game


def test_opening_and_amar():
    coach = load().coach()
    first = coach.live(['e2e4'])
    assert first['opening'] and first['in_book'] and first['left_ply'] is None
    assert first['book'] == ['d7d5', 'e7e6', 'd7d6']
    assert 'Amar' in coach.live(['g1h3'])['opening']['name']


def test_no_opening_is_named_before_the_first_move():
    """The empty board shares its position with every entry in the book.

    Naming the first of those 3,332 names anyway told a player on a freshly rematched
    board they were playing the Amar Opening at move 0 (the bug hunt). The book moves
    are still offered at the start; only the invented name goes away.
    """
    coach = load().coach()
    at_rest = coach.live([])
    assert at_rest['opening'] is None, at_rest
    assert at_rest['alt'] == 0, at_rest
    assert at_rest['in_book'] and at_rest['book'], "the book is still offered before the first move"
    assert coach.live(['g1h3'])['opening']['name'], 'the first move is what names the opening'


def test_transposition_and_multiple_names(monkeypatch):
    game = load()
    coach = game.coach()
    a = ['d2d4', 'g8f6', 'g1f3', 'd7d5']
    b = ['g1f3', 'd7d5', 'd2d4', 'g8f6']
    sa = list(coach.replay(game, a))[-1]
    sb = list(coach.replay(game, b))[-1]
    assert sa[1] == sb[1]
    book = dict(coach._book())
    entry = dict(book[sa[1]])
    entry['n'] = [*entry['n'], ['A00', 'Another name']]
    book[sa[1]] = entry
    monkeypatch.setattr(coach, '_BOOK', book)
    assert coach.live(b)['alt'] >= 1


def test_left_once_and_picture():
    game = load()
    coach = game.coach()
    moves = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5e5']
    assert coach.live(moves)['left_ply'] == 5
    assert coach.live(moves + ['c6e5'])['left_ply'] == 5
    state = game._child(game.fresh(), 'e2e4')
    state.update(status='active', plies=1, moves=['e2e4'], last='e2e4')
    assert game.picture(state)['coach']['book']
    state['lesson'] = {'step': 1}
    assert game.picture(state)['coach'] is None


def test_builtin_review_and_lesson(monkeypatch):
    game = load()
    coach = game.coach()
    monkeypatch.setattr(coach.shutil, 'which', lambda _: None)
    moves = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5e5']
    found = coach.coach_mistake(game, moves, 'white')
    detail = found['coach']
    assert detail['engine'] == 'built-in search'
    assert detail['better'] != detail['played']
    assert detail['before'] - detail['after'] >= 120
    assert detail['played_san'] == 'Qxe5+'
    state = kit.lesson_position(game, found)
    assert kit.lesson_passes(game, found, state, detail['better'])


def test_review_command_preserves_coach(tmp_path, monkeypatch):
    game = load()
    monkeypatch.setattr(game.coach().shutil, 'which', lambda _: None)
    # A real checkmate, played through the game rules.
    moves = ['f2f3', 'e7e5', 'g2g4', 'd8h4']
    state = review.start(game)
    for move in moves:
        assert move in game.legal(state)
        game.play(state, move)
        state['plies'] += 1
        state['moves'].append(move)
        state['last'] = move
    assert state['status'] == 'win'
    state.update(schema_version=2, table_id='t1', owner_id='u1', white='human', black='local',
                 white_id='u1', black_id='local', white_name='Ada', black_name='Local',
                 score={'white': 0, 'black': 1, 'draws': 0}, result_recorded=True)
    kit.save(tmp_path, state)
    table = game.create(tmp_path)
    answer = table.command('review', player=SimpleNamespace(id='u1', name='Ada', platform='desktop', bot=False))
    assert 'Review' in answer
    lesson = json.loads((tmp_path / 'state.json').read_text())['lesson']
    assert lesson['custom']['coach']['engine'] == 'built-in search'


@pytest.mark.skipif(os.name == "nt", reason="the fake UCI engine is a POSIX shebang script; Windows cannot execute it")
def test_uci_protocol(tmp_path):
    coach = load().coach()
    fake = tmp_path / 'engine'
    fake.write_text('''#!/usr/bin/env python3
import sys
for line in sys.stdin:
    if line.strip() == 'uci':
        print('id name Stockfish 99 fake', flush=True)
        print('uciok', flush=True)
    elif line.strip() == 'isready':
        print('readyok', flush=True)
    elif line.startswith('go '):
        print('info depth 10 score cp 42 pv e2e4', flush=True)
        print('info depth 12 score cp 37 pv e2e4', flush=True)
        print('bestmove e2e4', flush=True)
    elif line.strip() == 'quit':
        break
''')
    fake.chmod(0o755)
    engine = coach._Engine(str(fake))
    try:
        assert engine.label == 'Stockfish 99'
        assert engine.evaluate([]) == (37, 'e2e4')
    finally:
        engine.close()
    assert engine.proc.poll() is not None
