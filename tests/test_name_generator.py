"""No default player name: the person picks one, or asks for one (owner, 2026-11-18: "There should
not be a default user, but we can add a user name generator"). Every PC used to be offered the same
name, because the suggestion came from the local player id, which is "local" everywhere."""
from shelf.who import name_problem, random_name


def test_the_generator_gives_a_valid_name_and_a_new_one_each_press():
    names = {random_name() for _ in range(40)}
    assert len(names) > 30, f"forty presses gave only {len(names)} different names"
    for name in names:
        assert name_problem(name) == "", (name, name_problem(name))
        assert 4 <= len(name) <= 24, name


def test_the_route_answers_with_a_fresh_name_each_time():
    from dashboard import plugin_api

    first = plugin_api.suggest_a_name()
    assert first["ok"] is True and name_problem(first["name"]) == "", first
    assert len({plugin_api.suggest_a_name()["name"] for _ in range(20)}) > 10


def test_nothing_offers_every_computer_the_same_starting_name(monkeypatch, tmp_path):
    """The setup payload no longer hands the page a ready-made name to pre-fill."""
    from dashboard import plugin_api

    class Player:
        id = "local"
        name = ""
        named = False

    class Catalog:
        data_root = tmp_path
        settings = {}

    setup = plugin_api._setup_payload(Catalog(), Player())
    assert setup["name"] == "" and setup["suggested_name"] == "", setup
