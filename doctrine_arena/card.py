"""Strategy card data validation, serialisation, and presets for Doctrine Arena."""

import json

CARD_KIND = 'doctrine-arena-card'
SCHEMA_VERSION = 1

KEYS = (
    'kind',
    'schema_version',
    'name',
    'move',
    'weapon',
    'armour',
    'aggression',
    'range',
    'jink',
    'focus',
)

MOVES = ('advance', 'orbit', 'hold', 'flank')
WEAPONS = ('cannon', 'rapid', 'sniper')
ARMOURS = ('light', 'medium', 'heavy')
FOCUSES = ('nearest', 'weakest', 'leader')

_NAME_CHARS = frozenset(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -'
)


class CardError(Exception):
    """Raised when a Doctrine Arena strategy card is invalid or not found."""


def _is_strict_int(value):
    """Return True only when value is an int and not a bool."""
    return isinstance(value, int) and not isinstance(value, bool)


def validate(raw):
    """Validate a card dict or JSON string and return a new normalised dict."""
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise CardError(f'Invalid card JSON: {exc}') from exc
    else:
        data = raw

    if not isinstance(data, dict):
        raise CardError('Card must be a JSON object or dict.')

    unknown = [k for k in data if k not in KEYS]
    if unknown:
        raise CardError(f"Unknown card key(s): {', '.join(map(str, unknown))}.")

    missing = [k for k in KEYS if k not in data]
    if missing:
        raise CardError(f"Missing required card key(s): {', '.join(missing)}.")

    kind = data['kind']
    if not isinstance(kind, str) or kind != CARD_KIND:
        raise CardError(f"Card kind must be '{CARD_KIND}'.")

    schema_version = data['schema_version']
    if not _is_strict_int(schema_version) or schema_version != SCHEMA_VERSION:
        raise CardError(f'Card schema_version must be the integer {SCHEMA_VERSION}.')

    raw_name = data['name']
    if not isinstance(raw_name, str):
        raise CardError('Card name must be a string.')
    stripped_name = raw_name.strip()
    if not stripped_name:
        raise CardError('Card name must not be empty.')
    if len(raw_name) > 24:
        raise CardError('Card name must be at most 24 characters.')
    if any(ch not in _NAME_CHARS for ch in raw_name):
        raise CardError('Card name may only contain letters, digits, spaces, and hyphens.')

    move = data['move']
    if not isinstance(move, str) or move not in MOVES:
        raise CardError(f'Card move must be one of {MOVES}.')

    weapon = data['weapon']
    if not isinstance(weapon, str) or weapon not in WEAPONS:
        raise CardError(f'Card weapon must be one of {WEAPONS}.')

    armour = data['armour']
    if not isinstance(armour, str) or armour not in ARMOURS:
        raise CardError(f'Card armour must be one of {ARMOURS}.')

    focus = data['focus']
    if not isinstance(focus, str) or focus not in FOCUSES:
        raise CardError(f'Card focus must be one of {FOCUSES}.')

    stats = {}
    for field in ('aggression', 'range', 'jink'):
        val = data[field]
        if not _is_strict_int(val) or not (0 <= val <= 10):
            raise CardError(f"Card '{field}' must be an integer between 0 and 10.")
        stats[field] = int(val)

    return {
        'kind': CARD_KIND,
        'schema_version': SCHEMA_VERSION,
        'name': stripped_name,
        'move': move,
        'weapon': weapon,
        'armour': armour,
        'aggression': stats['aggression'],
        'range': stats['range'],
        'jink': stats['jink'],
        'focus': focus,
    }


def load(text):
    """Load and validate a strategy card from JSON text."""
    return validate(text)


def dump(card):
    """Return canonical compact JSON for a validated strategy card."""
    normalised = validate(card)
    return json.dumps(normalised, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def describe(card):
    """Return a single-line human summary of a strategy card."""
    c = validate(card)
    return (
        f"{c['name']} — {c['armour']} armour, {c['weapon']}, {c['move']}s, "
        f"focuses the {c['focus']}, aggression {c['aggression']}/10, "
        f"range {c['range']}/10, jink {c['jink']}/10"
    )


HOUSE_CARDS = (
    {
        'kind': CARD_KIND,
        'schema_version': SCHEMA_VERSION,
        'name': 'Bulwark',
        'move': 'hold',
        'weapon': 'cannon',
        'armour': 'heavy',
        'aggression': 4,
        'range': 6,
        'jink': 1,
        'focus': 'nearest',
    },
    {
        'kind': CARD_KIND,
        'schema_version': SCHEMA_VERSION,
        'name': 'Skirmisher',
        'move': 'orbit',
        'weapon': 'rapid',
        'armour': 'light',
        'aggression': 7,
        'range': 3,
        'jink': 8,
        'focus': 'weakest',
    },
    {
        'kind': CARD_KIND,
        'schema_version': SCHEMA_VERSION,
        'name': 'Sniper',
        'move': 'flank',
        'weapon': 'sniper',
        'armour': 'light',
        'aggression': 3,
        'range': 9,
        'jink': 3,
        'focus': 'leader',
    },
    {
        'kind': CARD_KIND,
        'schema_version': SCHEMA_VERSION,
        'name': 'Bruiser',
        'move': 'advance',
        'weapon': 'rapid',
        'armour': 'medium',
        'aggression': 9,
        'range': 2,
        'jink': 4,
        'focus': 'nearest',
    },
)


def house(name):
    """Return a copy of a house card by case-insensitive name."""
    if isinstance(name, str):
        target = name.lower()
        for preset in HOUSE_CARDS:
            if preset['name'].lower() == target:
                return dict(preset)
    raise CardError(f'No house card named {name}.')
