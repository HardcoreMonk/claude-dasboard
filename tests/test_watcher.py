"""Unit tests for watcher.py — state lock, metric injection, retry accounting."""
import json
import threading

import pytest

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
    for t in threads: t.start()
    for t in threads: t.join()
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


# ─── Spec A Task 5: subagent child link back-fill ────────────────────────

@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    """Fresh DB + isolated CLAUDE_PROJECTS for watcher.link_subagent_child tests.

    Mirrors the fixture used by test_database.py so we don't accidentally
    scan the developer's real ~/.claude/projects during init_db().

    NOTE: ``test_e2e_smoke.py`` evicts ``database`` and ``watcher`` from
    ``sys.modules`` and reimports them, which can leave stale references
    when subsequent tests do ``import watcher``. We re-evict the same
    modules here so ``watcher`` picks up our monkeypatched ``database.DB_PATH``.
    """
    import sys as _sys
    for name in ('database', 'watcher'):
        _sys.modules.pop(name, None)
    db_file = tmp_path / 'test.db'
    fake_claude_projects = tmp_path / 'claude-projects'
    fake_claude_projects.mkdir()
    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_claude_projects)
    if hasattr(database._read_local, 'conn'):
        try:
            database._read_local.conn.close()
        except Exception:
            pass
        database._read_local.conn = None
    database.init_db()
    # Reimport watcher so it binds to the freshly-configured database module.
    import importlib
    import watcher as _w
    importlib.reload(_w)
    # Update the module-level alias used by tests in this file.
    globals()['watcher'] = _w
    yield db_file
    if hasattr(database._read_local, 'conn') and database._read_local.conn is not None:
        try:
            database._read_local.conn.close()
        except Exception:
            pass
        database._read_local.conn = None


def test_subagent_child_link_updates_parent_payload(temp_db):
    """ClaudeFileWatcher.link_subagent_child back-fills child_session_id
    into the parent's subagent_dispatch event payload."""
    import database
    # Parent emits a subagent_dispatch with child_session_id=None.
    payload = json.dumps({
        'agent_type': 'Explore',
        'child_session_id': None,
        'tool_use_id': 'toolu_abc',
    })
    database.insert_session_event(
        session_id='parent-1', event_type='subagent_dispatch',
        ts='2026-04-27T12:00:00Z', payload=payload, source='jsonl')

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)
    w.link_subagent_child(
        parent_sid='parent-1',
        parent_tool_use_id='toolu_abc',
        child_sid='child-9',
    )

    rows = list(database.list_session_events('parent-1'))
    assert len(rows) == 1
    p = json.loads(rows[0]['payload'])
    assert p['child_session_id'] == 'child-9'
    assert p['tool_use_id'] == 'toolu_abc'


def test_subagent_child_link_idempotent(temp_db):
    """A second link call is a no-op: the IS NULL guard in
    database.update_subagent_child_link prevents overwrite."""
    import database
    payload = json.dumps({
        'agent_type': 'Explore',
        'child_session_id': None,
        'tool_use_id': 'toolu_xyz',
    })
    database.insert_session_event(
        session_id='parent-2', event_type='subagent_dispatch',
        ts='2026-04-27T12:30:00Z', payload=payload, source='jsonl')

    w = watcher.ClaudeFileWatcher(broadcast=lambda _: None)
    w.link_subagent_child('parent-2', 'toolu_xyz', 'child-first')
    # Second call must not overwrite (IS NULL guard in update_subagent_child_link).
    w.link_subagent_child('parent-2', 'toolu_xyz', 'child-second')

    rows = list(database.list_session_events('parent-2'))
    p = json.loads(rows[0]['payload'])
    assert p['child_session_id'] == 'child-first'
