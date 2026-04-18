#!/usr/bin/env bash
# Restore the dashboard database from a backup file, safely.
#
# Safety measures:
#   1. PRAGMA integrity check on the source backup before replacing
#   2. Snapshot the current DB to dashboard-backups/pre-restore_<ts>.db
#      so a mistaken restore can itself be undone
#   3. Stop codex-web-dashboard.service before replacement so the watcher
#      doesn't half-write to the swapped-out file, restart afterwards
#
# Usage:
#   ./restore.sh                              # interactive picker (newest 10)
#   ./restore.sh <backup_file>                # restore from an explicit path
#   ./restore.sh --latest                     # restore the most recent backup
set -euo pipefail

DB="$HOME/.codex/dashboard.db"
DEST_DIR="$HOME/.codex/dashboard-backups"
UNIT="codex-web-dashboard.service"

die() { echo "ERROR: $*" >&2; exit 1; }

pick_latest() {
  ls -1t "$DEST_DIR"/dashboard_*.db 2>/dev/null | head -n 1
}

pick_interactive() {
  local files=()
  mapfile -t files < <(ls -1t "$DEST_DIR"/dashboard_*.db 2>/dev/null | head -n 10)
  [ "${#files[@]}" -gt 0 ] || die "no backups found in $DEST_DIR"
  echo "Available backups (newest first):"
  local i=1
  for f in "${files[@]}"; do
    local size
    size=$(du -h "$f" | cut -f1)
    echo "  $i) $(basename "$f")  ($size)"
    i=$((i + 1))
  done
  printf "Pick a backup [1-%d, default 1]: " "${#files[@]}"
  read -r choice
  choice=${choice:-1}
  if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#files[@]}" ]; then
    die "invalid choice"
  fi
  echo "${files[$((choice - 1))]}"
}

# Resolve source
if [ $# -eq 0 ]; then
  SRC=$(pick_interactive)
elif [ "$1" = "--latest" ]; then
  SRC=$(pick_latest) || die "no backups found"
  [ -n "$SRC" ] || die "no backups found"
else
  SRC="$1"
fi

[ -f "$SRC" ] || die "backup file not found: $SRC"

# Integrity check on the source BEFORE we touch the live DB
echo "Verifying integrity of $(basename "$SRC") …"
if ! sqlite3 "$SRC" "PRAGMA integrity_check" | grep -qx "ok"; then
  die "source backup failed integrity_check — refusing to restore"
fi
VERSION=$(sqlite3 "$SRC" "PRAGMA user_version")
echo "  integrity: ok · schema version: $VERSION"

# Confirm with the user
TS=$(date +%Y%m%d_%H%M%S)
PRE_RESTORE="$DEST_DIR/pre-restore_${TS}.db"
echo
echo "About to:"
echo "  1. Stop ${UNIT}"
echo "  2. Snapshot current db → $PRE_RESTORE"
echo "  3. Replace $DB with $(basename "$SRC")"
echo "  4. Start ${UNIT}"
echo
if [ -t 0 ]; then
  read -r -p "Proceed? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || die "aborted"
fi

# Stop service (best effort — may not be running)
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl stop "$UNIT" 2>/dev/null || echo "  (service was not running)"
fi

# Snapshot current DB before overwrite
if [ -f "$DB" ]; then
  mkdir -p "$DEST_DIR"
  sqlite3 "$DB" ".backup '$PRE_RESTORE'" 2>/dev/null || cp "$DB" "$PRE_RESTORE"
  echo "  snapshot saved: $(basename "$PRE_RESTORE")"
fi

# Atomic replace via rename (fsync-safe on same filesystem)
TMP="${DB}.restore.tmp"
cp "$SRC" "$TMP"
mv "$TMP" "$DB"

# Verify the new file
if ! sqlite3 "$DB" "PRAGMA integrity_check" | grep -qx "ok"; then
  echo "ERROR: restored DB failed integrity_check — rolling back" >&2
  mv "$PRE_RESTORE" "$DB"
  exit 1
fi

echo "  restored: $DB"
echo "  schema version: $(sqlite3 "$DB" "PRAGMA user_version")"

# Restart service
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl start "$UNIT" 2>/dev/null || true
  sleep 1
  if systemctl is-active --quiet "$UNIT"; then
    echo "  ${UNIT}: active"
  fi
fi

echo "Done."
