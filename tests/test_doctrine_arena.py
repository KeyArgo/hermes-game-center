"""Tests for the Doctrine Arena strategy-card module."""

import copy
import json
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from doctrine_arena import card  # noqa: E402
from doctrine_arena import engine  # noqa: E402


def _sample_card(**overrides):
    base = dict(card.HOUSE_CARDS[0])
    base.update(overrides)
    return base


def test_house_cards_validate_and_round_trip():
    """Every house card validates, preserves key order, and round-trips through dump/validate."""
    assert len(card.HOUSE_CARDS) == 4
    names = [c['name'] for c in card.HOUSE_CARDS]
    assert names == ['Bulwark', 'Skirmisher', 'Sniper', 'Bruiser']

    for preset in card.HOUSE_CARDS:
        validated = card.validate(preset)
        assert validated == preset
        assert validated is not preset
        assert tuple(validated.keys()) == card.KEYS

        dumped = card.dump(preset)
        assert dumped == json.dumps(
            preset, sort_keys=True, separators=(',', ':'), ensure_ascii=True
        )
        assert card.validate(dumped) == preset
        assert card.load(dumped) == preset


def test_validate_accepts_json_string():
    """A card given as a JSON string validates into a normalised dict."""
    raw_json = json.dumps(_sample_card(name='Iron-Wolf 1'))
    result = card.validate(raw_json)
    assert result['name'] == 'Iron-Wolf 1'
    assert tuple(result.keys()) == card.KEYS


def test_validate_does_not_mutate_input():
    """The input dict is not mutated by validate()."""
    shuffled = {k: _sample_card()[k] for k in reversed(card.KEYS)}
    shuffled['name'] = '  Bulwark  '
    snapshot = copy.deepcopy(shuffled)

    result = card.validate(shuffled)
    assert shuffled == snapshot
    assert result is not shuffled
    assert result['name'] == 'Bulwark'
    assert tuple(result.keys()) == card.KEYS


def test_unknown_key_rejected():
    """Cards with unknown keys are rejected."""
    bad = _sample_card(extra='nope')
    with pytest.raises(card.CardError):
        card.validate(bad)


@pytest.mark.parametrize('missing_key', card.KEYS)
def test_missing_key_rejected(missing_key):
    """Cards missing any required key are rejected."""
    bad = _sample_card()
    del bad[missing_key]
    with pytest.raises(card.CardError):
        card.validate(bad)


def test_wrong_kind_rejected():
    """Cards with a wrong kind are rejected."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(kind='other-card'))


def test_schema_version_2_rejected():
    """Cards with schema_version 2 are rejected."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(schema_version=2))


@pytest.mark.parametrize('field', ('schema_version', 'aggression', 'range', 'jink'))
@pytest.mark.parametrize('bad_bool', (True, False))
def test_bool_rejected_where_int_required(field, bad_bool):
    """Booleans are rejected wherever an integer is required."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(**{field: bad_bool}))


@pytest.mark.parametrize('field', ('schema_version', 'aggression', 'range', 'jink'))
def test_float_rejected(field):
    """Floats are rejected where an integer is required."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(**{field: 1.0}))


@pytest.mark.parametrize('field', ('aggression', 'range', 'jink'))
@pytest.mark.parametrize('bad_val', (-1, 11, 99))
def test_out_of_range_int_rejected(field, bad_val):
    """Stat integers outside 0..10 are rejected."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(**{field: bad_val}))


def test_25_char_name_rejected():
    """A 25-character name is rejected, while 24 characters is accepted."""
    assert card.validate(_sample_card(name='A' * 24))['name'] == 'A' * 24
    with pytest.raises(card.CardError):
        card.validate(_sample_card(name='A' * 25))


@pytest.mark.parametrize('bad_name', ('<script>', 'Tank!', '', '   ', 123))
def test_invalid_name_rejected(bad_name):
    """Names with '<script>', invalid characters, empty strings, or non-strings are rejected."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(name=bad_name))


