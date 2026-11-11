"""Deterministic fixed-timestep tank battle simulation engine for Doctrine Arena."""

import hashlib
import json
import math
import random

from doctrine_arena import card

ARENA_W = 960
ARENA_H = 600
CENTER = (480.0, 300.0)
START_RADIUS = 240.0

TICK_SECONDS = 1.0 / 60.0
KEY_TICKS = 5
KEY_INTERVAL_SECONDS = KEY_TICKS * TICK_SECONDS
MAX_TICKS = 2400

# The storm starts once a stalemate is likely and closes fast enough that a
# four-way battle still resolves inside the 40 second cap.
STORM_START = 18.0
STORM_END = 34.0
STORM_RADIUS_START = 640.0
STORM_RADIUS_END = 260.0
STORM_DPS = 10.0

COLOURS = ('#7ec8ff', '#ff9f6e', '#9ae66e', '#e579ff')
REPLAY_KIND = 'doctrine-arena-replay'
REPLAY_VERSION = 1

# Armour is a trade: speed buys position and evasion, hp buys survival, and
# damage_mult is both the outgoing bonus and the incoming penalty (the engine
# multiplies a victim's damage by its own damage_mult). The shipped numbers
# made heavy armour worth ~2.7x light in a duel with no real downside, so a
# heavy card beat a light card almost regardless of the rest of its line.
# These values keep each armour viable in its band without a dominant pick.
ARMOUR_PROFILES = {
    'light': {
        'hp': 112.0,
        'speed': 112.0,
        'turn_rate': 4.4,
        'radius': 14.0,
        'damage_mult': 1.08,
    },
    'medium': {
        'hp': 126.0,
        'speed': 96.0,
        'turn_rate': 3.4,
        'radius': 16.0,
        'damage_mult': 1.0,
    },
    'heavy': {
        'hp': 152.0,
        'speed': 84.0,
        'turn_rate': 2.7,
        'radius': 19.0,
        'damage_mult': 0.9,
    },
}

# Every gun has a band where it pays: rapid up close, cannon at mid range,
# sniper at distance. Two things made cannon a dead pick: its 380 m/s shells
# spent so long in flight that a target orbiting at the mid standoff was
# ~39 units from where the linear lead predicted, and a 420 range could not
# reach the standoff a range-9 card asks for. A faster shell and a reach that
# covers the legal standoff range make the mid band real.
WEAPONS = {
    'rapid': {
        'cooldown': 0.35,
        'damage': 4.0,
        'range': 300.0,
        'bullet_speed': 520.0,
        'spread': 0.085,
    },
    'cannon': {
        'cooldown': 1.1,
        'damage': 12.0,
        'range': 460.0,
        'bullet_speed': 950.0,
        'spread': 0.02,
    },
    'sniper': {
        'cooldown': 2.2,
        'damage': 20.0,
        'range': 720.0,
        'bullet_speed': 900.0,
        'spread': 0.012,
    },
}


def _wrap_angle(angle):
    """Wrap an angle in radians into [-pi, pi)."""
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def _turn_toward(current, target, max_step):
    """Turn current angle toward target angle by at most max_step radians."""
    diff = _wrap_angle(target - current)
    if abs(diff) <= max_step:
        return _wrap_angle(target)
    return _wrap_angle(current + (max_step if diff > 0.0 else -max_step))


def _pick_target(tank, tanks):
    """Select an opponent living tank according to the tank's focus rule."""
    candidates = [
        other for other in tanks if other['alive'] and other['seat'] != tank['seat']
    ]
    if not candidates:
        return None

    focus = tank['card']['focus']
    if focus == 'weakest':
        return min(
            candidates,
            key=lambda o: (
                o['hp'],
                math.hypot(o['x'] - tank['x'], o['y'] - tank['y']),
                o['seat'],
            ),
        )
    if focus == 'leader':
        return min(
            candidates,
            key=lambda o: (
                -o['damage_dealt'],
                math.hypot(o['x'] - tank['x'], o['y'] - tank['y']),
                o['seat'],
            ),
        )
    return min(
        candidates,
        key=lambda o: (
            math.hypot(o['x'] - tank['x'], o['y'] - tank['y']),
            o['seat'],
        ),
    )


