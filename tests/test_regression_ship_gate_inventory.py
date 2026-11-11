"""The ship gate may only report on surfaces that exist in the tree.

A gate that carries an inventory entry for a deleted game tells a reader the
product has a surface it cannot build, and `--list`/`--game` then run against a
directory that is not there.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools.ship_gate.registry import SURFACES, BY_ID
from tools.ship_gate import __main__ as gate


def test_every_registered_directory_is_a_directory_in_the_tree():
    missing = [s.id for s in SURFACES if s.directory and not (ROOT / s.directory).is_dir()]
    assert missing == [], f"gate reports on surfaces that do not exist: {missing}"


def test_every_driver_belongs_to_a_registered_surface_and_exists():
    unknown = sorted(k for k in gate.DRIVERS if k not in BY_ID)
    assert unknown == [], f"drivers for surfaces the gate does not know: {unknown}"
    absent = sorted(f for _, (f, _) in gate.DRIVERS.items() if not (ROOT / "tools" / f).is_file())
    assert absent == [], f"drivers missing from tools/: {absent}"
