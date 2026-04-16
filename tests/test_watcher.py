"""Unit tests for watcher.py — state lock, metric injection, retry accounting."""
import sqlite3
import threading
from pathlib import Path

import database
import watcher

# ─── WatcherMetrics dependency injection ─────────────────────────────────

def test_metrics_none_is_noop():
    """An empty WatcherMetrics must accept all calls silently."""
    m = watcher.WatcherMetrics()
    m.inc_scan('initial', 5)
    m.inc_new_messages(10)
    m.inc_retry('gave_up')
    # no exception → pass


class _FakeLabeled:
    def __init__(self):
        self.value = 0
    def inc(self, n=1):
        self.value += n


class _FakeLabeledCounter:
    def __init__(self):
        self.labels_map: dict[tuple, _FakeLabeled] = {}
    def labels(self, **kw):
        key = tuple(sorted(kw.items()))
        return self.labels_map.setdefault(key, _FakeLabeled())


class _FakeCounter:
    def __init__(self):
        self.value = 0
    def inc(self, n=1):
        self.value += n


def test_metrics_inc_scan_routes_by_phase():
    c = _FakeLabeledCounter()
    m = watcher.WatcherMetrics(scan_files=c)
    m.inc_scan('initial', 8)
    m.inc_scan('event', 2)
    m.inc_scan('initial', 1)
    assert c.labels_map[(('phase', 'initial'),)].value == 9
    assert c.labels_map[(('phase', 'event'),)].value == 2


def test_metrics_inc_new_messages():
    c = _FakeCounter()
    m = watcher.WatcherMetrics(new_messages=c)
    m.inc_new_messages(3)
    m.inc_new_messages(7)
    m.inc_new_messages(0)   # should be a no-op
    assert c.value == 10


def test_metrics_inc_retry_routes_by_outcome():
    c = _FakeLabeledCounter()
    m = watcher.WatcherMetrics(retries=c)
    m.inc_retry('retry')
    m.inc_retry('retry')
    m.inc_retry('gave_up')
    assert c.labels_map[(('outcome', 'retry'),)].value == 2
    assert c.labels_map[(('outcome', 'gave_up'),)].value == 1


# ─── No circular import regression ───────────────────────────────────────

def test_watcher_module_has_no_direct_main_import():
    """The module source must not import main.* — that was the dead-metric
    bug fixed in R1. Lock it down with a static check."""
    import pathlib
    src = pathlib.Path(watcher.__file__).read_text()
    assert 'from main import' not in src
    assert 'import main' not in src.replace('import main_', '')


# ─── State lock on _retry_queue / _file_mtimes ───────────────────────────

def test_state_lock_exists_and_is_a_lock():
    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)
    assert hasattr(w, '_state_lock')
    # threading.Lock instances have 'acquire'/'release' methods
    assert callable(w._state_lock.acquire)
    assert callable(w._state_lock.release)


def test_retry_queue_concurrent_mutation_safe():
    """Stress: many threads hammering _retry_queue via the lock shouldn't
    raise RuntimeError / leave the dict in a torn state."""
    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)

    def bump():
        for i in range(500):
            with w._state_lock:
                w._retry_queue[f'f{i}'] = w._retry_queue.get(f'f{i}', 0) + 1
                if i % 3 == 0:
                    w._retry_queue.pop(f'f{i}', None)

    threads = [threading.Thread(target=bump) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # If we got here without an exception, the lock did its job.


# ─── Constructor injection ──────────────────────────────────────────────

def test_constructor_accepts_metrics_injection():
    m = watcher.WatcherMetrics(
        scan_files=_FakeLabeledCounter(),
        new_messages=_FakeCounter(),
        retries=_FakeLabeledCounter(),
    )
    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None, metrics=m)
    assert w._metrics is m


def test_constructor_defaults_to_noop_metrics():
    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)
    assert isinstance(w._metrics, watcher.WatcherMetrics)
    # all fields should be None (no-op)
    assert w._metrics.scan_files is None
    assert w._metrics.new_messages is None
    assert w._metrics.retries is None


