# Upgrading an existing Game Center Online database

There is no destructive step. The server adds tables only; it never drops a table, rewrites a
row, or changes an existing column.

## Before

1. Stop the service.
2. Copy the database and its WAL files:

   ```sh
   cp -a online.sqlite3 online.sqlite3-wal online.sqlite3-shm /var/backups/game-center-$(date +%F)/
   ```

   (If the WAL files do not exist, copy just `online.sqlite3`.)

## Upgrade

Start the new server with the same `--data` folder. On startup `Store` runs
`CREATE TABLE IF NOT EXISTS` and adds only missing columns, so:

- `players`, `rooms`, `invites`, `chat`, `moderation`, `matches`, `ratings`, `bot_records`,
  `old_names` and `arcade_removals` keep every row.
- New tables are created: `bot_ratings`, `rating_history`, `alert_prefs`, `alert_sent`,
  `availability`, `availability_games`, `play_requests`.
- Existing accounts keep working. A person who signed in before this version still has their
  hashed key in `players.token_hash`; they sign in with their name and saved key exactly as before.

## Verify

```sh
sqlite3 online.sqlite3 ".tables"
sqlite3 online.sqlite3 "SELECT COUNT(*) FROM players; SELECT COUNT(*) FROM matches;"
```

The first line must include `alert_prefs alert_sent bot_ratings rating_history` beside the old
tables, and also `availability`, `availability_games` and `play_requests`. The counts must match
the backup. Starting the server a second time changes nothing (the tests cover opening an old
schema twice).

## What is new

- Accounts now require the recovery key to sign in when the name already exists. New accounts get
  a key at creation and are told to copy it. Losing it means the name cannot be recovered; a new
  name can be made.
- Matchmaking (`/api/queue`), per-game lobby counts, alert preferences and the public bot ladder
  are new endpoints. Nothing old was removed.
- Old matches stay as they were. Bot-versus-bot games played from now on use the separate
  `bot_ratings` table; human ratings are untouched.
- Play requests add three empty tables and nothing else. `availability` is one row per player
  (`open`, `updated`). `availability_games` stores each game's on/off choice. `play_requests`
  is one row per request. Old rows are not rewritten, and a second startup does not add them again.