@pytest.mark.parametrize('bad_field,bad_val', [
    ('move', 'teleport'),
    ('weapon', 'laser'),
    ('armour', 'reactive'),
    ('focus', 'random'),
])
def test_invalid_enum_choices_rejected(bad_field, bad_val):
    """Invalid move, weapon, armour, or focus values are rejected."""
    with pytest.raises(card.CardError):
        card.validate(_sample_card(**{bad_field: bad_val}))


@pytest.mark.parametrize('non_dict_input', ('[1, 2, 3]', '"just a string"', '42', 'null', '{bad json', [1, 2], 42, None))
def test_non_dict_json_rejected(non_dict_input):
    """Non-dict JSON strings, invalid JSON, and non-dict Python values are rejected."""
    with pytest.raises(card.CardError):
        card.validate(non_dict_input)


def test_house_lookup_case_insensitive_and_unknown_raises():
    """house() is case-insensitive and raises CardError with exact message when absent."""
    bulwark = card.house('bulwark')
    assert bulwark == card.HOUSE_CARDS[0]
    assert card.house('BULWARK') == bulwark
    assert card.house('SkIrMiShEr')['name'] == 'Skirmisher'

    with pytest.raises(card.CardError, match=r'^No house card named Ghost\.$'):
        card.house('Ghost')


def test_describe_mentions_armour_and_move():
    """describe() returns a single line mentioning the armour and move."""
    for preset in card.HOUSE_CARDS:
        text = card.describe(preset)
        assert '\n' not in text
        assert preset['armour'] in text
        assert preset['move'] in text
        assert preset['weapon'] in text
        assert preset['focus'] in text

    custom = _sample_card(
        name='Bulwark',
        armour='heavy',
        weapon='cannon',
        move='advance',
        focus='nearest',
        aggression=6,
        range=5,
        jink=2,
    )
    assert card.describe(custom) == (
        'Bulwark — heavy armour, cannon, advances, focuses the nearest, '
        'aggression 6/10, range 5/10, jink 2/10'
    )


def test_simulate_determinism_and_seed_variation():
    """Two runs with the same seed and cards give the same digest; a different seed gives a different digest."""
    cards = [card.house('Bulwark'), card.house('Skirmisher')]
    r1 = engine.simulate(cards, seed=42)
    r2 = engine.simulate(cards, seed=42)
    r3 = engine.simulate(cards, seed=99)

    assert engine.digest(r1) == engine.digest(r2)
    assert r1 == r2
    assert engine.digest(r1) != engine.digest(r3)


def test_simulate_1v1_structure_and_frames():
    """A 1v1 house battle produces valid winner, duration, and strictly increasing keyframes."""
    cards = [card.house('Bulwark'), card.house('Bruiser')]
    replay = engine.simulate(cards, seed=7)

    assert replay['kind'] == engine.REPLAY_KIND
    assert replay['schema_version'] == engine.REPLAY_VERSION
    assert replay['result']['winner'] in (0, 1)
    assert 0 < replay['duration'] <= 40.0

    frames = replay['frames']
    assert len(frames) >= 20
    assert frames[0][0] == 0.0

    prev_t = -1.0
    for frame in frames:
        t, tanks, bullets = frame
        assert t > prev_t
        prev_t = t
        assert len(tanks) == 2
        for tk in tanks:
            assert len(tk) == 5
            assert all(isinstance(v, (int, float)) for v in tk)
            assert 0 <= tk[2] < 360
            assert 0 <= tk[3] < 360
            assert tk[4] >= 0
        assert isinstance(bullets, list)
        for b in bullets:
            assert len(b) == 3
            assert all(isinstance(v, (int, float)) for v in b)


def test_simulate_4_tank_house_battle():
    """A 4-tank battle of all four house cards finishes with a winner in 0..3 and at most 40 seconds."""
    cards = [card.house(c['name']) for c in card.HOUSE_CARDS]
    replay = engine.simulate(cards, seed=123)

    assert replay['result']['winner'] in (0, 1, 2, 3)
    assert 0 < replay['duration'] <= 40.0