def test_codex_watch_files_include_codex_only(tmp_path, monkeypatch):
    claude_root = tmp_path / '.claude' / 'projects'
    claude_root.mkdir(parents=True)
    claude_log = claude_root / 'session.jsonl'
    claude_log.write_text('{"type":"assistant"}\n', encoding='utf-8')
    codex_log = tmp_path / '.codex' / 'projects' / 'demo' / 'session.jsonl'
    codex_log.parent.mkdir(parents=True)
    codex_log.write_text('{"type":"message"}\n', encoding='utf-8')

    files = watcher._iter_watch_files(tmp_path)

    assert claude_log not in files
    assert codex_log in files


def test_start_observer_schedules_codex_roots(tmp_path, monkeypatch):
    home = tmp_path
    codex_projects = home / '.codex' / 'projects'
    codex_projects.mkdir(parents=True)
    codex_sessions = home / '.codex' / 'sessions'
    codex_sessions.mkdir(parents=True)

    scheduled: list[tuple[object, bool]] = []

    class _FakeObserver:
        def schedule(self, handler, path, recursive=True):
            scheduled.append((Path(path), recursive))
        def start(self):
            pass
        def stop(self):
            pass
        def join(self, timeout=None):
            pass

    monkeypatch.setattr(watcher, '_WATCHDOG_OK', True)
    monkeypatch.setattr(watcher, 'Observer', _FakeObserver)
    monkeypatch.setattr(watcher.Path, 'home', lambda: home)
    monkeypatch.setattr(watcher.asyncio, 'get_running_loop', lambda: object())

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)
    w._event_queue = object()
    w._start_observer()

    assert (codex_projects, True) in scheduled
    assert (codex_sessions, True) in scheduled


def test_process_file_recovers_after_truncation(tmp_path, monkeypatch):
    db_path = tmp_path / 'dashboard.db'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    database.init_db()

    file_path = tmp_path / 'session.jsonl'
    file_path.write_text(
        '\n'.join([
            '{"type":"assistant","sessionId":"s1","uuid":"u1","timestamp":"2026-04-16T10:00:00Z","cwd":"/home/user/projects/demo","message":{"model":"claude-opus-4-6","usage":{"input_tokens":1},"content":[{"type":"text","text":"first"}]}}',
            '{"type":"assistant","sessionId":"s1","uuid":"u2","timestamp":"2026-04-16T10:01:00Z","cwd":"/home/user/projects/demo","message":{"model":"claude-opus-4-6","usage":{"input_tokens":1},"content":[{"type":"text","text":"second"}]}}',
        ]) + '\n',
        encoding='utf-8',
    )

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)

    first = w._process_file(str(file_path))
    assert first is not None
    assert len(first['records']) == 2

    file_path.write_text(
        '{"type":"assistant","sessionId":"s1","uuid":"u3","timestamp":"2026-04-16T10:02:00Z","cwd":"/home/user/projects/demo","message":{"model":"claude-opus-4-6","usage":{"input_tokens":1},"content":[{"type":"text","text":"rewritten"}]}}\n',
        encoding='utf-8',
    )

    second = w._process_file(str(file_path))
    assert second is not None
    assert len(second['records']) == 1
    assert 'rewritten' in second['records'][0]['preview']

    with database.read_db() as db:
        state = db.execute(
            'SELECT last_line FROM file_watch_state WHERE file_path = ?',
            (str(file_path),),
        ).fetchone()
        count = db.execute(
            'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?',
            ('s1',),
        ).fetchone()

    assert state['last_line'] == 1
    assert count['n'] == 3


