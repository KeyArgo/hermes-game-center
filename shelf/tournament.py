"""Headless tournaments, ratings, and leaderboards."""

from __future__ import annotations

import copy
import itertools
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path

from . import elo, myth
from . import playbook
from .champions import persona
from .kitref import kit

log = logging.getLogger(__name__)

MIN_ENTRANTS = 2
MAX_ENTRANTS = 8
MAX_GAMES = 200
MAX_MODEL_CALLS = 1200
EST_CALLS_PER_GAME = 24
BADGES = ('first_win', 'giant_slayer', 'flawless', 'ten_wins')
_NEEDS_MODEL = NEEDS_MODEL = ('Champions need a model. Pick one in Settings -> Models -> '
                              '"Game Shelf opponent", or spar with the computer.')
# Doctrine Arena is a card battle, not a board: one model call picks a card,
# then the game's own engine plays it out. The same fairness rules apply.
DOCTRINE_ID = 'doctrine-arena'
HOUSE_CARDS = ('Bulwark', 'Skirmisher', 'Sniper', 'Bruiser')
# One card per strength: the weakest card for the gentlest bot and so on, with the
# old three spellings folded onto the four so an old tournament file still reads.
BOT_CARDS = {'beginner': 'Bruiser', 'intermediate': 'Skirmisher', 'advanced': 'Sniper',
             'expert': 'Sniper', 'easy': 'Bruiser', 'normal': 'Skirmisher', 'hard': 'Sniper'}


def _bot_level(level: str) -> str:
    said = str(level or '').strip().lower()
    return kit.LEVEL_ALIASES.get(said, said) if hasattr(kit, 'LEVEL_ALIASES') else said


def entrants_from(champions, bots) -> list[dict]:
    found = []
    for champion in champions or []:
        if isinstance(champion, dict) and champion.get('id'):
            found.append({**champion, 'kind': 'champion'})
    for bot in bots or []:
        level = bot.get('level', kit.DEFAULT_LEVEL) if isinstance(bot, dict) else kit.DEFAULT_LEVEL
        level = _bot_level(level)
        if level not in kit.LEVELS:
            level = kit.DEFAULT_LEVEL
        label = kit.LEVEL_LABELS.get(level, level.title())
        found.append({'id': 'bot-' + level, 'name': f'Computer ({label})',
                      'kind': 'bot', 'brief': '', 'level': level, 'brain': {}})
    return found


def pairings(entrants, games, seed=0) -> list[dict]:
    try:
        import random
        ids = sorted(e['id'] for e in entrants)
        pairs = [{'game': game, 'white': white, 'black': black}
                 for game in sorted(games) for a, b in itertools.combinations(ids, 2)
                 for white, black in ((a, b), (b, a))]
        # The seed decides the order of the fixture, never its contents: every
        # pair still plays every game in both colours.
        random.Random(seed).shuffle(pairs)
        return pairs
    except (TypeError, KeyError):
        return []


def estimate(entrants, games, seed=0) -> dict:
    n = len(pairings(entrants, games, seed))
    # Only champions call a model; a tournament of two computers costs nothing.
    per_game = EST_CALLS_PER_GAME if any(e.get('kind') == 'champion' for e in entrants or []
                                        if isinstance(e, dict)) else 0
    return {'games': n, 'model_calls': n * per_game, 'about_minutes': max(1, round(n * 0.6))}


def _known_games() -> set[str]:
    root = Path(__file__).resolve().parent.parent
    found = set()
    for path in root.glob('*/game.json'):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('kind') == 'table' and isinstance(data.get('id'), str):
                found.add(data['id'])
        except (OSError, ValueError, AttributeError):
            pass
    if (root / 'doctrine_arena' / 'engine.py').is_file():
        found.add(DOCTRINE_ID)
    return found


