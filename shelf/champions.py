"""Champion profiles and their local storage."""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
import uuid
from pathlib import Path

MAX_NAME = 32
MAX_MOTTO = 80
MAX_BRIEF = 600
MAX_CHAMPIONS = 64
MAX_IMPORT_BYTES = 20000
AVATARS = (("knight", "♞"), ("rook", "♜"), ("queen", "♛"), ("fang", "⚔"),
           ("spark", "✦"), ("orb", "●"), ("bolt", "⚡"), ("leaf", "❧"))
COLORS = (("amber", "#d9a441"), ("jade", "#3fa66a"), ("sky", "#3d8fdc"),
          ("rose", "#d4577c"), ("violet", "#8a6fd8"), ("steel", "#7c8792"))
_ID = re.compile(r"champ-[0-9a-f]{8}\Z")
_TOKEN = re.compile(r"[A-Za-z0-9._/:-]{0,80}\Z")


def clean_text(value, limit) -> str:
    if not isinstance(value, str):
        return ""
    try:
        text = ''.join(' ' if c in '\r\n\t' else c for c in value if c in '\r\n\t' or unicodedata.category(c) not in ('Cc', 'Cf'))
        return ' '.join(text.split())[:max(0, limit)]
    except (TypeError, ValueError):
        return ""


def validate(raw) -> tuple[dict | None, str]:
    try:
        if not isinstance(raw, dict):
            return None, "That is not a champion."
        if raw.get('schema_version', 1) not in (1, 2):
            return None, "That champion version is not supported."
        name = clean_text(raw.get('name'), MAX_NAME)
        brief = clean_text(raw.get('brief'), MAX_BRIEF)
        playbook = raw.get('playbook', '')
        if not isinstance(playbook, str) or not re.fullmatch(r'pb-[0-9a-f]{8}', playbook):
            playbook = ''
        if not name or (not brief and not playbook):
            return None, "A champion needs a name and a brief."
        avatar = raw.get('avatar', 'knight')
        color = raw.get('color', 'amber')
        if avatar not in dict(AVATARS) or color not in dict(COLORS):
            return None, "Choose a valid avatar and color."
        brain = raw.get('brain', {'kind': 'model'})
        if not isinstance(brain, dict) or brain.get('kind') != 'model':
            return None, "Champions play as this Hermes's model. Profiles are not supported."
        model, provider = brain.get('model', ''), brain.get('provider', '')
        if not isinstance(model, str) or not isinstance(provider, str) or not _TOKEN.fullmatch(model) or not _TOKEN.fullmatch(provider):
            return None, "Model and provider must be short tokens."
        route = raw.get('model', {})
        if not isinstance(route, dict):
            route = {}
        route_model, route_provider = route.get('model', ''), route.get('provider', '')
        if not isinstance(route_model, str) or not isinstance(route_provider, str) or not _TOKEN.fullmatch(route_model) or not _TOKEN.fullmatch(route_provider):
            return None, 'Model and provider must be short tokens.'
        pet = raw.get('pet', {})
        if not isinstance(pet, dict):
            pet = {}
        slug = pet.get('slug', '')
        if not isinstance(slug, str) or not _TOKEN.fullmatch(slug):
            slug = ''
        champion_id = raw.get('id')
        if not isinstance(champion_id, str) or not _ID.fullmatch(champion_id):
            champion_id = 'champ-' + uuid.uuid4().hex[:8]
        created = raw.get('created_at')
        if not isinstance(created, int) or isinstance(created, bool):
            created = int(time.time())
        return {'schema_version': 2, 'id': champion_id, 'name': name,
                'motto': clean_text(raw.get('motto'), MAX_MOTTO), 'avatar': avatar,
                'color': color, 'brief': brief,
                'brain': {'kind': 'model', 'model': model, 'provider': provider},
                'created_at': created, 'playbook': playbook, 'pet': {'slug': slug, 'pin': pet.get('pin') is True}, 'model': {'model': route_model, 'provider': route_provider}}, ''
    except Exception:
        return None, "That champion is invalid."


def avatar_glyph(champion) -> str:
    try:
        return dict(AVATARS).get(champion.get('avatar'), dict(AVATARS)['knight'])
    except Exception:
        return dict(AVATARS)['knight']


