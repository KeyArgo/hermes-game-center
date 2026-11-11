from __future__ import annotations

import os

from shelf import playbook as p


def book():
    return {'read': ['What threatens me?', 'What can I improve?'], 'tactics': ['If ahead then simplify'], 'scout': 'Watch the endgame.', 'voice': 'Calm.'}


def test_validation_and_caps():
    assert p.count_words(' a\n b ') == 2
    assert p.validate(None)[0] is None
    assert p.validate({**book(), 'read': ['a']})[0] is None
    assert p.validate({**book(), 'read': ['a'] * 4})[0] is None
    assert p.validate({**book(), 'read': ['a ' * 21, 'b']})[0] is None
    assert p.validate({**book(), 'tactics': ['a'] * 5})[0] is None
    for key in ('scout', 'voice'):
        assert p.validate({**book(), key: 'a ' * 41})[0] is None
    assert p.validate({**book(), 'tactics': ['a ' * 41]})[0] is None
    assert p.validate({**book(), 'read': [1, 'b']})[0] is None
    assert p.validate({**book(), 'voice': 'x' * 10000000})[0]
    assert p.validate({**book(), 'voice': 'hi\x00\nthere'})[0]['voice'] == 'hi there'
    large = {'read': ['a ' * 20] * 3, 'tactics': ['a ' * 40] * 4, 'scout': 'a ' * 40, 'voice': ''}
    assert 'cap is 250' in p.validate(large)[1]


def test_versions_and_dossiers(tmp_path):
    store = p.PlaybookStore(tmp_path)
    champ, rival = 'champ-12345678', 'champ-abcdef12'
    first = store.save(champ, '', book())[0]
    second = store.save(champ, 'Two', book())[0]
    assert first['id'] != second['id'] and store.current(champ)['id'] == second['id']
    assert store.select(champ, first['id']) and store.current(champ)['id'] == first['id']
    for _ in range(p.MAX_VERSIONS):
        assert store.save(champ, '', book())[0]
    assert len(store.versions(champ)) == p.MAX_VERSIONS
    assert not store.select('../bad', first['id'])
    notes = p.DossierStore(tmp_path)
    for outcome in ('win', 'loss', 'draw'):
        note = notes.note(champ, rival, opponent_name='Rook', result=outcome, game='connect4', rule='word ' * 200)
    assert (note['matches'], note['wins'], note['losses'], note['draws']) == (3, 1, 1, 1)
    assert note['words'] <= 80 and notes.get('../bad', rival) is None
    assert notes.forget(champ, rival)


def test_prompts_and_picking():
    champion = {'name': 'Rook', 'brief': 'Wait.'}
    version = {'playbook': book()}
    assert 'Wait.' in p.system_text(champion, version)
    assert p.system_text(champion, None).endswith('nothing else.')
    picker = lambda text, names, rules, legal: text.strip() if text.strip() in names else None
    assert p.pick_move('thought\nMOVE: α', {'α': 1}, None, [], picker) == 'α'
    assert p.pick_move('junk', {'α': 1}, None, [], picker) is None
    assert p.reads_from('one\ntwo\nMOVE: a') == ['one', 'two']


def test_move_prompt_contains_playbook_and_dossier():
    class Rules:
        TITLE = 'Example'
        MARKS = ('X', 'O')
        HELP = ['Rules.']
        @staticmethod
        def show(move): return move
        @staticmethod
        def draw(state): return ['board']
    prompt = p.move_prompt(rules=Rules, state={'turn': 'white'}, legal=['A'], moves=[], champion={'playbook_version': {'playbook': book()}}, dossiers={'text': 'Rook is patient.'})
    for expected in ('Before you move', 'What threatens me?', 'Tactics:', 'Record after the game', 'How you speak:', 'What you know about this rival: Rook is patient.', 'MOVE: <move>'):
        assert expected in prompt
    assert p.pick_move('a', {'a': 1}, None, [], lambda text, *args: text) == 'a'
    assert p.reads_from('x' * 200 + '\nMOVE: 1') == ['x' * 120]


def test_newest_version_wins_even_when_the_clock_is_coarse(tmp_path):
    """A 1-second filesystem must not shuffle the version list (ext3 on the test box does this)."""
    store = p.PlaybookStore(tmp_path)
    champ = 'champ-12345678'
    first = store.save(champ, 'one', book())[0]
    second = store.save(champ, 'two', book())[0]
    stamp = 1_700_000_000
    for record in (first, second):
        os.utime(tmp_path / 'playbooks' / champ / 'versions' / (record['id'] + '.json'), (stamp, stamp))
    assert [row['name'] for row in store.versions(champ)][:2] == ['two', 'one']
