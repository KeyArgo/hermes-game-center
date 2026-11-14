#!/usr/bin/env bash
# One pass over everything that can catch a broken Game Center change.
#
#   scripts/test.sh            # build, both UI harnesses, the browser fit check, the pytest suite
#   scripts/test.sh --fast     # skip the browser check (no Chrome, or a machine without a display)
#
# The UI harnesses read the BUILT bundle (desktop/plugin.js), never desktop/src, so the build runs
# first: grading the previous build passes on code that no longer exists and fails on code that is
# already right. The fit check drives real headless Chrome, which is why it has its own switch.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fast=0
[[ "${1:-}" == "--fast" ]] && fast=1

# The `python3` on PATH can be a Hermes install venv with no pytest in it; find one that has it.
PY=python3
if ! "$PY" -c 'import pytest' >/dev/null 2>&1; then
  for candidate in /usr/bin/python3 python3.13 python3.12 python3.11; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import pytest' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done
fi
printf 'python: %s (%s)\n' "$PY" "$("$PY" -c 'import sys; print(sys.version.split()[0])')"

status=0
run() {
  local label="$1"; shift
  printf '\n== %s ==\n' "$label"
  if "$@"; then
    printf 'ok   %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label"
    status=1
  fi
}

run "build the bundle" "$PY" tools/build_plugin.py
run "desktop page harness" node tests/table_ui_harness.cjs
run "jackpot overlay harness" node tests/jackpot_overlay_harness.cjs
run "jackpot2 harness" node tests/jackpot2_harness.cjs
run "jackpot2 look harness" node tests/jackpot2_look_harness.cjs
run "surface clocks (every surface closes its timers)" node tests/timers_harness.cjs
if [[ $fast -eq 0 ]]; then
  run "slot cabinet fit (headless Chrome)" node tests/slot_fit_regression.mjs
else
  printf '\n-- skipping the slot fit check (--fast)\n'
fi
run "python suite" "$PY" -m pytest tests -q -p no:cacheprovider

printf '\n'
if [[ $status -eq 0 ]]; then
  echo "all checks passed"
else
  echo "at least one check failed"
fi
exit $status
