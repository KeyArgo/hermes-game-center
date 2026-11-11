"""Viewer permissions are derived from authority, never a client-supplied seat."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace, ModuleType
import sys
import pytest

ROOT = Path(__file__).resolve().parents[1]

@pytest.fixture(autouse=True)
def load_api(monkeypatch):
    global api
    fake = ModuleType('fastapi')
    class APIRouter:
        def get(self, _path):
            return lambda handler: handler
        post = get
    fake.APIRouter = APIRouter
    monkeypatch.setitem(sys.modules, 'fastapi', fake)
    spec = importlib.util.spec_from_file_location('table_permissions_api', ROOT / 'dashboard/plugin_api.py')
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)


def test_spectator_cannot_control_an_occupied_table():
    pic = {'status': 'active', 'turn': 'white', 'owner_id': 'alice',
           'seats': [{'side': 'white', 'kind': 'human', 'id': 'alice', 'open': False},
                     {'side': 'black', 'kind': 'human', 'id': 'bob', 'open': False}]}
    p = api._permissions(pic, SimpleNamespace(id='eve', platform='discord'), allow_ai=True)
    assert not any(p.values())


def test_desktop_spectator_has_no_controls_on_someone_elses_bot_table():
    pic = {'status': 'active', 'turn': 'white', 'owner_id': 'alice',
           'seats': [{'side': 'white', 'kind': 'local', 'id': 'local', 'open': False},
                     {'side': 'black', 'kind': 'local', 'id': 'local', 'open': False}]}
    p = api._permissions(pic, SimpleNamespace(id='eve', platform='desktop'), allow_ai=True)
    assert not any(p.values())


def test_seated_human_permissions_follow_turn():
    pic = {'status': 'active', 'turn': 'white', 'owner_id': 'alice',
           'seats': [{'side': 'white', 'kind': 'human', 'id': 'alice', 'open': False},
                     {'side': 'black', 'kind': 'local', 'id': 'local', 'open': False}]}
    p = api._permissions(pic, SimpleNamespace(id='alice', platform='discord'), allow_ai=True)
    assert p['can_move'] and p['can_resign'] and p['can_draw']
    assert not p['can_join'] and not p['can_rematch'] and not p['can_step']
    pic['turn'] = 'black'
    p = api._permissions(pic, SimpleNamespace(id='alice', platform='discord'), allow_ai=False)
    assert not p['can_move'] and not p['can_step']


def test_pass_and_play_does_not_override_another_persons_seat():
    pic = {'status': 'active', 'turn': 'black', 'owner_id': 'alice',
           'seats': [{'side': 'white', 'kind': 'human', 'id': 'alice', 'open': False},
                     {'side': 'black', 'kind': 'human', 'id': 'bob', 'open': False}]}
    p = api._permissions(pic, SimpleNamespace(id='local', platform='desktop'), allow_ai=True)
    assert not p['can_move'] and not p['can_manage']


def test_board_exposes_authoritative_viewer_permissions(tmp_path, monkeypatch):
    monkeypatch.setattr(api, '_data_root', lambda: tmp_path / 'data')
    monkeypatch.setattr(api, '_config', lambda: {'plugins': {'enabled': ['hermes-gameshelf']}})
    assert 'library' in api.command({'line': 'install connect4'})['text'].lower()
    api.command({'line': 'connect4 new'})
    picture = api.board('connect4')['picture']
    assert picture['viewer_id'] == 'local'
    assert picture['permissions']['can_move']
    assert api.view()['viewer_id'] == 'local'


def test_legacy_game_without_seat_schema_keeps_its_own_command_contract(tmp_path, monkeypatch):
    class LegacyCatalog:
        settings = {'allow_ai': True}
        def has(self, game): return True
        def kind(self, game): return 'table'
        def picture(self, game): return {'view': 'chess', 'status': 'active', 'turn': 'white'}
        def _needs_install(self, game): return False
    monkeypatch.setattr(api, '_open', lambda: (LegacyCatalog(), api.NameBook(tmp_path / 'names.json')))
    monkeypatch.setattr(api, '_say', lambda line: 'legacy board')
    picture = api.board('chess')['picture']
    assert 'permissions' not in picture


def test_agent_vs_bot_keeps_stepping_on_the_agents_turn():
    """Agent vs bot used to freeze: can_step was true only for a "local" turn,
    so the page stopped watching and disabled Resume bots / Next move."""
    pic = {'status': 'active', 'turn': 'white', 'owner_id': 'alice',
           'seats': [{'side': 'white', 'kind': 'agent', 'id': 'agent', 'name': 'Your agent', 'open': False},
                     {'side': 'black', 'kind': 'local', 'id': 'local', 'name': 'Local', 'open': False}]}
    p = api._permissions(pic, SimpleNamespace(id='alice', platform='desktop'), allow_ai=True)
    assert p['can_step'], 'the agent seat must advance like a bot'
    assert not p['can_move']
    off = api._permissions(pic, SimpleNamespace(id='alice', platform='desktop'), allow_ai=False)
    assert not off['can_step'], 'AI off still stops every AI seat'


def test_agent_against_a_person_steps_on_the_agents_turn():
    pic = {'status': 'active', 'turn': 'black', 'owner_id': 'alice',
           'seats': [{'side': 'white', 'kind': 'human', 'id': 'alice', 'name': 'Ada', 'open': False},
                     {'side': 'black', 'kind': 'agent', 'id': 'agent', 'name': 'Your agent', 'open': False}]}
    p = api._permissions(pic, SimpleNamespace(id='alice', platform='desktop'), allow_ai=True)
    assert p['can_step'] and not p['can_move']
    pic['turn'] = 'white'
    p = api._permissions(pic, SimpleNamespace(id='alice', platform='desktop'), allow_ai=True)
    assert p['can_move'] and not p['can_step'], 'a person on turn is never stepped'


def test_command_refuses_a_too_long_line_instead_of_truncating(monkeypatch):
    seen = []
    monkeypatch.setattr(api, '_say', lambda line: seen.append(line) or 'ok')
    answer = api.command({'line': 'connect4 move ' + '4' * 400})
    assert answer['ok'] is False and 'longer than' in answer['text'], answer
    assert seen == [], 'a truncated line must never reach the table'


def test_command_hands_a_doctrine_import_through_whole(monkeypatch):
    seen = []
    monkeypatch.setattr(api, '_say', lambda line: seen.append(line) or 'Imported a replay.')
    payload = '{"kind":"doctrine-replay","data":{"cards":[],\n"frames":[],"note":"' + 'x' * 400 + '"}}'
    answer = api.command({'line': '/games doctrine import ' + payload})
    assert answer['ok'] is True
    assert seen == ['doctrine import ' + payload], 'the JSON arrived cut or flattened'


@pytest.mark.parametrize('text', [
    'Refused: That column is full.', 'A match is in progress. Finish or resign before starting a new game.',
    'Both seats are taken.', 'Take a seat first: sit black.',
    'Only a seated player can resign.', 'AI is off for this profile.',
    "It's Ada's turn.", 'Finish the current game before requesting a rematch.',
])
def test_command_marks_authority_refusals_as_unsuccessful(monkeypatch, text):
    monkeypatch.setattr(api, '_say', lambda line: text)
    assert api.command({'line': 'connect4 move 4'}) == {'text': text, 'ok': False}


def test_command_marks_normal_result_as_successful(monkeypatch):
    monkeypatch.setattr(api, '_say', lambda line: 'Played 4.\nWhite to move.')
    assert api.command({'line': 'connect4 move 4'})['ok'] is True
