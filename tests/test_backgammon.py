import random
import re
import time
from backgammon import game as g


def position(dice, white=(), black=(), bar=0, off=0):
    p = [0] * 24
    for point, count in white: p[point-1] = count
    for point, count in black: p[point-1] = -count
    return {'points': p, 'bar': {'white': bar, 'black': 0}, 'off': {'white': off, 'black': 0}, 'dice': dice, 'turn': 'white', 'status': 'active', 'winner': ''}


def test_bar_and_blocked():
    s = position([1, 2], [(6, 14)], [(24, 2)], bar=1)
    assert all(m[0] == 'bar' and m[1] == '23' for m in g.legal(s))
    s['points'][22] = -2
    assert g.legal(s) == [('pass',)]


def test_higher_die_and_maximum_use():
    s = position([1, 2], [(2, 1)], [(1, 2)], off=14)
    assert g.legal(s) == [('2', 'off', '2')]
    s = position([1, 2], [(3, 1)], off=14)
    assert set(g.legal(s)) == {('3', '2', '1'), ('3', '1', '2')}


def test_bearing_off_and_doubles():
    s = position([6], [(5, 1), (6, 1)], off=13)
    assert g.legal(s) == [('6', 'off', '6')]
    s = position([3] * 4, [(24, 1)], off=14)
    assert g.legal(s) == [('24', '21', '3')]
    for _ in range(3):
        g.play(s, g.legal(s)[0]); assert s['turn'] == 'white'
    assert len(s['dice']) == 1


def test_hit():
    s = position([1], [(8, 1)], [(7, 1)])
    g.play(s, ('8', '7', '1'))
    assert s['bar']['black'] == 1 and s['points'][6] == 1


def test_self_play_and_picture():
    random.seed(42)
    started = time.monotonic()
    for _ in range(8):
        s = {**g.fresh(), 'turn': 'white', 'status': 'active', 'winner': ''}
        for i in range(10000):
            pic = g.picture(s)
            assert pic['view'] == 'backgammon' and len(pic['points']) == 24
            assert set(pic['bar']) == set(pic['off']) == {'white', 'black'}
            assert pic['legal'] == [g.show(m) for m in g.legal(s)]
            m = random.choice(g.legal(s)); assert g.parse([g.show(m)]) == m
            g.play(s, m)
            if s['status'] == 'win': break
        assert s['status'] == 'win'
    assert time.monotonic() - started < 60


def test_bot_latency():
    s = {**g.fresh(), 'turn':'white', 'status':'active'}
    start = time.monotonic(); move = g.bot(s)
    assert time.monotonic() - start < 1 and move in g.legal(s)


# --- what the board expects of the engine (desktop/src/14b-backgammon-svg.js) ---
# The board is played by pointing. It splits one legal token on "-" into from / to / die, lights
# the second part as a destination, and hands the same token straight back as
# `backgammon move <token>`. It shows one die per move the turn has left, and it reads points,
# bar, off, dice and legal off the picture. These pin that contract: a change to the move format
# or the picture would otherwise leave the board silent, with nothing failing here.

SHAPE = re.compile(r'^(bar|(?:[1-9]|1[0-9]|2[0-4]))-((?:[1-9]|1[0-9]|2[0-4])|off)-[1-6]$')


def test_every_legal_token_has_the_shape_the_board_splits_on():
    # seed(42) is the seed tests/test_self_play_and_picture walks to a win, so this game ends.
    random.seed(42)
    seen_off = False
    s = {**g.fresh(), 'turn': 'white', 'status': 'active', 'winner': ''}
    for _ply in range(g.MAX_PLIES):
        for token in g.picture(s)['legal']:
            if token == 'pass':
                continue
            assert SHAPE.match(token), token
            parts = token.split('-')
            # The board sends exactly these three parts back as one command.
            assert g.parse([parts[0], parts[1], parts[2]]) == tuple(parts)
            assert g.show(tuple(parts)) == token
            assert token in [g.show(m) for m in g.legal(s)]
            seen_off = seen_off or parts[1] == 'off'
        g.play(s, random.choice(g.legal(s)))
        if s['status'] == 'win':
            break
    # One whole game was walked: it ended, and bearing off appeared in the tokens on the way.
    assert s['status'] == 'win' and seen_off


def test_the_three_commands_the_board_can_send_parse():
    # Point to point, the bar in, and a checker off the board. A hit is an ordinary move.
    assert g.parse(['24-18-6']) == ('24', '18', '6')
    assert g.parse(['bar-23-1']) == ('bar', '23', '1')
    assert g.parse(['6-off-6']) == ('6', 'off', '6')
    # The board only ever sends a token the engine listed as legal, and every legal token
    # carries its die: no two-part token is ever on offer, so the board cannot send one.
    assert all(len(m) == 3 for move in g.legal({**g.fresh(), 'turn': 'white'}) for m in [move])


def test_bar_and_bear_off_are_offered_as_sources_and_destinations():
    # On the bar: every legal move starts there and enters a point, so the Bar tray is a source.
    s = position([1, 2], [(6, 14)], [(24, 2)], bar=1)
    assert all(m[0] == 'bar' for m in g.legal(s))
    assert all(g.show(m).startswith('bar-') for m in g.legal(s))
    # In the home board with everything else home: the off tray is a destination, so the
    # Bear off control can be armed and the Off tray lit.
    s = position([6], [(5, 1), (6, 1)], off=13)
    legal = g.legal(s)
    assert legal and all(m[1] == 'off' for m in legal)
    assert all(g.show(m).endswith('-off-6') for m in legal)


def test_doubles_are_four_moves_and_are_shown_four_times():
    s = position([3] * 4, [(24, 2)], off=13)
    pic = g.picture(s)
    assert pic['dice'] == [3, 3, 3, 3]          # four moves, one per die
    assert all(m[2] == '3' for m in g.legal(s))
    for left in (3, 2, 1):
        g.play(s, g.legal(s)[0])
        # One die is spent per move, and the turn stays with the player until the dice run out.
        assert s['dice'] == [3] * left and s['turn'] == 'white'
    assert g.legal(s) and g.legal(s)[0][2] == '3'


def test_picture_carries_what_the_board_reads():
    s = {**g.fresh(), 'turn': 'white', 'status': 'active', 'winner': ''}
    pic = g.picture(s)
    assert pic['view'] == 'backgammon'
    assert len(pic['points']) == 24 and all(isinstance(n, int) for n in pic['points'])
    assert set(pic['bar']) == {'white', 'black'} and set(pic['off']) == {'white', 'black'}
    assert len(pic['dice']) in (2, 4) and all(1 <= d <= 6 for d in pic['dice'])
    assert pic['legal'] and all(isinstance(token, str) for token in pic['legal'])