def plan(entrants, games, *, cap_games=MAX_GAMES, cap_calls=MAX_MODEL_CALLS,
         seed=0) -> tuple[dict | None, str]:
    try:
        if not isinstance(entrants, list) or not MIN_ENTRANTS <= len(entrants) <= MAX_ENTRANTS:
            return None, 'Choose 2 to 8 entrants.'
        ids = [e.get('id') for e in entrants if isinstance(e, dict)]
        if len(ids) != len(entrants) or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
            return None, 'Choose entrants with unique IDs.'
        if not isinstance(games, list) or not games or any(not isinstance(g, str) for g in games):
            return None, 'Choose at least one game.'
        if len(set(games)) != len(games) or not set(games) <= _known_games():
            return None, 'Choose known games without duplicates.'
        result = estimate(entrants, games, seed)
        if result['games'] > cap_games or result['model_calls'] > cap_calls:
            choices = []
            for n in range(MIN_ENTRANTS, len(entrants) + 1):
                for g in range(1, len(games) + 1):
                    count = n * (n - 1) * g
                    if count <= cap_games and count * EST_CALLS_PER_GAME <= cap_calls:
                        choices.append((len(entrants) - n + len(games) - g, n, g))
            if not choices:
                return None, 'The limits are too low for a tournament.'
            _, n, g = min(choices, key=lambda x: (x[0], -x[1], -x[2]))
            changes = []
            if n < len(entrants):
                changes.append(f'{n} entrants' if n != 1 else '1 entrant')
            if g < len(games):
                changes.append(f'{g} games' if g != 1 else '1 game')
            return None, 'Choose ' + ' and '.join(changes) + ' to fit the limits.'
        return {'pairings': pairings(entrants, games, seed), 'estimate': result,
                'cap_games': cap_games, 'cap_calls': cap_calls}, ''
    except (TypeError, ValueError):
        return None, 'Could not plan that tournament.'


def champion_system(entrant, *, card: bool = False) -> str:
    """The system text a champion plays under. Its own brief only, never an opponent."""
    if isinstance(entrant.get('playbook_version'), dict):
        return playbook.system_text(entrant, entrant['playbook_version'])
    if card:
        from .champions import story
        return f"{story(entrant)}\nReply with exactly one card name from the list you are given, and nothing else."
    return persona(entrant)


def play_match(rules, white, black, ask, *, seed=0, cap_calls=None, calls=None, _stop=None) -> dict:
    ids = {'white': white.get('id', ''), 'black': black.get('id', '')}
    entrants = {'white': white, 'black': black}
    timing = {i: 0 for i in ids.values()}
    illegal = dict(timing)
    tokens = dict(timing)
    own_calls = dict(timing)
    if calls is None:
        calls = [0]
    moves = []
    reads = {i: [] for i in ids.values()}
    versions = {side: (entrant.get('playbook_version') or {}).get('id', '') for side, entrant in entrants.items()}
    status, winner, reason = 'active', '', ''
    try:
        state = {'turn': 'white', 'status': 'active', 'winner': '', 'plies': 0, 'moves': [], 'last': ''}
        state.update(rules.fresh())
        guard = rules.MAX_PLIES + 10
        while state.get('status') == 'active':
            if _stop is not None and _stop.is_set():
                status, reason = 'stopped', 'Tournament stopped.'
                break
            if len(moves) >= guard:
                status, reason = 'draw', 'Move limit reached.'
                break
            legal = list(rules.legal(state))
            if not legal:
                status, reason = 'draw', 'No legal moves remain.'
                break
            side = state['turn']
            entrant = entrants[side]
            entrant_id = ids[side]
            move = None
            if entrant.get('kind') == 'champion':
                names = {str(rules.show(m)).lower(): m for m in legal}
                prompt = playbook.move_prompt(rules=rules, state=state, legal=legal, moves=moves, champion=entrant, dossiers=entrant.get('dossiers', {}).get(ids['black' if side == 'white' else 'white']))
                for _ in range(kit.AGENT_TRIES):
                    if _stop is not None and _stop.is_set():
                        status, reason = 'stopped', 'Tournament stopped.'
                        break
                    if cap_calls is not None and calls[0] >= cap_calls:
                        status, reason = 'capped', 'Model call limit reached.'
                        break
                    if ask is None:
                        illegal[entrant_id] += 1
                        break
                    calls[0] += 1
                    own_calls[entrant_id] += 1
                    started = time.monotonic()
                    try:
                        answer = kit._bounded(lambda p, entrant=entrant: ask(entrant, champion_system(entrant), p), prompt)
                        if isinstance(answer, dict):
                            amount = answer.get('tokens', 0)
                            if isinstance(amount, (int, float)) and amount >= 0:
                                tokens[entrant_id] += int(amount)
                            text = answer.get('move', '')
                            if isinstance(text, str):
                                move = playbook.pick_move(text, names, rules, legal, kit._pick)
                                if move is not None:
                                    reads[entrant_id] = playbook.reads_from(text)
                    except Exception:
                        move = None
                    finally:
                        timing[entrant_id] += round((time.monotonic() - started) * 1000)
                    if move is not None:
                        break
                    illegal[entrant_id] += 1
                if status in ('capped', 'stopped'):
                    break
                if move is None:
                    state['level'] = kit.DEFAULT_LEVEL
                    move = rules.bot(state)
            else:
                state['level'] = entrant.get('level', kit.DEFAULT_LEVEL)
                move = rules.bot(state)
            rules.play(state, move)
            shown = str(rules.show(move))
            moves.append(shown)
            # The same bookkeeping kit.Table._count does: games read plies
            # (Go's scoring and every game's move limit) and their board
            # pictures read moves/last.
            state['plies'] = int(state.get('plies') or 0) + 1
            state['moves'] = [*state.get('moves', []), shown][-rules.MAX_PLIES:]
            state['last'] = shown
            if state.get('status') == 'active' and state['plies'] >= rules.MAX_PLIES:
                state['status'] = 'draw'
                state['winner'] = ''
        else:
            status = state.get('status', 'draw')
            winner = state.get('winner') or ''
        if status == 'active':
            status = state.get('status', 'draw')
            winner = state.get('winner') or ''
    except Exception:
        status, winner, reason = 'error', '', 'The game could not be played.'
    return {'game': getattr(rules, 'ID', ''), 'seed': seed, 'moves': moves,
            'status': status, 'winner': winner, 'reason': reason, 'plies': len(moves),
            'white': ids['white'], 'black': ids['black'], 'timing': timing,
            'illegal': illegal, 'tokens': tokens, 'calls': own_calls, 'reads': reads, 'versions': versions}


