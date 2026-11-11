"""Tests for the staff bootstrap and shared moderation primitives."""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from online import guard
from online.store import Store, token_hash


def test_cli_bootstrap(tmp_path):
    command = [sys.executable, '-m', 'online.admin', '--data', str(tmp_path), 'grant-owner', 'Alice']
    first = subprocess.run(command, capture_output=True, text=True, check=True)
    key = first.stdout.split('Staff key (shown once, keep it out of chat and the repo): ')[1].strip()
    store = Store(tmp_path / 'online.sqlite3')
    try:
        assert store.staff_list()[0]['key_hash'] == token_hash(key)
        assert key not in str(store.staff_list())
    finally:
        store.close()
    second = subprocess.run(command, capture_output=True, text=True)
    assert second.returncode != 0
    assert 'An owner already exists: Alice.' in second.stdout


def test_skeleton_confusables():
    assert guard.skeleton('Admіn') == guard.skeleton('a d m i n')
    assert guard.skeleton('vvorn') == 'wom'


def test_tombstone(tmp_path):
    store = Store(tmp_path / 'db')
    try:
        player, _ = store.create_player('Alice')
        message = store.add_chat('__lobby__', player['id'], 'spoof', 'player', 'private text')
        assert message['name'] == 'Alice'
        store.db.execute('UPDATE chat SET removed = 1 WHERE id = ?', (message['id'],))
        assert store.recent_chat('__lobby__')[0]['text'] == 'removed by a moderator'
    finally:
        store.close()


def test_permission_boundaries():
    from online.admin import allowed
    assert allowed('owner', 'force-rename', 'owner') == 'The owner cannot be changed.'
    assert allowed('admin', 'suspend', 'admin', minutes=10) == 'Only the owner can act on an admin.'
    assert allowed('moderator', 'suspend', minutes=0)
    assert allowed('moderator', 'suspend', minutes=10081)
    assert not allowed('moderator', 'suspend', minutes=10080)
    assert allowed('moderator', 'silence', minutes=0)


def test_punishment_expiry_and_deleted_bot(tmp_path):
    import time
    store = Store(tmp_path / 'db')
    try:
        player, _ = store.create_player('Alice')
        bot, _ = store.create_bot(player['id'], 'Robo')
        store.punish(player['id'], 'suspend', time.time() - 1, 'reason', 'actor', 'Actor')
        store.expire_punishments(time.time())
        assert store.is_active(player['id'])
        store.remove_bot(player['id'], bot['id'])
        store.punish(bot['id'], 'suspend', time.time() - 1, 'reason', 'actor', 'Actor')
        store.expire_punishments(time.time())
        assert not store.is_active(bot['id'])
    finally:
        store.close()
