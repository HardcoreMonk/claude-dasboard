#!/usr/bin/env bash
# Disaster recovery: rebuild the dashboard DB from scratch by rescanning
# every JSONL file under ~/.codex/projects/. Useful when:
#   - the DB is corrupted and no clean backup exists
#   - a migration bug left data in an inconsistent state
#   - you want a clean v0→v11 re-migration run
#
# Before wiping: always snapshot the current DB. We use dashboard-backups/
# with a distinctive `pre-rebuild_` prefix so it's never garbage-collected
# by backup.sh's 10-file rotation (which matches `dashboard_*`).
set -euo pipefail

DB="$HOME/.codex/dashboard.db"
DEST_DIR="$HOME/.codex/dashboard-backups"
UNIT="codex-web-dashboard.service"

die() { echo "ERROR: $*" >&2; exit 1; }

if [ ! -f "$DB" ]; then
  echo "No existing DB at $DB — nothing to rebuild. Just start the service:"
  echo "  sudo systemctl start $UNIT"
  exit 0
fi

mkdir -p "$DEST_DIR"
TS=$(date +%Y%m%d_%H%M%S)
PRE="$DEST_DIR/pre-rebuild_${TS}.db"

# Count current state for the "before" print
CUR_SESSIONS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions" 2>/dev/null || echo "?")
CUR_MSGS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM messages" 2>/dev/null || echo "?")
CUR_SIZE=$(du -h "$DB" | cut -f1)
echo "Current DB: $CUR_SESSIONS sessions, $CUR_MSGS messages, $CUR_SIZE"

echo
echo "This will:"
echo "  1. Stop $UNIT"
echo "  2. Snapshot current DB → $PRE"
echo "  3. Delete $DB"
echo "  4. Start $UNIT (auto v0→v11 re-migration + full JSONL rescan)"
echo
if [ -t 0 ]; then
  read -r -p "Proceed? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "aborted"
fi

echo "Stopping service …"
sudo systemctl stop "$UNIT" 2>/dev/null || echo "  (service was not running)"

echo "Snapshotting to $(basename "$PRE") …"
sqlite3 "$DB" ".backup '$PRE'" 2>/dev/null || cp "$DB" "$PRE"

echo "Removing $DB …"
rm -f "$DB" "${DB}-wal" "${DB}-shm"

echo "Starting service (initial scan may take 1-3 minutes) …"
sudo systemctl start "$UNIT"

# Wait for the service to be active
for i in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl is-active --quiet "$UNIT"; then
    break
  fi
  sleep 1
done

if ! systemctl is-active --quiet "$UNIT"; then
  die "service failed to start — check: journalctl -u $UNIT -n 50"
fi

echo "  service active"
echo
echo "Snapshot preserved: $PRE"
echo "To restore the original DB: ./restore.sh '$PRE'"
echo
echo "Watching progress (Ctrl+C to stop):"
journalctl -u "$UNIT" -f -n 20 --no-pager || true
