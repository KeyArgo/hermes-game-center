"""A bot identity cannot masquerade as a human even on command transport."""
from pathlib import Path
from types import SimpleNamespace
import sys
import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from connect4.game import create
from shelf.kitref import kit

@pytest.mark.parametrize('command', ['new', 'join', 'sit black', 'leave', 'resign', 'draw', 'rematch', 'abandon', 'move 4', 'step', 'allow-ai black=local'])
def test_bot_identity_is_not_human_consent(tmp_path, command):
    game = create(tmp_path)
    human = SimpleNamespace(id='Ada', name='Ada', platform='irc', bot=False)
    bot = SimpleNamespace(id='helper', name='helper', platform='irc', bot=True)
    game.command('new', player=human)
    before = kit.load(tmp_path)
    assert game.command(command, source='command', player=bot) == 'Refused (person_required).'
    assert kit.load(tmp_path) == before