def play_doctrine_match(white, black, ask, *, seed=0, cap_calls=None, calls=None, _stop=None) -> dict:
    """One Doctrine Arena battle: each side picks a house card, then the engine plays it.

    The same fairness rule holds: a champion is told the four house cards and
    nothing about its opponent. The engine decides the battle.
    """
    from doctrine_arena import card as card_module
    from doctrine_arena import engine

    ids = {'white': white.get('id', ''), 'black': black.get('id', '')}
    entrants = {'white': white, 'black': black}
    timing = {i: 0 for i in ids.values()}
    illegal = dict(timing)
    tokens = dict(timing)
    own_calls = dict(timing)
    if calls is None:
        calls = [0]
    capped = [False]

    def choose(side: str) -> str:
        entrant = entrants[side]
        if entrant.get('kind') != 'champion':
            return BOT_CARDS.get(_bot_level(entrant.get('level', kit.DEFAULT_LEVEL)), 'Skirmisher')
        if ask is None or (_stop is not None and _stop.is_set()):
            return 'Bulwark'
        if cap_calls is not None and calls[0] >= cap_calls:
            capped[0] = True
            return 'Bulwark'
        prompt = '\n'.join([
            f'You are entering a Doctrine Arena battle as {side}.',
            'House cards: ' + ', '.join(HOUSE_CARDS) + '.',
            'Reply with exactly one card name from that list and nothing else.',
        ])
        entrant_id = ids[side]
        calls[0] += 1
        own_calls[entrant_id] += 1
        started = time.monotonic()
        try:
            answer = kit._bounded(lambda p, entrant=entrant: ask(entrant, champion_system(entrant, card=True), p), prompt)
            text = answer.get('move', '') if isinstance(answer, dict) else str(answer or '')
            if isinstance(answer, dict):
                amount = answer.get('tokens', 0)
                if isinstance(amount, (int, float)) and amount >= 0:
                    tokens[entrant_id] += int(amount)
            for name in HOUSE_CARDS:
                if name.lower() in str(text).lower():
                    return name
            illegal[entrant_id] += 1
            return 'Bulwark'
        except Exception:
            illegal[entrant_id] += 1
            return 'Bulwark'
        finally:
            timing[entrant_id] += round((time.monotonic() - started) * 1000)

    try:
        white_card, black_card = choose('white'), choose('black')
        if _stop is not None and _stop.is_set():
            return {'game': DOCTRINE_ID, 'seed': seed, 'moves': [], 'status': 'stopped',
                    'winner': '', 'reason': 'Tournament stopped.', 'plies': 0,
                    'white': ids['white'], 'black': ids['black'], 'timing': timing,
                    'illegal': illegal, 'tokens': tokens, 'calls': own_calls, 'doctrine': {}}
        if capped[0]:
            return {'game': DOCTRINE_ID, 'seed': seed, 'moves': [], 'status': 'capped',
                    'winner': '', 'reason': 'Model call limit reached.', 'plies': 0,
                    'white': ids['white'], 'black': ids['black'], 'timing': timing,
                    'illegal': illegal, 'tokens': tokens, 'calls': own_calls, 'doctrine': {}}
        replay = engine.simulate([card_module.house(white_card), card_module.house(black_card)], seed)
        winner = 'white' if int((replay.get('result') or {}).get('winner', 0)) == 0 else 'black'
        return {'game': DOCTRINE_ID, 'seed': seed, 'moves': [], 'status': 'win',
                'winner': winner, 'reason': 'battle', 'plies': len(replay.get('frames') or []),
                'white': ids['white'], 'black': ids['black'], 'timing': timing,
                'illegal': illegal, 'tokens': tokens, 'calls': own_calls,
                'doctrine': {'cards': [white_card, black_card], 'seed': seed}}
    except Exception:
        return {'game': DOCTRINE_ID, 'seed': seed, 'moves': [], 'status': 'error',
                'winner': '', 'reason': 'The battle could not be played.', 'plies': 0,
                'white': ids['white'], 'black': ids['black'], 'timing': timing,
                'illegal': illegal, 'tokens': tokens, 'calls': own_calls, 'doctrine': {}}


