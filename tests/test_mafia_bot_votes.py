import random

from talktable.games import mafia


def voting_table():
    env = mafia.build(6)
    mafia.reset(env, list(range(6)), 42)
    env.state.game_state["phase"] = "Day-Voting"
    return env


def test_day_vote_excludes_self_and_known_partners():
    env = voting_table()
    for seat, role in env.player_roles.items():
        for seed in range(30):
            raw = mafia.bot(env, seat, random.Random(seed))
            target = int(raw[1:-1])
            assert target != seat
            if role == "Mafia":
                assert env.player_roles[target] != "Mafia"


def test_typed_number_matches_third_button():
    env = voting_table()
    allowed = mafia.actions(env, 0)
    button = next(item for item in allowed if item["label"] == "Player 3")
    # A person's commands carry the table's draft, even when it is empty.
    for text in ("3", "Player 3", button["id"], button["raw"]):
        assert mafia.parse(env, 0, text, allowed, []) == ("act", button["raw"])
    assert mafia.parse(env, 0, "0", allowed, []) is None
    assert mafia.parse(env, 0, "3", allowed, None) == ("act", "[3]")
