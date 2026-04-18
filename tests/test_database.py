"""Unit tests for database.py — migrations, FTS5, thread-local pool."""
import sqlite3
import sys
import threading
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    """Each test gets a fresh DB file and a fresh database module state."""
    db_file = tmp_path / 'test.db'
    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    if hasattr(database._read_local, 'conn'):
        try:
            database._read_local.conn.close()
        except Exception:
            pass
        database._read_local.conn = None
    yield db_file
    if hasattr(database._read_local, 'conn') and database._read_local.conn is not None:
        try:
            database._read_local.conn.close()
        except Exception:
            pass
        database._read_local.conn = None


# ─── Migrations ─────────────────────────────────────────────────────────

def test_init_db_creates_schema_at_current_version(temp_db):
    import database
    database.init_db()
    conn = sqlite3.connect(str(temp_db))
    v = conn.execute("PRAGMA user_version").fetchone()[0]
    assert v == database.SCHEMA_VERSION


def test_init_db_is_idempotent(temp_db):
    """Running migrations twice should leave the DB in the same state."""
    import database
    database.init_db()
    conn = sqlite3.connect(str(temp_db))
    v1 = conn.execute("PRAGMA user_version").fetchone()[0]
    tables1 = sorted(r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    conn.close()

    database.init_db()  # second run
    conn = sqlite3.connect(str(temp_db))
    v2 = conn.execute("PRAGMA user_version").fetchone()[0]
    tables2 = sorted(r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    conn.close()

    assert v1 == v2 == database.SCHEMA_VERSION
    assert tables1 == tables2

# ─── Codex schema / search ──────────────────────────────────────────────

def test_init_db_creates_codex_schema_objects(temp_db):
    import database
    database.init_db()

    conn = sqlite3.connect(str(temp_db))
    objects = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE name IN ('codex_projects', 'codex_sessions', 'codex_messages', 'codex_messages_fts')"
        )
    }

    assert objects == {
        'codex_projects',
        'codex_sessions',
        'codex_messages',
        'codex_messages_fts',
    }


def test_init_db_does_not_create_claude_ai_schema_objects(temp_db):
    import database
    database.init_db()

    conn = sqlite3.connect(str(temp_db))
    objects = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE name IN ('claude_ai_conversations', 'claude_ai_messages', 'claude_ai_messages_fts')"
        )
    }

    assert objects == set()


def test_codex_fts_search_returns_message_with_context(temp_db):
    import database
    database.init_db()

    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='sess-1',
        session_name='demo session',
        role='user',
        content='searchable quantum widget',
        content_preview='searchable quantum widget',
        timestamp='2026-04-16T00:00:01Z',
    )

    rows = database.search_codex_messages('quantum')

    assert len(rows) == 1
    row = rows[0]
    assert row['project_path'] == '/tmp/codex-demo'
    assert row['project_name'] == 'codex-demo'
    assert row['session_id'] == 'sess-1'
    assert row['role'] == 'user'
    assert row['content_preview'] == 'searchable quantum widget'


def test_codex_message_insert_is_duplicate_safe(temp_db):
    import database
    database.init_db()

    payload = dict(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='sess-dup',
        session_name='duplicate session',
        role='user',
        content='duplicate-safe content',
        content_preview='duplicate-safe content',
        timestamp='2026-04-16T00:00:02Z',
        message_uuid='msg-dup-1',
    )

    database.store_codex_message(**payload)
    database.store_codex_message(**payload)

    conn = sqlite3.connect(str(temp_db))
    rows = conn.execute(
        "SELECT COUNT(*) FROM codex_messages WHERE message_uuid='msg-dup-1'"
    ).fetchone()[0]
    assert rows == 1


def test_codex_session_counters_increment_on_message_insert(temp_db):
    import database
    database.init_db()

    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='sess-counts',
        session_name='counted session',
        role='user',
        content='first user message',
        content_preview='first user message',
        timestamp='2026-04-16T00:00:03Z',
        message_uuid='msg-count-1',
    )
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='sess-counts',
        session_name='counted session',
        role='assistant',
        content='assistant reply',
        content_preview='assistant reply',
        timestamp='2026-04-16T00:00:04Z',
        message_uuid='msg-count-2',
    )
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='sess-counts',
        session_name='counted session',
        role='user',
        content='first user message',
        content_preview='first user message',
        timestamp='2026-04-16T00:00:03Z',
        message_uuid='msg-count-1',
    )

    conn = sqlite3.connect(str(temp_db))
    row = conn.execute(
        "SELECT message_count, user_message_count FROM codex_sessions WHERE id='sess-counts'"
    ).fetchone()
    assert row == (2, 1)
    total = conn.execute(
        "SELECT COUNT(*) FROM codex_messages WHERE session_id='sess-counts'"
    ).fetchone()[0]
    assert total == 2


# ─── Thread-local read pool ─────────────────────────────────────────────

def test_read_db_reuses_connection_per_thread(temp_db):
    """Two read_db calls on the same thread should share one connection."""
    import database
    database.init_db()

    ids = []
    with database.read_db() as c1:
        ids.append(id(c1))
    with database.read_db() as c2:
        ids.append(id(c2))
    assert ids[0] == ids[1], 'same-thread read_db should reuse connection'


def test_read_db_isolates_connections_across_threads(temp_db):
    """Different threads must see different connection objects."""
    import database
    database.init_db()

    seen: list[int] = []
    lock = threading.Lock()

    def worker():
        with database.read_db() as c:
            with lock:
                seen.append(id(c))

    t1 = threading.Thread(target=worker)
    t2 = threading.Thread(target=worker)
    t1.start(); t2.start()
    t1.join(); t2.join()

    assert len(seen) == 2
    assert seen[0] != seen[1], 'thread-local isolation broken'


def test_write_db_serializes_writes(temp_db):
    """Concurrent writes must not corrupt row counts."""
    import database
    database.init_db()

    def writer(n):
        for i in range(20):
            with database.write_db() as db:
                db.execute("INSERT INTO file_watch_state (file_path, last_line) VALUES (?, ?)",
                           (f't{n}-{i}', 0))

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
    for t in threads: t.start()
    for t in threads: t.join()

    conn = sqlite3.connect(str(temp_db))
    n = conn.execute("SELECT COUNT(*) FROM file_watch_state").fetchone()[0]
    assert n == 80


# ─── Integrity ──────────────────────────────────────────────────────────

def test_check_integrity_ok_after_init(temp_db):
    import database
    database.init_db()
    assert database.check_integrity() is True
