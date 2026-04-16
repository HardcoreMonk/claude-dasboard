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
import hashlib
import json
import logging
import os
import threading
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Awaitable, Callable, Optional

from codex_discovery import codex_roots, discover_codex_logs
from codex_parser import iter_codex_records, normalize_codex_record
from database import read_db, store_codex_message, write_db
from parser import parse_jsonl_file, process_record

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
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


def _is_codex_log(file_path: str) -> bool:
    return '.codex' in Path(file_path).parts


def _codex_role(record) -> str:
    if record.event_type == 'message':
        role = record.payload.get('message', {}).get('role') or record.payload.get('role')
        if role:
            return str(role)
        return 'assistant'
    return record.event_type


def _codex_content(record) -> str:
    if record.event_type == 'message':
        return record.payload.get('content', '')
    return json.dumps(record.payload, ensure_ascii=False, sort_keys=True)


def _codex_preview(record) -> str:
    if record.event_type == 'message':
        return record.payload.get('content', '')
    if record.event_type == 'tool':
        return ' '.join(part for part in [record.payload.get('name', ''), str(record.payload.get('input', ''))] if part)
    if record.event_type == 'agent':
        return ' '.join(part for part in [record.payload.get('agent_name', ''), record.payload.get('status', '')] if part)
    return record.searchable_text


def _codex_project_info(record, file_path: str) -> tuple[str, str]:
    if record.project_path:
        return record.project_path, record.project_name or Path(record.project_path).name

    path = Path(file_path)
    if '.codex' in path.parts and path.parent.name == 'sessions':
        return str(path.with_suffix('')), path.stem

    return str(path.parent), path.parent.name


def _codex_message_uuid(record, role: str, preview: str) -> str:
    raw = record.payload.get('message', {}) if isinstance(record.payload.get('message'), dict) else {}
    explicit = raw.get('id') or raw.get('uuid') or record.payload.get('id') or record.payload.get('uuid')
    if explicit:
        return str(explicit)
    key = '|'.join([
        record.session_id,
        str(record.source_path or ''),
        str(record.line_number if record.line_number is not None else ''),
        record.timestamp,
        role,
        preview,
    ])
    return hashlib.sha1(key.encode('utf-8')).hexdigest()


def _is_valid_codex_record(record, project_path: str, project_name: str) -> bool:
    return bool(
        record.session_id
        and record.timestamp
        and project_path
        and project_name
    )


def _iter_watch_files(home: Path | None = None) -> list[Path]:
    """Return every JSONL file the watcher should consider."""
    home = home or Path.home()
    files: list[Path] = []
    seen: set[Path] = set()

    for path in discover_codex_logs(home):
        if path not in seen:
            files.append(path)
            seen.add(path)

    return files


def _iter_watch_roots(home: Path | None = None) -> list[Path]:
    """Return directory roots the filesystem observer should watch."""
    home = home or Path.home()
    roots: list[Path] = []
    seen: set[Path] = set()

    for root in codex_roots(home):
        if root not in seen:
            roots.append(root)
            seen.add(root)

    return roots


def _count_jsonl_lines(file_path: str) -> int:
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as handle:
            return sum(1 for _ in handle)
    except OSError:
        return 0


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
            for root in _iter_watch_roots():
                obs.schedule(handler, str(root), recursive=True)
            obs.start()
            self._observer = obs
            logger.info("watchdog started on %s (+ Codex roots) (polling safety net every %.0fs)",
                        codex_roots(Path.home()), POLL_INTERVAL_SLOW)
        except Exception as e:
            logger.warning("watchdog init failed (%s) — falling back to poll", e)
            self._observer = None

    async def _initial_scan(self):
        logger.info("Starting initial scan …")
        files = _iter_watch_files()
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
        for f in _iter_watch_files():
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

            rewound = False
            if start_line > 0:
                current_line_count = _count_jsonl_lines(file_path)
                if current_line_count < start_line:
                    rewound = True
                    start_line = 0

            if _is_codex_log(file_path):
                parsed = list(iter_codex_records(Path(file_path)))
                with read_db() as rdb:
                    row = rdb.execute(
                        'SELECT last_line FROM file_watch_state WHERE file_path = ?',
                        (file_path,),
                    ).fetchone()
                    actual_start = 0 if rewound else (row['last_line'] if row else 0)

                new_records: list[dict] = []
                last_line = actual_start
                allow_context_fill = (
                    Path(file_path).name == 'history.jsonl'
                    or 'sessions' in Path(file_path).parts
                )
                context = {
                    'session_id': '',
                    'project_path': '',
                    'project_name': '',
                    'timestamp': '',
                }
                for raw_record in parsed:
                    if raw_record['_line_number'] < actual_start:
                        continue
                    last_line = raw_record['_line_number'] + 1
                    normalized = normalize_codex_record(raw_record)
                    if normalized.session_id:
                        context['session_id'] = normalized.session_id
                    if normalized.project_path:
                        context['project_path'] = normalized.project_path
                        context['project_name'] = normalized.project_name
                    if normalized.timestamp:
                        context['timestamp'] = normalized.timestamp
                    if allow_context_fill and (
                        context['session_id']
                        and (
                            context['project_path']
                            or Path(file_path).name == 'history.jsonl'
                        )
                    ):
                        normalized = replace(
                            normalized,
                            session_id=normalized.session_id or context['session_id'],
                            project_path=normalized.project_path or context['project_path'],
                            project_name=normalized.project_name or context['project_name'],
                            timestamp=normalized.timestamp or context['timestamp'],
                        )
                    role = _codex_role(normalized)
                    project_path, project_name = _codex_project_info(normalized, file_path)
                    if not _is_valid_codex_record(normalized, project_path, project_name):
                        continue
                    preview = _codex_preview(normalized)
                    store_codex_message(
                        project_path=project_path,
                        project_name=project_name,
                        session_id=normalized.session_id,
                        session_name=normalized.session_id,
                        role=role,
                        content=_codex_content(normalized),
                        content_preview=preview[:240],
                        timestamp=normalized.timestamp,
                        message_uuid=_codex_message_uuid(normalized, role, preview),
                    )
                    new_records.append({
                        'type': 'new_message',
                        'session_id': normalized.session_id,
                        'project_name': project_name,
                        'project_path': project_path,
                        'timestamp': normalized.timestamp,
                        'role': role,
                        'preview': preview[:300],
                    })

                if last_line > actual_start or (rewound and last_line == actual_start):
                    try:
                        mtime = os.path.getmtime(file_path)
                    except OSError:
                        mtime = 0.0
                    with write_db() as db:
                        db.execute(
                            'INSERT OR REPLACE INTO file_watch_state'
                            ' (file_path, last_line, last_modified) VALUES (?, ?, ?)',
                            (file_path, last_line, mtime),
                        )

                with self._state_lock:
                    self._retry_queue.pop(file_path, None)
                if not parsed:
                    return None
                return {'type': 'batch_update', 'records': new_records} if new_records else None

            parsed = list(parse_jsonl_file(file_path, start_line))
            new_records: list[dict] = []
            with write_db() as db:
                row = db.execute(
                    'SELECT last_line FROM file_watch_state WHERE file_path = ?',
                    (file_path,),
                ).fetchone()
                actual_start = 0 if rewound else (row['last_line'] if row else 0)

                last_line = actual_start
                for record in parsed:
                    if record['_line_number'] < actual_start:
                        continue
                    last_line = record['_line_number'] + 1
                    result = process_record(record, file_path, db)
                    if result:
                        new_records.append(result)

                if last_line > actual_start or (rewound and last_line == actual_start):
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
            if not parsed:
                return None
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
