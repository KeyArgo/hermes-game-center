"""Game Shelf entry point and command handler for Doctrine Arena."""

import json
import logging
import os
import random
import shlex
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
# Import through the package, not the bare module names: engine.py itself does
# `from doctrine_arena import card`, and two copies of the card module would be
# a trap for the next reader.
from doctrine_arena import card as _card  # noqa: E402
from doctrine_arena import engine as _engine  # noqa: E402

log = logging.getLogger(__name__)

ID = 'doctrine-arena'
TITLE = 'Olympus Arena'
EXAMPLE = 'play'
MAX_CARD_TEXT = 600
# How long a save waits for another command's save, and when an abandoned lock is
# treated as stale. Both are short: a battle is saved in milliseconds.
LOCK_WAIT_SECONDS = 3.0
LOCK_STALE_SECONDS = 10.0

HELP = [
    'A battle is decided by a strategy card: move, weapon, armour and three dials. Try /games doctrine-arena play.',
    '/games doctrine-arena play [seed]   1v1: your card against a house card',
    '/games doctrine-arena ffa [seed]    your card against three house cards',
    '/games doctrine-arena cards         the four house cards',
    '/games doctrine-arena card <name>   take a house card as yours',
    '/games doctrine-arena card set name=Sniper move=flank weapon=sniper armour=light aggression=3 range=9 jink=3 focus=leader',
    '/games doctrine-arena state         your card and the last battle',
]

_DEMO_REPLAY = _engine.simulate(
    [_card.house('Bulwark'), _card.house('Skirmisher')], 1
)


def _is_valid_replay(replay: object) -> bool:
    """Return True if replay is a dict containing valid frames, result, and metadata."""
    if not isinstance(replay, dict):
        return False
    frames = replay.get('frames')
    result = replay.get('result')
    combatants = replay.get('combatants')
    if not isinstance(frames, list) or not isinstance(result, dict):
        return False
    if not isinstance(combatants, list) or not combatants:
        return False
    winner = result.get('winner')
    if not isinstance(winner, int) or isinstance(winner, bool):
        return False
    if not (0 <= winner < len(combatants)):
        return False
    if not isinstance(combatants[winner], dict) or 'name' not in combatants[winner]:
        return False
    for key in ('events', 'seed', 'duration', 'key_interval_seconds', 'arena'):
        if key not in replay:
            return False
    return True


class SaveBusy(OSError):
    """Another command held the state lock for longer than a save may wait."""