def color_hex(champion) -> str:
    try:
        return dict(COLORS).get(champion.get('color'), dict(COLORS)['amber'])
    except Exception:
        return dict(COLORS)['amber']


def story(champion) -> str:
    """Who the champion is: the persona text without the move instruction."""
    if not isinstance(champion, dict):
        champion = {}
    name = clean_text(champion.get('name'), MAX_NAME)
    motto = clean_text(champion.get('motto'), MAX_MOTTO)
    brief = clean_text(champion.get('brief'), MAX_BRIEF)
    text = f"You are {name}, a Game Center champion."
    if motto:
        text += f" Motto: {motto}."
    return f"{text} {brief}"


def persona(champion) -> str:
    return f"{story(champion)}\nReply with exactly one move from the legal moves you are given, and nothing else."


class ChampionStore:
    def __init__(self, folder: Path):
        self.folder = Path(folder) / 'champions'

    def path(self, champion_id):
        if not isinstance(champion_id, str) or not _ID.fullmatch(champion_id):
            return None
        return self.folder / f'{champion_id}.json'

    def ids(self) -> list[str]:
        try:
            return sorted(p.stem for p in self.folder.glob('*.json') if _ID.fullmatch(p.stem) and p.is_file())
        except OSError:
            return []

    def get(self, champion_id) -> dict | None:
        path = self.path(champion_id)
        if path is None:
            return None
        try:
            raw = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(raw, dict) or raw.get('id') != champion_id:
                return None
            return validate(raw)[0]
        except (OSError, ValueError, UnicodeError):
            return None

    def list(self) -> list[dict]:
        return sorted((c for i in self.ids() if (c := self.get(i)) is not None), key=lambda c: (c['created_at'], c['id']))

    def save(self, raw) -> tuple[dict | None, str]:
        champion, error = validate(raw)
        if error:
            return None, error
        ids = self.ids()
        if champion['id'] not in ids and len(ids) >= MAX_CHAMPIONS:
            return None, 'Champions are full (64). Delete one first.'
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            path = self.path(champion['id'])
            temporary = self.folder / ('.' + uuid.uuid4().hex + '.tmp')
            try:
                temporary.write_text(json.dumps(champion, ensure_ascii=False), encoding='utf-8')
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            return champion, ''
        except (OSError, ValueError, UnicodeError):
            return None, 'Could not save the champion.'

    def delete(self, champion_id) -> bool:
        path = self.path(champion_id)
        if path is None:
            return False
        try:
            path.unlink()
            return True
        except OSError:
            return False

    def export(self, champion_id) -> tuple[str, str]:
        champion = self.get(champion_id)
        if champion is None:
            return '', 'Champion not found.'
        return json.dumps({'schema_version': 1, 'kind': 'gamecenter-champion', 'champion': champion}, ensure_ascii=False, indent=2), ''

    def import_text(self, text, *, rename_on_clash=True) -> tuple[dict | None, str]:
        try:
            if not isinstance(text, str):
                return None, 'That is not a champion file.'
            if len(text.encode('utf-8')) > MAX_IMPORT_BYTES:
                return None, 'That file is too large to import.'
            raw = json.loads(text)
            if not isinstance(raw, dict):
                return None, 'That is not a champion file.'
            if 'kind' in raw or 'champion' in raw:
                if raw.get('kind') != 'gamecenter-champion' or raw.get('schema_version') != 1 or not isinstance(raw.get('champion'), dict):
                    return None, 'That is not a champion file.'
                raw = raw['champion']
            champion, error = validate(raw)
            if error:
                return None, error
            if champion['id'] in self.ids():
                champion['id'] = 'champ-' + uuid.uuid4().hex[:8]
                if rename_on_clash:
                    names = {c['name'] for c in self.list()}
                    n = 2
                    while True:
                        suffix = f' ({n})'
                        name = champion['name'][:MAX_NAME-len(suffix)].rstrip() + suffix
                        if name not in names:
                            champion['name'] = name
                            break
                        n += 1
            return self.save(champion)
        except (ValueError, TypeError, UnicodeError, RecursionError):
            return None, 'That is not a champion file.'
