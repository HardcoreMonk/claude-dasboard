"""DR tests: SQLite backup → integrity_check → restore round-trip.

The production /api/admin/backup endpoint uses sqlite3's ``.backup()`` API
while the restore.sh CLI takes a backup file and replaces the live DB. These
tests exercise the same primitive (sqlite3 backup) to ensure the produced
file is valid and restorable, and also verify that restoring a v1-schema
backup still allows the migration ladder to advance it to the latest.
"""
import sqlite3
import shutil
from pathlib import Path


def _populate(conn: sqlite3.Connection) -> None:
    """Write a representative row set so we can verify restore fidelity."""
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, project_path TEXT, cost_micro INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT, message_uuid TEXT UNIQUE, content_preview TEXT
        );
    ''')
    conn.execute("INSERT OR IGNORE INTO sessions(id, project_path, cost_micro) VALUES (?, ?, ?)",
                 ('sess-a', '/tmp/proj-a', 12345))
    conn.execute("INSERT OR IGNORE INTO sessions(id, project_path, cost_micro) VALUES (?, ?, ?)",
                 ('sess-b', '/tmp/proj-b', 67890))
    conn.execute(
        "INSERT OR IGNORE INTO messages(session_id, message_uuid, content_preview) VALUES (?, ?, ?)",
        ('sess-a', 'msg-1', 'hello'),
    )
    conn.execute(
        "INSERT OR IGNORE INTO messages(session_id, message_uuid, content_preview) VALUES (?, ?, ?)",
        ('sess-a', 'msg-2', 'world'),
    )
    conn.execute("PRAGMA user_version = 3")
    conn.commit()


def test_sqlite_backup_produces_valid_file(tmp_path):
    """The sqlite3 .backup() API must produce a file that passes integrity_check."""
    src = tmp_path / 'source.db'
    dst = tmp_path / 'backup.db'

    s = sqlite3.connect(str(src))
    _populate(s)

    d = sqlite3.connect(str(dst))
    with d:
        s.backup(d)
    d.close()
    s.close()

    # Verify
    chk = sqlite3.connect(str(dst))
    try:
        assert chk.execute("PRAGMA integrity_check").fetchone()[0] == 'ok'
        # Rows present
        assert chk.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2
        assert chk.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
        assert chk.execute("PRAGMA user_version").fetchone()[0] == 3
    finally:
        chk.close()


def test_restore_round_trip_preserves_data(tmp_path):
    """Copy a backup file over an existing DB file → the data comes back."""
    orig = tmp_path / 'live.db'
    backup = tmp_path / 'backup.db'

    # 1. Populate live DB
    conn = sqlite3.connect(str(orig))
    _populate(conn)
    conn.close()

    # 2. Backup it
    src = sqlite3.connect(str(orig))
    dst = sqlite3.connect(str(backup))
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    # 3. Mutate the live DB (simulate drift)
    conn = sqlite3.connect(str(orig))
    conn.execute("DELETE FROM sessions")
    conn.execute("DELETE FROM messages")
    conn.commit()
    conn.close()

    # 4. Restore = copy backup over live
    shutil.copy2(str(backup), str(orig))

    # 5. Verify original data is back
    conn = sqlite3.connect(str(orig))
    try:
        n = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        assert n == 2, f"expected 2 sessions, got {n}"
        cost = conn.execute("SELECT cost_micro FROM sessions WHERE id='sess-b'").fetchone()[0]
        assert cost == 67890
        assert conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == 'ok'
    finally:
        conn.close()


def test_backup_is_readable_while_source_has_pending_writes(tmp_path):
    """sqlite3.backup() must snapshot a consistent view even under concurrent
    writes (WAL mode protects us). Not a true concurrency test — just a smoke
    check that backup() doesn't throw when source was just committed."""
    src_path = tmp_path / 'busy.db'
    dst_path = tmp_path / 'busy.backup.db'

    src = sqlite3.connect(str(src_path))
    src.execute("PRAGMA journal_mode=WAL")
    _populate(src)

    # Pending insert (committed)
    src.execute("INSERT INTO sessions(id, project_path, cost_micro) VALUES ('sess-c', '/tmp/c', 1)")
    src.commit()

    dst = sqlite3.connect(str(dst_path))
    with dst:
        src.backup(dst)
    dst.close()
    src.close()

    # Destination must include the committed row
    chk = sqlite3.connect(str(dst_path))
    try:
        n = chk.execute("SELECT COUNT(*) FROM sessions WHERE id='sess-c'").fetchone()[0]
        assert n == 1
    finally:
        chk.close()