def _record() -> dict:
    return {'rating': elo.START_RATING, 'games': 0, 'wins': 0, 'losses': 0,
            'draws': 0, 'illegal': 0, 'tokens': 0, 'think_ms': 0, 'calls': 0,
            'beat_higher': 0, 'best_game': ''}


# Two tournaments run at once, and every match reads then rewrites ratings.json.
# One process-wide lock (not one per Ratings) keeps those read-modify-writes
# from losing each other.
_RATINGS_LOCK = threading.RLock()


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / ('.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Ratings:
    def __init__(self, folder: Path):
        self.path = Path(folder) / 'ratings.json'

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
            if isinstance(data, dict) and isinstance(data.get('overall'), dict) and isinstance(data.get('by_game'), dict):
                if not isinstance(data.get('by_version'), dict):
                    data['by_version'] = {}
                return data
        except (OSError, ValueError, UnicodeError):
            pass
        return {'overall': {}, 'by_game': {}, 'by_version': {}}

    def record(self, game, white_id, black_id, result, *, illegal, tokens, think_ms, calls=None,
               beat_higher=False, versions=None):
        if result not in (0.0, 0.5, 1.0) or white_id == black_id:
            return
        call_counts = calls or {}
        try:
            with _RATINGS_LOCK:
                data = self.load()
                for group in (data['overall'], data['by_game'].setdefault(game, {})):
                    a = {**_record(), **group.get(white_id, {})}
                    b = {**_record(), **group.get(black_id, {})}
                    old_a, old_b = a['rating'], b['rating']
                    a['rating'], b['rating'] = elo.update(old_a, old_b, result)
                    for record, entrant_id, score, higher in ((a, white_id, result, old_b > old_a), (b, black_id, 1 - result, old_a > old_b)):
                        record['games'] += 1
                        record['wins' if score == 1 else 'losses' if score == 0 else 'draws'] += 1
                        for key, values in (('illegal', illegal), ('tokens', tokens), ('think_ms', think_ms), ('calls', call_counts)):
                            record[key] += max(0, values.get(entrant_id, 0))
                        if score == 1 and (higher or (beat_higher and entrant_id == white_id)):
                            record['beat_higher'] += 1
                    group[white_id], group[black_id] = a, b
                for entrant_id, opponent_id, score in ((white_id, black_id, result), (black_id, white_id, 1 - result)):
                    version = (versions or {}).get(entrant_id, '')
                    if version:
                        group = data['by_version'].setdefault(entrant_id, {})
                        record = {**_record(), **group.get(version, {})}
                        opponent = data['overall'].get(opponent_id, _record())
                        record['rating'] = elo.update(record['rating'], opponent['rating'], score)[0]
                        record['games'] += 1
                        record['wins' if score == 1 else 'losses' if score == 0 else 'draws'] += 1
                        for key, values in (('illegal', illegal), ('tokens', tokens), ('think_ms', think_ms), ('calls', call_counts)):
                            record[key] += max(0, values.get(entrant_id, 0))
                        group[version] = record
                for entrant_id in (white_id, black_id):
                    candidates = [(records.get(entrant_id, {}).get('wins', 0), name)
                                  for name, records in data['by_game'].items() if isinstance(records, dict)]
                    best = sorted(candidates, key=lambda item: (-item[0], item[1]))
                    data['overall'][entrant_id]['best_game'] = best[0][1] if best and best[0][0] else ''
                    data['by_game'][game][entrant_id]['best_game'] = game if data['by_game'][game][entrant_id]['wins'] else ''
                _write(self.path, data)
        except (OSError, TypeError, ValueError, KeyError):
            return

    def record_for(self, champion_id, game="", version="") -> dict:
        try:
            data = self.load()
            group = data['by_version'].get(champion_id, {}) if version else (data['by_game'].get(game, {}) if game else data['overall'])
            if version:
                return {**_record(), **group.get(version, {})}
            return {**_record(), **group.get(champion_id, {})}
        except (TypeError, ValueError):
            return _record()


def badges(record, *, all_records) -> list[str]:
    try:
        return [name for name, earned in (
            ('first_win', record.get('wins', 0) >= 1),
            ('giant_slayer', record.get('beat_higher', 0) >= 1),
            ('flawless', record.get('games', 0) >= 1 and record.get('illegal', 0) == 0),
            ('ten_wins', record.get('wins', 0) >= 10)) if earned]
    except (AttributeError, TypeError):
        return []


def leaderboard(ratings, champions, game="") -> list[dict]:
    try:
        data = ratings.load() if isinstance(ratings, Ratings) else ratings
        records = data['by_game'].get(game, {}) if game else data['overall']
        names = {c['id']: c for c in champions if isinstance(c, dict) and 'id' in c}
        rows = []
        for entrant_id, record in records.items():
            if not isinstance(record, dict):
                continue
            champion = names.get(entrant_id, {})
            if entrant_id.startswith('bot-'):
                fallback = f"Computer ({entrant_id[4:].title()})"
            elif entrant_id.startswith('boss-'):
                # A house boss whose model is no longer configured still has a
                # record; name it plainly rather than show its minted id.
                fallback = "House boss"
            else:
                fallback = entrant_id
            rows.append({'id': entrant_id, 'name': champion.get('name') or record.get('name') or fallback,
                         'title': myth.rank_title(record.get('rating', elo.START_RATING)),
                         'avatar': champion.get('avatar', ''), 'rating': record.get('rating', elo.START_RATING),
                         'games': record.get('games', 0), 'wins': record.get('wins', 0),
                         'losses': record.get('losses', 0), 'draws': record.get('draws', 0),
                         'best_game': record.get('best_game', ''), 'badges': badges(record, all_records=records)})
        return sorted(rows, key=lambda r: (-r['rating'], -r['wins'], r['name']))
    except (TypeError, KeyError, AttributeError):
        return []


class Tournament:
    def __init__(self, folder, loaders, ask, plan, entrants, *, seed=0, cap_calls=MAX_MODEL_CALLS):
        self.id = 'tour-' + uuid.uuid4().hex[:8]
        self.folder = Path(folder) / 'tournaments'
        self.loaders = loaders
        self.ask = ask
        self.plan = plan
        self.entrants = {e['id']: e for e in entrants}
        self.seed = seed
        self.cap_calls = cap_calls
        self.ratings = Ratings(folder)
        self.dossiers = playbook.DossierStore(folder)
        self._stop = threading.Event()
        self._lock = threading.RLock()
        self._thread = None
        self._data = {'id': self.id, 'status': 'running', 'total': len(plan.get('pairings', [])),
                      'played': 0, 'current': {}, 'results': [], 'estimate': plan.get('estimate', {}),
                      'error': '', 'started_at': None, 'ended_at': None, 'ratings': self.ratings.load()}

    def start(self):
        with self._lock:
            if self._thread is not None:
                return 'This tournament has already started.'
            if self.ask is None and any(e.get('kind') == 'champion' for e in self.entrants.values()):
                self._data['status'] = 'error'
                self._data['error'] = _NEEDS_MODEL
                return _NEEDS_MODEL
            self._data['started_at'] = int(time.time())
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()
            return ''

    def _run(self):
        calls = [0]
        try:
            for pairing in self.plan['pairings']:
                if self._stop.is_set():
                    self._data['status'] = 'stopped'
                    break
                with self._lock:
                    self._data['current'] = dict(pairing)
                game = pairing['game']
                if game == DOCTRINE_ID:
                    result = play_doctrine_match(self.entrants[pairing['white']],
                                                 self.entrants[pairing['black']], self.ask,
                                                 seed=self.seed, cap_calls=self.cap_calls,
                                                 calls=calls, _stop=self._stop)
                else:
                    result = play_match(self.loaders[game], self.entrants[pairing['white']],
                                        self.entrants[pairing['black']], self.ask, seed=self.seed,
                                        cap_calls=self.cap_calls, calls=calls, _stop=self._stop)
                with self._lock:
                    if result['status'] in ('stopped', 'capped', 'error'):
                        self._data['status'] = result['status']
                        self._data['error'] = result['reason'] if result['status'] == 'error' else ''
                        break
                    score = 0.5 if result['status'] == 'draw' else (1.0 if result['winner'] == 'white' else 0.0)
                    self.ratings.record(game, pairing['white'], pairing['black'], score,
                                        illegal=result['illegal'], tokens=result['tokens'],
                                        think_ms=result['timing'], calls=result.get('calls'),
                                        versions={self.entrants[pairing[side]]['id']: (self.entrants[pairing[side]].get('playbook_version') or {}).get('id', '') for side in ('white', 'black')})
                    try:
                        for side, other in (('white', 'black'), ('black', 'white')):
                            entrant, rival = self.entrants[pairing[side]], self.entrants[pairing[other]]
                            outcome = 'draw' if score == .5 else ('win' if result['winner'] == side else 'loss')
                            rule = ((entrant.get('playbook_version') or {}).get('playbook') or {}).get('scout', '')
                            self.dossiers.note(entrant['id'], rival['id'], opponent_name=rival.get('name', ''), result=outcome, game=game, illegal=result['illegal'].get(rival['id'], 0), rule=rule)
                    except Exception:
                        log.warning("a dossier note could not be recorded", exc_info=True)
                    self._data['results'].append(result)
                    self._data['played'] = len(self._data['results'])
                    self._data['ratings'] = self.ratings.load()
                    _write(self.folder / (self.id + '.json'), self._data)
            else:
                self._data['status'] = 'done'
        except Exception:
            self._data['status'] = 'error'
            self._data['error'] = 'The tournament could not be completed.'
        finally:
            with self._lock:
                self._data['current'] = {}
                self._data['ended_at'] = int(time.time())
                try:
                    _write(self.folder / (self.id + '.json'), self._data)
                except (OSError, TypeError, ValueError):
                    self._data['status'] = 'error'
                    self._data['error'] = 'The tournament could not be saved.'

    def stop(self):
        self._stop.set()

    def status(self) -> dict:
        try:
            with self._lock:
                return copy.deepcopy(self._data)
        except Exception:
            return {'id': self.id, 'status': 'error', 'error': 'Could not read tournament status.'}

    def result(self) -> dict:
        return self.status()

    def replay(self, index):
        try:
            if not isinstance(index, int) or index < 0:
                return None
            with self._lock:
                return copy.deepcopy(self._data['results'][index])
        except (IndexError, TypeError):
            return None
