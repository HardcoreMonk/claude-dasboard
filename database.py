"""
SQLite layer with thread-safe writes, thread-local read pool, and versioned migrations.

Cost stored as INTEGER micro-dollars (1 USD = 1,000,000 microusd).
This eliminates float accumulation drift entirely.
"""
import json
import logging
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH = Path(
    os.environ.get(
        'DASHBOARD_DB_PATH',
        str(Path.home() / '.codex' / 'dashboard.db'),
    )
)

_write_lock = threading.Lock()
_read_local = threading.local()   # per-thread cached read connection
_READ_CONN_TTL = 300              # seconds before recycling a cached read connection
_READ_EPOCH = 0                   # incremented after writes so readers reopen snapshots

MICRO = 1_000_000                 # 1 USD = 1M micro-dollars
SCHEMA_VERSION = 18               # bump on every schema change
_CODEX_FTS_TOKEN_RE = re.compile(r'[\w가-힣]+', re.UNICODE)


def _esc_like(value: str) -> str:
    return value.replace('\\', '\\\\').replace('%', r'\%').replace('_', r'\_')


def _configure(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    # Incremental auto-vacuum lets /api/admin/retention reclaim space without
    # a full VACUUM rewrite. First-time switch from NONE only takes effect
    # after a one-shot VACUUM, so a brand-new DB inherits it immediately.
    conn.execute("PRAGMA auto_vacuum=INCREMENTAL")


def _new_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30)
    _configure(conn)
    return conn


@contextmanager
def read_db():
    """Reuses a single sqlite3.Connection per OS thread (PRAGMAs are set once).

    Connections older than ``_READ_CONN_TTL`` seconds are closed and recreated
    to prevent stale WAL snapshots from accumulating indefinitely.
    """
    conn = getattr(_read_local, 'conn', None)
    conn_epoch = getattr(_read_local, 'conn_epoch', -1)
    if (
        conn is None
        or conn_epoch != _READ_EPOCH
        or (time.time() - getattr(_read_local, 'conn_time', 0)) > _READ_CONN_TTL
    ):
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        conn = _new_connection()
        _read_local.conn = conn
        _read_local.conn_time = time.time()
        _read_local.conn_epoch = _READ_EPOCH
    try:
        yield conn
    except sqlite3.Error:
        try:
            conn.close()
        except Exception:
            pass
        _read_local.conn = None
        _read_local.conn_epoch = -1
        raise


@contextmanager
def write_db():
    """Single-writer context. Always opens a fresh connection to avoid
    interleaving with any read connection cached on the same thread."""
    global _READ_EPOCH
    with _write_lock:
        conn = _new_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
            _READ_EPOCH += 1
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


_CODEX_BOOTSTRAP_SCHEMA = '''
CREATE TABLE IF NOT EXISTS file_watch_state (
    file_path TEXT PRIMARY KEY,
    last_line INTEGER DEFAULT 0,
    last_modified REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    daily_cost_limit REAL DEFAULT 50.0,
    weekly_cost_limit REAL DEFAULT 300.0,
    reset_hour INTEGER DEFAULT 0,
    reset_weekday INTEGER DEFAULT 0,
    timezone_offset INTEGER DEFAULT 9,
    timezone_name TEXT DEFAULT 'Asia/Seoul'
);
INSERT OR IGNORE INTO plan_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS remote_nodes (
    node_id TEXT PRIMARY KEY,
    label TEXT,
    ingest_key_hash TEXT NOT NULL,
    last_seen TEXT,
    session_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    action TEXT NOT NULL,
    actor_ip TEXT,
    status TEXT NOT NULL DEFAULT 'ok',
    detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_ts
ON admin_audit(ts DESC);

CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
'''


# v15: Codex-native project/session/message store with message-first FTS.
_MIGRATE_V15_CODEX = '''
CREATE TABLE IF NOT EXISTS codex_projects (
    project_path TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS codex_sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL REFERENCES codex_projects(project_path) ON DELETE CASCADE,
    session_name TEXT,
    created_at TEXT,
    updated_at TEXT,
    model TEXT,
    cwd TEXT,
    source_node TEXT DEFAULT 'local',
    pinned INTEGER DEFAULT 0,
    final_stop_reason TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    user_message_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_codex_sessions_project_path ON codex_sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated_at ON codex_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_source_node ON codex_sessions(source_node);

CREATE TABLE IF NOT EXISTS codex_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
    message_uuid TEXT UNIQUE,
    parent_uuid TEXT,
    role TEXT,
    content TEXT,
    content_preview TEXT,
    timestamp TEXT,
    model TEXT
);

CREATE INDEX IF NOT EXISTS idx_codex_messages_session_id ON codex_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_codex_messages_timestamp ON codex_messages(timestamp);

CREATE VIRTUAL TABLE IF NOT EXISTS codex_messages_fts USING fts5(
    content_preview,
    content='codex_messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
);

CREATE TRIGGER IF NOT EXISTS codex_messages_fts_ai AFTER INSERT ON codex_messages BEGIN
    INSERT INTO codex_messages_fts(rowid, content_preview)
    VALUES (new.id, COALESCE(new.content_preview, ''));
END;

CREATE TRIGGER IF NOT EXISTS codex_messages_fts_ad AFTER DELETE ON codex_messages BEGIN
    INSERT INTO codex_messages_fts(codex_messages_fts, rowid, content_preview)
    VALUES ('delete', old.id, COALESCE(old.content_preview, ''));
END;

CREATE TRIGGER IF NOT EXISTS codex_messages_fts_au AFTER UPDATE OF content_preview ON codex_messages BEGIN
    INSERT INTO codex_messages_fts(codex_messages_fts, rowid, content_preview)
    VALUES ('delete', old.id, COALESCE(old.content_preview, ''));
    INSERT INTO codex_messages_fts(rowid, content_preview)
    VALUES (new.id, COALESCE(new.content_preview, ''));
END;
'''


