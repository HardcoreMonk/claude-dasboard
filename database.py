"""
SQLite layer with thread-safe writes, thread-local read pool, and versioned migrations.

Cost stored as INTEGER micro-dollars (1 USD = 1,000,000 microusd).
This eliminates float accumulation drift entirely.
"""
import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH = Path.home() / '.claude' / 'dashboard.db'
CLAUDE_PROJECTS = Path.home() / '.claude' / 'projects'

_write_lock = threading.Lock()
_read_local = threading.local()   # per-thread cached read connection

MICRO = 1_000_000                 # 1 USD = 1M micro-dollars
SCHEMA_VERSION = 8                # bump on every schema change


def _configure(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")


def _new_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=30)
    _configure(conn)
    return conn


@contextmanager
def read_db():
    """Reuses a single sqlite3.Connection per OS thread (PRAGMAs are set once)."""
    conn = getattr(_read_local, 'conn', None)
    if conn is None:
        conn = _new_connection()
        _read_local.conn = conn
    try:
        yield conn
    except sqlite3.Error:
        try:
            conn.close()
        except Exception:
            pass
        _read_local.conn = None
        raise


@contextmanager
def write_db():
    """Single-writer context. Always opens a fresh connection to avoid
    interleaving with any read connection cached on the same thread."""
    with _write_lock:
        conn = _new_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


# ─── Schema ──────────────────────────────────────────────────────────────────

_SCHEMA_V1 = '''
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT,
    project_name TEXT,
    created_at TEXT,
    updated_at TEXT,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cache_creation_tokens INTEGER DEFAULT 0,
    total_cache_read_tokens INTEGER DEFAULT 0,
    cost_micro INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    user_message_count INTEGER DEFAULT 0,
    model TEXT,
    cwd TEXT,
    entrypoint TEXT,
    version TEXT,
    is_subagent INTEGER DEFAULT 0,
    parent_session_id TEXT,
    agent_type TEXT,
    agent_description TEXT,
    pinned INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    message_uuid TEXT UNIQUE,
    parent_uuid TEXT,
    role TEXT,
    content TEXT,
    content_preview TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cost_micro INTEGER DEFAULT 0,
    model TEXT,
    request_id TEXT,
    timestamp TEXT,
    cwd TEXT,
    git_branch TEXT,
    is_sidechain INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id  ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp   ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_role_ts     ON messages(role, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at  ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project     ON sessions(project_name);
CREATE INDEX IF NOT EXISTS idx_sessions_model       ON sessions(model);
CREATE INDEX IF NOT EXISTS idx_messages_session_sc  ON messages(session_id, is_sidechain);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned      ON sessions(pinned);
CREATE INDEX IF NOT EXISTS idx_messages_preview     ON messages(content_preview);

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
'''

# v2: composite and path-based indexes for hot queries
_MIGRATE_V2 = '''
CREATE INDEX IF NOT EXISTS idx_sessions_path            ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned_updated  ON sessions(pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_path_updated    ON sessions(project_path, updated_at);
CREATE INDEX IF NOT EXISTS idx_messages_session_time    ON messages(session_id, timestamp);
'''