def _make_frame(t, tanks, bullets):
    """Build a replay keyframe [t, tanks, bullets]."""
    frame_tanks = [
        [
            int(round(tk['x'])),
            int(round(tk['y'])),
            int(round(math.degrees(tk['body']))) % 360,
            int(round(math.degrees(tk['turret']))) % 360,
            max(0, int(round(tk['hp']))) if tk['alive'] else 0,
        ]
        for tk in tanks
    ]
    frame_bullets = [
        [
            int(round(b['x'])),
            int(round(b['y'])),
            int(b['seat']),
        ]
        for b in bullets
    ]
    return [round(t, 2), frame_tanks, frame_bullets]


def simulate(cards, seed=0):
    """Simulate a full Doctrine Arena battle and return a deterministic replay dict."""
    if not isinstance(cards, (list, tuple)) or len(cards) < 2:
        raise ValueError('A battle needs at least two cards.')
    if len(cards) > 4:
        raise ValueError('A battle supports at most four cards.')

    validated_cards = [card.validate(c) for c in cards]
    rng = random.Random(seed)
    num_tanks = len(validated_cards)
    cx, cy = CENTER

    tanks = []
    combatants = []
    for seat, c in enumerate(validated_cards):
        angle = 2.0 * math.pi * seat / num_tanks
        x = cx + START_RADIUS * math.cos(angle)
        y = cy + START_RADIUS * math.sin(angle)
        facing = _wrap_angle(math.atan2(cy - y, cx - x))
        armour = ARMOUR_PROFILES[c['armour']]
        weapon = WEAPONS[c['weapon']]
        tanks.append({
            'seat': seat,
            'card': c,
            'x': x,
            'y': y,
            'vx': 0.0,
            'vy': 0.0,
            'body': facing,
            'turret': facing,
            'hp': float(armour['hp']),
            'speed': armour['speed'],
            'turn_rate': armour['turn_rate'],
            'radius': armour['radius'],
            'damage_mult': armour['damage_mult'],
            'weapon': weapon,
            'cooldown': 0.0,
            'alive': True,
            'kills': 0,
            'damage_dealt': 0.0,
            'last_hit_by': None,
        })
        combatants.append({
            'seat': seat,
            'name': c['name'],
            'card': c,
            'colour': COLOURS[seat],
        })

    bullets = []
    events = []
    frames = [_make_frame(0.0, tanks, bullets)]
    max_frames = int(round(40.0 / KEY_INTERVAL_SECONDS)) + 2

    dt = TICK_SECONDS
    last_dead_seat = 0
    ticks = 0
    winner = 0
    reason = 'timeout'

    for tick in range(1, MAX_TICKS + 1):
        ticks = tick
        t = tick * dt

        for tank in tanks:
            if not tank['alive']:
                continue

            # 1. Pick a target
            target = _pick_target(tank, tanks)
            if target is None:
                continue

            # 2. Desired distance. The card's range/aggression line can ask for a
            # standoff beyond the gun's reach (a range-10 card with rapid armour
            # wants 470 units from a 300-unit gun), which left the tank circling
            # forever without ever firing. Clamp inside the weapon so every legal
            # card can shoot; this changes nothing for a card already in reach.
            d = max(
                50.0,
                110.0
                + tank['card']['range'] * 40.0
                - tank['card']['aggression'] * 6.0,
            )
            d = min(d, tank['weapon']['range'] * 0.95)

            # 3. Steering by card['move']
            dx = target['x'] - tank['x']
            dy = target['y'] - tank['y']
            dist = math.hypot(dx, dy)
            bearing = math.atan2(dy, dx)
            side = 1.0 if (tank['seat'] % 2 == 0) else -1.0
            move_mode = tank['card']['move']

            if move_mode == 'advance':
                heading = bearing
                speed_factor = 1.0
            elif move_mode == 'hold':
                if dist > 1.1 * d:
                    heading = bearing
                    speed_factor = 0.8
                elif dist < 0.9 * d:
                    heading = bearing + math.pi
                    speed_factor = 0.6
                else:
                    heading = bearing + (math.pi / 2.0) * side
                    speed_factor = 0.5
            elif move_mode == 'orbit':
                if dist > 1.15 * d:
                    heading = bearing
                else:
                    heading = bearing + (math.pi / 2.0) * side
                speed_factor = 0.9
            else:  # 'flank'
                perp = target['body'] + (math.pi / 2.0) * side
                flank_x = target['x'] + math.cos(perp) * d
                flank_y = target['y'] + math.sin(perp) * d
                heading = math.atan2(flank_y - tank['y'], flank_x - tank['x'])
                speed_factor = 0.95

            # 4. Add the weave
            heading += math.radians(tank['card']['jink'] * 0.7) * math.sin(
                2.2 * t + 1.7 * tank['seat']
            )

            # 5. Separation
            for other in tanks:
                if not other['alive'] or other['seat'] == tank['seat']:
                    continue
                sep_dist = math.hypot(tank['x'] - other['x'], tank['y'] - other['y'])
                if sep_dist < (tank['radius'] + other['radius'] + 10.0):
                    away = math.atan2(tank['y'] - other['y'], tank['x'] - other['x'])
                    heading = _wrap_angle(heading + 0.5 * _wrap_angle(away - heading))

            # Clamp the final heading change per tick by the body turn rate
            tank['body'] = _turn_toward(
                tank['body'], heading, tank['turn_rate'] * dt
            )

            # 6. Move and clamp inside arena walls
            vx = math.cos(tank['body']) * tank['speed'] * speed_factor
            vy = math.sin(tank['body']) * tank['speed'] * speed_factor
            tank['vx'] = vx
            tank['vy'] = vy
            r = tank['radius']
            tank['x'] = min(ARENA_W - r, max(r, tank['x'] + vx * dt))
            tank['y'] = min(ARENA_H - r, max(r, tank['y'] + vy * dt))

            # 7. Turret aim and firing
            weapon = tank['weapon']
            bullet_speed = weapon['bullet_speed']
            dist_now = math.hypot(target['x'] - tank['x'], target['y'] - tank['y'])
            flight = dist_now / bullet_speed
            pred_x = target['x'] + target['vx'] * flight
            pred_y = target['y'] + target['vy'] * flight
            flight = math.hypot(pred_x - tank['x'], pred_y - tank['y']) / bullet_speed
            pred_x = target['x'] + target['vx'] * flight
            pred_y = target['y'] + target['vy'] * flight
            aim = math.atan2(pred_y - tank['y'], pred_x - tank['x'])

            turret_rate = 3.2 + (0.4 if tank['card']['armour'] == 'light' else 0.0)
            tank['turret'] = _turn_toward(tank['turret'], aim, turret_rate * dt)

            tank['cooldown'] -= dt
            if (
                tank['cooldown'] <= 0.0
                and dist_now <= weapon['range']
                and abs(_wrap_angle(aim - tank['turret'])) <= 0.10
            ):
                muzzle_x = tank['x'] + math.cos(tank['turret']) * r * 1.2
                muzzle_y = tank['y'] + math.sin(tank['turret']) * r * 1.2
                shot_dir = tank['turret'] + rng.uniform(
                    -weapon['spread'], weapon['spread']
                )
                bullets.append({
                    'x': muzzle_x,
                    'y': muzzle_y,
                    'vx': math.cos(shot_dir) * bullet_speed,
                    'vy': math.sin(shot_dir) * bullet_speed,
                    'damage': weapon['damage'],
                    'seat': tank['seat'],
                    'ttl': 3.0,
                })
                tank['cooldown'] = weapon['cooldown']
                events.append({
                    't': round(t, 2),
                    'kind': 'shot',
                    'seat': tank['seat'],
                    'x': round(muzzle_x, 1),
                    'y': round(muzzle_y, 1),
                })

            # 8. Storm
            if t > STORM_START:
                progress = min(1.0, (t - STORM_START) / (STORM_END - STORM_START))
                storm_radius = STORM_RADIUS_START + (
                    STORM_RADIUS_END - STORM_RADIUS_START
                ) * progress
                if math.hypot(tank['x'] - cx, tank['y'] - cy) > storm_radius:
                    tank['hp'] -= STORM_DPS * dt * tank['damage_mult']
                    if tank['hp'] <= 0.0:
                        tank['hp'] = 0.0
                        tank['alive'] = False
                        last_dead_seat = tank['seat']
                        # Only a tank that actually shot this one gets the kill. A tank
                        # that is caught by the storm has no killer, and crediting a
                        # neighbour would quietly hand out kills nobody earned.
                        killer_seat = tank['last_hit_by']
                        if killer_seat is not None and killer_seat != tank['seat']:
                            tanks[killer_seat]['kills'] += 1
                        events.append({
                            't': round(t, 2),
                            'kind': 'kill',
                            'by': killer_seat,
                            'on': tank['seat'],
                        })

        # Bullets update after all tanks have moved
        remaining_bullets = []
        for b in bullets:
            b['x'] += b['vx'] * dt
            b['y'] += b['vy'] * dt
            b['ttl'] -= dt
            if (
                b['ttl'] <= 0.0
                or b['x'] < 0.0
                or b['x'] > ARENA_W
                or b['y'] < 0.0
                or b['y'] > ARENA_H
            ):
                continue

            hit = False
            for victim in tanks:
                if not victim['alive'] or victim['seat'] == b['seat']:
                    continue
                if math.hypot(b['x'] - victim['x'], b['y'] - victim['y']) < victim['radius']:
                    hit = True
                    actual_damage = b['damage'] * victim['damage_mult']
                    owner = tanks[b['seat']]
                    owner['damage_dealt'] += actual_damage
                    victim['hp'] -= actual_damage
                    victim['last_hit_by'] = b['seat']
                    events.append({
                        't': round(t, 2),
                        'kind': 'hit',
                        'by': b['seat'],
                        'on': victim['seat'],
                        'x': round(b['x'], 1),
                        'y': round(b['y'], 1),
                        'damage': round(actual_damage, 1),
                    })
                    if victim['hp'] <= 0.0:
                        victim['hp'] = 0.0
                        victim['alive'] = False
                        last_dead_seat = victim['seat']
                        owner['kills'] += 1
                        events.append({
                            't': round(t, 2),
                            'kind': 'kill',
                            'by': b['seat'],
                            'on': victim['seat'],
                        })
                    break
            if not hit:
                remaining_bullets.append(b)
        bullets = remaining_bullets

        living = [tk for tk in tanks if tk['alive']]
        ended = len(living) <= 1 or tick == MAX_TICKS

        if (tick % KEY_TICKS == 0 or ended) and len(frames) < max_frames:
            frames.append(_make_frame(t, tanks, bullets))

        if len(living) == 1:
            winner = living[0]['seat']
            reason = 'destroyed'
            break
        if len(living) == 0:
            winner = last_dead_seat
            reason = 'destroyed'
            break
        if tick == MAX_TICKS:
            best = min(living, key=lambda tk: (-tk['hp'], tk['seat']))
            winner = best['seat']
            reason = 'timeout'
            break

    return {
        'kind': REPLAY_KIND,
        'schema_version': REPLAY_VERSION,
        'seed': seed,
        'arena': {'w': ARENA_W, 'h': ARENA_H},
        'key_interval_seconds': KEY_INTERVAL_SECONDS,
        'duration': round(ticks * TICK_SECONDS, 2),
        'combatants': combatants,
        'frames': frames,
        'events': events,
        'result': {
            'winner': int(winner),
            'reason': reason,
            'kills': [int(tk['kills']) for tk in tanks],
            'damage': [round(tk['damage_dealt'], 1) for tk in tanks],
            'hp': [
                max(0, int(round(tk['hp']))) if tk['alive'] else 0
                for tk in tanks
            ],
        },
    }


