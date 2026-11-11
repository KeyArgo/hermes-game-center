#!/bin/sh
# Nightly copy of the Game Center Online database (cron: 17 4 * * * /opt/gameshelf-online/backup.sh).
# sqlite3 .backup is safe while the server runs. Keeps 14 days.
set -eu
dest=/var/backups/gameshelf-online
mkdir -p "$dest"
sqlite3 /var/lib/gameshelf-online/online.sqlite3 ".backup '$dest/online-$(date +%F).sqlite3'"
find "$dest" -name 'online-*.sqlite3' -mtime +14 -delete
