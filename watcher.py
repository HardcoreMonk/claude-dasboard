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
MAX_RETRIES = 3
SCAN_BATCH = 8              # parallel file-parse workers during initial scan


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
            self._loop.call_soon_threadsafe(self._queue.put_nowait, path)
        except RuntimeError:
            pass  # loop closing

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
        self._task: Optional[asyncio.Task] = None
        self._observer: Optional["Observer"] = None  # type: ignore[name-defined]
        self._event_queue: Optional[asyncio.Queue] = None

    async def start_async(self):
        self._event_queue = asyncio.Queue(maxsize=10_000)
        self._task = asyncio.create_task(self._lifecycle())

    def stop(self):
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

        loop = asyncio.get_event_loop()

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

    async def _event_loop(self):
        """Primary driver: drain watchdog events, periodic safety-net poll."""
        loop = asyncio.get_event_loop()
        poll_interval = POLL_INTERVAL_SLOW if self._observer else POLL_INTERVAL_FAST
        logger.info("Watcher event loop: poll every %.0fs, watchdog=%s",
                    poll_interval, bool(self._observer))
        while True:
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