# v3: FTS5 virtual table for full-text search + sync triggers
_MIGRATE_V3 = '''
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content_preview,
    content='messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content_preview)
    VALUES (new.id, COALESCE(new.content_preview, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content_preview)
    VALUES ('delete', old.id, COALESCE(old.content_preview, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content_preview ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content_preview)
    VALUES ('delete', old.id, COALESCE(old.content_preview, ''));
    INSERT INTO messages_fts(rowid, content_preview)
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


def _backfill_fts(conn: sqlite3.Connection) -> None:
    """Populate messages_fts from the external content table.

    FTS5 external-content tables expose a special ``rebuild`` command that
    re-indexes every row in the content table from scratch. This is the
    correct way to backfill — a plain ``INSERT INTO messages_fts SELECT``
    would be rejected in contentless mode and gives only partial tokenisation
    in external-content mode.
    """
    total = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    logger.info("Rebuilding FTS index (%d rows) …", total)
    conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
    logger.info("FTS rebuild complete")


def _heal_project_identity(conn: sqlite3.Connection) -> int:
    """v4 migration: heal sessions whose project_path was computed from the
    legacy dash-decoding heuristic (which lost the original dashes).

    The authoritative value is the ``cwd`` column captured at ingest time.
    """
    rows = conn.execute(
        "SELECT id, cwd, project_path FROM sessions "
        "WHERE cwd IS NOT NULL AND cwd != '' "
        "  AND (project_path IS NULL OR project_path != cwd)"
    ).fetchall()
    fixed = 0
    for r in rows:
        sid = r['id']
        cwd = r['cwd']
        p = Path(cwd)
        new_name = p.name or cwd
        conn.execute(
            "UPDATE sessions SET project_path = ?, project_name = ? WHERE id = ?",
            (str(p), new_name, sid),
        )
        fixed += 1
    if fixed:
        logger.info("Healed %d sessions: project_path/project_name from cwd", fixed)
    return fixed


def _heal_session_models(conn: sqlite3.Connection) -> int:
    """v4 migration: pick the highest-spend real model for each session whose
    sessions.model was hijacked by a synthetic / meta tag."""
    rows = conn.execute(
        "SELECT id FROM sessions "
        "WHERE model IS NULL OR model = '' "
        "   OR model LIKE '<%' OR model LIKE '%synth%'"
    ).fetchall()
    fixed = 0
    for r in rows:
        sid = r['id']
        pick = conn.execute('''
            SELECT model FROM messages
            WHERE session_id = ? AND role = 'assistant'
              AND model IS NOT NULL AND model != ''
              AND model NOT LIKE '<%' AND model NOT LIKE '%synth%'
            GROUP BY model
            ORDER BY SUM(cost_micro) DESC, COUNT(*) DESC
            LIMIT 1
        ''', (sid,)).fetchone()
        if pick and pick['model']:
            conn.execute("UPDATE sessions SET model = ? WHERE id = ?",
                         (pick['model'], sid))
            fixed += 1
    if fixed:
        logger.info("Healed %d sessions: session.model from dominant real model", fixed)
    return fixed


def _migrate_v5_subagent_reassign(conn: sqlite3.Connection) -> tuple[int, int]:
    """v5: walk every ``subagents/*.jsonl`` file and reattach its messages to
    a NEW session row keyed by the filename (not the record.sessionId which
    points to the parent). Creates ``(new_sessions, reassigned_messages)``.
    """
    if not CLAUDE_PROJECTS.exists():
        return 0, 0

    new_sessions = 0
    reassigned = 0
    for jsonl in CLAUDE_PROJECTS.rglob('subagents/agent-*.jsonl'):
        subagent_id = jsonl.stem           # 'agent-a4db55...'
        parent_dir = jsonl.parent.parent   # '<parent-sid>'
        parent_sid = parent_dir.name

        # Read the sidecar + collect message UUIDs + pick up metadata
        meta_path = jsonl.with_suffix('.meta.json')
        agent_type = ''
        agent_desc = ''
        if meta_path.exists():
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                    agent_type = meta.get('agentType', '') or ''
                    agent_desc = meta.get('description', '') or ''
            except Exception:
                pass

        uuids: list[str] = []
        cwd = ''
        first_ts = ''
        last_ts = ''
        try:
            with open(jsonl, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    u = r.get('uuid')
                    if u:
                        uuids.append(u)
                    if not cwd and r.get('cwd'):
                        cwd = r['cwd']
                    ts = r.get('timestamp', '')
                    if ts:
                        if not first_ts:
                            first_ts = ts
                        last_ts = ts
        except OSError:
            continue

        if not uuids:
            continue

        # Create / upsert the subagent session row
        project_path = cwd or ''
        project_name = Path(project_path).name if project_path else subagent_id
        res = conn.execute('''
            INSERT OR IGNORE INTO sessions
                (id, project_path, project_name, created_at, updated_at, cwd,
                 is_subagent, parent_session_id, agent_type, agent_description)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ''', (subagent_id, project_path, project_name,
              first_ts, last_ts or first_ts, cwd,
              parent_sid, agent_type, agent_desc))
        if res.rowcount > 0:
            new_sessions += 1
        else:
            # Refresh metadata for an existing row in case it was seeded
            # by the old parser (wrong parent pointer).
            conn.execute('''
                UPDATE sessions SET
                    is_subagent = 1,
                    parent_session_id = ?,
                    agent_type = COALESCE(NULLIF(agent_type, ''), ?),
                    agent_description = COALESCE(NULLIF(agent_description, ''), ?),
                    project_path = COALESCE(NULLIF(project_path, ''), ?),
                    project_name = COALESCE(NULLIF(project_name, ''), ?),
                    cwd = COALESCE(NULLIF(cwd, ''), ?)
                WHERE id = ?
            ''', (parent_sid, agent_type, agent_desc,
                  project_path, project_name, cwd, subagent_id))

        # Reassign messages that currently live on the parent row.
        placeholders = ','.join('?' * len(uuids))
        cur = conn.execute(
            f"UPDATE messages SET session_id = ? "
            f"WHERE message_uuid IN ({placeholders}) AND session_id != ?",
            [subagent_id, *uuids, subagent_id],
        )
        reassigned += cur.rowcount

    if new_sessions or reassigned:
        logger.info(
            "v5: created %d subagent sessions, reassigned %d messages",
            new_sessions, reassigned)
    return new_sessions, reassigned


def _migrate_v5_clear_false_subagent_flag(conn: sqlite3.Connection) -> int:
    """v5: parent sessions that were wrongly tagged as their own subagent
    (parent_session_id == id) get their flag cleared."""
    cur = conn.execute(
        "UPDATE sessions SET is_subagent = 0, parent_session_id = NULL "
        "WHERE parent_session_id = id"
    )
    if cur.rowcount:
        logger.info("v5: cleared false is_subagent flag on %d parent sessions", cur.rowcount)
    return cur.rowcount


def _migrate_v7_add_columns(conn: sqlite3.Connection) -> None:
    """v7: add stop_reason / parent_tool_use_id / task_prompt columns."""
    _ensure_column(conn, 'messages', 'stop_reason', "TEXT")
    _ensure_column(conn, 'sessions', 'final_stop_reason', "TEXT")
    _ensure_column(conn, 'sessions', 'parent_tool_use_id', "TEXT")
    _ensure_column(conn, 'sessions', 'task_prompt', "TEXT")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_parent_tool_use "
        "ON sessions(parent_tool_use_id)"
    )


def _migrate_v7_backfill_stop_reason(conn: sqlite3.Connection) -> int:
    """v7: walk every JSONL file once, extract ``message.stop_reason`` for
    each assistant record, UPDATE ``messages.stop_reason`` keyed by
    ``message_uuid``. This is a one-shot O(records) scan."""
    if not CLAUDE_PROJECTS.exists():
        return 0
    updates: list[tuple[str, str]] = []
    for jsonl in CLAUDE_PROJECTS.rglob('*.jsonl'):
        try:
            with open(jsonl, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line or '"stop_reason"' not in line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if r.get('type') != 'assistant':
                        continue
                    uuid = r.get('uuid')
                    stop_reason = (r.get('message') or {}).get('stop_reason') or ''
                    if uuid and stop_reason:
                        updates.append((stop_reason, uuid))
        except OSError:
            continue
    total = 0
    BATCH = 1000
    for i in range(0, len(updates), BATCH):
        chunk = updates[i:i + BATCH]
        conn.executemany(
            'UPDATE messages SET stop_reason = ? WHERE message_uuid = ?', chunk)
        total += len(chunk)
    if total:
        logger.info("v7: backfilled stop_reason for %d message uuids", total)
    return total


def _migrate_v7_recompute_final_stop_reason(conn: sqlite3.Connection) -> int:
    """Set each session's ``final_stop_reason`` from its latest assistant
    message's stop_reason (requires v7 backfill to have populated that
    column first)."""
    cur = conn.execute('''
        UPDATE sessions SET final_stop_reason = (
            SELECT stop_reason FROM messages
            WHERE session_id = sessions.id
              AND role = 'assistant'
              AND stop_reason IS NOT NULL AND stop_reason != ''
            ORDER BY timestamp DESC, id DESC LIMIT 1
        )
    ''')
    logger.info("v7: recomputed final_stop_reason for %d sessions", cur.rowcount)
    return cur.rowcount


def _migrate_v7_link_parent_tool_use(conn: sqlite3.Connection) -> int:
    """Walk every *parent* JSONL file, find Agent/Task ``tool_use`` blocks,
    and UPDATE the matching subagent row with the parent tool_use_id +
    task_prompt. Match key is ``(parent_session_id, agent_description)``,
    which empirically is 1:1 (verified 8/8 in the sample audit)."""
    if not CLAUDE_PROJECTS.exists():
        return 0
    linked = 0
    for jsonl in CLAUDE_PROJECTS.rglob('*.jsonl'):
        if 'subagents' in jsonl.parts:
            continue
        parent_sid = jsonl.stem   # filename basename — matches sessions.id
        try:
            with open(jsonl, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line or '"tool_use"' not in line:
                        continue
                    try:
                        r = json.loads(line)
                    except Exception:
                        continue
                    if r.get('type') != 'assistant':
                        continue
                    content = (r.get('message') or {}).get('content') or []
                    if not isinstance(content, list):
                        continue
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get('type') != 'tool_use':
                            continue
                        if b.get('name') not in ('Agent', 'Task'):
                            continue
                        inp = b.get('input') or {}
                        description = inp.get('description') or ''
                        prompt = (inp.get('prompt') or '')[:2000]
                        tool_use_id = b.get('id') or ''
                        if not description or not tool_use_id:
                            continue
                        cur = conn.execute('''
                            UPDATE sessions
                               SET parent_tool_use_id = ?, task_prompt = ?
                             WHERE parent_session_id = ?
                               AND agent_description = ?
                               AND is_subagent = 1
                               AND (parent_tool_use_id IS NULL OR parent_tool_use_id = '')
                        ''', (tool_use_id, prompt, parent_sid, description))
                        linked += cur.rowcount
        except OSError:
            continue
    if linked:
        logger.info("v7: linked %d subagent sessions to parent_tool_use_id", linked)
    return linked


def _migrate_v6_tag_compact_subagents(conn: sqlite3.Connection) -> int:
    """v6: back-fill ``agent_type='compact'`` for ``agent-acompact-*`` rows.

    These are Claude Code's context-compaction subagents — they don't ship a
    ``.meta.json`` sidecar, so v5 left them uncategorized. The filename
    prefix is a stable marker.
    """
    cur = conn.execute('''
        UPDATE sessions
           SET agent_type = 'compact',
               agent_description = COALESCE(NULLIF(agent_description, ''), 'Context compaction')
         WHERE is_subagent = 1
           AND id LIKE 'agent-acompact-%'
           AND (agent_type IS NULL OR agent_type = '')
    ''')
    if cur.rowcount:
        logger.info("v6: tagged %d agent-acompact-* rows as compact", cur.rowcount)
    return cur.rowcount


def _migrate_v5_recompute_session_totals(conn: sqlite3.Connection) -> int:
    """v5: after reassigning subagent messages, rebuild every session's
    token/cost/count totals from the messages table. Idempotent."""
    cur = conn.execute('''
        UPDATE sessions SET
            total_input_tokens = COALESCE((
                SELECT SUM(input_tokens) FROM messages
                WHERE session_id = sessions.id AND role='assistant'), 0),
            total_output_tokens = COALESCE((
                SELECT SUM(output_tokens) FROM messages
                WHERE session_id = sessions.id AND role='assistant'), 0),
            total_cache_creation_tokens = COALESCE((
                SELECT SUM(cache_creation_tokens) FROM messages
                WHERE session_id = sessions.id AND role='assistant'), 0),
            total_cache_read_tokens = COALESCE((
                SELECT SUM(cache_read_tokens) FROM messages
                WHERE session_id = sessions.id AND role='assistant'), 0),
            cost_micro = COALESCE((
                SELECT SUM(cost_micro) FROM messages
                WHERE session_id = sessions.id AND role='assistant'), 0),
            message_count = COALESCE((
                SELECT COUNT(*) FROM messages
                WHERE session_id = sessions.id AND role='assistant'), 0),
            user_message_count = COALESCE((
                SELECT COUNT(*) FROM messages
                WHERE session_id = sessions.id AND role='user'), 0)
    ''')
    logger.info("v5: recomputed totals for %d sessions", cur.rowcount)
    return cur.rowcount


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


def init_db() -> None:
    """Create / migrate schema. Safe to call on every startup."""
    with _write_lock:
        conn = _new_connection()
        try:
            conn.executescript(_SCHEMA_V1)
            # Defensive: guarantee columns added after v1 are present even on old DBs
            _ensure_column(conn, 'sessions', 'pinned', 'INTEGER DEFAULT 0')
            current = _get_user_version(conn)
            if current < 2:
                logger.info("Migrating schema v%d → 2", current)
                conn.executescript(_MIGRATE_V2)
                _set_user_version(conn, 2)
                current = 2
            if current < 3:
                logger.info("Migrating schema v%d → 3 (FTS5)", current)
                try:
                    conn.executescript(_MIGRATE_V3)
                    _backfill_fts(conn)
                    _set_user_version(conn, 3)
                    current = 3
                except sqlite3.OperationalError as e:
                    logger.warning(
                        "FTS5 migration skipped (SQLite build lacks fts5?): %s", e)
                    # S6: still advance user_version — the attempt counts.
                    # Search API has a LIKE fallback. A future migration can
                    # retry FTS5 if the sqlite build later supports it.
                    _set_user_version(conn, 3)
                    current = 3
            if current < 4:
                logger.info("Migrating schema v%d → 4 (heal project/model)", current)
                _heal_project_identity(conn)
                _heal_session_models(conn)
                _set_user_version(conn, 4)
                current = 4
            if current < 5:
                logger.info("Migrating schema v%d → 5 (subagent reassign)", current)
                _migrate_v5_subagent_reassign(conn)
                _migrate_v5_clear_false_subagent_flag(conn)
                _migrate_v5_recompute_session_totals(conn)
                # Subagent rows' model column is empty until we pick it from
                # their messages — piggy-back on the existing healer.
                _heal_session_models(conn)
                _set_user_version(conn, 5)
                current = 5
            if current < 6:
                logger.info("Migrating schema v%d → 6 (tag compact subagents)", current)
                _migrate_v6_tag_compact_subagents(conn)
                _set_user_version(conn, 6)
                current = 6
            if current < 7:
                logger.info("Migrating schema v%d → 7 (stop_reason + parent_tool_use_id)", current)
                _migrate_v7_add_columns(conn)
                _migrate_v7_backfill_stop_reason(conn)
                _migrate_v7_recompute_final_stop_reason(conn)
                _migrate_v7_link_parent_tool_use(conn)
                _set_user_version(conn, 7)
                current = 7
            if current < 8:
                logger.info("Migrating schema v%d → 8 (session tags)", current)
                _ensure_column(conn, 'sessions', 'tags', "TEXT")
                _set_user_version(conn, 8)
                current = 8
            conn.commit()
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