def _get_user_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0]) if row else 0


def _set_user_version(conn: sqlite3.Connection, v: int) -> None:
    conn.execute(f"PRAGMA user_version = {int(v)}")


def _ensure_column(conn: sqlite3.Connection, table: str, col: str, decl: str) -> None:
    cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    if col not in cols:
        logger.info("Adding column %s.%s", table, col)
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def _backfill_codex_fts(conn: sqlite3.Connection) -> None:
    total = conn.execute("SELECT COUNT(*) FROM codex_messages").fetchone()[0]
    logger.info("Rebuilding Codex FTS index (%d rows) …", total)
    conn.execute("INSERT INTO codex_messages_fts(codex_messages_fts) VALUES('rebuild')")
    logger.info("Codex FTS rebuild complete")


def _ensure_codex_project(conn: sqlite3.Connection, project_path: str, project_name: str) -> None:
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    conn.execute(
        '''
        INSERT INTO codex_projects (project_path, project_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_path) DO UPDATE SET
            project_name = excluded.project_name,
            updated_at = excluded.updated_at
        ''',
        (project_path, project_name, now, now),
    )


def _ensure_codex_session(
    conn: sqlite3.Connection,
    session_id: str,
    project_path: str,
    session_name: str = '',
    created_at: str = '',
    updated_at: str = '',
    cwd: str = '',
    model: str | None = None,
    source_node: str = 'local',
) -> None:
    conn.execute(
        '''
        INSERT INTO codex_sessions
            (id, project_path, session_name, created_at, updated_at, cwd, model, source_node)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            project_path = excluded.project_path,
            session_name = COALESCE(NULLIF(excluded.session_name, ''), codex_sessions.session_name),
            created_at = COALESCE(NULLIF(excluded.created_at, ''), codex_sessions.created_at),
            updated_at = COALESCE(NULLIF(excluded.updated_at, ''), codex_sessions.updated_at),
            cwd = COALESCE(NULLIF(excluded.cwd, ''), codex_sessions.cwd),
            model = COALESCE(NULLIF(excluded.model, ''), codex_sessions.model),
            source_node = COALESCE(NULLIF(excluded.source_node, ''), codex_sessions.source_node, 'local')
        ''',
        (session_id, project_path, session_name, created_at, updated_at, cwd, model or '', source_node or 'local'),
    )


def store_codex_message(
    *,
    project_path: str,
    project_name: str,
    session_id: str,
    session_name: str = '',
    role: str,
    content: str = '',
    content_preview: str = '',
    timestamp: str = '',
    message_uuid: str | None = None,
    parent_uuid: str = '',
    model: str = '',
    cwd: str = '',
    source_node: str = 'local',
) -> int:
    """Persist a Codex message plus its project/session context."""
    preview = content_preview or content[:240]
    with write_db() as conn:
        _ensure_codex_project(conn, project_path, project_name or Path(project_path).name or project_path)
        _ensure_codex_session(
            conn,
            session_id,
            project_path,
            session_name,
            timestamp,
            timestamp,
            cwd,
            model,
            source_node,
        )
        cur = conn.execute(
            '''
            INSERT OR IGNORE INTO codex_messages
                (session_id, message_uuid, parent_uuid, role, content, content_preview, timestamp, model)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''',
            (session_id, message_uuid, parent_uuid, role, content, preview, timestamp, model),
        )
        if cur.rowcount > 0:
            conn.execute(
                '''
                UPDATE codex_sessions
                   SET message_count = COALESCE(message_count, 0) + 1,
                       user_message_count = COALESCE(user_message_count, 0) + ?
                 WHERE id = ?
                ''',
                (1 if role == 'user' else 0, session_id),
            )
        return int(cur.lastrowid)


