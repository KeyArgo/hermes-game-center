"""Champion playbooks, rival notes, and prompt helpers."""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from .champions import clean_text, persona, story

CAP_TOTAL_WORDS = 250
MIN_READ_QUESTIONS = 2
CAP_READ_QUESTIONS = 3
CAP_READ_QUESTION_WORDS = 20
CAP_TACTICS = 4
CAP_TACTIC_WORDS = 40
CAP_SCOUT_WORDS = 40
CAP_VOICE_WORDS = 40
CAP_VERSION_NAME = 40
MAX_DOSSIER_WORDS = 80
MAX_VERSIONS = 40
_CHAMP = re.compile(r'champ-[0-9a-f]{8}\Z')
_PB = re.compile(r'pb-[0-9a-f]{8}\Z')


def count_words(text) -> int:
    try:
        return len(str(text).split())
    except Exception:
        return 0


def validate(raw) -> tuple[dict | None, str]:
    try:
        if not isinstance(raw, dict):
            return None, 'That is not a playbook.'
        reads, tactics = raw.get('read'), raw.get('tactics')
        if not isinstance(reads, list) or not isinstance(tactics, list):
            return None, 'Read questions and tactics must be lists.'
        if len(reads) < MIN_READ_QUESTIONS:
            return None, 'A playbook needs at least two read questions.'
        if len(reads) > CAP_READ_QUESTIONS:
            return None, 'Three read questions is the most a playbook may have.'
        if len(tactics) > CAP_TACTICS:
            return None, 'Four tactic rules is the most a playbook may have.'
        scout, voice = raw.get('scout', ''), raw.get('voice', '')
        if any(not isinstance(x, str) for x in [*reads, *tactics, scout, voice]):
            return None, 'Every playbook field must be plain text.'
        reads = [clean_text(x, len(x)) for x in reads]
        tactics = [clean_text(x, len(x)) for x in tactics]
        scout, voice = clean_text(scout, len(scout)), clean_text(voice, len(voice))
        if any(not x for x in reads) or any(not x for x in tactics):
            return None, 'Read questions and tactic rules cannot be empty.'
        for values, cap, message in ((reads, CAP_READ_QUESTION_WORDS, 'A read question may be at most 20 words.'), (tactics, CAP_TACTIC_WORDS, 'A tactic rule may be at most 40 words.'), ([scout], CAP_SCOUT_WORDS, 'The scout rule may be at most 40 words.'), ([voice], CAP_VOICE_WORDS, 'The voice may be at most 40 words.')):
            if any(count_words(x) > cap for x in values):
                return None, message
        words = {'read': sum(map(count_words, reads)), 'tactics': sum(map(count_words, tactics)), 'scout': count_words(scout), 'voice': count_words(voice)}
        words['total'] = sum(words.values())
        if words['total'] > CAP_TOTAL_WORDS:
            return None, f"This playbook is {words['total']} words. The cap is 250."
        return {'read': reads, 'tactics': tactics, 'scout': scout, 'voice': voice, 'words': words}, ''
    except Exception:
        return None, 'That playbook is invalid.'


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / ('.' + uuid.uuid4().hex + '.tmp')
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read(path):
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, UnicodeError):
        return None


def _valid(pattern, value):
    return isinstance(value, str) and bool(pattern.fullmatch(value))


class PlaybookStore:
    def __init__(self, folder):
        self.folder = Path(folder) / 'playbooks'

    def get(self, champion_id, version_id):
        if not _valid(_CHAMP, champion_id) or not _valid(_PB, version_id):
            return None
        value = _read(self.folder / champion_id / 'versions' / (version_id + '.json'))
        return value if value and value.get('id') == version_id and value.get('champion_id') == champion_id else None

    def _saved_at(self, champion_id, record):
        """Newest-first order that does not depend on how fine the filesystem clock is.

        Older records only carry whole-second ``created_at``, so they fall back to the file's
        mtime, and a coarse (1-second) filesystem is why ties need the save stamp to break them.
        """
        stamp = record.get('saved_at')
        if isinstance(stamp, (int, float)) and stamp > 0:
            return float(stamp)
        try:
            return os.stat(self.folder / champion_id / 'versions' / (record['id'] + '.json')).st_mtime_ns / 1e9
        except OSError:
            return float(record.get('created_at') or 0)

    def versions(self, champion_id):
        if not _valid(_CHAMP, champion_id):
            return []
        try:
            paths = list((self.folder / champion_id / 'versions').glob('pb-*.json'))
            records = [v for p in paths if (v := self.get(champion_id, p.stem))]
            records.sort(key=lambda v: (self._saved_at(champion_id, v), v['id']), reverse=True)
            return [{'id': v['id'], 'name': v.get('name', ''), 'words': v.get('playbook', {}).get('words', {}), 'created_at': v.get('created_at', 0)} for v in records]
        except Exception:
            return []

    def current(self, champion_id):
        if not _valid(_CHAMP, champion_id):
            return None
        selected = _read(self.folder / champion_id / 'current.json') or {}
        version = self.get(champion_id, selected.get('version_id'))
        versions = self.versions(champion_id)
        return version or (self.get(champion_id, versions[0]['id']) if versions else None)

    def save(self, champion_id, name, playbook):
        if not _valid(_CHAMP, champion_id):
            return None, 'Champion not found.'
        if not isinstance(name, str):
            return None, 'The version name must be plain text.'
        book, error = validate(playbook)
        if error:
            return None, error
        try:
            versions = self.versions(champion_id)
            record = {'schema_version': 2, 'id': 'pb-' + uuid.uuid4().hex[:8], 'champion_id': champion_id, 'name': clean_text(name, CAP_VERSION_NAME) or f'Version {len(versions) + 1}', 'playbook': book, 'created_at': int(time.time()), 'saved_at': time.time()}
            _write(self.folder / champion_id / 'versions' / (record['id'] + '.json'), record)
            _write(self.folder / champion_id / 'current.json', {'version_id': record['id']})
            for old in self.versions(champion_id)[MAX_VERSIONS:]:
                (self.folder / champion_id / 'versions' / (old['id'] + '.json')).unlink(missing_ok=True)
            return record, ''
        except Exception:
            return None, 'Could not save the playbook.'

    def select(self, champion_id, version_id):
        if not self.get(champion_id, version_id):
            return False
        try:
            _write(self.folder / champion_id / 'current.json', {'version_id': version_id})
            return True
        except OSError:
            return False