def test_process_file_routes_codex_logs_to_codex_storage(tmp_path, monkeypatch):
    db_path = tmp_path / 'dashboard.db'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    database.init_db()

    codex_log = tmp_path / '.codex' / 'projects' / 'demo' / 'session.jsonl'
    codex_log.parent.mkdir(parents=True)
    codex_log.write_text(
        '\n'.join([
            '{"type":"message","sessionId":"codex-s1","timestamp":"2026-04-16T10:00:00Z","project_path":"/tmp/codex-demo","role":"user","content":"search structure"}',
            '{"type":"tool","sessionId":"codex-s1","timestamp":"2026-04-16T10:00:01Z","project_path":"/tmp/codex-demo","name":"rg","input":"search structure"}',
            '{"type":"agent","sessionId":"codex-s1","timestamp":"2026-04-16T10:00:02Z","project_path":"/tmp/codex-demo","agent_name":"planner","status":"completed"}',
        ]) + '\n',
        encoding='utf-8',
    )

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)

    batch = w._process_file(str(codex_log))

    assert batch is not None
    assert [record['role'] for record in batch['records']] == ['user', 'tool', 'agent']
    assert batch['records'][0]['session_id'] == 'codex-s1'

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    codex_count = conn.execute(
        'SELECT COUNT(*) AS n FROM codex_messages WHERE session_id = ?',
        ('codex-s1',),
    ).fetchone()
    legacy_count = conn.execute(
        'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?',
        ('codex-s1',),
    ).fetchone()
    session_row = conn.execute(
        'SELECT message_count, user_message_count FROM codex_sessions WHERE id = ?',
        ('codex-s1',),
    ).fetchone()
    conn.close()

    assert codex_count['n'] == 3
    assert legacy_count['n'] == 0
    assert session_row['message_count'] == 3
    assert session_row['user_message_count'] == 1


def test_process_file_uses_rollout_session_meta_for_project_tool_and_agent(tmp_path, monkeypatch):
    db_path = tmp_path / 'dashboard.db'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    database.init_db()

    rollout_log = (
        tmp_path
        / '.codex'
        / 'sessions'
        / '2026'
        / '04'
        / '17'
        / 'rollout-2026-04-17T02-22-22-019d9750-b622-71f0-ae0a-889467c995f9.jsonl'
    )
    rollout_log.parent.mkdir(parents=True)
    rollout_log.write_text(
        '\n'.join([
            '{"timestamp":"2026-04-16T17:22:23.867Z","type":"session_meta","payload":{"id":"019d9750-b622-71f0-ae0a-889467c995f9","timestamp":"2026-04-16T17:22:22.393Z","cwd":"/home/user/projects/codex-dashboard","agent_nickname":"Singer","agent_role":"worker"}}',
            '{"timestamp":"2026-04-16T17:22:24.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"pytest -q\\"}"}}',
            '{"timestamp":"2026-04-16T17:22:25.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"테스트를 실행하겠습니다."}]}}',
        ]) + '\n',
        encoding='utf-8',
    )

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)

    batch = w._process_file(str(rollout_log))

    assert batch is not None
    assert [record['role'] for record in batch['records']] == ['agent', 'tool', 'assistant']
    assert all(record['project_name'] == 'codex-dashboard' for record in batch['records'])

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        '''
        SELECT role, content_preview
        FROM codex_messages
        WHERE session_id = ?
        ORDER BY id
        ''',
        ('019d9750-b622-71f0-ae0a-889467c995f9',),
    ).fetchall()
    session_row = conn.execute(
        'SELECT project_path FROM codex_sessions WHERE id = ?',
        ('019d9750-b622-71f0-ae0a-889467c995f9',),
    ).fetchone()
    conn.close()

    assert [row['role'] for row in rows] == ['agent', 'tool', 'assistant']
    assert 'exec_command' in rows[1]['content_preview']
    assert '테스트를 실행하겠습니다.' in rows[2]['content_preview']
    assert session_row['project_path'] == '/home/user/projects/codex-dashboard'