def search_codex_messages(
    query: str,
    limit: int = 20,
    project: str = '',
    role: str = '',
) -> list[sqlite3.Row]:
    """Search Codex messages joined with session/project context."""
    if not query.strip():
        return []

    select_sql = '''
        SELECT
            m.id AS message_id,
            m.session_id,
            m.message_uuid,
            m.parent_uuid,
            m.role,
            m.content AS body,
            m.content_preview,
            m.content_preview AS body_text,
            m.timestamp AS created_at,
            m.model,
            s.session_name AS session_title,
            s.created_at AS session_created_at,
            s.updated_at AS session_updated_at,
            p.project_path,
            p.project_name
        FROM codex_messages m
        JOIN codex_sessions s ON s.id = m.session_id
        JOIN codex_projects p ON p.project_path = s.project_path
    '''

    filters: list[str] = []
    base_params: list[object] = []
    if project:
        filters.append('(p.project_name = ? OR p.project_path = ?)')
        base_params.extend([project, project])
    if role:
        filters.append('m.role = ?')
        base_params.append(role)

    tokens = [t for t in _CODEX_FTS_TOKEN_RE.findall(query) if len(t) >= 2]
    fts_query = ' '.join(f'"{token}"' for token in tokens)

    def _like_search(conn: sqlite3.Connection) -> list[sqlite3.Row]:
        like_sql = select_sql
        like_filters = list(filters)
        like_filters.append("(m.content_preview LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')")
        like_sql += ' WHERE ' + ' AND '.join(like_filters)
        like_sql += ' ORDER BY m.timestamp DESC, m.id DESC LIMIT ?'
        like_value = f"%{_esc_like(query)}%"
        params = [*base_params, like_value, like_value, limit]
        return list(conn.execute(like_sql, params).fetchall())

    with read_db() as conn:
        if not fts_query:
            return _like_search(conn)
        sql = '''
            SELECT
                m.id AS message_id,
                m.session_id,
                m.message_uuid,
                m.parent_uuid,
                m.role,
                m.content AS body,
                m.content_preview,
                m.content_preview AS body_text,
                m.timestamp AS created_at,
                m.model,
                s.session_name AS session_title,
                s.created_at AS session_created_at,
                s.updated_at AS session_updated_at,
                p.project_path,
                p.project_name
            FROM codex_messages_fts f
            JOIN codex_messages m ON m.id = f.rowid
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE codex_messages_fts MATCH ?
        '''
        params: list[object] = [fts_query, *base_params]
        if filters:
            sql += ' AND ' + ' AND '.join(filters)
        sql += ' ORDER BY bm25(codex_messages_fts), m.timestamp DESC, m.id DESC LIMIT ?'
        params.append(limit)
        try:
            return list(conn.execute(sql, params).fetchall())
        except sqlite3.OperationalError:
            return _like_search(conn)


def get_codex_message_context(message_id: int, window: int = 2) -> dict | None:
    """Return neighboring Codex messages around one message."""
    with read_db() as conn:
        current = conn.execute(
            '''
            SELECT id AS message_id, session_id, role,
                   content_preview AS body_text, timestamp AS created_at
            FROM codex_messages
            WHERE id = ?
            ''',
            (message_id,),
        ).fetchone()
        if not current:
            return None

        before = conn.execute(
            '''
            SELECT * FROM (
                SELECT id AS message_id, session_id, role,
                       content_preview AS body_text, timestamp AS created_at
                FROM codex_messages
                WHERE session_id = ?
                  AND (timestamp < ? OR (timestamp = ? AND id < ?))
                ORDER BY timestamp DESC, id DESC
                LIMIT ?
            )
            ORDER BY created_at ASC, message_id ASC
            ''',
            (
                current['session_id'],
                current['created_at'],
                current['created_at'],
                current['message_id'],
                window,
            ),
        ).fetchall()
        after = conn.execute(
            '''
            SELECT id AS message_id, session_id, role,
                   content_preview AS body_text, timestamp AS created_at
            FROM codex_messages
            WHERE session_id = ?
              AND (timestamp > ? OR (timestamp = ? AND id > ?))
            ORDER BY timestamp ASC, id ASC
            LIMIT ?
            ''',
            (
                current['session_id'],
                current['created_at'],
                current['created_at'],
                current['message_id'],
                window,
            ),
        ).fetchall()

    return {
        'session_id': current['session_id'],
        'current': dict(current),
        'before': [dict(row) for row in before],
        'after': [dict(row) for row in after],
    }


def _decode_codex_payload(content: str) -> dict:
    if not content:
        return {}
    try:
        value = json.loads(content)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def get_codex_session_replay(session_id: str) -> dict | None:
    """Return ordered replay events for a Codex session."""
    with read_db() as conn:
        session = conn.execute(
            '''
            SELECT s.id AS session_id, s.session_name AS session_title,
                   s.created_at, s.updated_at, p.project_name, p.project_path
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE s.id = ?
            ''',
            (session_id,),
        ).fetchone()
        if not session:
            return None

        rows = conn.execute(
            '''
            SELECT id AS message_id, role, content, content_preview, timestamp, model
            FROM codex_messages
            WHERE session_id = ?
            ORDER BY timestamp ASC, message_id ASC
            ''',
            (session_id,),
        ).fetchall()

    events: list[dict] = []
    for row in rows:
        payload = _decode_codex_payload(row['content'])
        event = {
            'message_id': row['message_id'],
            'timestamp': row['timestamp'],
            'model': row['model'],
            'payload': payload,
        }
        if row['role'] == 'tool':
            event.update({
                'kind': 'tool_call',
                'tool_name': payload.get('name', ''),
                'body_text': row['content_preview'],
            })
        elif row['role'] == 'agent':
            event.update({
                'kind': 'agent_run',
                'agent_name': payload.get('agent_name', ''),
                'status': payload.get('status', ''),
                'body_text': row['content_preview'],
            })
        else:
            event.update({
                'kind': 'message',
                'role': row['role'],
                'body_text': row['content_preview'],
            })
        events.append(event)

    payload = dict(session)
    payload['events'] = events
    return payload