class Arena:
    """Doctrine Arena game session persisted inside a directory root."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _state_path(self) -> Path:
        return self.root / 'state.json'

    def _load_state(self) -> tuple[dict, dict | None, str, int]:
        """Defensively read <root>/state.json and return (card, replay, battle_id, battle_seq)."""
        default_card = _card.house('Bulwark')
        try:
            raw_text = self._state_path().read_text(encoding='utf-8')
            data = json.loads(raw_text)
            if not isinstance(data, dict):
                return default_card, None, '', 0
        except (OSError, ValueError, KeyError, TypeError):
            return default_card, None, '', 0

        raw_seq = data.get('battle_seq', 0)
        battle_seq = (
            raw_seq
            if isinstance(raw_seq, int) and not isinstance(raw_seq, bool) and raw_seq >= 0
            else 0
        )

        try:
            saved_card = _card.validate(data['card'])
        except (_card.CardError, KeyError, TypeError, ValueError):
            saved_card = default_card

        raw_replay = data.get('replay')
        if _is_valid_replay(raw_replay):
            saved_replay = raw_replay
            raw_battle_id = data.get('battle_id')
            if isinstance(raw_battle_id, str) and raw_battle_id:
                battle_id = raw_battle_id[:16]
            else:
                try:
                    battle_id = _engine.digest(saved_replay)[:16]
                except (TypeError, ValueError):
                    saved_replay = None
                    battle_id = ''
        else:
            saved_replay = None
            battle_id = ''

        return saved_card, saved_replay, battle_id, battle_seq

    def _save_state(
        self,
        user_card: dict,
        replay: dict | None,
        battle_id: str | None = None,
        *,
        owns: str = 'battle',
    ) -> str:
        """Write <root>/state.json and return the battle_id.

        Two commands can run at once (a card change and a battle in another chat),
        so this never writes back a field it did not just change: it re-reads the
        file and keeps the *other* side from disk. ``owns='card'`` keeps whatever
        battle is stored; ``owns='battle'`` keeps whatever card is stored.
        """
        validated_card = _card.validate(user_card)
        if replay is not None:
            resolved_id = (
                battle_id[:16]
                if isinstance(battle_id, str) and battle_id
                else _engine.digest(replay)[:16]
            )
        else:
            resolved_id = ''

        with self._save_lock():
            stored = self._stored_payload()
            stored_card = None
            raw_card = stored.get('card')
            if raw_card is not None:
                try:
                    stored_card = _card.validate(raw_card)
                except (_card.CardError, KeyError, TypeError, ValueError):
                    stored_card = None
            stored_replay = (
                stored.get('replay') if _is_valid_replay(stored.get('replay')) else None
            )
            raw_seq = stored.get('battle_seq', 0)
            stored_seq = (
                raw_seq
                if isinstance(raw_seq, int) and not isinstance(raw_seq, bool) and raw_seq >= 0
                else 0
            )

            if owns == 'card':
                # Keep the newest battle: one that landed while this command ran wins.
                card_out = validated_card
                replay_out = stored_replay
                raw_id = stored.get('battle_id')
                if isinstance(raw_id, str) and raw_id and stored_replay is not None:
                    id_out = raw_id[:16]
                elif stored_replay is not None:
                    try:
                        id_out = _engine.digest(stored_replay)[:16]
                    except (TypeError, ValueError):
                        replay_out = None
                        id_out = ''
                else:
                    id_out = ''
                seq_out = stored_seq
            else:
                # Keep the newest card: a card change that landed while the battle ran wins.
                card_out = stored_card if stored_card is not None else validated_card
                replay_out = replay
                id_out = resolved_id
                # Bump the counter only when a battle was just played. The Desktop restarts
                # its canvas when battle_seq changes, so playing the same seed twice still
                # shows the fight again instead of leaving a finished replay on screen.
                seq_out = stored_seq + 1 if replay is not None and battle_id else stored_seq

            payload = {
                'schema_version': 2,
                'card': card_out,
                'replay': replay_out,
                'battle_id': id_out,
                'battle_seq': seq_out,
            }
            self.root.mkdir(parents=True, exist_ok=True)
            state_path = self._state_path()
            # One temp file per caller: two commands saving at the same moment must not
            # write through the same path and replace each other's half-written state.
            tmp_path = self.root / f'state.json.{os.getpid()}.{uuid.uuid4().hex}.tmp'
            try:
                tmp_path.write_text(
                    json.dumps(payload, indent=2, ensure_ascii=True),
                    encoding='utf-8',
                )
                os.replace(tmp_path, state_path)
            finally:
                try:
                    tmp_path.unlink()
                except OSError:
                    log.debug("a temporary state file could not be removed", exc_info=True)
        return resolved_id

    @contextmanager
    def _save_lock(self):
        """Take a short lock so a read-then-replace cannot lose another command's write.

        A lock file made with O_EXCL works on every platform the shelf runs on, and it
        holds a random token so a command only ever removes *its own* lock — a lock it
        broke as stale, or one a later command has already taken, is left alone. An
        abandoned lock older than a few seconds is broken, so a command that died
        mid-save can never wedge the game. If the wait runs out, this refuses the save
        (``SaveBusy``) instead of writing anyway and silently losing someone's change.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / 'state.lock'
        token = uuid.uuid4().hex
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        held = False
        while True:
            try:
                handle = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                holder = self._read_lock_token(lock_path)
                # st_mtime is wall-clock, so compare it with time.time(), not with
                # the monotonic clock used for the wait budget.
                try:
                    stale = time.time() - lock_path.stat().st_mtime > LOCK_STALE_SECONDS
                except OSError:
                    stale = False
                if stale and holder is not None and self._read_lock_token(lock_path) == holder:
                    try:
                        lock_path.unlink()
                    except OSError:
                        log.debug("a stale lock file could not be removed", exc_info=True)
                    continue
                if time.monotonic() >= deadline:
                    raise SaveBusy('another command is saving this game')
                time.sleep(0.01)
                continue
            else:
                try:
                    os.write(handle, token.encode('ascii'))
                finally:
                    os.close(handle)
                held = True
                break
        try:
            yield
        finally:
            if held and self._read_lock_token(lock_path) == token:
                try:
                    lock_path.unlink()
                except OSError:
                    log.debug("a lock file could not be removed on release", exc_info=True)

    @staticmethod
    def _read_lock_token(lock_path: Path) -> str | None:
        try:
            return lock_path.read_text(encoding='ascii').strip() or None
        except (OSError, ValueError, UnicodeDecodeError):
            return None

    def _stored_payload(self) -> dict:
        """The raw state file, or an empty dict when it is missing or unreadable."""
        try:
            data = json.loads(self._state_path().read_text(encoding='utf-8'))
        except (OSError, ValueError, TypeError):
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _card_from_words(tokens: list[str], raw_tail: str) -> tuple[dict | None, str]:
        """Read a card from ``key=value`` pairs, or from JSON when it arrived intact.

        A chat line goes through shlex twice, which strips the double quotes
        JSON needs, so ``key=value`` is the form that survives /games:
        ``card set name=Sniper move=flank weapon=sniper armour=light
        aggression=3 range=9 jink=3 focus=leader``.
        """
        pairs: dict = {}
        last_key = ''
        for token in tokens:
            if '=' not in token:
                # A card name may contain spaces and the shelf's first shlex pass
                # has already eaten the quotes, so a bare word straight after
                # name= belongs to the name: name=Iron Wolf becomes "Iron Wolf".
                if last_key == 'name' and token.strip():
                    pairs['name'] = f"{pairs['name']} {token.strip()}"
                    continue
                pairs = {}
                break
            key, value = token.split('=', 1)
            key = key.strip().lower()
            value = value.strip()
            if key in ('aggression', 'range', 'jink') and value.isdigit():
                value = int(value)
            pairs[key] = value
            last_key = key
        if pairs:
            built = {'kind': _card.CARD_KIND, 'schema_version': _card.SCHEMA_VERSION, **pairs}
            try:
                return _card.validate(built), ''
            except _card.CardError as exc:
                return None, f'That card is not valid: {exc}'
        tail = raw_tail.strip()
        if not tail:
            return None, (
                'Usage: /games doctrine-arena card set name=Sniper move=flank '
                'weapon=sniper armour=light aggression=3 range=9 jink=3 focus=leader'
            )
        try:
            return _card.validate(tail), ''
        except _card.CardError as exc:
            return None, f'That card is not valid: {exc}'

    def command(
        self,
        raw: str,
        *,
        source: str = 'command',
        complete=None,
        player=None,
    ) -> str:
        """Execute a Doctrine Arena command and return a plain-text response.

        The ``complete`` callback is accepted for Game Shelf interface
        compatibility and ignored on purpose: no model is ever called while a
        battle runs.
        """
        del source, complete, player
        try:
            if not isinstance(raw, str):
                return 'Could not read that. Try /games doctrine-arena play'
            try:
                parts = shlex.split(raw)
            except ValueError:
                return 'Could not read that. Try /games doctrine-arena play'

            help_text = '\n'.join([TITLE, *HELP])
            if not parts:
                return help_text

            cmd = parts[0].lower()
            if cmd == 'help':
                return help_text

            if cmd == 'cards' and len(parts) == 1:
                return '\n'.join(
                    f'{idx}. {_card.describe(preset)}'
                    for idx, preset in enumerate(_card.HOUSE_CARDS, 1)
                )

            user_card, saved_replay, _, _ = self._load_state()

            if cmd == 'card':
                if len(parts) == 1:
                    return (
                        f'Your card: {_card.describe(user_card)}\n'
                        'House cards: Bulwark, Skirmisher, Sniper, Bruiser.'
                    )
                if parts[1].lower() == 'set':
                    joined_json = ' '.join(parts[2:])
                    raw_split = raw.strip().split(None, 2)
                    raw_json = raw_split[2] if len(raw_split) >= 3 else ''
                    if len(joined_json) > MAX_CARD_TEXT or len(raw_json) > MAX_CARD_TEXT:
                        return 'That card is too long.'
                    new_card, problem = self._card_from_words(parts[2:], raw_json)
                    if problem or new_card is None:
                        return problem or 'That card is not valid.'
                    self._save_state(new_card, saved_replay, owns='card')
                    return f'Card set: {_card.describe(new_card)}'

                house_name = ' '.join(parts[1:])
                try:
                    new_card = _card.house(house_name)
                except _card.CardError:
                    return (
                        f'No house card named {house_name}. '
                        '/games doctrine-arena cards'
                    )
                self._save_state(new_card, saved_replay, owns='card')
                return f'Card set: {_card.describe(new_card)}'

            if cmd in ('play', 'duel', 'ffa'):
                if len(parts) > 2:
                    return 'Seed must be a whole number.'
                if len(parts) == 2:
                    token = parts[1]
                    try:
                        seed = int(token, 10)
                    except ValueError:
                        return 'Seed must be a whole number.'
                    if not (0 <= seed <= 2147483647):
                        return 'Seed must be a whole number.'
                else:
                    seed = random.SystemRandom().randrange(0, 2**31)

                others = [
                    dict(preset)
                    for preset in _card.HOUSE_CARDS
                    if preset['name'].lower() != user_card['name'].lower()
                ]
                if cmd in ('play', 'duel'):
                    cards = [user_card, others[0]]
                else:
                    cards = [user_card, *others[:3]]

                replay = _engine.simulate(cards, seed)
                battle_id = _engine.digest(replay)[:16]
                self._save_state(user_card, replay, battle_id)
                return (
                    f'{_engine.summary(replay)}\n'
                    f'Replay {battle_id} · /games doctrine-arena state'
                )

            if cmd in ('state', 'board') and len(parts) == 1:
                header = f'Your card: {_card.describe(user_card)}'
                if saved_replay is not None:
                    return f'{header}\n{_engine.summary(saved_replay)}'
                return f'{header}\nNo battle yet. /games doctrine-arena play'

            return help_text
        except SaveBusy:
            return 'Another command is saving this game. Try again in a moment.'
        except (OSError, ValueError, KeyError, TypeError):
            return 'Could not read that. Try /games doctrine-arena play'

    def picture(self) -> dict:
        """Build the structured arena view dictionary from the saved state."""
        try:
            user_card, saved_replay, battle_id, battle_seq = self._load_state()
            if saved_replay is None:
                replay = _DEMO_REPLAY
                preview = True
                battle_id = ''
            else:
                replay = saved_replay
                preview = False

            winner_seat = replay['result']['winner']
            winner_name = replay['combatants'][winner_seat]['name']

            return {
                'view': 'arena',
                'game': ID,
                'schema_version': 2,
                'title': TITLE,
                'preview': preview,
                'status': 'win',
                'winner': winner_name,
                'result': replay['result'],
                'combatants': replay['combatants'],
                'frames': replay['frames'],
                'events': replay['events'],
                'seed': replay['seed'],
                'duration': replay['duration'],
                'key_interval_seconds': replay['key_interval_seconds'],
                'arena': replay['arena'],
                'battle_id': battle_id or '',
                'battle_seq': battle_seq,
                'card': user_card,
                'card_line': _card.describe(user_card),
                'moves': [],
            }
        except Exception:
            return {
                'view': 'arena',
                'game': ID,
                'preview': True,
                'frames': [],
                'combatants': [],
                'result': {'winner': 0},
                'title': TITLE,
            }


def create(root: Path, settings: dict | None = None) -> Arena:
    """Factory entry point for the Game Shelf loader."""
    del settings
    return Arena(Path(root))
