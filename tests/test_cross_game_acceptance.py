"""Cross-game acceptance through the catalog, including duplicate plugin scan order."""
from pathlib import Path
import sys
import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from shelf.catalog import Catalog
from shelf.commands import run
from shelf.who import Player

GAMES = ['connect4', 'reversi', 'checkers', 'breakthrough', 'gomoku', 'chessboard', 'go', 'hex']

@pytest.mark.parametrize('game', GAMES)
def test_two_people_finish_and_rematch_each_game_via_catalog(tmp_path, game):
    catalog = Catalog([ROOT.parent], tmp_path, {'allow_ai': True})
    ada, bea, eve = [Player(name, name, 'irc') for name in ['Ada', 'Bea', 'Eve']]
    assert 'library' in run(catalog, f'install {game}', player=ada).lower(), 'a shipped game is already in the library'
    run(catalog, f'{game} new', player=ada)
    run(catalog, f'{game} sit black', player=bea)
    before = catalog.picture(game)
    run(catalog, f'{game} move {before["legal"][0]}', player=eve)
    assert catalog.picture(game) == before
    run(catalog, f'{game} move {before["legal"][0]}', player=ada)
    moved = catalog.picture(game)
    assert moved['plies'] == 1 and len(moved['moves']) == 1
    run(catalog, f'{game} resign', player=bea)
    assert catalog.picture(game)['score'] == {'white': 1, 'black': 0, 'draws': 0}
    run(catalog, f'{game} rematch', player=ada)
    assert catalog.picture(game)['status'] == 'resigned'
    run(catalog, f'{game} rematch', player=bea)
    reloaded = Catalog([ROOT.parent], tmp_path, {'allow_ai': True}).picture(game)
    assert reloaded['status'] == 'active' and reloaded['plies'] == 0
    assert reloaded['table_id'] == before['table_id']
    assert reloaded['score'] == {'white': 1, 'black': 0, 'draws': 0}


@pytest.mark.parametrize('game', GAMES)
def test_watch_bots_each_game_finishes_through_paced_steps(tmp_path, game):
    catalog = Catalog([ROOT.parent], tmp_path, {'allow_ai': True})
    ada = Player('Ada', 'Ada', 'irc')
    run(catalog, f'install {game}', player=ada)
    run(catalog, f'allow-ai {game} white=local black=local', player=ada)
    picture = catalog.picture(game)
    assert picture['plies'] == 1
    for _ in range(1000):
        if picture['status'] != 'active':
            break
        prior_plies = picture['plies']
        run(catalog, f'{game} step', player=ada)
        picture = catalog.picture(game)
        assert picture['plies'] == prior_plies + 1
    assert picture['status'] in {'win', 'draw'}
    assert sum(picture['score'].values()) == 1
