import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shelf import catalog as catalog_module
from shelf.catalog import Catalog, ship_failed, ship_states
from tools.ship_gate.registry import BY_ID, CHECKS
from tools.ship_gate.report import save

ROOT = Path(__file__).resolve().parents[1]


def results(status='pass'):
    return {name: {'status': status, 'reason': '', 'evidence': []} for name in CHECKS}


def test_registry_contains_curated_and_fixed_surfaces():
    curated = json.loads(open('shelf/curated.json', encoding='utf-8').read())['games']
    assert set('chess' if item == 'chessboard' else item for item in curated) <= set(BY_ID)
    assert {'doctrine', 'doctrine-arena', 'talk-auction', 'talk-liarsdice',
            'talk-prisoners-dilemma', 'talk-mafia', 'liars-dice-2v2', 'mafia-town',
            'chess-coach', 'lobby', 'champions', 'side-pane', 'admin',
            'sea-battle'} <= set(BY_ID)


def test_writers_and_merge(tmp_path):
    save(tmp_path, {'connect4': results()})
    assert json.loads((tmp_path / 'shelf/ship.json').read_text())['connect4']['ship']
    other = results()
    other['clear'] = {'status': 'skip', 'reason': 'model pass pending', 'evidence': ['proof/shot.png']}
    save(tmp_path, {'chess': other}, merge=True)
    data = json.loads((tmp_path / 'ship_gate.json').read_text())
    ship = json.loads((tmp_path / 'shelf/ship.json').read_text())
    assert set(data) == {'connect4', 'chess'}
    assert ship['connect4']['ship'] and not ship['chess']['ship']
    text = (tmp_path / 'SHIP-GATE.md').read_text()
    assert 'model pass pending' in text and 'proof/shot.png' in text


def test_apply_flags_preserves_manifest(tmp_path):
    (tmp_path / 'connect4').mkdir()
    (tmp_path / 'connect4/game.json').write_text('{"name": "test"}')
    save(tmp_path, {'connect4': results('fail')}, apply_flags=True, directories={'connect4': 'connect4'})
    assert json.loads((tmp_path / 'connect4/game.json').read_text()) == {'name': 'test', 'ship': False}


def test_ship_states_tolerates_missing_and_broken_files(tmp_path):
    assert ship_states(tmp_path / 'absent.json') == {}
    broken = tmp_path / 'broken.json'
    broken.write_text('{not json')
    assert ship_states(broken) == {}
    good = tmp_path / 'good.json'
    good.write_text(json.dumps({'connect4': {'ship': False, 'fails': ['play']}, 'chess': {'ship': True}}))
    states = ship_states(good)
    assert ship_failed(states, 'connect4') and not ship_failed(states, 'chess')
    assert not ship_failed(states, 'unknown')


def test_release_switch_moves_a_failed_game_from_play_to_labs(tmp_path, monkeypatch):
    """A game the ship gate failed leaves Play and appears on the Labs shelf, badged."""
    ship = tmp_path / 'ship.json'
    ship.write_text(json.dumps({'connect4': {'ship': False, 'fails': ['play: level buttons are Easy/Normal/Hard']}}))
    monkeypatch.setattr(catalog_module, '_SHIP_FILE', ship)
    catalog = Catalog([ROOT.parent], tmp_path / 'data', {'allow_ai': True})
    catalog.library.add('connect4')
    catalog.library.add('chessboard')
    play_ids = {card['id'] for card in catalog.play_cards()}
    labs = {card['id']: card for card in catalog.labs_games()}
    assert 'connect4' not in play_ids, 'a failed game must not sit on the reviewed Play shelf'
    assert 'chessboard' in play_ids, 'a passing game stays in Play'
    assert 'connect4' in labs, 'the dev build still shows it, under Labs'
    assert labs['connect4']['ship'] is False
    assert labs['connect4']['gate_fails'] == ['play: level buttons are Easy/Normal/Hard']