class DossierStore:
    def __init__(self, folder):
        self.folder = Path(folder) / 'dossiers'

    def get(self, champion_id, opponent_id):
        if not _valid(_CHAMP, champion_id) or not _valid(_CHAMP, opponent_id):
            return None
        return _read(self.folder / champion_id / (opponent_id + '.json'))

    def list(self, champion_id):
        if not _valid(_CHAMP, champion_id):
            return []
        try:
            return [v for p in sorted((self.folder / champion_id).glob('*.json')) if (v := self.get(champion_id, p.stem))]
        except OSError:
            return []

    def forget(self, champion_id, opponent_id):
        if not self.get(champion_id, opponent_id):
            return False
        try:
            (self.folder / champion_id / (opponent_id + '.json')).unlink()
            return True
        except OSError:
            return False

    def note(self, champion_id, opponent_id, *, opponent_name, result, game, illegal=0, rule=''):
        if not _valid(_CHAMP, champion_id) or not _valid(_CHAMP, opponent_id) or result not in ('win', 'loss', 'draw'):
            return None
        try:
            old = self.get(champion_id, opponent_id) or {}
            wins = int(old.get('wins', 0)) + (result == 'win')
            losses = int(old.get('losses', 0)) + (result == 'loss')
            draws = int(old.get('draws', 0)) + (result == 'draw')
            name = clean_text(opponent_name, 80) or 'Rival'
            tail = re.split(r'(?<=[.!?])\s', clean_text(rule, 1000), maxsplit=1)[0] or 'Watch their play.'
            text = f'{name}: {wins + losses + draws} matches, we won {wins}, lost {losses}, drew {draws}. {max(0, int(illegal))} illegal replies. {tail}'
            text = ' '.join(text.split()[:MAX_DOSSIER_WORDS])
            record = {'schema_version': 1, 'champion': champion_id, 'opponent': opponent_id, 'opponent_name': name, 'text': text, 'words': count_words(text), 'matches': wins + losses + draws, 'wins': wins, 'losses': losses, 'draws': draws, 'updated_at': int(time.time())}
            _write(self.folder / champion_id / (opponent_id + '.json'), record)
            return record
        except Exception:
            return None


def system_text(champion, version) -> str:
    if not isinstance(version, dict) or not isinstance(version.get('playbook'), dict):
        return persona(champion)
    book = version['playbook']
    return story(champion) + '\nRead questions: ' + '; '.join(book.get('read', [])) + '\nTactics: ' + '; '.join(book.get('tactics', [])) + '\nScout: ' + book.get('scout', '') + '\nVoice: ' + book.get('voice', '')


def move_prompt(*, rules, state, legal, moves, champion, dossiers) -> str:
    side = state['turn']
    names = [str(rules.show(m)).lower() for m in legal]
    mark = rules.MARKS[0 if side == 'white' else 1]
    lines = [f'You are playing {rules.TITLE} as {side} ({mark}).', *rules.HELP, '', 'Board:', *rules.draw(state), '', 'Moves so far: ' + (' '.join(moves[-20:]) or 'none'), 'Legal moves: ' + ', '.join(names)]
    version = champion.get('playbook_version') or {}
    book = version.get('playbook') or {}
    if book:
        if isinstance(dossiers, dict) and dossiers.get('text'):
            lines.append('What you know about this rival: ' + dossiers['text'])
        lines += ['Before you move, answer these privately, one short line each:', *book.get('read', []), 'Tactics:', *book.get('tactics', []), 'Record after the game (your scout rule): ' + book.get('scout', ''), 'How you speak: ' + book.get('voice', ''), "Write your private answers first, then a final line 'MOVE: <move>' with exactly one legal move."]
    else:
        lines.append('Reply with exactly one legal move from that list and nothing else.')
    return '\n'.join(lines)


def pick_move(text, names, rules, legal, picker):
    try:
        return picker(re.split(r'MOVE\s*:', text, flags=re.IGNORECASE)[-1], names, rules, legal)
    except Exception:
        return None


def reads_from(text) -> list[str]:
    try:
        parts = list(re.finditer(r'MOVE\s*:', text, flags=re.IGNORECASE))
        return [line.strip()[:120] for line in text[:parts[-1].start()].splitlines() if line.strip()][:CAP_READ_QUESTIONS] if parts else []
    except Exception:
        return []
