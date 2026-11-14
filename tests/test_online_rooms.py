"""Game Center Online rooms: seats, invites, results, ratings, moderation, disconnect claims."""
from pathlib import Path
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import kit  # noqa: E402
from online import guard, league  # noqa: E402
from online.rooms import DISCONNECT_GRACE, GAMES, Rooms, load_games  # noqa: E402
from online.store import Store  # noqa: E402

LOADED = load_games()


class Clock:
    """Starts at real time: tables stamp activity with time.time()."""

    def __init__(self):
        self.now = time.time()

    def __call__(self):
        return self.now


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / "db.sqlite3")
    clock = Clock()
    rooms = Rooms(store, tmp_path, games=LOADED, clock=clock)
    people = {name: store.create_player(name)[0] for name in ("Ada", "Bea", "Eve")}
    yield store, rooms, people, clock
    store.close()


def fresh(store, room):
    return store.room(room["id"])


def legal(rooms, room, viewer):
    return rooms.picture(room, viewer["id"])["legal"]


def test_public_room_two_people_play_and_spectator_is_locked_out(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    picture = rooms.picture(room, p["Ada"]["id"])
    assert picture["seats"][0]["id"] == p["Ada"]["id"] and picture["seats"][1]["open"]
    assert rooms.run(room, p["Bea"], "join")["ok"]
    # Eve watches: cannot move, cannot sit in a taken seat, cannot resign for anyone.
    first = legal(rooms, room, p["Ada"])[0]
    assert not rooms.run(room, p["Eve"], "move", [first])["ok"]
    assert not rooms.run(room, p["Eve"], "sit", ["black"])["ok"]
    assert not rooms.run(room, p["Eve"], "resign")["ok"]
    assert rooms.state(room)["plies"] == 0
    # Bea cannot move on Ada's turn; Ada can.
    assert not rooms.run(room, p["Bea"], "move", [first])["ok"]
    assert rooms.run(room, p["Ada"], "move", [first])["ok"]
    assert rooms.picture(room, p["Bea"]["id"])["permissions"]["can_move"]
    assert not rooms.picture(room, p["Eve"]["id"])["permissions"]["can_move"]


def test_private_room_needs_invite_and_invite_is_single_use(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=False)
    assert not rooms.run(room, p["Bea"], "join")["ok"]
    assert not rooms.run(room, p["Bea"], "sit", ["black"])["ok"]
    code = store.live_invites(room["id"])["black"]
    assert rooms.redeem(room, p["Bea"], code)["ok"]
    assert rooms.state(room)["black_id"] == p["Bea"]["id"]
    again = rooms.redeem(room, p["Eve"], code)
    assert not again["ok"] and "already used" in again["text"]
    assert rooms.state(room)["black_id"] == p["Bea"]["id"]


def test_invite_for_other_room_and_bad_code_are_refused(setup):
    store, rooms, p, _ = setup
    one, _ = rooms.create("connect4", p["Ada"], public=False)
    two, _ = rooms.create("connect4", p["Ada"], public=False)
    code = store.live_invites(one["id"])["black"]
    assert not rooms.redeem(two, p["Bea"], code)["ok"]
    assert not rooms.redeem(two, p["Bea"], "nope")["ok"]
    assert store.invite(code)["used_at"] is None


def test_only_host_makes_invites_and_new_invite_replaces_old(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=False)
    old = store.live_invites(room["id"])["black"]
    code, reason = rooms.invite(room, p["Bea"], "black")
    assert code is None and "host" in reason
    new, _ = rooms.invite(room, p["Ada"], "black")
    assert new and new != old
    assert not rooms.redeem(room, p["Bea"], old)["ok"]
    assert rooms.redeem(room, p["Bea"], new)["ok"]
    assert rooms.invite(room, p["Ada"], "black") == (None, "That seat is not open.")


def test_only_host_starts_new_match(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("reversi", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    assert not rooms.run(room, p["Bea"], "new", ["two"])["ok"]
    assert not rooms.run(room, p["Bea"], "new", ["bot"])["ok"]


def test_unknown_actions_and_abandon_are_not_exposed(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
    for action in ("abandon", "allow-ai", "install", "", "state"):
        assert not rooms.run(room, p["Bea"], action)["ok"]
    assert rooms.state(room)["status"] == "active"


@pytest.mark.parametrize("game", [game for game in GAMES if league.ranked(game, GAMES)])
def test_resignation_records_one_rated_match_per_game(setup, game):
    store, rooms, p, _ = setup
    first, second = make_pair(store, rooms, game, p["Ada"], p["Bea"])
    rooms.run(first, p["Ada"], "move", [legal(rooms, first, p["Ada"])[0]])
    rooms.run(first, p["Bea"], "move", [legal(rooms, first, p["Bea"])[0]])
    answer = rooms.run(first, p["Bea"], "resign")
    # The leg is a replay and a scoreline; the pair is the rated game and is still open.
    assert answer["ok"] and answer["finished"]["rated"] is False and answer["finished"]["winner"] == "white"
    assert answer["finished"]["pair"]["waiting"] is True
    assert store.stats(p["Ada"]["id"])["rated"] == []
    # A second resign or a state read does not record again.
    assert rooms.run(first, p["Bea"], "resign")["finished"] is None
    assert len(store.recent_matches(first["id"])) == 1
    # Leg 2: the seats are swapped, and Ada (black) wins it too, so Ada wins the pair.
    rooms.run(second, p["Bea"], "move", [legal(rooms, second, p["Bea"])[0]])
    rooms.run(second, p["Ada"], "move", [legal(rooms, second, p["Ada"])[0]])
    done = rooms.run(second, p["Bea"], "resign")
    assert done["finished"]["pair"]["rated"] is True and done["finished"]["pair"]["winner"] == "white"
    stats = {row["game"]: row for row in store.stats(p["Ada"]["id"])["rated"]}
    assert stats[game]["wins"] == 1 and stats[game]["rating"] > 1200
    assert store.stats(p["Bea"]["id"])["rated"][0]["rating"] < 1200


def test_a_casual_game_is_played_but_never_rated(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    play_two(rooms, room, p)
    answer = rooms.run(room, p["Bea"], "resign")
    assert answer["finished"]["rated"] is False
    assert store.stats(p["Ada"]["id"])["rated"] == []


def test_rematch_needs_both_and_second_result_is_recorded(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    for _ in range(2):
        rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
        rooms.run(room, p["Bea"], "move", [legal(rooms, room, p["Bea"])[0]])
        rooms.run(room, p["Ada"], "resign")
        assert rooms.run(room, p["Ada"], "rematch")["ok"]
        assert rooms.state(room)["status"] == "resigned"
        assert not rooms.run(room, p["Eve"], "rematch")["ok"]
        assert rooms.run(room, p["Bea"], "rematch")["ok"]
        assert rooms.state(room)["status"] == "active"
    assert [m["match_no"] for m in store.recent_matches(room["id"])] == [2, 1]
    assert rooms.state(room)["score"]["black"] == 2


def test_connect4_win_by_rules_is_recorded(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    finished = None
    for ada, bea in [("1", "2"), ("1", "2"), ("1", "2"), ("1", None)]:
        finished = rooms.run(room, p["Ada"], "move", [ada])["finished"] or finished
        if bea:
            rooms.run(room, p["Bea"], "move", [bea])
    assert rooms.state(room)["status"] == "win"
    assert finished and finished["winner"] == "white" and finished["reason"] == "rules"


def test_draw_agreement_records_draw(setup):
    store, rooms, p, _ = setup
    # A game that can be drawn: Hex is excluded by design (it always has a winner).
    first, second = make_pair(store, rooms, "connect4", p["Ada"], p["Bea"])
    for room in (first, second):
        rooms.run(room, p["Ada"] if room is first else p["Bea"], "move",
                  [legal(rooms, room, p["Ada"] if room is first else p["Bea"])[0]])
        rooms.run(room, p["Bea"] if room is first else p["Ada"], "move",
                  [legal(rooms, room, p["Bea"] if room is first else p["Ada"])[0]])
        assert rooms.run(room, p["Ada"] if room is first else p["Bea"], "draw")["ok"]
        assert not rooms.run(room, p["Ada"] if room is first else p["Bea"], "draw", ["accept"])["ok"]
        answer = rooms.run(room, p["Bea"] if room is first else p["Ada"], "draw", ["accept"])
        assert answer["ok"] and answer["finished"]["winner"] == "" and answer["finished"]["reason"] == "agreement"
    # Two drawn legs are a drawn pair, rated once for both people.
    assert store.stats(p["Ada"]["id"])["rated"][0]["draws"] == 1
    assert store.stats(p["Bea"]["id"])["rated"][0]["draws"] == 1


def test_bot_game_is_unrated_and_tracked_separately(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True, mode="bot")
    assert rooms.state(room)["black"] == "local"
    assert not rooms.run(room, p["Bea"], "join")["ok"]
    rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
    assert rooms.state(room)["plies"] == 2  # the bot answered
    answer = rooms.run(room, p["Ada"], "resign")
    assert answer["finished"] and not answer["finished"]["rated"]
    assert store.stats(p["Ada"]["id"]) == {"rated": [], "bots": [{"game": "connect4", "wins": 0, "losses": 1, "draws": 0}]}


def test_watch_bots_only_host_steps(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("checkers", p["Ada"], public=True, mode="bots")
    assert not rooms.run(room, p["Bea"], "step")["ok"]
    assert rooms.picture(room, p["Ada"]["id"])["permissions"]["can_step"]
    assert not rooms.picture(room, p["Bea"]["id"])["permissions"]["can_step"]
    started = rooms.state(room)["plies"]  # creating a bot table plays its first ply
    assert rooms.run(room, p["Ada"], "step")["ok"]
    assert rooms.state(room)["plies"] == started + 1


def test_disconnect_claim_after_grace_only(setup):
    store, rooms, p, clock = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.connected(room["id"], p["Ada"]["id"])
    rooms.connected(room["id"], p["Bea"]["id"])
    rooms.run(room, p["Bea"], "join")
    assert not rooms.claim(room, p["Ada"])["ok"]  # no moves yet
    rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
    rooms.disconnected(room["id"], p["Bea"]["id"])
    clock.now += DISCONNECT_GRACE - 1
    assert not rooms.claim(room, p["Ada"])["ok"]
    assert not rooms.picture(room, p["Ada"]["id"])["permissions"]["can_claim"]
    clock.now += 2
    assert rooms.picture(room, p["Ada"]["id"])["permissions"]["can_claim"]
    assert not rooms.claim(room, p["Eve"])["ok"]  # spectators cannot claim
    answer = rooms.claim(room, p["Ada"])
    assert answer["ok"] and answer["finished"]["winner"] == "white" and answer["finished"]["reason"] == "disconnect"
    assert rooms.state(room)["result_reason"] == "disconnect"


def test_reconnect_cancels_claim(setup):
    store, rooms, p, clock = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
    rooms.disconnected(room["id"], p["Bea"]["id"])
    clock.now += DISCONNECT_GRACE + 5
    rooms.connected(room["id"], p["Bea"]["id"])
    assert not rooms.claim(room, p["Ada"])["ok"]


def test_remove_and_mute_rules(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    assert rooms.remove(room, p["Bea"], p["Eve"]["id"])[0] is False
    assert rooms.remove(room, p["Ada"], p["Bea"]["id"])[0] is True  # no moves yet: seat reopens
    assert rooms.state(room)["black_id"] == ""
    assert store.moderated(room["id"], p["Bea"]["id"], "removed")
    rooms.run(room, p["Eve"], "join")
    rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
    ok, reason = rooms.remove(room, p["Ada"], p["Eve"]["id"])
    assert not ok and "Mute" in reason
    assert rooms.mute(room, p["Ada"], p["Eve"]["id"], True)[0]
    assert store.moderated(room["id"], p["Eve"]["id"], "muted")


def test_host_closing_mid_match_is_resignation(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    rooms.run(room, p["Ada"], "move", [legal(rooms, room, p["Ada"])[0]])
    assert not rooms.close(room, p["Bea"])["ok"]
    answer = rooms.close(room, p["Ada"])
    assert answer["ok"] and answer["finished"]["winner"] == "black"
    assert fresh(store, room)["closed"]
    assert not rooms.run(fresh(store, room), p["Bea"], "move", ["1"])["ok"]


def test_self_play_two_accounts_same_id_not_rated(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    assert not rooms.run(room, p["Ada"], "sit", ["black"])["ok"]  # one person, one seat


def test_leaderboard_is_opt_in(setup):
    store, rooms, p, _ = setup
    first, second = make_pair(store, rooms, "hex", p["Ada"], p["Bea"])
    play_leg(rooms, first, p["Ada"], p["Bea"])
    rooms.run(first, p["Bea"], "resign")
    play_leg(rooms, second, p["Bea"], p["Ada"])
    rooms.run(second, p["Bea"], "resign")
    assert store.leaderboard("hex") == []
    store.update_player(p["Ada"]["id"], public=True)
    rows = store.leaderboard("hex")
    assert [row["name"] for row in rows] == ["Ada"] and rows[0]["wins"] == 1


def test_expire_closes_idle_rooms(setup):
    store, rooms, p, clock = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    clock.now = store.room(room["id"])["active"] + 4 * 86400
    assert rooms.expire() == [room["id"]]
    assert fresh(store, room)["closed"] and not rooms.folder(room["id"]).exists()


def test_names_and_chat_filters():
    assert guard.clean_name("Ada")[0] == "Ada"
    assert guard.clean_name("  Ada   Lovelace ")[0] == "Ada Lovelace"
    for bad in ("a", "x" * 21, "<script>", "admin", "Host", "f u c k", "fuck", "-dash"):
        assert guard.clean_name(bad)[0] is None, bad
    assert guard.clean_chat("good game!")[0] == "good game!"
    assert guard.clean_chat("my therapist in Scunthorpe")[0]
    assert guard.clean_chat("x" * 301)[0] is None
    assert guard.clean_chat("you n1gger")[0] is None
    assert guard.clean_chat("line\nbreak\x00")[0] == "line break"
    assert guard.clean_chat("   ")[0] is None


def test_limiter_window():
    now = [0.0]
    limit = guard.Limiter(2, 10, clock=lambda: now[0])
    assert limit.allow("a") and limit.allow("a") and not limit.allow("a")
    assert limit.allow("b")
    now[0] = 10.0
    assert limit.allow("a")


def play_leg(rooms, room, white, black):
    """One move each, in turn order: white first, whoever is seated there."""
    rooms.run(room, white, "move", [legal(rooms, room, white)[0]])
    rooms.run(room, black, "move", [legal(rooms, room, black)[0]])


def play_two(rooms, room, p):
    """Ada white, Bea black — the first leg's seating."""
    play_leg(rooms, room, p["Ada"], p["Bea"])


def make_pair(store, rooms, game, a, b, seed=7):
    """One ranked match: two tables, the same deal, the seats swapped.

    ``a`` is white in the first leg and black in the second, so a seat cannot decide
    the pair. The pair is rated once, when both legs are in.
    """
    first, _ = rooms.create(game, a, public=True)
    rooms.run(first, b, "join")
    second, _ = rooms.create(game, b, public=True)
    rooms.run(second, a, "join")
    store.create_pair(game, seed, first["id"], second["id"], a["id"], b["id"])
    return first, second


def test_leaving_mid_match_is_a_recorded_loss_that_names_the_leaver(setup):
    store, rooms, p, _ = setup
    first, second = make_pair(store, rooms, "hex", p["Ada"], p["Bea"])
    play_two(rooms, first, p)
    answer = rooms.run(first, p["Bea"], "leave")
    # The leg names Bea as the leaver and is kept as a replay; the pair still waits.
    assert answer["ok"] and answer["finished"]["winner"] == "white" and answer["finished"]["rated"] is False
    row = store.db.execute("SELECT black_id, rated FROM matches WHERE room_id = ?", (first["id"],)).fetchone()
    assert row["black_id"] == p["Bea"]["id"] and row["rated"] == 0
    assert rooms.state(first)["black_id"] == ""  # and the seat is free again
    assert second  # leg two exists with the seats swapped


def test_non_playing_host_cannot_close_on_other_peoples_match(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Ada"], "leave")  # before any move: just frees the seat
    rooms.run(room, p["Bea"], "sit", ["white"])
    rooms.run(room, p["Eve"], "sit", ["black"])
    rooms.run(room, p["Bea"], "move", [legal(rooms, room, p["Bea"])[0]])
    answer = rooms.close(room, p["Ada"])
    assert not answer["ok"] and not fresh(store, room)["closed"]


def test_same_pair_rated_at_most_three_times_a_day(setup):
    store, rooms, p, _ = setup
    rated = []
    for _ in range(5):
        first, second = make_pair(store, rooms, "hex", p["Ada"], p["Bea"])
        play_two(rooms, first, p)
        rooms.run(first, p["Bea"], "resign")
        play_leg(rooms, second, p["Bea"], p["Ada"])
        rated.append(rooms.run(second, p["Bea"], "resign")["finished"]["pair"]["rated"])
    assert rated == [True, True, True, False, False]
    assert store.stats(p["Ada"]["id"])["rated"][0]["games"] == 3


def test_result_survives_a_crash_between_referee_and_database(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    play_two(rooms, room, p)
    # The referee writes the finished state, then the process dies before recording.
    rooms.table(room).command("resign", source="command", player=__import__("online.rooms", fromlist=["person"]).person(p["Bea"]))
    assert store.recent_matches(room["id"]) == []
    recorded = rooms.settle(room)  # next command or restart repairs it
    assert recorded and recorded["winner"] == "white"
    assert rooms.settle(room) is None  # and only once
    assert len(store.recent_matches(room["id"])) == 1
    assert store.record_match(room["id"], recorded["match_no"], rooms.state(room)) is None  # idempotent


def test_after_restart_absent_seated_player_becomes_claimable(setup, tmp_path):
    store, rooms, p, clock = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    rooms.run(room, p["Bea"], "join")
    play_two(rooms, room, p)
    restarted = Rooms(store, tmp_path, games=LOADED, clock=clock)  # presence is gone
    restarted.connected(room["id"], p["Ada"]["id"])
    assert not restarted.claim(fresh(store, room), p["Ada"])["ok"]
    clock.now += DISCONNECT_GRACE + 1
    assert restarted.claim(fresh(store, room), p["Ada"])["ok"]


def test_invite_is_kept_when_seat_was_taken_first(setup):
    store, rooms, p, _ = setup
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    code, _ = rooms.invite(room, p["Ada"], "black")
    rooms.run(room, p["Eve"], "join")  # public table: someone else sits first
    answer = rooms.redeem(room, p["Bea"], code)
    assert not answer["ok"] and store.invite(code)["used_at"] is None
    rooms.run(room, p["Eve"], "leave")
    assert rooms.redeem(room, p["Bea"], code)["ok"]


def test_fresh_table_host_not_shown_away_for_server_uptime(setup):
    store, rooms, p, clock = setup
    rooms.started = clock.now - 3 * 86400  # server has been up for days
    room, _ = rooms.create("connect4", p["Ada"], public=True)
    room = fresh(store, room)
    assert rooms.absent_sides(room).get("white", 0) < 5


def test_curated_and_recovery_store(setup):
    from online.rooms import CURATED
    store, rooms, _, _ = setup
    assert set(rooms.games) == set(CURATED)
    player, key = store.create_player("Recovery")
    assert store.player_by_name("recovery")["id"] == player["id"]
    assert store.verify_secret(player["id"], key)
    assert not store.verify_secret(player["id"], "wrong")


def test_queue_matching_windows_and_pools():
    from online.matchqueue import MatchQueue
    q = MatchQueue()
    def add(pid, joined, rating=1200, level="normal", pool="human", owner=""):
        e = dict(player_id=pid, name=pid, pool=pool, game="connect4", level=level,
                 rating=rating, games=0, joined=joined, seen=joined, practice_room="", owner_id=owner)
        q.entries[(pool, "connect4", pid)] = e
    add("a", 0); add("b", 1, level="hard"); add("c", 2)
    assert [(a["player_id"], b["player_id"]) for a, b in q.match("connect4", "human", 3)] == [("a", "c")]
    add("d", 4, 1501)
    assert not q.match("connect4", "human", 10)
    assert q.match("connect4", "human", 35)
    add("e", 35, pool="bot", owner="one"); add("f", 35, pool="bot", owner="one")
    assert not q.match("connect4", "bot", 35)
    add("g", 35, pool="bot", owner="two")
    assert q.match("connect4", "bot", 35)
    q.prune(700)
    assert not q.entries


def test_bot_ladder_and_timeout(setup):
    store, rooms, people, clock = setup
    a = store.create_bot(people["Ada"]["id"], "Robot A")[0]
    b = store.create_bot(people["Bea"]["id"], "Robot B")[0]

    def pair_of_bots():
        first, _ = rooms.create("hex", people["Ada"], True, bots_ok=True)
        assert rooms.run(first, people["Ada"], "leave")["ok"]
        assert rooms.run(first, a, "sit", ["white"])["ok"]
        assert rooms.run(first, b, "sit", ["black"])["ok"]
        second, _ = rooms.create("hex", people["Bea"], True, bots_ok=True)
        assert rooms.run(second, people["Bea"], "leave")["ok"]
        assert rooms.run(second, b, "sit", ["white"])["ok"]
        assert rooms.run(second, a, "sit", ["black"])["ok"]
        store.create_pair("hex", 7, first["id"], second["id"], a["id"], b["id"])
        return first, second

    first, second = pair_of_bots()
    rooms.turn_since[first["id"]] = clock.now
    assert rooms.run(first, a, "move", [legal(rooms, first, a)[0]])["ok"]
    assert rooms.run(first, b, "move", [legal(rooms, first, b)[0]])["ok"]
    # Leg 2 has nobody on the clock yet: drop its stamp so only leg 1 can time out.
    rooms.turn_since.pop(second["id"], None)
    clock.now += 16
    assert rooms.check_clocks(clock.now) == [first["id"]]
    match = store.recent_matches(first["id"])[0]
    assert match["reason"] == "timeout" and match["rated"] == 0
    # One leg is not a rating: the pair waits for its second leg.
    assert store.db.execute("SELECT COUNT(*) FROM bot_ratings").fetchone()[0] == 0
    rooms.turn_since[second["id"]] = clock.now
    assert rooms.run(second, b, "move", [legal(rooms, second, b)[0]])["ok"]
    assert rooms.run(second, a, "move", [legal(rooms, second, a)[0]])["ok"]
    clock.now += 16
    assert rooms.check_clocks(clock.now) == [second["id"]]
    assert len(store.leaderboard("hex", "bots")) == 2
    assert store.bot_career(a["id"])["history"]


def test_casual_bot_table_is_unrated_and_not_clocked(setup):
    store, rooms, people, clock = setup
    a = store.create_bot(people["Ada"]["id"], "Robot A")[0]
    b = store.create_bot(people["Bea"]["id"], "Robot B")[0]
    room, _ = rooms.create("connect4", people["Ada"], True, bots_ok=True)
    assert rooms.run(room, people["Ada"], "leave")["ok"]
    assert rooms.run(room, a, "sit", ["white"])["ok"]
    assert rooms.run(room, b, "sit", ["black"])["ok"]
    assert store.room(room["id"])["ladder"] == 0
    for seat, move in ((a, "1"), (b, "2"), (a, "1"), (b, "2"), (a, "1"), (b, "2")):
        assert rooms.run(room, seat, "move", [move])["ok"]
    done = rooms.run(room, a, "move", ["1"])
    assert done["finished"] and done["finished"]["rated"] is False
    assert store.recent_matches(room["id"])[0]["rated"] == 0
    clock.now += 60
    assert rooms.check_clocks(clock.now) == []


def test_pre_ladder_database_migrates_twice(tmp_path):
    import sqlite3
    from online.store import SCHEMA
    path = tmp_path / "old.sqlite3"
    db = sqlite3.connect(path)
    # Recreate the earlier schema without the four new tables and index.
    old = SCHEMA
    for line in SCHEMA.splitlines():
        if any(name in line for name in ("alert_prefs", "alert_sent", "bot_ratings", "rating_history")):
            old = old.replace(line + "\n", "")
    db.executescript(old)
    db.execute("INSERT INTO players VALUES (?, ?, ?, 0, 1, 1)", ("web:old", "hash", "Old"))
    db.execute("INSERT INTO rooms (id, game, host_id, public, created, active, closed, matches) VALUES (?, ?, ?, 1, 1, 1, 0, 0)", ("oldroom", "connect4", "web:old"))
    db.commit()
    db.close()
    for _ in range(2):
        store = Store(path)
        assert store.player("web:old")["name"] == "Old"
        assert store.room("oldroom")["host_id"] == "web:old"
        tables = {r[0] for r in store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"alert_prefs", "alert_sent", "bot_ratings", "rating_history"} <= tables
        store.close()