def test_result_lists_and_kills_sum_to_dead_tanks():
    """The result lists have one entry per seat and kills never exceed the number of dead tanks."""
    cards = [card.house(c['name']) for c in card.HOUSE_CARDS]
    replay = engine.simulate(cards, seed=123)
    res = replay['result']

    assert len(res['kills']) == 4
    assert len(res['damage']) == 4
    assert len(res['hp']) == 4

    dead_tanks = sum(1 for hp in res['hp'] if hp == 0)
    # A tank caught by the storm dies with no killer, so the total can be lower.
    assert sum(res['kills']) <= dead_tanks


def test_a_kill_is_only_credited_to_a_tank_that_shot_the_victim():
    """Every credited kill follows a hit by the same tank on the same victim; storm deaths credit nobody."""
    for first in card.HOUSE_CARDS:
        for second in card.HOUSE_CARDS:
            for seed in range(6):
                replay = engine.simulate([dict(first), dict(second)], seed)
                for event in replay['events']:
                    if event['kind'] != 'kill':
                        continue
                    if event['by'] is None:
                        continue
                    shot_before = any(
                        hit['kind'] == 'hit'
                        and hit['by'] == event['by']
                        and hit['on'] == event['on']
                        and hit['t'] <= event['t']
                        for hit in replay['events']
                    )
                    assert shot_before, (
                        f"{event['by']} was credited with killing {event['on']} "
                        f'without ever hitting it (seed {seed})'
                    )


def test_events_contain_hit_and_kill_with_valid_schema():
    """Events contain at least one 'hit' and one 'kill' in a 2-tank battle and have valid fields."""
    cards = [card.house('Bulwark'), card.house('Bruiser')]
    replay = engine.simulate(cards, seed=7)
    events = replay['events']

    kinds = {e['kind'] for e in events}
    assert 'hit' in kinds
    assert 'kill' in kinds

    for ev in events:
        assert isinstance(ev['t'], (int, float))
        assert ev['kind'] in {'shot', 'hit', 'kill'}


def test_frames_are_bounded():
    """Frames are bounded by 40 / (KEY_TICKS * TICK_SECONDS) + 2."""
    cards = [card.house('Bulwark'), card.house('Skirmisher')]
    replay = engine.simulate(cards, seed=11)
    max_allowed = 40.0 / (engine.KEY_TICKS * engine.TICK_SECONDS) + 2
    assert len(replay['frames']) <= max_allowed


def test_summary_mentions_winner_and_beat():
    """summary(replay) mentions the winner's card name and the word 'beat'."""
    cards = [card.house('Bulwark'), card.house('Skirmisher')]
    replay = engine.simulate(cards, seed=7)
    winner_seat = replay['result']['winner']
    winner_name = replay['combatants'][winner_seat]['name']

    text = engine.summary(replay)
    assert winner_name in text
    assert 'beat' in text


def test_simulate_with_one_card_raises_value_error():
    """simulate with fewer than two cards raises ValueError."""
    with pytest.raises(ValueError, match='A battle needs at least two cards'):
        engine.simulate([card.house('Bulwark')], seed=1)


def test_simulate_with_invalid_card_raises_card_error():
    """simulate with a card whose 'move' is replaced by '<script>' raises card.CardError."""
    bad = _sample_card(move='<script>')
    with pytest.raises(card.CardError):
        engine.simulate([bad, card.house('Bulwark')], seed=1)


def test_simulate_does_not_mutate_input_cards():
    """simulate does not mutate the card dicts it was given."""
    given = [dict(card.house('Bulwark')), dict(card.house('Skirmisher'))]
    given[0]['name'] = '  Bulwark  '
    snapshot = copy.deepcopy(given)

    engine.simulate(given, seed=5)
    assert given == snapshot


def test_hold_jink_10_battle_ends_by_time_limit():
    """A battle between two Bulwark cards with move 'hold' and jink 10 ends within 40.0s with a winner."""
    c1 = _sample_card(move='hold', jink=10)
    c2 = _sample_card(move='hold', jink=10)
    replay = engine.simulate([c1, c2], seed=17)

    assert replay['duration'] <= 40.0
    assert replay['result']['winner'] in (0, 1)



