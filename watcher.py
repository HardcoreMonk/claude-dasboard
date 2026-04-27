"""
Async file watcher — scan first, then react to filesystem events (or poll).

Architecture:
  1. Initial scan  — walk CLAUDE_PROJECTS once, parse every JSONL file.
  2. Event loop    — watchdog Observer (inotify on Linux) signals changed
                     files instantly; a slow polling loop runs as a safety
                     net in case events are missed.

File I/O + JSON parsing happens WITHOUT the write lock. Only the DB insert
phase acquires write_db(), minimising lock contention.
"""
import asyncio
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Optional

import database
from database import read_db, write_db
from parser import CLAUDE_PROJECTS, parse_jsonl_file, process_record

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    _WATCHDOG_OK = True
except ImportError:
    _WATCHDOG_OK = False


@dataclass
class WatcherMetrics:
    """Dependency-injected Prometheus counters.

    Avoids a circular import with main.py — main.py owns the Counter
    instances and passes them in when constructing ``ClaudeFileWatcher``.
    Any field may be ``None`` if metrics are disabled.
    """
    scan_files: object = None          # Counter with label 'phase'
    new_messages: object = None        # Counter
    retries: object = None             # Counter with label 'outcome'

    def inc_scan(self, phase: str, n: int = 1) -> None:
        if self.scan_files is not None:
            try:
                self.scan_files.labels(phase=phase).inc(n)
            except Exception:
                pass

    def inc_new_messages(self, n: int) -> None:
        if self.new_messages is not None and n:
            try:
                self.new_messages.inc(n)
            except Exception:
                pass

    def inc_retry(self, outcome: str) -> None:
        if self.retries is not None:
            try:
                self.retries.labels(outcome=outcome).inc()
            except Exception:
                pass


logger = logging.getLogger(__name__)

POLL_INTERVAL_FAST = 3.0    # fallback polling when watchdog unavailable
POLL_INTERVAL_SLOW = 30.0   # safety-net polling while watchdog is active
OBSERVER_HEALTH_INTERVAL = 60.0  # check observer liveness every 60s
MAX_RETRIES = 3
SCAN_BATCH = 4              # parallel file-parse workers during initial scan


class _JsonlEventHandler(FileSystemEventHandler if _WATCHDOG_OK else object):
    """Pushes .jsonl change events onto an asyncio queue in a threadsafe way."""

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue):
        super().__init__()
        self._loop = loop
        self._queue = queue

    def _enqueue(self, path: str):
        if not path.endswith('.jsonl'):
            return
        try:
            self._loop.call_soon_threadsafe(self._safe_put, path)
        except (RuntimeError, AttributeError):
            pass  # loop closing or queue not yet initialised

    def _safe_put(self, path: str):
        """Called on the event-loop thread by call_soon_threadsafe."""
        try:
            self._queue.put_nowait(path)
        except asyncio.QueueFull:
            pass  # back-pressure: safety poll will catch up

    def on_modified(self, event):
        if not getattr(event, 'is_directory', False):
            self._enqueue(event.src_path)

    def on_created(self, event):
        if not getattr(event, 'is_directory', False):
            self._enqueue(event.src_path)

    def on_moved(self, event):
        dst = getattr(event, 'dest_path', '')
        if dst and not getattr(event, 'is_directory', False):
            self._enqueue(dst)


