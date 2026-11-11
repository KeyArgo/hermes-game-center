"""Sea Battle rules, privacy and replay."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest

spec = importlib.util.spec_from_file_location("seabattle_rules", Path(__file__).resolve().parent.parent / "seabattle/game.py")
game = importlib.util.module_from_spec(spec)
spec.loader.exec_module(game)


def start(seed=0):
    return {"turn": "white", "status": "active", "winner": "", "moves": [str(seed)], "plies": 0, **game.fresh()}


def step(s, move):
    assert move in game.legal(s)
    note = game.play(s, move)
    s['moves'].append(game.show(move))
    s['plies'] += 1
    return note


def setup(seed=0):
    s = start(seed)
    step(s, ('random',))
    step(s, ('look',))
    step(s, ('random',))
    step(s, ('look',))
    return s


def test_grammar_and_placements():
    for text in ('place carrier a1 h', 'place destroyer j9 v', 'fire j10', 'random', 'look', 'duplicate'):
        assert game.show(game.parse(text.split())) == text
    assert game.parse(['place', 'carrier', 'a1']) == ('place', 'carrier', 'a1', 'h')
    for text in ('fire a0', 'fire a01', 'fire a1 extra', 'place boat a1', 'place carrier a1 z', 'random now'):
        assert game.parse(text.split()) is None
    s = start()
    for name, square, orientation in game._DUPLICATE_PATTERN:
        assert s['turn'] == 'white'
        step(s, ('place', name, square, orientation))
        assert ('place', 'destroyer', 'a1', 'h') not in game.legal(s)
    assert s['turn'] == 'black' and s['cover'] == 'black'
    assert ('place', 'carrier', 'j10', 'h') not in game.legal(start())


def test_firing_and_victory():
    s = start()
    step(s, ('duplicate',)); step(s, ('look',)); step(s, ('random',)); step(s, ('look',))
    cells = [game._name(p) for ship in s['fleets']['black'] for p in ship['cells']]
    for i, cell in enumerate(cells):
        note = step(s, ('fire', cell))
        if i == 4:
            assert 'carrier' in note
        if s['status'] == 'win':
            break
        step(s, ('look',)); step(s, ('fire', game._name((9 - i // 10, i % 10)))); step(s, ('look',))
        assert ('fire', cell) not in game.legal(s)
    assert (s['winner'], s['result_reason']) == ('white', 'fleet sunk')


def test_random_and_duplicate():
    for seed in range(60):
        a, b = start(seed), start(seed)
        step(a, ('random',)); step(b, ('random',))
        assert a['fleets'] == b['fleets']
        cells = [tuple(p) for s in a['fleets']['white'] for p in s['cells']]
        assert len(cells) == len(set(cells)) == 17
    a, b = game.duplicate_fleet('white'), game.duplicate_fleet('black')
    assert not {tuple(p) for s in a for p in s['cells']} & {tuple(p) for s in b for p in s['cells']}
    s = start(); step(s, ('duplicate',)); step(s, ('look',)); step(s, ('random',))
    assert s['fleets'] == {'white': a, 'black': b}


def test_a_ship_can_be_lifted_back_onto_the_tray():
    s = start()
    step(s, ('place', 'carrier', 'a1', 'h'))
    assert s['fleets']['white'][0]['name'] == 'carrier'
    assert ('unplace', 'carrier') in game.legal(s)
    assert ('place', 'carrier', 'a1', 'h') not in game.legal(s)
    step(s, ('unplace', 'carrier'))
    assert s['fleets']['white'] == []
    assert ('place', 'carrier', 'a1', 'h') in game.legal(s)
    # A lifted ship gives its water back: the square can be used again.
    step(s, ('place', 'battleship', 'a1', 'h'))
    assert game.parse(['unplace', 'boat']) is None


def test_the_pass_cover_is_only_for_two_people_on_one_screen():
    against_bot = start()
    against_bot.update(white='human', black='local')
    step(against_bot, ('random',))
    assert against_bot['cover'] == '', 'a computer seat never asks for the screen'
    step(against_bot, ('random',))
    assert against_bot['cover'] == '' and against_bot['phase'] == 'fire'

    shared = start()
    shared.update(white='human', black='human')
    step(shared, ('random',))
    assert shared['cover'] == 'black'
    assert game.legal(shared) == [('look',)]
    step(shared, ('look',))
    assert shared['cover'] == '' and shared['phase'] == 'place'


def test_a_sunk_ship_is_the_only_enemy_hull_a_player_ever_sees():
    s = setup()
    s.update(white='human', black='local', white_id='w', black_id='b')
    target = next(ship for ship in s['fleets']['black'] if ship['name'] == 'destroyer')

    def fire(cell):
        if s['turn'] != 'white':
            step(s, next(move for move in game.legal(s) if move[0] == 'fire'))
        step(s, ('fire', cell))

    fire(game._name(target['cells'][0]))
    assert s['status'] == 'active', 'a two-cell ship is not sunk by one hit'
    view = game.picture(s, SimpleNamespace(id='w'))
    assert view['enemy_ships'] == [], 'nothing is revealed before the last cell'
    assert not any('S' in row or 'X' in row for row in view['enemy_cells'])

    fire(game._name(target['cells'][-1]))
    view = game.picture(s, SimpleNamespace(id='w'))
    assert [ship['name'] for ship in view['enemy_ships']] == ['destroyer']
    assert all(view['enemy_cells'][9 - row][col] == 'X' for row, col in target['cells'])
    assert not any('S' in row for row in view['enemy_cells']), 'an unsunk enemy hull is never drawn'
    for ship in s['fleets']['black']:
        if ship['name'] == 'destroyer':
            continue
        for row, col in ship['cells']:
            assert view['enemy_cells'][9 - row][col] in {'.', 'M'}, 'no other hull is drawn'
    assert view['last_shot']['result'] == 'sunk' and view['last_shot']['ship'] == 'destroyer'


def test_bot_levels_are_ordered_by_strength():
    """Beginner is random, Intermediate hunts, Advanced and Expert count placements."""
    def finish(level, seed):
        s = start(seed)
        s['level'] = level
        s.update(white='human', black='local')
        step(s, ('random',)); step(s, ('random',))
        shots = 0
        while s['status'] == 'active':
            if s['cover']:
                step(s, ('look',))
            move = game.bot(s)
            if move[0] == 'fire' and s['turn'] == 'white':
                shots += 1
            step(s, move)
        return shots

    seeds = range(16)
    beginner = sum(finish('beginner', seed) for seed in seeds) / 16
    intermediate = sum(finish('intermediate', seed) for seed in seeds) / 16
    advanced = sum(finish('advanced', seed) for seed in seeds) / 16
    expert = sum(finish('expert', seed) for seed in seeds) / 16
    assert beginner > intermediate + 10, (beginner, intermediate)
    assert intermediate > advanced, (intermediate, advanced)
    assert expert <= advanced + 2, (advanced, expert)


def test_finished_game_still_knows_your_side():
    # The pane asks for the picture with no player attached, and a finished game used to come
    # back with your_side empty: every shot then looked like the enemy's, so a sinking read as
    # "your ship went down" and the player neither saw nor heard their own hit.
    s = setup()
    s.update(status="win", winner="white", white="human", black="local")
    view = game.picture(s)
    assert view["your_side"] == "white", view["your_side"]
    # Two people on one keyboard stay colourless: the screen cannot claim either seat.
    s.update(white="human", black="human", white_id="a", black_id="b")
    assert game.picture(s, player=SimpleNamespace(id="nobody"))["your_side"] == ""


def test_picture_keeps_the_players_own_shot():
    # A turn's shot and the computer's answer arrive in the same request. With only the newest
    # shot published, the board could never show or sound the player's own hit.
    s = setup()
    hull = [game._name(p) for ship in s['fleets']['black'] for p in ship['cells']]
    step(s, ('fire', hull[0]))
    view = game.picture(s)
    shots = view['last_shots']
    assert any(shot['side'] == 'white' for shot in shots), shots
    mine = [shot for shot in shots if shot['side'] == 'white'][-1]
    assert mine['result'] == 'hit' and mine['square'] == hull[0], mine
    assert view['last_shot'] == shots[-1], 'the single newest shot still exists for the marker'


def test_picture_and_replay():
    s = setup()
    s.update(white_id='w', black_id='b')
    view = game.picture(s, SimpleNamespace(id='w'))
    assert not any('S' in row for row in view['enemy_cells'])
    assert game.picture(s)['own_ships'] == []
    for level in game.LEVELS:
        s['level'] = level
        assert game.bot(s) in game.legal(s)
    s['level'] = 'intermediate'
    while s['status'] == 'active':
        step(s, game.bot(s))
    rebuilt = start()
    for token in s['moves'][1:]:
        step(rebuilt, game.parse(token.split()))
    for key in game.fresh():
        assert rebuilt[key] == s[key]
    view = game.picture(s)
    assert view['phase'] == 'over' and any('S' in row for row in view['own_cells'] + view['enemy_cells'])


def test_picture_publishes_the_moves_a_person_can_press():
    # The person-playthrough suite presses moves straight out of the picture, so a
    # hint and the screen must both come from this one list.
    s = start()
    s.update(white_id='w', black_id='b')
    view = game.picture(s, SimpleNamespace(id='w'))
    assert {'random', 'duplicate', 'place carrier a1 h'} <= set(view['legal'])
    s = setup()
    view = game.picture(s, SimpleNamespace(id='w'))
    assert [token for token in view['legal'] if token.startswith('fire ')] and len(view['legal']) >= 100
    assert 'fire e5' in view['legal']
    s['level'] = 'intermediate'
    assert game.show(game.bot(s)) in view['legal']
    s.update(status='win', winner='white')
    assert game.picture(s, SimpleNamespace(id='w'))['legal'] == []


def test_bot_levels_choose_unfired_squares():
    s = setup(47)
    for index in range(50):
        if s['status'] != 'active':
            break
        if s['cover']:
            step(s, ('look',))
        for level in game.LEVELS:
            s['level'] = level
            move = game.bot(s)
            assert move in game.legal(s)
            assert list(game._square(move[1])) not in s['shots'][s['turn']]
        s['level'] = 'beginner'
        step(s, game.bot(s))