def _load_game_module():
    import importlib.util

    game_path = ROOT / 'doctrine_arena' / 'game.py'
    spec = importlib.util.spec_from_file_location('_shelf_doctrine_arena', game_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_shelf_load_and_preview(tmp_path):
    """game.py loads by file path via importlib, command('help') mentions play, and picture() returns a preview."""
    manifest = json.loads((ROOT / 'doctrine_arena' / 'game.json').read_text(encoding='utf-8'))
    assert manifest == {
        'id': 'doctrine-arena',
        'plugin': 'hermes-gameshelf',
        'title': 'Olympus Arena',
        'subtitle': 'The arena of the gods',
        'summary': (
            'Send a champion into Olympus Arena. A strategy card decides the whole '
            'battle, it plays out on its own, and it replays exactly from its seed. '
            'No model is called while the tanks fight.'
        ),
        'entry': 'game.py',
        'factory': 'create',
        'bots': True,
        'kind': 'play',
    }

    mod = _load_game_module()
    arena = mod.create(tmp_path)

    help_out = arena.command('help')
    assert 'play' in help_out

    pic = arena.picture()
    assert pic['view'] == 'arena'
    assert isinstance(pic['frames'], list) and len(pic['frames']) > 0
    assert pic['preview'] is True


def test_play_command_determinism_and_state(tmp_path):
    """command('play 7') saves state with matching digest prefix and repeats identically."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    out1 = arena.command('play 7')
    assert 'beat' in out1
    assert 'Replay ' in out1

    state_path = tmp_path / 'state.json'
    assert state_path.exists()
    state_data = json.loads(state_path.read_text(encoding='utf-8'))
    assert state_data['schema_version'] == 2
    assert len(state_data['battle_id']) == 16
    assert engine.digest(state_data['replay']).startswith(state_data['battle_id'])

    out2 = arena.command('play 7')
    assert out1.splitlines()[0] == out2.splitlines()[0]


def test_card_selection_and_unknown_house_card(tmp_path):
    """command('card skirmisher') selects Skirmisher and an unknown name returns the expected error line."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    set_out = arena.command('card skirmisher')
    assert 'Skirmisher' in set_out
    assert 'Skirmisher' in arena.command('card')

    unknown_out = arena.command('card phantom')
    assert 'No house card named' in unknown_out


def test_card_set_validation_and_length_limit(tmp_path):
    """command('card set {bad json') fails validation and a 700-char valid card is refused as too long."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    bad_out = arena.command('card set {bad json')
    assert bad_out.startswith('That card is not valid')

    base_json = json.dumps(card.house('Bulwark'))
    long_valid_json = '{' + (' ' * (700 - len(base_json))) + base_json[1:]
    assert len(long_valid_json) == 700
    assert card.validate(long_valid_json)['name'] == 'Bulwark'

    long_out = arena.command(f"card set '{long_valid_json}'")
    assert 'too long' in long_out
    assert 'too long' in arena.command(f'card set {long_valid_json}')


def test_ffa_battle_four_combatants(tmp_path):
    """command('ffa 3') runs a 4-tank battle with a winner in 0..3."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    out = arena.command('ffa 3')
    assert 'beat' in out

    pic = arena.picture()
    assert len(pic['combatants']) == 4
    assert pic['result']['winner'] in (0, 1, 2, 3)


def test_picture_after_battle_not_preview_and_battle_id_matches_digest(tmp_path):
    """picture() after a battle has preview False and battle_id equal to the first 16 chars of engine.digest(replay)."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    arena.command('play 7')
    saved = json.loads((tmp_path / 'state.json').read_text(encoding='utf-8'))
    pic = arena.picture()

    assert pic['preview'] is False
    assert pic['battle_id'] == engine.digest(saved['replay'])[:16]


def test_corrupt_state_file_does_not_raise(tmp_path):
    """A corrupt state.json does not raise in picture() or command('state')."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    (tmp_path / 'state.json').write_text('{not json', encoding='utf-8')

    pic = arena.picture()
    assert isinstance(pic, dict)
    assert pic['view'] == 'arena'

    state_text = arena.command('state')
    assert isinstance(state_text, str)
    assert 'Your card:' in state_text


def test_no_model_called_during_battle(tmp_path):
    """Passing a throwing complete callback to command('play 5') succeeds without calling the model."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    out = arena.command(
        'play 5',
        complete=lambda *a: (_ for _ in ()).throw(AssertionError('model called')),
    )
    assert 'beat' in out


def test_battle_counter_restarts_the_same_replay(tmp_path):
    """Playing the same seed twice keeps the battle id but bumps battle_seq, so the page replays it."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    arena.command('play 7')
    first = arena.picture()
    assert first['battle_seq'] == 1

    arena.command('play 7')
    second = arena.picture()
    assert second['battle_id'] == first['battle_id'], 'the same seed is the same battle'
    assert second['battle_seq'] == 2, 'a second showing must ask the page to restart'

    arena.command('card skirmisher')
    third = arena.picture()
    assert third['battle_seq'] == 2, 'changing a card does not start a battle'


def test_card_name_with_a_space_survives_the_command_line(tmp_path):
    """`card set name=Iron Wolf ...` keeps both words: the shelf shlex pass has eaten the quotes."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    out = arena.command(
        'card set name=Iron Wolf move=flank weapon=sniper armour=light '
        'aggression=3 range=9 jink=3 focus=leader'
    )
    assert out.startswith('Card set:'), out
    assert arena.picture()['card']['name'] == 'Iron Wolf'


def test_saving_leaves_no_temp_file_behind(tmp_path):
    """Each save uses its own temp name and cleans it up, so concurrent commands cannot collide."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    arena.command('play 7')
    arena.command('card skirmisher')

    leftovers = sorted(path.name for path in tmp_path.glob('state.json.*'))
    assert leftovers == []
    assert not (tmp_path / 'state.lock').exists(), 'a normal save releases its lock'


def test_an_abandoned_lock_does_not_wedge_the_game(tmp_path):
    """A lock left behind by a command that died is broken instead of blocking every later save."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    lock = tmp_path / 'state.lock'
    lock.write_text('a-dead-command-token', encoding='ascii')
    old = time.time() - 60
    os.utime(lock, (old, old))

    assert 'beat' in arena.command('play 7')
    assert not lock.exists()


def test_a_busy_lock_is_refused_not_written_through(tmp_path, monkeypatch):
    """A lock someone else holds is waited on, then refused with a plain message — no silent overwrite."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)
    monkeypatch.setattr(mod, 'LOCK_WAIT_SECONDS', 0.05)

    lock = tmp_path / 'state.lock'
    lock.write_text('someone-else', encoding='ascii')

    out = arena.command('play 7')
    assert out.startswith('Another command is saving'), out
    assert not (tmp_path / 'state.json').exists(), 'a refused save writes nothing'
    assert lock.exists(), 'the other command keeps its lock'


def test_two_commands_do_not_overwrite_each_other(tmp_path):
    """A save keeps the field it did not change, so a card change and a battle cannot undo each other."""
    mod = _load_game_module()
    arena = mod.create(tmp_path)

    # A battle began before a card change landed: it must not restore the old card.
    arena.command('play 7')
    first_replay = json.loads((tmp_path / 'state.json').read_text(encoding='utf-8'))['replay']
    arena.command('card sniper')
    newer = engine.simulate([card.house('Bulwark'), card.house('Skirmisher')], 8)
    arena._save_state(card.house('Bulwark'), newer, engine.digest(newer)[:16])
    saved = json.loads((tmp_path / 'state.json').read_text(encoding='utf-8'))
    assert saved['card']['name'] == 'Sniper', 'the newest card survives a slow battle save'
    assert saved['battle_id'] == engine.digest(newer)[:16]

    # A card change began before a battle landed: it must not throw the battle away.
    arena._save_state(card.house('Bruiser'), first_replay, owns='card')
    saved = json.loads((tmp_path / 'state.json').read_text(encoding='utf-8'))
    assert saved['card']['name'] == 'Bruiser'
    assert saved['battle_id'] == engine.digest(newer)[:16], 'the newest battle survives a slow card save'

