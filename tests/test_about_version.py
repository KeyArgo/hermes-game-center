"""The version shown on screen must be the build that is actually running."""

from pathlib import Path

from dashboard import plugin_api

ROOT = Path(__file__).resolve().parent.parent


def _declared() -> str:
    manifest = ROOT / "plugin.yaml"
    return next(
        line.split(":", 1)[1].strip().strip('"').strip("'")
        for line in manifest.read_text(encoding="utf-8").splitlines()
        if line.startswith("version:")
    )


def _release_of(version):
    """A development build reads X.Y.Z-dev[.N]; the release it is heading for is still plugin.yaml's."""
    return version.split("-dev", 1)[0]


def test_about_reports_the_manifest_version():
    assert _release_of(plugin_api.about()["version"]) == _declared()


def test_the_version_route_carries_the_whole_identity():
    answer = plugin_api.version_route()
    assert _release_of(answer["version"]) == _declared()
    assert {"commit", "commit_date", "built_at", "dirty", "channel", "source"} <= set(answer)


def test_the_stamp_is_vendored_in_the_package():
    assert (ROOT / "version_stamp.py").is_file()


def test_the_stamp_never_invents_a_commit():
    info = plugin_api._build_stamp()
    assert info["source"] in {"build_info", "git", "manifest"}
    if info["source"] == "manifest":
        assert info["commit"] == ""


def test_build_info_is_not_committed():
    assert "BUILD_INFO.json" in (ROOT / ".gitignore").read_text(encoding="utf-8")


def test_the_version_chip_is_drawn_in_settings_and_the_games_main_screen_only():
    """The version moved out of the status bar and out of the Games header (owner, 2026-11-10):
    one chip, at the top of Settings, which is what the full screen shows and what the
    play-while-you-code pane's own gear opens. Everything else stays in the status bar."""
    bundle = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert "GamesVersionChip" in bundle
    assert "GamesVersionItem" not in bundle, "the old status-bar item is gone, not renamed in place"
    assert "/v1/version" in bundle
    # One reusable chip, mounted twice: at the top of SettingsPanel and at the top of the Games
    # main screen (owner, 2026-11-11: "you can even put the chip at the top of game center").
    assert bundle.count("jsx(GamesVersionChip") == 2
    settings = (ROOT / "desktop" / "src" / "60-settings-and-alerts.js").read_text(encoding="utf-8")
    pane = (ROOT / "desktop" / "src" / "65-wait-pane.js").read_text(encoding="utf-8")
    home = (ROOT / "desktop" / "src" / "70-home.js").read_text(encoding="utf-8")
    assert settings.count("jsx(GamesVersionChip, { ctx })") == 1, "Settings carries it, once"
    assert "data-games-version-top" in settings, "at the top of that panel"
    # ... and both Settings views are that one panel, so neither can drift from the other.
    assert "jsx(SettingsPanel, {" in pane, "the pane's gear opens the same Settings"
    assert "jsx(SettingsPanel, {" in home, "and so does the full-screen Games app"
    # Everywhere else it is gone: not the status bar, not the header, not the pane's foot.
    assert home.count("jsx(GamesVersionChip") == 1, "the Games main screen carries it once, at the top"
    assert "GamesVersionChip" not in pane, "and neither does the pane's own markup"
    assert "data-games-version-row" not in bundle, "the masthead version row is gone"
    assert "data-games-version-footer" not in bundle, "and so is the pane's version footer"
    assert "id: 'version'" not in bundle, "the version is not a status-bar item"
    # The other status-bar items: one, the Slots chip. The old Slots item was retired when Slots became
    # one game on the Jackpot machine, and the Jackpot v2 item went with the overlay it existed to anchor:
    # both see-through machines are a composer-slot contribution now (review, 2026-11-12).
    assert bundle.count("area: STATUSBAR_AREAS.right") == 1
    assert "id: 'status'" in bundle
    assert "id: 'jackpot'" not in bundle
    assert "id: 'jackpot2'" not in bundle
    assert "area: COMPOSER_AREAS.underside" in bundle
