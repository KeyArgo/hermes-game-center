"""Turning AI off also stops already-seated bots, not only creation."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from shelf.catalog import Catalog
from shelf.commands import run


def test_ai_off_blocks_moves_that_would_trigger_an_existing_bot(tmp_path):
    catalog = Catalog([ROOT], tmp_path, {'allow_ai': True})
    run(catalog, 'install connect4')
    run(catalog, 'allow-ai connect4 black=local')
    before = catalog.picture('connect4')
    catalog.settings['allow_ai'] = False
    response = run(catalog, 'connect4 move 4')
    assert 'off' in response.lower()
    assert catalog.picture('connect4') == before


def test_ai_off_blocks_rematch_of_existing_bot_seats(tmp_path):
    catalog = Catalog([ROOT], tmp_path, {'allow_ai': True})
    run(catalog, 'install connect4')
    run(catalog, 'allow-ai connect4 black=local')
    run(catalog, 'connect4 resign')
    catalog.settings['allow_ai'] = False
    assert 'off' in run(catalog, 'connect4 rematch').lower()
