"""Sanity: the coach picture and the mover's speed, from the repo itself."""
import sys, json, time

sys.path.insert(0, '.')
from chessboard import game

state = game.fresh()
pic = game.picture(state)
print(sorted(pic.keys()))
print('ranks', pic.get('ranks'), 'files', pic.get('files'))
coach = game.coach().picture({'moves': ['e2e4', 'e7e5', 'g1f3']})
print(json.dumps(coach)[:300])
print('legal sample', game.legal(state)[:5])
for depth in (1, 5):
    now = time.time()
    move = game.bot(game.fresh(), depth)
    print('bot', depth, move, round(time.time() - now, 2))