def list_codex_sessions(limit: int = 50) -> dict:
    """Return recent Codex sessions suitable for replay launching."""
    with read_db() as conn:
        rows = conn.execute(
            '''
            SELECT s.id AS session_id,
                   s.session_name AS session_title,
                   p.project_name,
                   s.message_count,
                   s.user_message_count,
                   s.updated_at AS last_activity_at
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            ORDER BY s.updated_at DESC, s.id DESC
            LIMIT ?
            ''',
            (limit,),
        ).fetchall()
        total = conn.execute('SELECT COUNT(*) AS c FROM codex_sessions').fetchone()['c']
        role_rows = conn.execute(
            '''
            SELECT session_id, role, COUNT(*) AS count
            FROM codex_messages
            GROUP BY session_id, role
            '''
        ).fetchall()

    role_counts: dict[str, dict[str, int]] = {}
    for row in role_rows:
        role_counts.setdefault(row['session_id'], {})[row['role']] = int(row['count'] or 0)

    sessions = []
    for row in rows:
        session = dict(row)
        session['message_count'] = int(session['message_count'] or 0)
        session['user_message_count'] = int(session['user_message_count'] or 0)
        session['role_counts'] = role_counts.get(session['session_id'], {})
        session['replay_url'] = f"/api/sessions/{session['session_id']}/replay"
        sessions.append(session)

    return {'sessions': sessions, 'total': int(total or 0)}