class ClaudeFileWatcher:
    def __init__(self,
                 broadcast: Callable[[dict], Awaitable[None]],
                 metrics: Optional[WatcherMetrics] = None):
        self._broadcast = broadcast
        self._metrics = metrics or WatcherMetrics()
        self._file_mtimes: dict[str, float] = {}
        self._retry_queue: dict[str, int] = {}
        self._state_lock = threading.Lock()     # protects _file_mtimes + _retry_queue
        self._stop_event = threading.Event()    # prevents new _process_file after stop()
        self._task: Optional[asyncio.Task] = None
        self._observer: Optional["Observer"] = None  # type: ignore[name-defined]
        self._event_queue: Optional[asyncio.Queue] = None

    # ── Spec A Task 5: subagent child-link back-fill ──────────────────────

    def link_subagent_child(self, parent_sid: str, parent_tool_use_id: str,
                            child_sid: str) -> int:
        """Back-fill ``child_session_id`` into the parent's ``subagent_dispatch``
        event payload. Thin wrapper over ``database.update_subagent_child_link``.

        Safe to call from OUTSIDE a held write lock — opens its own
        ``write_db()``. Inside ``_process_file`` (which already holds the
        lock), use :meth:`_link_subagent_child_inline` instead.
        """
        return database.update_subagent_child_link(
            parent_sid, parent_tool_use_id, child_sid)

    def _maybe_link_subagent_child(self, child_sid: str) -> None:
        """Look up a child session's (parent_session_id, parent_tool_use_id)
        and back-fill the parent's subagent_dispatch event. No-op if either
        column is empty (link will be re-attempted on the next re-scan)."""
        try:
            with read_db() as rdb:
                row = rdb.execute(
                    "SELECT parent_session_id, parent_tool_use_id"
                    "  FROM sessions WHERE id = ?",
                    (child_sid,),
                ).fetchone()
            if not row:
                return
            parent_sid = row['parent_session_id'] or ''
            parent_tool_use_id = row['parent_tool_use_id'] or ''
            if parent_sid and parent_tool_use_id:
                self.link_subagent_child(
                    parent_sid=parent_sid,
                    parent_tool_use_id=parent_tool_use_id,
                    child_sid=child_sid,
                )
        except Exception:
            # Linking is best-effort; never break the watcher loop over it.
            logger.exception("subagent child-link failed for sid=%s", child_sid)

    @staticmethod
    def _link_subagent_child_inline(db, parent_sid: str,
                                    parent_tool_use_id: str,
                                    child_sid: str) -> int:
        """Same UPDATE as ``database.update_subagent_child_link`` but on the
        caller's already-open write connection — avoids re-acquiring
        ``_write_lock`` (would deadlock since the watcher's batch path
        already holds it). Mirrors the Task 4 inline-event pattern.
        """
        cur = db.execute(
            "UPDATE session_events"
            "   SET payload = json_set(payload, '$.child_session_id', ?)"
            " WHERE session_id = ?"
            "   AND event_type = 'subagent_dispatch'"
            "   AND json_extract(payload, '$.tool_use_id') = ?"
            "   AND json_extract(payload, '$.child_session_id') IS NULL",
            (child_sid, parent_sid, parent_tool_use_id),
        )
        return cur.rowcount

    async def start_async(self):
        self._event_queue = asyncio.Queue(maxsize=10_000)
        self._task = asyncio.create_task(self._lifecycle())

    def stop(self):
        self._stop_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=3)
            except Exception:
                pass
            self._observer = None

    # ── lifecycle ─────────────────────────────────────────────────────────

    async def _lifecycle(self):
        try:
            await self._initial_scan()
            self._start_observer()
            await self._event_loop()
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Watcher lifecycle error")

    def _start_observer(self):
        if not _WATCHDOG_OK:
            logger.info("watchdog unavailable — polling every %.0fs", POLL_INTERVAL_FAST)
            return
        try:
            loop = asyncio.get_running_loop()
            handler = _JsonlEventHandler(loop, self._event_queue)
            obs = Observer()
            obs.schedule(handler, str(CLAUDE_PROJECTS), recursive=True)
            obs.start()
            self._observer = obs
            logger.info("watchdog started on %s (polling safety net every %.0fs)",
                        CLAUDE_PROJECTS, POLL_INTERVAL_SLOW)
        except Exception as e:
            logger.warning("watchdog init failed (%s) — falling back to poll", e)
            self._observer = None

    async def _initial_scan(self):
        logger.info("Starting initial scan …")
        files = sorted(CLAUDE_PROJECTS.rglob('*.jsonl'))
        total = len(files)
        logger.info("Found %d JSONL files to scan", total)

        loop = asyncio.get_running_loop()

        for i in range(0, total, SCAN_BATCH):
            batch = files[i:i + SCAN_BATCH]
            tasks = [loop.run_in_executor(None, self._process_file, str(f))
                     for f in batch]
            await asyncio.gather(*tasks, return_exceptions=True)

            with self._state_lock:
                for f in batch:
                    try:
                        self._file_mtimes[str(f)] = f.stat().st_mtime
                    except OSError:
                        pass

            self._metrics.inc_scan('initial', len(batch))

            done = min(i + SCAN_BATCH, total)
            if done % 80 == 0 or done == total:
                await self._broadcast(
                    {'type': 'scan_progress', 'processed': done, 'total': total})

        await self._broadcast({'type': 'scan_complete', 'total': total})
        logger.info("Initial scan complete: %d files", total)

    def _check_observer_health(self):
        """Restart watchdog observer if it died at runtime."""
        if not _WATCHDOG_OK:
            return
        if self._observer is not None and not self._observer.is_alive():
            logger.warning("watchdog observer died — restarting")
            try:
                self._observer.stop()
            except Exception:
                pass
            self._observer = None
            self._start_observer()

    async def _event_loop(self):
        """Primary driver: drain watchdog events, periodic safety-net poll."""
        loop = asyncio.get_running_loop()
        poll_interval = POLL_INTERVAL_SLOW if self._observer else POLL_INTERVAL_FAST
        last_health_check = loop.time()
        logger.info("Watcher event loop: poll every %.0fs, watchdog=%s",
                    poll_interval, bool(self._observer))
        while True:
            # Periodic observer health check
            now = loop.time()
            if now - last_health_check >= OBSERVER_HEALTH_INTERVAL:
                self._check_observer_health()
                # Adjust poll interval if observer state changed
                poll_interval = POLL_INTERVAL_SLOW if self._observer else POLL_INTERVAL_FAST
                last_health_check = now

            try:
                path = await asyncio.wait_for(
                    self._event_queue.get(), timeout=poll_interval)
            except asyncio.TimeoutError:
                await self._poll_once(loop)
                continue

            # Coalesce bursts — drain queue within a short window
            to_process = {path}
            while not self._event_queue.empty():
                try:
                    to_process.add(self._event_queue.get_nowait())
                except asyncio.QueueEmpty:
                    break

            for p in to_process:
                updates = await loop.run_in_executor(None, self._process_file, p)
                if updates:
                    self._metrics.inc_new_messages(len(updates.get('records', [])))
                    await self._broadcast(updates)

            self._metrics.inc_scan('event', len(to_process))

    async def _poll_once(self, loop):
        """Safety-net scan: mtime-based detection of changed files."""
        try:
            changed = self._detect_changes()
            for path in changed:
                updates = await loop.run_in_executor(None, self._process_file, path)
                if updates:
                    self._metrics.inc_new_messages(len(updates.get('records', [])))
                    await self._broadcast(updates)
            if changed:
                self._metrics.inc_scan('poll', len(changed))
            with self._state_lock:
                retries = list(self._retry_queue)
            for path in retries:
                updates = await loop.run_in_executor(None, self._process_file, path)
                if updates:
                    await self._broadcast(updates)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Poll safety-net error")

    # ── file detection ────────────────────────────────────────────────────

    def _detect_changes(self) -> list[str]:
        changed: list[str] = []
        seen: set[str] = set()
        for f in CLAUDE_PROJECTS.rglob('*.jsonl'):
            path = str(f)
            seen.add(path)
            try:
                mtime = f.stat().st_mtime
            except OSError:
                continue
            with self._state_lock:
                if self._file_mtimes.get(path) != mtime:
                    self._file_mtimes[path] = mtime
                    changed.append(path)
        # Clean up tracking entries for files that no longer exist
        with self._state_lock:
            stale = [p for p in self._file_mtimes if p not in seen]
            for p in stale:
                self._file_mtimes.pop(p, None)
        if stale:
            logger.info("Dropped %d stale mtime entries", len(stale))
        return changed

    # ── per-file processing ───────────────────────────────────────────────

    def _process_file(self, file_path: str) -> Optional[dict]:
        """
        Three-phase processing:
          1. Read last_line (lock-free sqlite read)
          2. Parse file (pure I/O, no lock)
          3. Write to DB (serialised via _write_lock inside write_db())
        """
        if self._stop_event.is_set():
            return None
        try:
            with read_db() as rdb:
                row = rdb.execute(
                    'SELECT last_line FROM file_watch_state WHERE file_path = ?',
                    (file_path,),
                ).fetchone()
                start_line = row['last_line'] if row else 0

            parsed = list(parse_jsonl_file(file_path, start_line))
            if not parsed:
                with self._state_lock:
                    self._retry_queue.pop(file_path, None)
                return None

            new_records: list[dict] = []
            with write_db() as db:
                row = db.execute(
                    'SELECT last_line FROM file_watch_state WHERE file_path = ?',
                    (file_path,),
                ).fetchone()
                actual_start = row['last_line'] if row else 0

                last_line = actual_start
                for record in parsed:
                    if record['_line_number'] < actual_start:
                        continue
                    last_line = record['_line_number'] + 1
                    result = process_record(record, file_path, db)
                    if result:
                        new_records.append(result)

                if last_line > actual_start:
                    try:
                        mtime = os.path.getmtime(file_path)
                    except OSError:
                        mtime = 0.0
                    db.execute(
                        'INSERT OR REPLACE INTO file_watch_state'
                        ' (file_path, last_line, last_modified) VALUES (?, ?, ?)',
                        (file_path, last_line, mtime),
                    )

            with self._state_lock:
                self._retry_queue.pop(file_path, None)

            # Spec A Task 5: if any of the new records came from a subagent
            # transcript, try to back-fill the parent's subagent_dispatch
            # event with this child's session_id. We do this AFTER the
            # write_db() block exits so update_subagent_child_link can
            # safely re-acquire _write_lock without deadlock.
            #
            # Best-effort: the child's parent_tool_use_id is populated by the
            # v7 migration's startup scan of parent JSONL files. If it's not
            # set yet (race with a brand-new subagent file), the link will
            # happen on a subsequent re-scan of the parent file, or via
            # the v7 migration on the next restart.
            if new_records:
                child_sids = {r['session_id'] for r in new_records
                              if r.get('is_subagent') and r.get('session_id')}
                for child_sid in child_sids:
                    self._maybe_link_subagent_child(child_sid)

            return {'type': 'batch_update', 'records': new_records} if new_records else None

        except Exception:
            logger.exception("watcher: _process_file failed for %s", file_path)
            gave_up = False
            with self._state_lock:
                attempt = self._retry_queue.get(file_path, 0) + 1
                if attempt <= MAX_RETRIES:
                    self._retry_queue[file_path] = attempt
                    logger.warning("Will retry %s (attempt %d/%d)",
                                   file_path, attempt, MAX_RETRIES)
                else:
                    self._retry_queue.pop(file_path, None)
                    self._file_mtimes.pop(file_path, None)
                    gave_up = True
                    logger.error("Giving up on %s after %d retries"
                                 " — will re-detect on next modification",
                                 file_path, MAX_RETRIES)
            self._metrics.inc_retry('gave_up' if gave_up else 'retry')
            return None