def test_process_file_routes_codex_history_log_to_codex_storage(tmp_path, monkeypatch):
    db_path = tmp_path / 'dashboard.db'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    database.init_db()

    history_log = tmp_path / '.codex' / 'history.jsonl'
    history_log.parent.mkdir(parents=True)
    history_log.write_text(
        '\n'.join([
            '{"session_id":"codex-h1","ts":1776253250,"text":"history search term"}',
            '{"session_id":"codex-h1","ts":1776253260,"text":"second history line"}',
        ]) + '\n',
        encoding='utf-8',
    )

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)
    batch = w._process_file(str(history_log))

    assert batch is not None
    assert len(batch['records']) == 2
    assert batch['records'][0]['role'] == 'assistant'
    assert 'history search term' in batch['records'][0]['preview']

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    codex_count = conn.execute(
        'SELECT COUNT(*) AS n FROM codex_messages WHERE session_id = ?',
        ('codex-h1',),
    ).fetchone()
    session_row = conn.execute(
        '''
        SELECT p.project_name, s.message_count
        FROM codex_sessions s
        JOIN codex_projects p ON p.project_path = s.project_path
        WHERE s.id = ?
        ''',
        ('codex-h1',),
    ).fetchone()
    conn.close()

    assert codex_count['n'] == 2
    assert session_row['project_name'] == '.codex'
    assert session_row['message_count'] == 2


def test_process_file_skips_incomplete_codex_records(tmp_path, monkeypatch):
    db_path = tmp_path / 'dashboard.db'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    database.init_db()

    codex_log = tmp_path / '.codex' / 'projects' / 'demo' / 'session.jsonl'
    codex_log.parent.mkdir(parents=True)
    codex_log.write_text(
        '\n'.join([
            '{"type":"message","timestamp":"2026-04-16T10:00:00Z","project_path":"/tmp/codex-demo","role":"user","content":"missing session"}',
            '{"type":"message","sessionId":"codex-skip","project_path":"/tmp/codex-demo","role":"user","content":"missing timestamp"}',
            '{"type":"message","sessionId":"codex-skip","timestamp":"2026-04-16T10:00:02Z","project_path":"/tmp/codex-demo","role":"user","content":"valid record"}',
        ]) + '\n',
        encoding='utf-8',
    )

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)

    batch = w._process_file(str(codex_log))

    assert batch is not None
    assert len(batch['records']) == 1
    assert batch['records'][0]['preview'] == 'valid record'

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    codex_count = conn.execute(
        'SELECT COUNT(*) AS n FROM codex_messages WHERE session_id = ?',
        ('codex-skip',),
    ).fetchone()
    blank_sessions = conn.execute(
        "SELECT COUNT(*) AS n FROM codex_sessions WHERE id = ''",
    ).fetchone()
    conn.close()

    assert codex_count['n'] == 1
    assert blank_sessions['n'] == 0


def test_process_file_attributes_codex_sessions_file_without_project_path(tmp_path, monkeypatch):
    db_path = tmp_path / 'dashboard.db'
    monkeypatch.setattr(database, 'DB_PATH', db_path)
    database.init_db()

    codex_log = tmp_path / '.codex' / 'sessions' / 'orphan-session.jsonl'
    codex_log.parent.mkdir(parents=True)
    codex_log.write_text(
        '{"type":"message","sessionId":"orphan-session","timestamp":"2026-04-16T12:00:00Z","role":"assistant","content":"session-only record"}\n',
        encoding='utf-8',
    )

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)

    batch = w._process_file(str(codex_log))

    assert batch is not None
    assert batch['records'][0]['project_name'] == 'orphan-session'

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        '''
        SELECT s.project_path, p.project_name
        FROM codex_sessions s
        JOIN codex_projects p ON p.project_path = s.project_path
        WHERE s.id = ?
        ''',
        ('orphan-session',),
    ).fetchone()
    conn.close()

    assert row['project_name'] == 'orphan-session'
    assert row['project_path'] == str(codex_log.with_suffix(''))
    assert row['project_path'] != str(codex_log.parent)