def get_codex_timeline_summary(
    limit: int = 200,
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict:
    """Return recent Codex events in a compact timeline-friendly shape."""
    where = ''
    params: list[object] = []
    if date_from:
        where += ' AND m.timestamp >= ?'
        params.append(date_from)
    if date_to:
        where += ' AND m.timestamp <= ?'
        params.append(date_to if len(date_to) > 10 else date_to + 'T23:59:59Z')
    with read_db() as conn:
        rows = conn.execute(
            f'''
            SELECT m.id AS message_id,
                   m.session_id,
                   m.role,
                   m.content,
                   m.content_preview,
                   m.timestamp,
                   s.session_name,
                   p.project_name
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE 1=1 {where}
            ORDER BY m.timestamp DESC, m.id DESC
            LIMIT ?
            ''',
            (*params, limit),
        ).fetchall()
        totals = conn.execute(
            f'''
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT session_id) AS sessions
            FROM codex_messages
            WHERE 1=1 {where.replace('m.timestamp', 'timestamp')}
            ''',
            params,
        ).fetchone()
        session_rows = conn.execute(
            f'''
            SELECT m.session_id,
                   s.session_name AS session_title,
                   p.project_name,
                   COUNT(*) AS event_count,
                   MAX(m.timestamp) AS last_activity_at
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE 1=1 {where}
            GROUP BY m.session_id, s.session_name, p.project_name
            ORDER BY last_activity_at DESC, m.session_id DESC
            LIMIT ?
            ''',
            (*params, limit),
        ).fetchall()

    items: list[dict] = []
    for row in rows:
        payload = _decode_codex_payload(row['content'])
        label = row['role']
        kind = 'message'
        if row['role'] == 'tool':
            kind = 'tool_call'
            label = payload.get('name', '') or 'tool'
        elif row['role'] == 'agent':
            kind = 'agent_run'
            label = payload.get('agent_name', '') or 'agent'
        items.append({
            'message_id': row['message_id'],
            'session_id': row['session_id'],
            'session_title': row['session_name'],
            'project_name': row['project_name'],
            'timestamp': row['timestamp'],
            'kind': kind,
            'label': label,
            'body_text': row['content_preview'] or '',
        })

    return {
        'items': items,
        'total': int(totals['total'] or 0),
        'sessions': int(totals['sessions'] or 0),
        'session_summaries': [
            {
                'session_id': row['session_id'],
                'session_title': row['session_title'],
                'project_name': row['project_name'],
                'event_count': int(row['event_count'] or 0),
                'last_activity_at': row['last_activity_at'],
            }
            for row in session_rows
        ],
    }


def get_codex_usage_summary() -> dict:
    """Return compact Codex usage totals for summary widgets."""
    with read_db() as conn:
        totals = conn.execute(
            '''
            SELECT COUNT(*) AS messages,
                   COUNT(DISTINCT m.session_id) AS sessions,
                   COUNT(DISTINCT s.project_path) AS projects,
                   MAX(m.timestamp) AS latest_activity_at
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            '''
        ).fetchone()
        by_role = conn.execute(
            '''
            SELECT role, COUNT(*) AS count
            FROM codex_messages
            GROUP BY role
            ORDER BY role
            '''
        ).fetchall()
        top_sessions = conn.execute(
            '''
            SELECT s.id AS session_id,
                   s.session_name AS session_title,
                   p.project_name,
                   s.message_count,
                   s.updated_at AS last_activity_at
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            ORDER BY s.message_count DESC, s.updated_at DESC, s.id DESC
            LIMIT 10
            '''
        ).fetchall()

    return {
        'sessions': int(totals['sessions'] or 0),
        'messages': int(totals['messages'] or 0),
        'projects': int(totals['projects'] or 0),
        'latest_activity_at': totals['latest_activity_at'],
        'by_role': {row['role']: int(row['count'] or 0) for row in by_role},
        'top_sessions': [
            {
                'session_id': row['session_id'],
                'session_title': row['session_title'],
                'project_name': row['project_name'],
                'message_count': int(row['message_count'] or 0),
                'last_activity_at': row['last_activity_at'],
            }
            for row in top_sessions
        ],
    }


_CODEX_SESSIONS_SORT_MAP = {
    'updated_at': 's.updated_at',
    'created_at': 's.created_at',
    'messages': 's.message_count',
    'project': 'p.project_name',
    'model': 's.model',
}


def list_codex_sessions_table(
    *,
    page: int = 1,
    per_page: int = 25,
    search: str = '',
    sort: str = 'updated_at',
    order: str = 'desc',
) -> dict:
    sort_col = _CODEX_SESSIONS_SORT_MAP.get(sort, 's.updated_at')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    offset = (page - 1) * per_page
    where = ''
    params: list[object] = []
    if search:
        where = '''
        WHERE (
            p.project_name LIKE ? ESCAPE '\\'
            OR s.cwd LIKE ? ESCAPE '\\'
            OR s.session_name LIKE ? ESCAPE '\\'
            OR s.id LIKE ? ESCAPE '\\'
        )
        '''
        term = f'%{search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")}%'
        params.extend([term, term, term, term])

    with read_db() as conn:
        total = conn.execute(
            f'''
            SELECT COUNT(*)
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            {where}
            ''',
            params,
        ).fetchone()[0]
        rows = conn.execute(
            f'''
            SELECT
                s.id,
                p.project_name,
                s.project_path,
                COALESCE(s.cwd, s.project_path) AS cwd,
                COALESCE(NULLIF(s.model, ''), '(unknown)') AS model,
                s.created_at,
                s.updated_at,
                0 AS total_input_tokens,
                0 AS total_output_tokens,
                0 AS total_cache_creation_tokens,
                0 AS total_cache_read_tokens,
                0.0 AS total_cost_usd,
                s.message_count,
                s.user_message_count,
                COALESCE(s.pinned, 0) AS pinned,
                0 AS is_subagent,
                NULL AS parent_session_id,
                '' AS agent_type,
                '' AS agent_description,
                '' AS version,
                COALESCE(NULLIF(s.final_stop_reason, ''), '') AS final_stop_reason,
                COALESCE(NULLIF(s.tags, ''), '') AS tags,
                0 AS turn_duration_ms,
                COALESCE(NULLIF(s.source_node, ''), 'local') AS source_node,
                (julianday(COALESCE(NULLIF(s.updated_at,''), s.created_at)) - julianday(s.created_at)) * 86400.0 AS duration_seconds,
                0 AS subagent_count,
                0.0 AS subagent_cost,
                COALESCE(NULLIF(s.session_name, ''), s.id) AS session_title
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            {where}
            ORDER BY {sort_col} {order_sql}, s.id DESC
            LIMIT ? OFFSET ?
            ''',
            (*params, per_page, offset),
        ).fetchall()

    return {
        'sessions': [dict(r) for r in rows],
        'total': int(total or 0),
        'page': page,
        'per_page': per_page,
        'pages': max(1, -(-int(total or 0) // per_page)),
        'sort': sort,
        'order': order_sql.lower(),
    }


def get_codex_session_detail_row(session_id: str) -> dict | None:
    with read_db() as conn:
        row = conn.execute(
            '''
            SELECT
                s.id,
                p.project_name,
                s.project_path,
                COALESCE(s.cwd, s.project_path) AS cwd,
                COALESCE(NULLIF(s.model, ''), '(unknown)') AS model,
                s.created_at,
                s.updated_at,
                0 AS total_input_tokens,
                0 AS total_output_tokens,
                0 AS total_cache_creation_tokens,
                0 AS total_cache_read_tokens,
                0.0 AS total_cost_usd,
                s.message_count,
                s.user_message_count,
                COALESCE(s.pinned, 0) AS pinned,
                0 AS is_subagent,
                NULL AS parent_session_id,
                '' AS agent_type,
                '' AS agent_description,
                '' AS version,
                COALESCE(NULLIF(s.final_stop_reason, ''), '') AS final_stop_reason,
                COALESCE(NULLIF(s.tags, ''), '') AS tags,
                0 AS turn_duration_ms,
                COALESCE(NULLIF(s.source_node, ''), 'local') AS source_node,
                (julianday(COALESCE(NULLIF(s.updated_at,''), s.created_at)) - julianday(s.created_at)) * 86400.0 AS duration_seconds,
                0 AS subagent_count,
                0.0 AS subagent_cost,
                COALESCE(NULLIF(s.session_name, ''), s.id) AS session_title
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE s.id = ?
            ''',
            (session_id,),
        ).fetchone()
    return dict(row) if row else None


def get_codex_session_messages_page(session_id: str, limit: int = 500, offset: int = 0) -> dict:
    with read_db() as conn:
        rows = conn.execute(
            '''
            SELECT
                id,
                message_uuid,
                parent_uuid,
                role,
                content_preview,
                content,
                0 AS input_tokens,
                0 AS output_tokens,
                0 AS cache_creation_tokens,
                0 AS cache_read_tokens,
                0.0 AS cost_usd,
                COALESCE(NULLIF(model, ''), '(unknown)') AS model,
                timestamp,
                '' AS git_branch,
                0 AS is_sidechain,
                '' AS stop_reason
            FROM codex_messages
            WHERE session_id = ?
            ORDER BY timestamp ASC, id ASC
            LIMIT ? OFFSET ?
            ''',
            (session_id, limit, offset),
        ).fetchall()
        total = conn.execute(
            'SELECT COUNT(*) FROM codex_messages WHERE session_id = ?',
            (session_id,),
        ).fetchone()[0]
    return {'messages': [dict(r) for r in rows], 'total': int(total or 0), 'limit': limit, 'offset': offset}


def get_codex_message_position(session_id: str, message_id: int) -> dict | None:
    with read_db() as conn:
        current = conn.execute(
            '''
            SELECT id, timestamp
            FROM codex_messages
            WHERE id = ? AND session_id = ?
            ''',
            (message_id, session_id),
        ).fetchone()
        if not current:
            return None

        pos = conn.execute(
            '''
            SELECT COUNT(*)
            FROM codex_messages
            WHERE session_id = ?
              AND (timestamp < ? OR (timestamp = ? AND id < ?))
            ''',
            (session_id, current['timestamp'], current['timestamp'], current['id']),
        ).fetchone()[0]
        total = conn.execute(
            'SELECT COUNT(*) FROM codex_messages WHERE session_id = ?',
            (session_id,),
        ).fetchone()[0]
    return {'position': int(pos or 0), 'total': int(total or 0), 'message_id': message_id}


def get_codex_session_delete_preview(session_id: str) -> dict | None:
    with read_db() as conn:
        row = conn.execute(
            '''
            SELECT
                s.id AS session_id,
                p.project_name,
                s.message_count
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE s.id = ?
            ''',
            (session_id,),
        ).fetchone()
    return dict(row) if row else None


def delete_codex_session(session_id: str) -> dict:
    with write_db() as conn:
        preview = conn.execute(
            'SELECT COUNT(*) AS messages_deleted FROM codex_messages WHERE session_id = ?',
            (session_id,),
        ).fetchone()
        deleted = conn.execute(
            'DELETE FROM codex_sessions WHERE id = ?',
            (session_id,),
        ).rowcount
    close_thread_connections()
    return {
        'deleted': deleted > 0,
        'messages_deleted': int(preview['messages_deleted'] or 0) if preview else 0,
    }


def set_codex_session_pinned(session_id: str, pinned: bool) -> bool:
    with write_db() as conn:
        updated = conn.execute(
            'UPDATE codex_sessions SET pinned = ? WHERE id = ?',
            (1 if pinned else 0, session_id),
        ).rowcount
    close_thread_connections()
    return updated > 0


def get_codex_models(sort: str = 'messages', order: str = 'desc', page: int = 1, per_page: int = 500) -> dict:
    sort_map = {
        'model': 'model',
        'messages': 'message_count',
    }
    sort_col = sort_map.get(sort, 'message_count')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    offset = (page - 1) * per_page
    with read_db() as conn:
        rows = conn.execute(
            f'''
            SELECT
                COALESCE(NULLIF(model, ''), '(unknown)') AS model,
                COUNT(*) AS message_count,
                0 AS input_tokens,
                0 AS output_tokens,
                0 AS cache_creation_tokens,
                0 AS cache_read_tokens,
                0.0 AS cost_usd
            FROM codex_messages
            WHERE role = 'assistant'
            GROUP BY COALESCE(NULLIF(model, ''), '(unknown)')
            ORDER BY {sort_col} {order_sql}, model ASC
            LIMIT ? OFFSET ?
            ''',
            (per_page, offset),
        ).fetchall()
    return {'models': [dict(r) for r in rows], 'sort': sort, 'order': order_sql.lower(), 'page': page, 'per_page': per_page}


def get_codex_projects(sort: str = 'last_active', order: str = 'desc', page: int = 1, per_page: int = 500) -> dict:
    sort_map = {
        'name': 'p.project_name',
        'sessions': 'session_count',
        'tokens': 'total_tokens',
        'cost': 'total_cost',
        'last_active': 'last_active',
    }
    sort_col = sort_map.get(sort, 'last_active')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    offset = (page - 1) * per_page
    with read_db() as conn:
        rows = conn.execute(
            f'''
            SELECT
                p.project_name,
                p.project_path,
                COUNT(DISTINCT s.id) AS session_count,
                0 AS subagent_count,
                0.0 AS total_cost,
                0 AS total_tokens,
                MAX(s.updated_at) AS last_active,
                '' AS tags
            FROM codex_projects p
            JOIN codex_sessions s ON s.project_path = p.project_path
            GROUP BY p.project_path, p.project_name
            ORDER BY {sort_col} {order_sql}, p.project_name ASC
            LIMIT ? OFFSET ?
            ''',
            (per_page, offset),
        ).fetchall()
    return {'projects': [dict(r) for r in rows], 'sort': sort, 'order': order_sql.lower(), 'page': page, 'per_page': per_page}


def get_codex_projects_top(limit: int = 5, with_last_message: bool = False, active_window_minutes: int = 30) -> dict:
    active_cutoff = (datetime.now(timezone.utc) - timedelta(minutes=active_window_minutes)).strftime('%Y-%m-%dT%H:%M:%SZ')
    with read_db() as conn:
        rows = conn.execute(
            '''
            SELECT
                p.project_name,
                p.project_path,
                COUNT(DISTINCT s.id) AS session_count,
                0 AS subagent_count,
                0.0 AS total_cost,
                0 AS input_tokens,
                0 AS output_tokens,
                0 AS cache_read_tokens,
                0 AS total_tokens,
                MAX(s.updated_at) AS last_active
            FROM codex_projects p
            JOIN codex_sessions s ON s.project_path = p.project_path
            GROUP BY p.project_path, p.project_name
            ORDER BY last_active DESC, p.project_name ASC
            LIMIT ?
            ''',
            (limit,),
        ).fetchall()
        projects = [dict(r) for r in rows]
        for row in projects:
            row['is_active'] = bool(row.get('last_active') and row['last_active'] >= active_cutoff)
        if with_last_message and projects:
            paths = [row['project_path'] for row in projects]
            ph = ','.join(['?'] * len(paths))
            previews = conn.execute(
                f'''
                WITH ranked AS (
                    SELECT
                        m.content_preview,
                        m.timestamp,
                        m.model,
                        m.session_id,
                        s.project_path,
                        ROW_NUMBER() OVER (
                            PARTITION BY s.project_path
                            ORDER BY m.timestamp DESC, m.id DESC
                        ) AS rn
                    FROM codex_messages m
                    JOIN codex_sessions s ON s.id = m.session_id
                    WHERE s.project_path IN ({ph})
                )
                SELECT * FROM ranked WHERE rn = 1
                ''',
                paths,
            ).fetchall()
            preview_map = {row['project_path']: dict(row) for row in previews}
            for project in projects:
                row = preview_map.get(project['project_path'])
                project['last_message'] = None if not row else {
                    'preview': row['content_preview'] or '',
                    'summary_line': row['content_preview'] or '',
                    'timestamp': row['timestamp'],
                    'model': row['model'],
                    'session_id': row['session_id'],
                }
    return {'projects': projects}


def get_codex_agents_summary(limit: int = 20) -> dict:
    """Return Codex agent-run summaries for the agent-focused secondary view."""
    with read_db() as conn:
        rows = conn.execute(
            '''
            SELECT id AS message_id, session_id, content, content_preview, timestamp
            FROM codex_messages
            WHERE role = 'agent'
            ORDER BY timestamp DESC, id DESC
            ''',
        ).fetchall()

    visible_rows = rows[:limit]
    agents: list[dict] = []
    by_status: dict[str, int] = {}
    active_names: set[str] = set()
    by_agent: dict[str, dict[str, object]] = {}
    for row in rows:
        payload = _decode_codex_payload(row['content'])
        status = payload.get('status', '') or 'unknown'
        agent_name = payload.get('agent_name', '') or 'agent'
        by_status[status] = by_status.get(status, 0) + 1
        active_names.add(agent_name)
        agent_summary = by_agent.setdefault(agent_name, {'count': 0, 'last_status': status, 'timestamp': row['timestamp']})
        agent_summary['count'] = int(agent_summary['count']) + 1
        if row['timestamp'] >= str(agent_summary['timestamp']):
            agent_summary['last_status'] = status
            agent_summary['timestamp'] = row['timestamp']
    for row in visible_rows:
        payload = _decode_codex_payload(row['content'])
        agents.append({
            'message_id': row['message_id'],
            'session_id': row['session_id'],
            'agent_name': payload.get('agent_name', '') or 'agent',
            'status': payload.get('status', '') or 'unknown',
            'timestamp': row['timestamp'],
            'body_text': row['content_preview'] or '',
        })

    return {
        'total_runs': len(rows),
        'active_agents': len(active_names),
        'statuses': [
            {'status': status, 'count': count}
            for status, count in sorted(by_status.items())
        ],
        'by_agent': [
            {
                'agent_name': agent_name,
                'count': int(summary['count']),
                'last_status': str(summary['last_status']),
            }
            for agent_name, summary in sorted(by_agent.items())
        ],
        'agents': agents,
    }


def get_codex_ingest_status() -> dict:
    with read_db() as conn:
        row = conn.execute(
            '''
            SELECT
                (SELECT COUNT(*) FROM codex_sessions) AS indexed_sessions,
                (SELECT COUNT(*) FROM codex_messages) AS indexed_messages
            '''
        ).fetchone()
    return {
        'source_kind': 'codex',
        'indexed_sessions': int(row['indexed_sessions']),
        'indexed_messages': int(row['indexed_messages']),
    }


def check_integrity() -> bool:
    try:
        conn = _new_connection()
        try:
            r = conn.execute("PRAGMA quick_check").fetchone()
            return r[0] == 'ok'
        finally:
            conn.close()
    except Exception:
        logger.exception("integrity check failed")
        return False


def _commit_migration(conn: sqlite3.Connection, version: int) -> int:
    """Commit current transaction and set user_version atomically."""
    _set_user_version(conn, version)
    conn.commit()
    return version


def init_db() -> None:
    """Create / migrate schema. Safe to call on every startup.

    Each migration step commits independently so a crash mid-migration
    leaves the database at the last fully-applied version, not in a
    partially-applied state.
    """
    with _write_lock:
        conn = _new_connection()
        try:
            current = _get_user_version(conn)
            conn.executescript(_CODEX_BOOTSTRAP_SCHEMA)
            conn.commit()
            if current < 15:
                logger.info("Migrating schema v%d → 15 (Codex schema + FTS)", current)
                conn.executescript(_MIGRATE_V15_CODEX)
                try:
                    _backfill_codex_fts(conn)
                except sqlite3.OperationalError as e:
                    logger.warning("v15 Codex FTS skipped: %s", e)
                current = _commit_migration(conn, 15)
            if current < 16:
                logger.info("Migrating schema v%d → 16 (drop retired claude.ai schema)", current)
                conn.executescript('''
                    DROP TRIGGER IF EXISTS cai_msg_fts_ai;
                    DROP TRIGGER IF EXISTS cai_msg_fts_ad;
                    DROP TRIGGER IF EXISTS cai_msg_fts_au;
                    DROP TABLE IF EXISTS claude_ai_messages_fts;
                    DROP INDEX IF EXISTS idx_cai_msg_conv;
                    DROP INDEX IF EXISTS idx_cai_msg_created;
                    DROP INDEX IF EXISTS idx_cai_conv_updated;
                    DROP TABLE IF EXISTS claude_ai_messages;
                    DROP TABLE IF EXISTS claude_ai_conversations;
                ''')
                current = _commit_migration(conn, 16)
            if current < 17:
                logger.info("Migrating schema v%d → 17 (codex_sessions.source_node)", current)
                _ensure_column(conn, 'codex_sessions', 'source_node', "TEXT DEFAULT 'local'")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_codex_sessions_source_node "
                    "ON codex_sessions(source_node)"
                )
                conn.execute("UPDATE codex_sessions SET source_node = 'local' WHERE source_node IS NULL OR source_node = ''")
                current = _commit_migration(conn, 17)
            if current < 18:
                logger.info("Migrating schema v%d → 18 (codex_sessions metadata)", current)
                _ensure_column(conn, 'codex_sessions', 'final_stop_reason', "TEXT DEFAULT ''")
                _ensure_column(conn, 'codex_sessions', 'tags', "TEXT DEFAULT ''")
                current = _commit_migration(conn, 18)
            # One-time VACUUM to activate auto_vacuum=INCREMENTAL on legacy databases
            av = conn.execute('PRAGMA auto_vacuum').fetchone()[0]
            if av != 2:  # 2 = INCREMENTAL
                logger.info("Running one-time VACUUM to activate auto_vacuum=INCREMENTAL")
                conn.execute('PRAGMA auto_vacuum = INCREMENTAL')
                conn.execute('VACUUM')
                logger.info("VACUUM complete")
        finally:
            conn.close()


def close_thread_connections() -> None:
    """Call on shutdown from each thread that used read_db()."""
    conn = getattr(_read_local, 'conn', None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
        _read_local.conn = None


def wal_checkpoint() -> None:
    """Run a WAL checkpoint to keep the WAL file size bounded."""
    try:
        with _write_lock:
            conn = _new_connection()
            try:
                conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            finally:
                conn.close()
    except Exception as e:
        logger.warning("WAL checkpoint failed: %s", e)
