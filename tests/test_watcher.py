"""Unit tests for watcher.py — state lock, metric injection, retry accounting."""
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