def digest(replay):
    """Return the SHA-256 hex digest of the canonical JSON of a replay."""
    canonical = json.dumps(
        replay, sort_keys=True, separators=(',', ':'), ensure_ascii=True
    )
    return hashlib.sha256(canonical.encode('ascii')).hexdigest()


def summary(replay):
    """Return a concise two-line human summary of a replay dict.

    The first line names the winner. The second line carries one segment per
    combatant, in seat order, each with the name in front of its numbers, so a
    four-way battle never reads as an ambiguous row of figures.
    """
    combatants = replay['combatants']
    result = replay['result']
    winner_seat = result['winner']
    winner_name = combatants[winner_seat]['name']
    others = [c['name'] for c in combatants if c['seat'] != winner_seat]
    losers_str = others[0] if len(others) == 1 else ', '.join(others)

    line1 = (
        f"{winner_name} beat {losers_str} in {replay['duration']} s "
        f"({result['reason']})."
    )
    parts = []
    for index, combatant in enumerate(combatants):
        kills = result['kills'][index]
        damage = result['damage'][index]
        hp = result['hp'][index]
        parts.append(
            f"{combatant['name']}: {kills} kill{'' if kills == 1 else 's'}, "
            f'{damage} damage, {hp} hp'
        )
    return f'{line1}\n' + ' · '.join(parts)

