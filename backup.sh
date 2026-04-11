#!/usr/bin/env bash
# Manual backup of the dashboard database.
# Also callable via:  curl -X POST http://localhost:8765/api/admin/backup
set -e

DB="$HOME/.claude/dashboard.db"
DEST_DIR="$HOME/.claude/dashboard-backups"
mkdir -p "$DEST_DIR"

TS=$(date +%Y%m%d_%H%M%S)
DEST="$DEST_DIR/dashboard_${TS}.db"

if [ ! -f "$DB" ]; then
  echo "No database at $DB" >&2
  exit 1
fi

sqlite3 "$DB" ".backup '$DEST'" 2>/dev/null || cp "$DB" "$DEST"

SIZE=$(du -h "$DEST" | cut -f1)
echo "Backup: $DEST ($SIZE)"

# Keep only last 10 backups
ls -1t "$DEST_DIR"/dashboard_*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "Kept $(ls -1 "$DEST_DIR"/dashboard_*.db 2>/dev/null | wc -l) backups"
