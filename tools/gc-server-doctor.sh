#!/usr/bin/env bash
# Read-only look at a live Game Center lobby.
#
# Set the ssh target first (nothing in this repo names a machine):
#   export GC_SERVER_SSH=user@host
# Optional:
#   GC_SERVER_APP   directory that contains the online package
#                   (default /opt/gameshelf-online/app)
#   GC_SERVER_DATA  the server's --data directory
#                   (default /var/lib/gameshelf-online, the path in the unit file)
#
# The script runs online.doctor over ssh, then the last hour of WARNING and ERROR
# lines from the gameshelf-online journal. It does not write.

set -eu

if [ -z "${GC_SERVER_SSH:-}" ]; then
  echo "Set GC_SERVER_SSH to the ssh target, for example: export GC_SERVER_SSH=user@host" >&2
  exit 2
fi

APP="${GC_SERVER_APP:-/opt/gameshelf-online/app}"
DATA="${GC_SERVER_DATA:-/var/lib/gameshelf-online}"

case "$APP" in
  *[!A-Za-z0-9/_.-]*) echo "GC_SERVER_APP may only contain letters, numbers, slashes, dots, underscores and dashes." >&2; exit 2 ;;
esac
case "$DATA" in
  *[!A-Za-z0-9/_.-]*) echo "GC_SERVER_DATA may only contain letters, numbers, slashes, dots, underscores and dashes." >&2; exit 2 ;;
esac

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -- "$GC_SERVER_SSH")

echo "=== online.doctor ==="
"${SSH[@]}" "cd '$APP' && python3 -m online.doctor --db '$DATA/online.sqlite3'"

echo "=== journalctl -u gameshelf-online --since -1h (WARNING/ERROR) ==="
"${SSH[@]}" "journalctl -u gameshelf-online --since -1h --no-pager | grep -E 'WARNING|ERROR' || true"
