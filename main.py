import asyncio
import base64
import csv
import hmac
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone as _tz
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, model_validator

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None  # Python < 3.9 fallback

try:
    from prometheus_client import (
        Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST,
    )
    _PROMETHEUS_OK = True
except ImportError:
    _PROMETHEUS_OK = False

from database import (
    read_db, write_db, init_db, check_integrity, DB_PATH, _write_lock,
    close_thread_connections,
)
from watcher import ClaudeFileWatcher, WatcherMetrics

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
)
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / 'static'
BACKUP_DIR = Path.home() / '.claude' / 'dashboard-backups'
CREDENTIALS_PATH = Path.home() / '.claude' / '.credentials.json'
_AUTH_PW = os.environ.get('DASHBOARD_PASSWORD')


# ─── Plan auto-detection ──────────────────────────────────────────────────────

PLAN_PRESETS: dict[str, dict] = {
    'default_claude_pro':      {'label': 'Pro',      'daily': 15,   'weekly': 80},
    'default_claude_max_5x':   {'label': 'Max 5x',   'daily': 80,   'weekly': 400},
    'default_claude_max_20x':  {'label': 'Max 20x',  'daily': 300,  'weekly': 1500},
}


def detect_plan() -> dict:
    """Read plan tier from Claude Code credentials (local file, no API call)."""
    try:
        with open(CREDENTIALS_PATH) as f:
            creds = json.load(f)
        oauth = creds.get('claudeAiOauth', {})
        tier = oauth.get('rateLimitTier', '')
        sub_type = oauth.get('subscriptionType', '')
        preset = PLAN_PRESETS.get(tier, {})
        return {
            'tier': tier,
            'subscription_type': sub_type,
            'label': preset.get('label', sub_type or 'unknown'),
            'suggested_daily': preset.get('daily', 50),
            'suggested_weekly': preset.get('weekly', 300),
        }
    except Exception:
        return {'tier': '', 'subscription_type': '', 'label': 'unknown',
                'suggested_daily': 50, 'suggested_weekly': 300}


# ─── WebSocket connection manager ────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self._conns: list[WebSocket] = []
        self._locks: dict[WebSocket, asyncio.Lock] = {}

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._conns.append(ws)
        self._locks[ws] = asyncio.Lock()
        logger.info("WS connected (%d total)", len(self._conns))
        if _PROMETHEUS_OK:
            METRIC_WS.set(len(self._conns))

    def disconnect(self, ws: WebSocket):
        self._locks.pop(ws, None)
        try:
            self._conns.remove(ws)
        except ValueError:
            pass
        if _PROMETHEUS_OK:
            METRIC_WS.set(len(self._conns))

    def get_lock(self, ws: WebSocket) -> asyncio.Lock:
        return self._locks.get(ws) or asyncio.Lock()

    async def broadcast(self, data: dict):
        if not self._conns:
            return
        payload = json.dumps(data)
        dead: list[WebSocket] = []
        for ws in list(self._conns):
            lock = self._locks.get(ws)
            try:
                if lock:
                    async with lock:
                        await ws.send_text(payload)
                else:
                    await ws.send_text(payload)
            except Exception as exc:
                logger.warning("WS send failed, removing client: %s", exc)
                dead.append(ws)
        for ws in dead:
            try:
                self._conns.remove(ws)
                self._locks.pop(ws, None)
            except ValueError:
                pass


manager = ConnectionManager()
watcher: Optional[ClaudeFileWatcher] = None


# ─── Prometheus metrics ──────────────────────────────────────────────────────

if _PROMETHEUS_OK:
    METRIC_REQUESTS = Counter(
        'http_requests_total', 'HTTP requests',
        ['method', 'path', 'status'])
    METRIC_LATENCY = Histogram(
        'http_request_duration_seconds', 'Request latency seconds',
        ['method', 'path'],
        buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0))
    METRIC_WS = Gauge('dashboard_ws_connections', 'Active WebSocket connections')
    METRIC_SCAN_FILES = Counter(
        'dashboard_scan_files_total', 'JSONL files processed by watcher',
        ['phase'])  # initial | event | poll
    METRIC_NEW_MESSAGES = Counter(
        'dashboard_new_messages_total', 'New assistant messages ingested')
    METRIC_RETRIES = Counter(
        'dashboard_file_retries_total', 'Watcher file processing retry outcomes',
        ['outcome'])  # retry | gave_up
    METRIC_DB_SIZE = Gauge('dashboard_db_size_bytes', 'Dashboard DB file size')
    METRIC_SESSIONS = Gauge('dashboard_sessions_total', 'Total sessions in DB')
    METRIC_MESSAGES = Gauge('dashboard_messages_total', 'Total messages in DB')


def _make_watcher_metrics() -> "WatcherMetrics":
    """Build the metric bundle injected into ClaudeFileWatcher.

    Kept separate so tests can instantiate a watcher with empty metrics.
    Also pre-creates zero-valued label series so Prometheus can distinguish
    "no data yet" from "zero count" (important for alerting).
    """
    if not _PROMETHEUS_OK:
        return WatcherMetrics()
    # Pre-materialize zero-valued series
    for phase in ('initial', 'event', 'poll'):
        METRIC_SCAN_FILES.labels(phase=phase)
    for outcome in ('retry', 'gave_up'):
        METRIC_RETRIES.labels(outcome=outcome)
    return WatcherMetrics(
        scan_files=METRIC_SCAN_FILES,
        new_messages=METRIC_NEW_MESSAGES,
        retries=METRIC_RETRIES,
    )


# ─── Lifespan ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global watcher
    init_db()
    if DB_PATH.exists() and not check_integrity():
        logger.error("DATABASE INTEGRITY CHECK FAILED — consider restoring from backup")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    watcher = ClaudeFileWatcher(manager.broadcast, metrics=_make_watcher_metrics())
    await watcher.start_async()
    yield
    watcher.stop()
    close_thread_connections()


app = FastAPI(title="Claude Usage Dashboard", lifespan=lifespan)

# CORS — allow any origin so the dashboard works behind reverse proxies
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Middleware stack (order matters) ────────────────────────────────────
# Starlette wraps middleware in REVERSE declaration order, so the LAST
# registered middleware is the OUTERMOST at request time. To make metrics
# track EVERY request (including 401s from auth), register auth FIRST and
# metrics SECOND. At runtime the order is: metrics → auth → route.

_AUTH_BYPASS = {'/api/health', '/metrics'}

if _AUTH_PW:
    @app.middleware("http")
    async def _basic_auth_middleware(request: Request, call_next):
        if request.url.path in _AUTH_BYPASS:
            return await call_next(request)
        auth = request.headers.get('Authorization', '')
        if auth.startswith('Basic '):
            try:
                decoded = base64.b64decode(auth[6:]).decode()
                _, pw = decoded.split(':', 1)
                # Constant-time comparison defeats timing oracles
                if hmac.compare_digest(pw, _AUTH_PW):
                    return await call_next(request)
            except Exception:
                pass
        return Response(
            status_code=401,
            headers={'WWW-Authenticate': 'Basic realm="Claude Dashboard"'},
        )


if _PROMETHEUS_OK:
    @app.middleware("http")
    async def _metrics_middleware(request: Request, call_next):
        start = time.monotonic()
        status = 500
        response = None
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            # Use the matched route template to bound label cardinality.
            # For 401s from auth the route may not be resolved — fall back
            # to the literal path (bounded because auth rejects early).
            route = request.scope.get('route')
            path_tpl = getattr(route, 'path', None) or request.url.path
            elapsed = time.monotonic() - start
            try:
                METRIC_REQUESTS.labels(
                    method=request.method, path=path_tpl, status=str(status)).inc()
                METRIC_LATENCY.labels(
                    method=request.method, path=path_tpl).observe(elapsed)
            except Exception:
                pass


# ─── Preview cleanup (server-side) ───────────────────────────────────────────
# Used by /api/projects/top to pre-compute a one-paragraph summary from the
# stored content_preview, stripping markdown decoration while preserving
# table cell content. Server-side is preferred over JS regex heuristics
# because (a) it's unit-testable and (b) the same cleanup can be reused by
# other endpoints later.

_CLEANUP_CODE_FENCE = re.compile(r'```[\s\S]*?```')
_CLEANUP_TABLE_SEP  = re.compile(r'^\s*\|?[\s:|-]+\|?\s*$', re.MULTILINE)
_CLEANUP_TABLE_LHS  = re.compile(r'^\s*\|\s*', re.MULTILINE)
_CLEANUP_TABLE_RHS  = re.compile(r'\s*\|\s*$', re.MULTILINE)
_CLEANUP_PIPE       = re.compile(r'\s*\|\s*')
_CLEANUP_LEAD_MARK  = re.compile(r'^[#>\-*]+\s*', re.MULTILINE)
_CLEANUP_WHITESPACE = re.compile(r'\s+')


def _iso_to_epoch(iso: Optional[str]) -> float:
    """Parse an ISO-8601 UTC timestamp into a float epoch. Returns 0 on
    anything unparseable so it can be used as a stable sort key."""
    if not iso:
        return 0.0
    try:
        # DB stores ``YYYY-MM-DDTHH:MM:SS[.fraction]Z``
        s = iso.rstrip('Z').replace('T', ' ')
        return datetime.strptime(s[:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=_tz.utc).timestamp()
    except (ValueError, TypeError):
        return 0.0


def summarize_preview(content_preview: str, max_len: int = 1500) -> str:
    """Collapse a stored content_preview into a single flat paragraph.

    Strips fenced code blocks entirely, flattens markdown table rows to
    ``cell1 · cell2 · cell3`` so table-heavy replies don't lose all content,
    and collapses whitespace. The result is safe to display with line-clamp
    styling on the frontend without further client-side regex work.
    """
    if not content_preview:
        return ''
    s = _CLEANUP_CODE_FENCE.sub(' ', content_preview)
    s = _CLEANUP_TABLE_SEP.sub(' ', s)
    s = _CLEANUP_TABLE_LHS.sub('', s)
    s = _CLEANUP_TABLE_RHS.sub('', s)
    s = _CLEANUP_PIPE.sub(' · ', s)
    s = _CLEANUP_LEAD_MARK.sub('', s)
    s = _CLEANUP_WHITESPACE.sub(' ', s).strip()
    return s[:max_len]


# ─── Static ───────────────────────────────────────────────────────────────────

# Filename-based cache busting: URLs like /static/app.v31.js resolve to the
# same app.js file on disk, but they are completely distinct URL keys from the
# browser's / proxy's / CDN's perspective. This is strictly safer than query-
# string (?v=N) versioning because some proxies drop query strings from cache
# keys entirely. A regex rewrites the filename before filesystem lookup.
_STATIC_VERSION_RE = re.compile(r'^(.+?)\.v\d+\.(js|css|html|map)$')


@app.get("/static/{path:path}")
async def static_file(path: str):
    # Strip ".vNNN" segment from the filename (e.g. "app.v31.js" → "app.js").
    m = _STATIC_VERSION_RE.match(path)
    if m:
        path = f"{m.group(1)}.{m.group(2)}"
    try:
        target = (STATIC_DIR / path).resolve()
    except Exception:
        return JSONResponse({'error': 'bad path'}, status_code=400)
    # Path traversal guard: the resolved path must live under STATIC_DIR.
    if not str(target).startswith(str(STATIC_DIR.resolve()) + os.sep) \
            and target != STATIC_DIR.resolve():
        return JSONResponse({'error': 'not found'}, status_code=404)
    if not target.is_file():
        return JSONResponse({'error': 'not found'}, status_code=404)
    # Versioned URLs are treated as immutable — aggressive cache is safe.
    headers = {}
    if m:
        headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return FileResponse(target, headers=headers)


@app.get("/")
async def index():
    # SPA entry: never cache the HTML shell — it contains the ?v=N cache-bust
    # query strings that point at the current static bundle. If the browser
    # caches this file, it keeps loading stale asset versions forever.
    # The referenced /static/* assets themselves stay cacheable under their
    # own ETag/Last-Modified (immutable per version).
    return FileResponse(
        STATIC_DIR / 'index.html',
        headers={
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
        },
    )


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
def api_health():
    with read_db() as db:
        n_msg = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        n_sess = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    return {"ok": True, "messages": n_msg, "sessions": n_sess}


# ─── WebSocket ────────────────────────────────────────────────────────────────

def _ws_auth_ok(ws: WebSocket) -> bool:
    """Validate Basic Auth on WebSocket upgrade if DASHBOARD_PASSWORD is set."""
    if not _AUTH_PW:
        return True
    auth = ws.headers.get('authorization', '')
    # Browser sends auth header on WS if same origin authenticated via Basic Auth
    if auth.startswith('Basic '):
        try:
            decoded = base64.b64decode(auth[6:]).decode()
            _, pw = decoded.split(':', 1)
            if pw == _AUTH_PW:
                return True
        except Exception:
            pass
    # Fallback: check query param (?token=...)
    token = ws.query_params.get('token', '')
    if token == _AUTH_PW:
        return True
    return False


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    if not _ws_auth_ok(ws):
        await ws.close(code=4001, reason="Unauthorized")
        return
    await manager.connect(ws)
    lock = manager.get_lock(ws)
    try:
        stats = _get_stats()
        async with lock:
            await ws.send_text(json.dumps({'type': 'init', 'data': stats}))
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive_text(), timeout=30)
                if msg == 'ping':
                    async with lock:
                        await ws.send_text('pong')
            except asyncio.TimeoutError:
                try:
                    async with lock:
                        await ws.send_text(json.dumps({'type': 'ping'}))
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WS error: %s", exc)
    finally:
        manager.disconnect(ws)


# ─── Timezone helpers ─────────────────────────────────────────────────────────

def _user_tz(db):
    """Return the user's timezone (IANA if available, fixed-offset fallback)."""
    row = db.execute(
        'SELECT timezone_offset, timezone_name FROM plan_config WHERE id = 1'
    ).fetchone()
    tz_name = row['timezone_name'] if row else None
    tz_off = row['timezone_offset'] if row else 9
    # Prefer IANA name (DST-aware)
    if ZoneInfo and tz_name:
        try:
            return ZoneInfo(tz_name)
        except (KeyError, Exception):
            pass
    return _tz(timedelta(hours=tz_off))


def _tz_offset(db) -> int:
    """Integer offset for SQL strftime (no DST, but matches user config)."""
    row = db.execute('SELECT timezone_offset FROM plan_config WHERE id = 1').fetchone()
    return row['timezone_offset'] if row else 9


def _today_start_utc(db) -> str:
    tz = _user_tz(db)
    now = datetime.now(tz)
    local_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return local_midnight.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ─── Stats ────────────────────────────────────────────────────────────────────

@app.get("/api/stats")
def api_stats():
    return _get_stats()


def _get_stats() -> dict:
    with read_db() as db:
        today_utc = _today_start_utc(db)

        row = db.execute('''
            SELECT COUNT(*) AS total_sessions,
                   COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(total_output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(total_cache_creation_tokens), 0) AS cache_creation_tokens,
                   COALESCE(SUM(total_cache_read_tokens), 0) AS cache_read_tokens,
                   COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost_usd,
                   COALESCE(SUM(message_count), 0) AS messages
            FROM sessions
        ''').fetchone()

        today = db.execute('''
            SELECT COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(total_output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(total_cache_creation_tokens), 0) AS cache_creation_tokens,
                   COALESCE(SUM(total_cache_read_tokens), 0) AS cache_read_tokens,
                   COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost_usd,
                   COALESCE(SUM(message_count), 0) AS messages,
                   COUNT(*) AS sessions
            FROM sessions WHERE updated_at >= ?
        ''', (today_utc,)).fetchone()

        # Aggregate from MESSAGES, not sessions — the session's "primary model"
        # can be misleading when multiple models are used in one session.
        # See C1 in the architecture audit.
        models = db.execute('''
            SELECT model,
                   COUNT(DISTINCT session_id) AS cnt,
                   SUM(cost_micro)*1.0/1000000 AS cost
            FROM messages
            WHERE role = 'assistant' AND model IS NOT NULL AND model != ''
            GROUP BY model
            ORDER BY cost DESC
        ''').fetchall()

    return {
        'all_time': dict(row) if row else {},
        'today': dict(today) if today else {},
        'models': [dict(m) for m in models],
    }


# ─── Sessions ─────────────────────────────────────────────────────────────────

def _esc_like(s: str) -> str:
    return s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


_SESSIONS_SORT_MAP = {
    'updated_at': 'updated_at',
    'created_at': 'created_at',
    'cost':       'cost_micro',
    'messages':   'message_count',
    'project':    'project_name',
    'model':      'model',
    'input':      'total_input_tokens',
    'output':     'total_output_tokens',
    'cache':      'total_cache_read_tokens',
}


@app.get("/api/sessions")
def api_sessions(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    project: Optional[str] = None,
    model: Optional[str] = None,
    search: Optional[str] = None,
    sort: str = Query('updated_at'),
    order: str = Query('desc'),
    include_subagents: bool = Query(False),
    pinned_only: bool = Query(False),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    cost_min: Optional[float] = Query(None, ge=0),
    cost_max: Optional[float] = Query(None, ge=0),
    tag: Optional[str] = Query(None, max_length=80),
):
    """List parent sessions. Subagents are excluded by default — use
    ``?include_subagents=true`` or the dedicated ``/api/subagents`` endpoint.
    ``?pinned_only=true`` narrows to starred sessions.
    ``?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`` filters by ``updated_at``.
    ``?cost_min=&cost_max=`` filters by session cost (USD).
    """
    sort_col = _SESSIONS_SORT_MAP.get(sort, 'updated_at')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    with read_db() as db:
        conds: list[str] = []
        params: list = []
        if not include_subagents:
            conds.append("is_subagent = 0")
        if pinned_only:
            conds.append("pinned = 1")
        if project:
            conds.append("project_name = ?")
            params.append(project)
        if model:
            conds.append("model LIKE ? ESCAPE '\\'")
            params.append(f"%{_esc_like(model)}%")
        if search:
            conds.append("(project_name LIKE ? ESCAPE '\\' OR cwd LIKE ? ESCAPE '\\')")
            s = f"%{_esc_like(search)}%"
            params.extend([s, s])
        if date_from:
            conds.append("updated_at >= ?")
            params.append(date_from)
        if date_to:
            # end-of-day: append "T23:59:59Z" so the full day is included
            conds.append("updated_at <= ?")
            params.append(date_to + "T23:59:59Z" if len(date_to) == 10 else date_to)
        if cost_min is not None:
            conds.append("cost_micro >= ?")
            params.append(int(cost_min * 1_000_000))
        if cost_max is not None:
            conds.append("cost_micro <= ?")
            params.append(int(cost_max * 1_000_000))
        if tag:
            conds.append(
                "(',' || COALESCE(tags, '') || ',') LIKE ? ESCAPE '\\'"
            )
            params.append(f"%,{_esc_like(tag)},%")
        where = "WHERE " + " AND ".join(conds) if conds else ""
        total = db.execute(f"SELECT COUNT(*) FROM sessions {where}", params).fetchone()[0]
        offset = (page - 1) * per_page
        rows = db.execute(f'''
            SELECT s.id, s.project_name, s.project_path, s.cwd, s.model,
                   s.created_at, s.updated_at,
                   s.total_input_tokens, s.total_output_tokens,
                   s.total_cache_creation_tokens, s.total_cache_read_tokens,
                   s.cost_micro*1.0/1000000 AS total_cost_usd,
                   s.message_count, s.user_message_count, s.pinned,
                   s.is_subagent, s.parent_session_id,
                   s.agent_type, s.agent_description, s.version,
                   s.final_stop_reason, s.tags,
                   {_DURATION_SQL} AS duration_seconds,
                   (SELECT COUNT(*) FROM sessions c
                    WHERE c.parent_session_id = s.id AND c.is_subagent = 1) AS subagent_count,
                   (SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 FROM sessions c
                    WHERE c.parent_session_id = s.id AND c.is_subagent = 1) AS subagent_cost
            FROM sessions s {where}
            ORDER BY s.pinned DESC, s.{sort_col} {order_sql}
            LIMIT ? OFFSET ?
        ''', params + [per_page, offset]).fetchall()
    return {
        'sessions': [dict(r) for r in rows],
        'total': total, 'page': page, 'per_page': per_page,
        'pages': max(1, -(-total // per_page)),
        'sort': sort, 'order': order_sql.lower(),
    }


_FTS_TOKEN_RE = re.compile(r'[\w가-힣]+', re.UNICODE)


def _build_fts_query(q: str) -> str:
    """Turn a user query into a safe FTS5 MATCH expression.

    Each token (2+ chars) is quoted and joined with implicit AND. Keeps
    operators like OR / NEAR / " / * out of user input."""
    tokens = [t for t in _FTS_TOKEN_RE.findall(q) if len(t) >= 2]
    return ' '.join(f'"{t}"' for t in tokens)


@app.get("/api/sessions/search")
def api_session_search_messages(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(50, ge=1, le=200),
):
    """Full-text search across message previews using SQLite FTS5."""
    fts_query = _build_fts_query(q)
    with read_db() as db:
        if fts_query:
            try:
                rows = db.execute('''
                    SELECT m.id, m.session_id, m.role, m.content_preview,
                           m.timestamp, m.cost_micro*1.0/1000000 AS cost_usd,
                           s.project_name, s.project_path
                    FROM messages_fts fts
                    JOIN messages m ON m.id = fts.rowid
                    JOIN sessions s ON m.session_id = s.id
                    WHERE messages_fts MATCH ?
                    ORDER BY m.timestamp DESC
                    LIMIT ?
                ''', (fts_query, limit)).fetchall()
                return {'results': [dict(r) for r in rows], 'query': q, 'fts': True}
            except sqlite3.OperationalError as e:
                logger.warning("FTS query failed (%s) — falling back to LIKE", e)
        # Fallback: LIKE scan (used when FTS5 unavailable or empty token set)
        rows = db.execute('''
            SELECT m.id, m.session_id, m.role, m.content_preview,
                   m.timestamp, m.cost_micro*1.0/1000000 AS cost_usd,
                   s.project_name, s.project_path
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE m.content_preview LIKE ? ESCAPE '\\'
            ORDER BY m.timestamp DESC
            LIMIT ?
        ''', (f'%{_esc_like(q)}%', limit)).fetchall()
    return {'results': [dict(r) for r in rows], 'query': q, 'fts': False}


@app.get("/api/sessions/{session_id}")
def api_session_detail(session_id: str):
    with read_db() as db:
        row = db.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
    if not row:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return dict(row)


@app.get("/api/sessions/{session_id}/messages")
def api_session_messages(
    session_id: str,
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    """Return messages for a session.

    Parent sessions filter ``is_sidechain=0`` (subagent-owned records have
    already been moved out by the v5 migration, so the filter is a belt-and-
    braces guard). Subagent sessions skip the filter entirely because their
    records were authored as sidechain records in the original parent JSONL.
    """
    with read_db() as db:
        row = db.execute(
            'SELECT is_subagent FROM sessions WHERE id = ?', (session_id,)
        ).fetchone()
        is_sub = bool(row and row['is_subagent'])
        side_filter = '' if is_sub else 'AND is_sidechain = 0'
        rows = db.execute(f'''
            SELECT id, message_uuid, parent_uuid, role, content_preview, content,
                   input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
                   cost_micro*1.0/1000000 AS cost_usd, model, timestamp, git_branch,
                   is_sidechain, stop_reason
            FROM messages
            WHERE session_id = ? {side_filter}
            ORDER BY timestamp ASC, id ASC
            LIMIT ? OFFSET ?
        ''', (session_id, limit, offset)).fetchall()
        total = db.execute(
            f'SELECT COUNT(*) FROM messages WHERE session_id = ? {side_filter}',
            (session_id,),
        ).fetchone()[0]
    return {'messages': [dict(r) for r in rows], 'total': total, 'limit': limit, 'offset': offset}


# ─── Usage time-series (timezone-aware) ───────────────────────────────────────

@app.get("/api/usage/hourly")
def api_usage_hourly(hours: int = Query(24, ge=1, le=168)):
    with read_db() as db:
        off = _tz_offset(db)
        off_sql = f'+{off} hours' if off >= 0 else f'{off} hours'
        rows = db.execute('''
            SELECT strftime('%Y-%m-%dT%H:00:00', timestamp, ?) AS hour,
                   SUM(input_tokens)  AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(cache_creation_tokens) AS cache_creation_tokens,
                   SUM(cache_read_tokens)     AS cache_read_tokens,
                   SUM(cost_micro)*1.0/1000000 AS cost_usd,
                   COUNT(*) AS message_count
            FROM messages
            WHERE role = 'assistant'
              AND timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY hour ORDER BY hour
        ''', (off_sql, f'-{hours} hours')).fetchall()
    return {'data': [dict(r) for r in rows]}


@app.get("/api/usage/daily")
def api_usage_daily(days: int = Query(30, ge=1, le=365)):
    with read_db() as db:
        off = _tz_offset(db)
        off_sql = f'+{off} hours' if off >= 0 else f'{off} hours'
        rows = db.execute('''
            SELECT strftime('%Y-%m-%d', timestamp, ?) AS date,
                   SUM(input_tokens)  AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(cache_creation_tokens) AS cache_creation_tokens,
                   SUM(cache_read_tokens)     AS cache_read_tokens,
                   SUM(cost_micro)*1.0/1000000 AS cost_usd,
                   COUNT(*) AS message_count
            FROM messages
            WHERE role = 'assistant'
              AND timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY date ORDER BY date
        ''', (off_sql, f'-{days} days')).fetchall()
    return {'data': [dict(r) for r in rows]}


# ─── Models / Projects ────────────────────────────────────────────────────────

_MODELS_SORT_MAP = {
    'model':    'model',
    'messages': 'message_count',
    'input':    'input_tokens',
    'output':   'output_tokens',
    'cache':    'cache_read_tokens',
    'cost':     'cost_usd',
}


@app.get("/api/models")
def api_models(
    sort: str = Query('messages'),
    order: str = Query('desc'),
):
    sort_col = _MODELS_SORT_MAP.get(sort, 'message_count')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    with read_db() as db:
        rows = db.execute(f'''
            SELECT model, COUNT(*) AS message_count,
                   SUM(input_tokens) AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(cache_creation_tokens) AS cache_creation_tokens,
                   SUM(cache_read_tokens) AS cache_read_tokens,
                   SUM(cost_micro)*1.0/1000000 AS cost_usd
            FROM messages
            WHERE role = 'assistant' AND model IS NOT NULL AND model != ''
            GROUP BY model
            ORDER BY {sort_col} {order_sql}
        ''').fetchall()
    return {'models': [dict(r) for r in rows], 'sort': sort, 'order': order_sql.lower()}


_PROJECTS_SORT_MAP = {
    'name':        'project_name',
    'sessions':    'session_count',
    'tokens':      'total_tokens',
    'cost':        'total_cost',
    'last_active': 'last_active',
}

# Group by the composite (path, name) so two projects with the same last-segment
# name but different paths are listed separately (C2 fix).
_PROJECT_GROUP_SQL = "COALESCE(NULLIF(project_path, ''), project_name), project_name"


@app.get("/api/projects")
def api_projects(
    sort: str = Query('last_active'),
    order: str = Query('desc'),
):
    """Project roll-up. ``session_count`` is PARENT sessions only;
    ``subagent_count`` is the spawned-subagent count. All cost/token totals
    include everything (parents + subagents)."""
    sort_col = _PROJECTS_SORT_MAP.get(sort, 'last_active')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    with read_db() as db:
        rows = db.execute(f'''
            SELECT project_name, project_path,
                   SUM(CASE WHEN is_subagent=0 THEN 1 ELSE 0 END) AS session_count,
                   SUM(CASE WHEN is_subagent=1 THEN 1 ELSE 0 END) AS subagent_count,
                   SUM(cost_micro)*1.0/1000000 AS total_cost,
                   SUM(total_input_tokens + total_output_tokens) AS total_tokens,
                   MAX(updated_at) AS last_active,
                   GROUP_CONCAT(tags) AS tags_concat
            FROM sessions GROUP BY {_PROJECT_GROUP_SQL}
            ORDER BY {sort_col} {order_sql}
        ''').fetchall()
    projects = []
    for r in rows:
        d = dict(r)
        raw = d.pop('tags_concat', '') or ''
        seen: list[str] = []
        for tok in raw.split(','):
            tok = tok.strip()
            if tok and tok not in seen:
                seen.append(tok)
        d['tags'] = ','.join(seen)
        projects.append(d)
    return {'projects': projects, 'sort': sort, 'order': order_sql.lower()}


@app.get("/api/projects/top")
def api_projects_top(
    limit: int = Query(5, ge=1, le=50),
    with_last_message: bool = Query(False),
    active_window_minutes: int = Query(30, ge=1, le=1440),
):
    """Top N projects. Projects with activity in the last
    ``active_window_minutes`` minutes are surfaced first (sorted by most
    recent activity); the remaining slots are filled by cost-ranked
    projects. Set ``with_last_message=true`` to attach the most recent
    assistant message preview for the overview TOP 5 widget.
    """
    # Fetch a wider candidate pool so we can re-rank in Python: enough that
    # actives + top-by-cost never loses a legitimate entry.
    candidate_limit = max(limit * 3, 30)
    with read_db() as db:
        rows = db.execute(f'''
            SELECT project_name, project_path,
                   SUM(CASE WHEN is_subagent=0 THEN 1 ELSE 0 END) AS session_count,
                   SUM(CASE WHEN is_subagent=1 THEN 1 ELSE 0 END) AS subagent_count,
                   SUM(cost_micro)*1.0/1000000 AS total_cost,
                   SUM(total_input_tokens) AS input_tokens,
                   SUM(total_output_tokens) AS output_tokens,
                   SUM(total_cache_read_tokens) AS cache_read_tokens,
                   SUM(total_input_tokens + total_output_tokens) AS total_tokens,
                   MAX(updated_at) AS last_active
            FROM sessions GROUP BY {_PROJECT_GROUP_SQL}
            ORDER BY total_cost DESC LIMIT ?
        ''', (candidate_limit,)).fetchall()

        # Compute is_active against a fresh "now" timestamp and re-rank.
        active_cutoff = (datetime.now(_tz.utc) - timedelta(minutes=active_window_minutes)).strftime(
            '%Y-%m-%dT%H:%M:%SZ')
        projects = []
        for r in rows:
            d = dict(r)
            d['is_active'] = bool(d.get('last_active') and d['last_active'] >= active_cutoff)
            projects.append(d)

        # Two-tier sort:
        #   (a) active first, most recent activity at the very top
        #   (b) remaining slots: highest cost first
        # Sorting an already cost-sorted list by (is_active DESC, last_active
        # DESC) is stable, so inactive ordering by cost is preserved.
        projects.sort(key=lambda p: (
            0 if p['is_active'] else 1,       # active group first
            -(_iso_to_epoch(p.get('last_active')) if p['is_active'] else 0),
        ))
        projects = projects[:limit]

        if with_last_message and projects:
            # Fetch the most recent MEANINGFUL assistant message preview per
            # project. Pure-tool messages (`[Tool: Read]`) and extended-
            # thinking summaries are noise — we want the most recent actual
            # text reply. Falls back to any non-empty preview when no clean
            # text is found.
            for p in projects:
                row = db.execute('''
                    SELECT m.content_preview, m.timestamp, m.model, m.session_id
                    FROM messages m
                    JOIN sessions s ON m.session_id = s.id
                    WHERE s.project_path = ?
                      AND m.role = 'assistant'
                      AND m.content_preview IS NOT NULL
                      AND m.content_preview != ''
                      AND m.content_preview NOT LIKE '[Tool:%'
                      AND m.content_preview NOT LIKE '[Extended Thinking]%'
                      AND m.content_preview NOT LIKE '[생각중:%'
                      AND LENGTH(m.content_preview) >= 20
                    ORDER BY m.timestamp DESC, m.id DESC
                    LIMIT 1
                ''', (p['project_path'],)).fetchone()
                if row is None:
                    # Fallback: accept any non-empty preview
                    row = db.execute('''
                        SELECT m.content_preview, m.timestamp, m.model, m.session_id
                        FROM messages m
                        JOIN sessions s ON m.session_id = s.id
                        WHERE s.project_path = ?
                          AND m.role = 'assistant'
                          AND m.content_preview IS NOT NULL
                          AND m.content_preview != ''
                        ORDER BY m.timestamp DESC, m.id DESC
                        LIMIT 1
                    ''', (p['project_path'],)).fetchone()
                if row:
                    preview = row['content_preview'] or ''
                    # Strip common parser prefixes for a cleaner summary
                    for prefix in ('[Extended Thinking]', '[생각중:'):
                        if preview.startswith(prefix):
                            preview = preview[len(prefix):].lstrip(' ]:')
                    # Pre-compute the clean flat summary on the server so the
                    # frontend doesn't need fragile regex logic to strip
                    # markdown. `preview` keeps the raw content for tooltip;
                    # `summary_line` is what the UI renders inline.
                    p['last_message'] = {
                        'preview':      preview[:2000],
                        'summary_line': summarize_preview(preview),
                        'timestamp':    row['timestamp'],
                        'model':        row['model'],
                        'session_id':   row['session_id'],
                    }
                else:
                    p['last_message'] = None

    return {'projects': projects}


def _project_where(project_name: str, path: Optional[str]) -> tuple[str, str, list]:
    """Build a WHERE clause for project-scoped queries.

    Returns a 3-tuple: ``(where_plain, where_joined, params)``.
    ``where_plain`` targets the ``sessions`` table directly. ``where_joined``
    is the same predicate rewritten against an ``s`` alias for use inside a
    ``JOIN`` (previously this was done with a fragile ``str.replace()``).

    - ``path`` (when given) is the canonical identifier — exact match.
    - ``project_name`` is a display fallback when the frontend hasn't yet
      migrated to sending paths, or when two distinct projects share a name.
    """
    if path:
        return "project_path = ?", "s.project_path = ?", [path]
    return "project_name = ?", "s.project_name = ?", [project_name]


# ─── Plan config / usage / detection ─────────────────────────────────────────

class PlanConfigBody(BaseModel):
    daily_cost_limit:  float = Field(default=50.0,  ge=0, le=100_000)
    weekly_cost_limit: float = Field(default=300.0, ge=0, le=1_000_000)
    reset_hour:        int   = Field(default=0,     ge=0, le=23)
    reset_weekday:     int   = Field(default=0,     ge=0, le=6)
    timezone_offset:   int   = Field(default=9,     ge=-12, le=14)
    timezone_name:     str   = Field(default='Asia/Seoul', max_length=64)

    @model_validator(mode='after')
    def _check_daily_le_weekly(self):
        if self.daily_cost_limit > self.weekly_cost_limit:
            raise ValueError(
                f'daily_cost_limit ({self.daily_cost_limit}) must be ≤ '
                f'weekly_cost_limit ({self.weekly_cost_limit})')
        return self


def _plan_cfg(db) -> dict:
    row = db.execute('SELECT * FROM plan_config WHERE id = 1').fetchone()
    return dict(row) if row else {
        'id': 1, 'daily_cost_limit': 50.0, 'weekly_cost_limit': 300.0,
        'reset_hour': 0, 'reset_weekday': 0, 'timezone_offset': 9,
    }


@app.get("/api/plan/detect")
def api_plan_detect():
    return detect_plan()


@app.get("/api/plan/config")
def api_plan_config_get():
    with read_db() as db:
        cfg = _plan_cfg(db)
    cfg['detected'] = detect_plan()
    return cfg


@app.post("/api/plan/config")
def api_plan_config_set(body: PlanConfigBody):
    with write_db() as db:
        db.execute('''
            INSERT INTO plan_config
                (id, daily_cost_limit, weekly_cost_limit,
                 reset_hour, reset_weekday, timezone_offset, timezone_name)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                daily_cost_limit  = excluded.daily_cost_limit,
                weekly_cost_limit = excluded.weekly_cost_limit,
                reset_hour        = excluded.reset_hour,
                reset_weekday     = excluded.reset_weekday,
                timezone_offset   = excluded.timezone_offset,
                timezone_name     = excluded.timezone_name
        ''', (body.daily_cost_limit, body.weekly_cost_limit,
              body.reset_hour, body.reset_weekday, body.timezone_offset,
              body.timezone_name))
    return {'ok': True}


@app.get("/api/forecast")
def api_forecast(days: int = Query(14, ge=3, le=60)):
    """Linear forecast of cost / message volume.

    Strategy:
      1. Pull the last ``days`` days of assistant message totals (timezone-aware).
      2. Average daily cost over the window → ``avg_cost``.
      3. Project to month-end: ``projected_eom = mtd + avg_cost * days_left``.
      4. Burn rate vs configured daily/weekly budget: report seconds until
         each limit is reached at the current pace.
    """
    with read_db() as db:
        off = _tz_offset(db)
        off_sql = f'+{off} hours' if off >= 0 else f'{off} hours'
        rows = db.execute(f'''
            SELECT strftime('%Y-%m-%d', timestamp, ?) AS date,
                   SUM(cost_micro)*1.0/1000000 AS cost,
                   COUNT(*) AS msgs
            FROM messages
            WHERE role='assistant'
              AND timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY date ORDER BY date
        ''', (off_sql, f'-{days} days')).fetchall()
        cfg = _plan_cfg(db)
        tz = _user_tz(db)

    daily = [dict(r) for r in rows]
    if not daily:
        return {
            'window_days': days, 'daily': [],
            'avg_cost_per_day': 0, 'avg_msgs_per_day': 0,
            'mtd_cost': 0, 'projected_eom_cost': 0, 'days_left_in_month': 0,
            'daily_used': 0, 'weekly_used': 0,
            'daily_limit': cfg.get('daily_cost_limit', 50.0) or 0.0,
            'weekly_limit': cfg.get('weekly_cost_limit', 300.0) or 0.0,
            'daily_budget_burnout_seconds': None,
            'weekly_budget_burnout_seconds': None,
        }

    # Weekday-aware projection — averaging weekdays and weekends separately
    # gives a much better month-end estimate when developer usage is bursty on
    # work days. Falls back to simple mean when one side is empty.
    weekday_costs: list[float] = []
    weekend_costs: list[float] = []
    weekday_msgs: list[float] = []
    weekend_msgs: list[float] = []
    for d in daily:
        try:
            dow = datetime.strptime(d['date'], '%Y-%m-%d').weekday()
        except (ValueError, TypeError):
            continue
        is_weekend = dow >= 5
        (weekend_costs if is_weekend else weekday_costs).append(d['cost'] or 0)
        (weekend_msgs  if is_weekend else weekday_msgs ).append(d['msgs']  or 0)

    def _mean(xs):
        return (sum(xs) / len(xs)) if xs else 0.0

    wd_cost, we_cost = _mean(weekday_costs), _mean(weekend_costs)
    wd_msgs, we_msgs = _mean(weekday_msgs),  _mean(weekend_msgs)
    # Fall back to whichever side has data when the other is empty.
    if not weekday_costs:
        wd_cost = we_cost
        wd_msgs = we_msgs
    if not weekend_costs:
        we_cost = wd_cost
        we_msgs = wd_msgs
    # Blended simple mean for backwards-compatible avg_cost_per_day field.
    avg_cost = sum(d['cost'] or 0 for d in daily) / len(daily)
    avg_msgs = sum(d['msgs'] or 0 for d in daily) / len(daily)

    now = datetime.now(tz)
    # Days left in current month (inclusive)
    if now.month == 12:
        next_month = now.replace(year=now.year + 1, month=1, day=1)
    else:
        next_month = now.replace(month=now.month + 1, day=1)
    days_left = (next_month - now).days

    # Month-to-date cost
    mtd_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    mtd_start_utc = mtd_start.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with read_db() as db:
        mtd = db.execute('''
            SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost
            FROM messages WHERE role='assistant' AND timestamp >= ?
        ''', (mtd_start_utc,)).fetchone()
    mtd_cost = mtd['cost'] if mtd else 0

    # Weekday-aware projection: walk remaining days individually, adding the
    # appropriate per-weekday average for each. Much closer to reality when
    # weekend spend differs from weekdays by 2-3x.
    remaining_cost_projection = 0.0
    cursor = now
    for _ in range(days_left):
        cursor = cursor + timedelta(days=1)
        is_weekend = cursor.weekday() >= 5
        remaining_cost_projection += we_cost if is_weekend else wd_cost
    projected_eom = mtd_cost + remaining_cost_projection

    # Burn-rate to daily/weekly limits, given current spend so far + avg pace
    daily_limit = cfg.get('daily_cost_limit', 50.0) or 0.0
    weekly_limit = cfg.get('weekly_cost_limit', 300.0) or 0.0

    # Helper: at the average pace (cost per hour), how many seconds until we
    # hit ``limit`` from a starting cost of ``current``?
    def _burnout(current, limit, period_seconds):
        if avg_cost <= 0 or limit <= 0:
            return None
        if current >= limit:
            return 0
        # Convert avg_cost (per day) to per-second
        per_sec = avg_cost / 86400.0
        if per_sec <= 0:
            return None
        return int((limit - current) / per_sec)

    # Day spend so far
    today_local = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_utc = today_local.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with read_db() as db:
        d_used = db.execute(
            "SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS c FROM messages WHERE role='assistant' AND timestamp >= ?",
            (today_utc,),
        ).fetchone()
        # Current week start using plan_config (Mon by default)
        days_since = (now.weekday() - cfg.get('reset_weekday', 0)) % 7
        ws = (now - timedelta(days=days_since)).replace(
            hour=cfg.get('reset_hour', 0), minute=0, second=0, microsecond=0)
        if now < ws:
            ws -= timedelta(weeks=1)
        ws_utc = ws.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        w_used = db.execute(
            "SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS c FROM messages WHERE role='assistant' AND timestamp >= ?",
            (ws_utc,),
        ).fetchone()

    return {
        'window_days': days,
        'daily': daily,
        'avg_cost_per_day': round(avg_cost, 4),
        'avg_msgs_per_day': round(avg_msgs, 1),
        'mtd_cost': round(mtd_cost, 4),
        'projected_eom_cost': round(projected_eom, 4),
        'days_left_in_month': days_left,
        'daily_used': round(d_used['c'], 4),
        'weekly_used': round(w_used['c'], 4),
        'daily_limit': daily_limit,
        'weekly_limit': weekly_limit,
        'daily_budget_burnout_seconds': _burnout(d_used['c'], daily_limit, 86400),
        'weekly_budget_burnout_seconds': _burnout(w_used['c'], weekly_limit, 7 * 86400),
    }


@app.get("/api/usage/periods")
def api_usage_periods():
    """Daily / weekly / monthly usage summary with deltas."""
    with read_db() as db:
        tz = _user_tz(db)
        now = datetime.now(tz)

        def _boundary(days_back):
            dt = (now - timedelta(days=days_back)).replace(
                hour=0, minute=0, second=0, microsecond=0)
            return dt.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        today_utc = _boundary(0)
        yesterday_utc = _boundary(1)
        week_start_utc = _boundary(now.weekday())       # Monday 00:00
        prev_week_utc = _boundary(now.weekday() + 7)
        month_start_utc = _boundary(now.day - 1)        # 1st of month 00:00
        prev_month_start = (now.replace(day=1) - timedelta(days=1)).replace(day=1)
        prev_month_utc = prev_month_start.replace(
            hour=0, minute=0, second=0, microsecond=0
        ).astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        def _q(since, until=None):
            if until:
                r = db.execute('''
                    SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost,
                           COALESCE(SUM(input_tokens),0) AS input_tok,
                           COALESCE(SUM(output_tokens),0) AS output_tok,
                           COALESCE(SUM(cache_creation_tokens),0) AS cache_create,
                           COALESCE(SUM(cache_read_tokens),0) AS cache_read,
                           COUNT(*) AS msgs
                    FROM messages WHERE role='assistant'
                      AND timestamp >= ? AND timestamp < ?
                ''', (since, until)).fetchone()
            else:
                r = db.execute('''
                    SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost,
                           COALESCE(SUM(input_tokens),0) AS input_tok,
                           COALESCE(SUM(output_tokens),0) AS output_tok,
                           COALESCE(SUM(cache_creation_tokens),0) AS cache_create,
                           COALESCE(SUM(cache_read_tokens),0) AS cache_read,
                           COUNT(*) AS msgs
                    FROM messages WHERE role='assistant' AND timestamp >= ?
                ''', (since,)).fetchone()
            return dict(r)

        day_cur = _q(today_utc)
        day_prev = _q(yesterday_utc, today_utc)
        week_cur = _q(week_start_utc)
        week_prev = _q(prev_week_utc, week_start_utc)
        month_cur = _q(month_start_utc)
        month_prev = _q(prev_month_utc, month_start_utc)

    def _blk(cur, prev, label):
        c, p = cur['cost'], prev['cost']
        delta = ((c - p) / p * 100) if p > 0 else (100.0 if c > 0 else 0.0)
        return {
            'label': label,
            'cost': round(c, 4),
            'input_tokens': cur['input_tok'],
            'output_tokens': cur['output_tok'],
            'cache_creation_tokens': cur['cache_create'],
            'cache_read_tokens': cur['cache_read'],
            'messages': cur['msgs'],
            'prev_cost': round(p, 4),
            'delta_pct': round(delta, 1),
        }

    return {
        'day':   _blk(day_cur, day_prev, '오늘'),
        'week':  _blk(week_cur, week_prev, '이번 주'),
        'month': _blk(month_cur, month_prev, '이번 달'),
    }


@app.get("/api/plan/usage")
def api_plan_usage():
    with read_db() as db:
        cfg = _plan_cfg(db)
        r_hour = cfg['reset_hour']
        r_wd   = cfg['reset_weekday']
        tz = _user_tz(db)
        now = datetime.now(tz)

        ds = now.replace(hour=r_hour, minute=0, second=0, microsecond=0)
        if now < ds:
            ds -= timedelta(days=1)
        de = ds + timedelta(days=1)

        days_since = (now.weekday() - r_wd) % 7
        ws = (now - timedelta(days=days_since)).replace(
            hour=r_hour, minute=0, second=0, microsecond=0)
        if now < ws:
            ws -= timedelta(weeks=1)
        we = ws + timedelta(weeks=1)

        ds_utc = ds.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        ws_utc = ws.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        def _q(since):
            return db.execute('''
                SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost,
                       COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                       COALESCE(SUM(cache_read_tokens), 0) AS cache_tokens,
                       COUNT(*) AS messages
                FROM messages WHERE role = 'assistant' AND timestamp >= ?
            ''', (since,)).fetchone()

        dr, wr = _q(ds_utc), _q(ws_utc)
        dl, wl = cfg['daily_cost_limit'], cfg['weekly_cost_limit']

        def _blk(row, lim, start, end):
            c = row['cost']
            return {
                'used_cost': round(c, 4), 'limit_cost': lim,
                'used_tokens': row['tokens'], 'cache_tokens': row['cache_tokens'],
                'messages': row['messages'],
                'percentage': round(c / lim * 100, 1) if lim > 0 else 0,
                'remaining_seconds': int(max(0, (end - now).total_seconds())),
                'reset_at': end.isoformat(), 'period_start': start.isoformat(),
            }

    return {
        'daily': _blk(dr, dl, ds, de),
        'weekly': _blk(wr, wl, ws, we),
        'config': {k: v for k, v in cfg.items() if k != 'id'},
        'plan': detect_plan(),
    }


# ─── Session / Conversation Management ────────────────────────────────────────

@app.delete("/api/sessions/{session_id}")
def api_session_delete(session_id: str, confirm: bool = Query(False)):
    """Delete a single session and all its messages."""
    if not confirm:
        with read_db() as db:
            row = db.execute(
                'SELECT project_name, message_count FROM sessions WHERE id = ?',
                (session_id,)).fetchone()
        if not row:
            return JSONResponse({'error': 'Not found'}, status_code=404)
        return {'preview': True, 'session_id': session_id,
                'project_name': row['project_name'],
                'message_count': row['message_count']}
    with write_db() as db:
        msg_del = db.execute(
            'DELETE FROM messages WHERE session_id = ?', (session_id,)).rowcount
        sess_del = db.execute(
            'DELETE FROM sessions WHERE id = ?', (session_id,)).rowcount
    logger.info("Deleted session %s (%d messages)", session_id, msg_del)
    return {'deleted': sess_del > 0, 'messages_deleted': msg_del}


@app.post("/api/sessions/{session_id}/pin")
def api_session_pin(session_id: str):
    with write_db() as db:
        db.execute('UPDATE sessions SET pinned = 1 WHERE id = ?', (session_id,))
    return {'ok': True}


@app.delete("/api/sessions/{session_id}/pin")
def api_session_unpin(session_id: str):
    with write_db() as db:
        db.execute('UPDATE sessions SET pinned = 0 WHERE id = ?', (session_id,))
    return {'ok': True}


class SessionTagsBody(BaseModel):
    tags: str = Field(default='', max_length=500)


@app.post("/api/sessions/{session_id}/tags")
def api_session_set_tags(session_id: str, body: SessionTagsBody):
    """Store a comma-separated tag list on a session. The frontend trims
    and normalises, the backend just stores the string."""
    with write_db() as db:
        cur = db.execute(
            'UPDATE sessions SET tags = ? WHERE id = ?',
            (body.tags.strip(), session_id),
        )
    return {'ok': True, 'updated': cur.rowcount > 0, 'tags': body.tags.strip()}


@app.get("/api/tags")
def api_tags_list():
    """Return every distinct tag across all sessions with its session count."""
    counts: dict[str, int] = {}
    with read_db() as db:
        rows = db.execute(
            "SELECT tags FROM sessions WHERE tags IS NOT NULL AND tags != ''"
        ).fetchall()
    for r in rows:
        for t in (r['tags'] or '').split(','):
            t = t.strip()
            if not t:
                continue
            counts[t] = counts.get(t, 0) + 1
    return {
        'tags': sorted(
            [{'tag': k, 'count': v} for k, v in counts.items()],
            key=lambda x: (-x['count'], x['tag'])
        ),
    }



@app.delete("/api/projects/{project_name}")
def api_project_delete(
    project_name: str,
    path: Optional[str] = Query(None),
    confirm: bool = Query(False),
):
    """Delete ALL sessions and messages for a project.

    Use ``?path=`` to target a specific project_path when two projects share
    a final-segment name (C2 fix).
    """
    where, _where_join, params = _project_where(project_name, path)
    if not confirm:
        with read_db() as db:
            row = db.execute(f'''
                SELECT COUNT(*) AS sessions,
                       COALESCE(SUM(message_count),0) AS messages,
                       COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost
                FROM sessions WHERE {where}
            ''', params).fetchone()
        return {'preview': True, 'project_name': project_name, 'path': path,
                'sessions': row['sessions'], 'messages': row['messages'],
                'cost': row['cost']}
    with write_db() as db:
        sids = [r['id'] for r in db.execute(
            f'SELECT id FROM sessions WHERE {where}', params).fetchall()]
        msg_del = sess_del = 0
        if sids:
            ph = ','.join(['?'] * len(sids))
            msg_del = db.execute(
                f'DELETE FROM messages WHERE session_id IN ({ph})', sids).rowcount
            sess_del = db.execute(
                f'DELETE FROM sessions WHERE id IN ({ph})', sids).rowcount
    logger.info("Deleted project '%s' (path=%s): %d sessions, %d messages",
                project_name, path, sess_del, msg_del)
    return {'deleted_sessions': sess_del, 'deleted_messages': msg_del}


@app.get("/api/projects/{project_name}/stats")
def api_project_stats(project_name: str, path: Optional[str] = Query(None)):
    """Detailed stats for a single project (use ?path= to disambiguate)."""
    where, where_join, params = _project_where(project_name, path)
    with read_db() as db:
        summary = db.execute(f'''
            SELECT COUNT(*) AS sessions,
                   COALESCE(SUM(message_count),0) AS messages,
                   COALESCE(SUM(user_message_count),0) AS user_messages,
                   COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost,
                   COALESCE(SUM(total_input_tokens),0) AS input_tokens,
                   COALESCE(SUM(total_output_tokens),0) AS output_tokens,
                   COALESCE(SUM(total_cache_read_tokens),0) AS cache_read_tokens,
                   MIN(created_at) AS first_active,
                   MAX(updated_at) AS last_active,
                   MIN(project_path) AS canonical_path
            FROM sessions WHERE {where}
        ''', params).fetchone()
        if not summary or summary['sessions'] == 0:
            return JSONResponse({'error': 'Not found'}, status_code=404)
        # Models breakdown — aggregate from MESSAGES (C1 fix)
        models = db.execute(f'''
            SELECT m.model,
                   COUNT(DISTINCT m.session_id) AS cnt,
                   SUM(m.cost_micro)*1.0/1000000 AS cost
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_join}
              AND m.role = 'assistant'
              AND m.model IS NOT NULL AND m.model != ''
            GROUP BY m.model ORDER BY cost DESC
        ''', params).fetchall()
        daily = db.execute(f'''
            SELECT strftime('%Y-%m-%d', m.timestamp, ?) AS date,
                   SUM(m.cost_micro)*1.0/1000000 AS cost,
                   COUNT(*) AS messages
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_join}
              AND m.role = 'assistant'
            GROUP BY date ORDER BY date DESC LIMIT 30
        ''', [f'+{_tz_offset(db)} hours', *params]).fetchall()
        sessions = db.execute(f'''
            SELECT id, model, created_at, updated_at,
                   cost_micro*1.0/1000000 AS cost_usd,
                   message_count, user_message_count,
                   total_input_tokens, total_output_tokens,
                   total_cache_read_tokens, pinned, is_subagent, version,
                   tags
            FROM sessions
            WHERE {where}
            ORDER BY updated_at DESC
        ''', params).fetchall()
    return {
        'summary': dict(summary),
        'models': [dict(m) for m in models],
        'daily': [dict(d) for d in daily],
        'sessions': [dict(s) for s in sessions],
    }


# ─── Subagents ────────────────────────────────────────────────────────────

_SUBAGENTS_SORT_MAP = {
    'updated_at':  'updated_at',
    'created_at':  'created_at',
    'cost':        'cost_micro',
    'messages':    'message_count',
    'type':        'agent_type',
    'description': 'agent_description',
}


# Duration computed in SQL as (julianday(updated_at) - julianday(created_at)) * 86400.
# Both timestamps are stored as ISO-8601 UTC strings, which julianday() parses.
_DURATION_SQL = (
    "(julianday(COALESCE(NULLIF(updated_at,''),created_at)) - "
    "julianday(created_at)) * 86400.0"
)


@app.get("/api/sessions/{session_id}/subagents")
def api_session_subagents(session_id: str):
    """List subagents spawned by a given parent session."""
    with read_db() as db:
        rows = db.execute(f'''
            SELECT id, agent_type, agent_description, model,
                   created_at, updated_at,
                   cost_micro*1.0/1000000 AS cost_usd,
                   message_count,
                   total_input_tokens, total_output_tokens, total_cache_read_tokens,
                   {_DURATION_SQL} AS duration_seconds,
                   final_stop_reason, parent_tool_use_id, task_prompt
            FROM sessions
            WHERE parent_session_id = ? AND is_subagent = 1
            ORDER BY cost_micro DESC, updated_at DESC
        ''', (session_id,)).fetchall()
    return {
        'parent_session_id': session_id,
        'subagents': [dict(r) for r in rows],
        'total': len(rows),
    }


@app.get("/api/subagents")
def api_subagents_list(
    agent_type: Optional[str] = Query(None),
    parent: Optional[str] = Query(None),
    search: Optional[str] = None,
    sort: str = Query('cost'),
    order: str = Query('desc'),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=500),
):
    """Flat listing of every subagent session."""
    sort_col = _SUBAGENTS_SORT_MAP.get(sort, 'cost_micro')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    conds: list[str] = ['is_subagent = 1']
    params: list = []
    if agent_type:
        conds.append('agent_type = ?')
        params.append(agent_type)
    if parent:
        conds.append('parent_session_id = ?')
        params.append(parent)
    if search:
        conds.append("(agent_description LIKE ? ESCAPE '\\' OR agent_type LIKE ? ESCAPE '\\')")
        s = f"%{_esc_like(search)}%"
        params.extend([s, s])
    where = ' AND '.join(conds)
    with read_db() as db:
        total = db.execute(
            f"SELECT COUNT(*) FROM sessions WHERE {where}", params
        ).fetchone()[0]
        offset = (page - 1) * per_page
        rows = db.execute(f'''
            SELECT id, parent_session_id, agent_type, agent_description, model,
                   created_at, updated_at,
                   cost_micro*1.0/1000000 AS cost_usd,
                   message_count,
                   total_input_tokens, total_output_tokens, total_cache_read_tokens,
                   project_name, project_path,
                   {_DURATION_SQL} AS duration_seconds,
                   final_stop_reason, parent_tool_use_id, task_prompt
            FROM sessions
            WHERE {where}
            ORDER BY {sort_col} {order_sql}
            LIMIT ? OFFSET ?
        ''', [*params, per_page, offset]).fetchall()
    return {
        'subagents': [dict(r) for r in rows],
        'total': total, 'page': page, 'per_page': per_page,
        'pages': max(1, -(-total // per_page)),
        'sort': sort, 'order': order_sql.lower(),
    }


@app.get("/api/subagents/stats")
def api_subagents_stats():
    """Aggregate metrics over all subagents: count / cost / tokens / duration
    by agentType + top lists + longest-running samples."""
    with read_db() as db:
        by_type = db.execute(f'''
            SELECT COALESCE(NULLIF(agent_type, ''), '(unknown)') AS agent_type,
                   COUNT(*) AS count,
                   SUM(cost_micro)*1.0/1000000 AS cost,
                   SUM(total_input_tokens + total_output_tokens) AS tokens,
                   SUM(message_count) AS messages,
                   AVG(cost_micro)*1.0/1000000 AS avg_cost,
                   AVG({_DURATION_SQL}) AS avg_duration_seconds,
                   MAX({_DURATION_SQL}) AS max_duration_seconds
            FROM sessions WHERE is_subagent = 1
            GROUP BY agent_type
            ORDER BY cost DESC
        ''').fetchall()
        totals = db.execute('''
            SELECT COUNT(*) AS count,
                   SUM(cost_micro)*1.0/1000000 AS cost,
                   SUM(total_input_tokens + total_output_tokens) AS tokens,
                   SUM(message_count) AS messages
            FROM sessions WHERE is_subagent = 1
        ''').fetchone()
        top = db.execute(f'''
            SELECT id, agent_type, agent_description,
                   cost_micro*1.0/1000000 AS cost_usd,
                   message_count, parent_session_id,
                   {_DURATION_SQL} AS duration_seconds
            FROM sessions WHERE is_subagent = 1
            ORDER BY cost_micro DESC LIMIT 10
        ''').fetchall()
        longest = db.execute(f'''
            SELECT id, agent_type, agent_description,
                   cost_micro*1.0/1000000 AS cost_usd,
                   message_count, parent_session_id,
                   {_DURATION_SQL} AS duration_seconds
            FROM sessions WHERE is_subagent = 1
              AND created_at != '' AND updated_at != ''
            ORDER BY duration_seconds DESC LIMIT 10
        ''').fetchall()
        parents_with_most_subs = db.execute('''
            SELECT parent_session_id,
                   COUNT(*) AS sub_count,
                   SUM(cost_micro)*1.0/1000000 AS total_cost,
                   (SELECT project_name FROM sessions WHERE id = s.parent_session_id) AS project
            FROM sessions s
            WHERE is_subagent = 1 AND parent_session_id IS NOT NULL
            GROUP BY parent_session_id
            ORDER BY sub_count DESC LIMIT 10
        ''').fetchall()
        by_stop_reason = db.execute('''
            SELECT COALESCE(NULLIF(final_stop_reason, ''), '(missing)') AS stop_reason,
                   COUNT(*) AS count,
                   SUM(cost_micro)*1.0/1000000 AS cost
            FROM sessions WHERE is_subagent = 1
            GROUP BY stop_reason ORDER BY count DESC
        ''').fetchall()
        # agent_type × stop_reason success matrix
        by_type_and_stop_reason = db.execute('''
            SELECT COALESCE(NULLIF(agent_type, ''), '(unknown)') AS agent_type,
                   COALESCE(NULLIF(final_stop_reason, ''), '(missing)') AS stop_reason,
                   COUNT(*) AS count,
                   SUM(cost_micro)*1.0/1000000 AS cost
            FROM sessions WHERE is_subagent = 1
            GROUP BY agent_type, stop_reason
            ORDER BY agent_type, count DESC
        ''').fetchall()
    return {
        'totals': dict(totals) if totals else {},
        'by_type': [dict(r) for r in by_type],
        'top_by_cost': [dict(r) for r in top],
        'top_by_duration': [dict(r) for r in longest],
        'parents_with_most_subs': [dict(r) for r in parents_with_most_subs],
        'by_stop_reason': [dict(r) for r in by_stop_reason],
        'by_type_and_stop_reason': [dict(r) for r in by_type_and_stop_reason],
    }


@app.get("/api/sessions/{session_id}/chain")
def api_session_chain(session_id: str, depth: int = Query(3, ge=1, le=5)):
    """Walk the subagent dispatch chain rooted at ``session_id``.

    A 'compact' or 'general-purpose' subagent can issue ``Agent`` tool_use
    blocks of its own. We follow those by matching ``input.description`` to
    other subagent rows, building a tree up to ``depth`` levels deep.

    Used by the frontend chain visualisation in the conversation viewer.
    """
    visited: set[str] = set()
    nodes: list[dict] = []

    def _walk(sid: str, level: int):
        if level >= depth or sid in visited:
            return
        visited.add(sid)
        with read_db() as db:
            row = db.execute('''
                SELECT id, agent_type, agent_description,
                       cost_micro*1.0/1000000 AS cost_usd,
                       message_count, parent_session_id,
                       project_path, is_subagent
                FROM sessions WHERE id = ?
            ''', (sid,)).fetchone()
            if not row:
                return
            nodes.append({**dict(row), 'level': level})
            # Find any Agent/Task tool_use this session emitted by scanning
            # its assistant messages' content. We then match descriptions to
            # other subagent sessions.
            ctx = db.execute('''
                SELECT content FROM messages
                WHERE session_id = ? AND role = 'assistant' AND content IS NOT NULL
            ''', (sid,)).fetchall()
            child_descriptions: list[str] = []
            for c in ctx:
                txt = c['content'] or ''
                if '"Agent"' not in txt and '"Task"' not in txt:
                    continue
                try:
                    blocks = json.loads(txt)
                except Exception:
                    continue
                if not isinstance(blocks, list):
                    continue
                for b in blocks:
                    if not isinstance(b, dict):
                        continue
                    if b.get('type') != 'tool_use':
                        continue
                    if b.get('name') not in ('Agent', 'Task'):
                        continue
                    desc = (b.get('input') or {}).get('description', '')
                    if desc:
                        child_descriptions.append(desc)
            if child_descriptions:
                placeholders = ','.join(['?'] * len(child_descriptions))
                children = db.execute(f'''
                    SELECT id FROM sessions
                    WHERE is_subagent = 1
                      AND agent_description IN ({placeholders})
                ''', child_descriptions).fetchall()
                for ch in children:
                    _walk(ch['id'], level + 1)

    _walk(session_id, 0)
    return {'root': session_id, 'nodes': nodes, 'count': len(nodes)}


@app.get("/api/subagents/heatmap")
def api_subagents_heatmap():
    """2-D aggregation: agent_type × project, returning a dense grid the
    frontend can render as a heatmap.

    Response:
      {
        'projects':    ['proj-a', 'proj-b', ...],
        'agent_types': ['Explore', 'Plan', ...],
        'cells':       { 'Explore|proj-a': {count, cost}, ... },
      }
    """
    with read_db() as db:
        rows = db.execute('''
            SELECT COALESCE(NULLIF(agent_type, ''), '(unknown)') AS agent_type,
                   COALESCE(NULLIF(project_name, ''), '(unknown)') AS project_name,
                   COUNT(*) AS count,
                   SUM(cost_micro)*1.0/1000000 AS cost,
                   SUM(total_input_tokens + total_output_tokens) AS tokens
            FROM sessions
            WHERE is_subagent = 1
            GROUP BY agent_type, project_name
            ORDER BY cost DESC
        ''').fetchall()
    projects: list[str] = []
    seen_p: set[str] = set()
    types: list[str] = []
    seen_t: set[str] = set()
    cells: dict[str, dict] = {}
    for r in rows:
        p = r['project_name']
        t = r['agent_type']
        if p not in seen_p:
            seen_p.add(p); projects.append(p)
        if t not in seen_t:
            seen_t.add(t); types.append(t)
        cells[f'{t}|{p}'] = {
            'count': r['count'],
            'cost': r['cost'],
            'tokens': r['tokens'],
        }
    return {
        'projects': projects,
        'agent_types': types,
        'cells': cells,
    }


@app.get("/api/projects/{project_name}/messages")
def api_project_messages(
    project_name: str,
    path: Optional[str] = Query(None),
    limit: int = Query(300, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    order: str = Query('asc'),
):
    """Messages across all sessions in a project (chronological by default)."""
    order_sql = 'DESC' if str(order).lower() == 'desc' else 'ASC'
    _where, where_join, params = _project_where(project_name, path)
    with read_db() as db:
        total = db.execute(f'''
            SELECT COUNT(*) FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_join} AND m.is_sidechain = 0
        ''', params).fetchone()[0]
        rows = db.execute(f'''
            SELECT m.id, m.message_uuid, m.session_id, m.role,
                   m.content_preview, m.content,
                   m.input_tokens, m.output_tokens,
                   m.cache_creation_tokens, m.cache_read_tokens,
                   m.cost_micro*1.0/1000000 AS cost_usd,
                   m.model, m.timestamp, m.git_branch
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE {where_join} AND m.is_sidechain = 0
            ORDER BY m.timestamp {order_sql}, m.id {order_sql}
            LIMIT ? OFFSET ?
        ''', [*params, limit, offset]).fetchall()
    return {
        'messages': [dict(r) for r in rows],
        'total': total, 'limit': limit, 'offset': offset,
        'order': order_sql.lower(),
    }


# ─── Export ───────────────────────────────────────────────────────────────────

_CSV_COLS = [
    'session_id', 'project_name', 'project_path', 'cwd', 'model',
    'created_at', 'updated_at', 'duration_seconds',
    'total_input_tokens', 'total_output_tokens',
    'total_cache_creation_tokens', 'total_cache_read_tokens',
    'total_cost_usd', 'message_count', 'user_message_count',
    'is_subagent', 'parent_session_id', 'parent_tool_use_id',
    'agent_type', 'agent_description', 'final_stop_reason',
    'pinned', 'tags',
]


@app.get("/api/export/csv")
def api_export_csv():
    with read_db() as db:
        rows = db.execute(f'''
            SELECT id AS session_id, project_name, project_path, cwd, model,
                   created_at, updated_at,
                   {_DURATION_SQL} AS duration_seconds,
                   total_input_tokens, total_output_tokens,
                   total_cache_creation_tokens, total_cache_read_tokens,
                   cost_micro*1.0/1000000 AS total_cost_usd,
                   message_count, user_message_count,
                   is_subagent, parent_session_id, parent_tool_use_id,
                   agent_type, agent_description, final_stop_reason,
                   pinned, tags
            FROM sessions ORDER BY updated_at DESC
        ''').fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_CSV_COLS)
    for r in rows:
        d = dict(r)
        w.writerow([d.get(c, '') if d.get(c) is not None else '' for c in _CSV_COLS])
    return Response(
        buf.getvalue(), media_type='text/csv',
        headers={'Content-Disposition': 'attachment; filename="claude-usage.csv"'},
    )


# ─── Admin: backup + retention ────────────────────────────────────────────────

@app.post("/api/admin/backup")
def api_backup():
    """Create a timestamped SQLite backup (acquires write lock for consistency)."""
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    dest = BACKUP_DIR / f'dashboard_{ts}.db'
    try:
        with _write_lock:
            src_conn = sqlite3.connect(str(DB_PATH))
            dst_conn = sqlite3.connect(str(dest))
            src_conn.backup(dst_conn)
            dst_conn.close()
            src_conn.close()
        # Keep only last 10 backups
        backups = sorted(BACKUP_DIR.glob('dashboard_*.db'))
        for old in backups[:-10]:
            old.unlink(missing_ok=True)
        size = dest.stat().st_size
        return {'ok': True, 'path': str(dest), 'size_bytes': size}
    except Exception as e:
        logger.error("Backup failed: %s", e)
        return JSONResponse({'error': str(e)}, status_code=500)


@app.delete("/api/admin/retention")
def api_retention(
    older_than_days: int = Query(90, ge=7, le=3650),
    confirm: bool = Query(False),
):
    """Delete sessions older than N days. Set confirm=true to execute."""
    cutoff = (datetime.now(_tz.utc) - timedelta(days=older_than_days)).strftime(
        '%Y-%m-%dT%H:%M:%SZ')

    if not confirm:
        # Preview only — show what WOULD be deleted
        with read_db() as db:
            cnt = db.execute(
                'SELECT COUNT(*) FROM sessions WHERE updated_at < ?', (cutoff,)
            ).fetchone()[0]
        return {'preview': True, 'sessions_to_delete': cnt, 'cutoff': cutoff}

    with write_db() as db:
        old = db.execute(
            'SELECT id FROM sessions WHERE updated_at < ?', (cutoff,)
        ).fetchall()
        sids = [r['id'] for r in old]
        msg_del = sess_del = 0
        if sids:
            ph = ','.join(['?'] * len(sids))
            msg_del = db.execute(
                f'DELETE FROM messages WHERE session_id IN ({ph})', sids
            ).rowcount
            sess_del = db.execute(
                f'DELETE FROM sessions WHERE id IN ({ph})', sids
            ).rowcount
    logger.info("Retention: deleted %d sessions, %d messages (cutoff=%s)",
                sess_del, msg_del, cutoff)
    return {'preview': False, 'deleted_sessions': sess_del,
            'deleted_messages': msg_del, 'cutoff': cutoff}


@app.get("/api/admin/db-size")
def api_db_size():
    try:
        size = DB_PATH.stat().st_size
        if _PROMETHEUS_OK:
            METRIC_DB_SIZE.set(size)
        return {'size_bytes': size, 'size_mb': round(size / 1048576, 1)}
    except OSError:
        return {'size_bytes': 0, 'size_mb': 0}


# ─── claude.ai export routes ─────────────────────────────────────────────────
# These tables are populated by import_claude_ai.py from a claude.ai "Export
# data" archive. The export has no token / model / cost info, so the routes
# only serve metadata + searchable content.

_CAI_SORT_MAP = {
    'updated_at':    'updated_at',
    'created_at':    'created_at',
    'message_count': 'message_count',
    'name':          'name',
    'text_bytes':    'total_text_bytes',
}


@app.get("/api/claude-ai/conversations")
def api_cai_conversations(
    sort: str = Query('updated_at'),
    order: str = Query('desc'),
    search: str = Query('', max_length=200),
    per_page: int = Query(100, ge=1, le=500),
    page: int = Query(1, ge=1),
):
    sort_col = _CAI_SORT_MAP.get(sort, 'updated_at')
    order_sql = 'DESC' if order.lower() != 'asc' else 'ASC'
    clauses: list[str] = []
    params: list = []
    if search:
        clauses.append("(name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')")
        pat = f'%{_esc_like(search)}%'
        params += [pat, pat]
    where = ('WHERE ' + ' AND '.join(clauses)) if clauses else ''
    offset = (page - 1) * per_page
    with read_db() as db:
        total = db.execute(
            f"SELECT COUNT(*) FROM claude_ai_conversations {where}",
            params,
        ).fetchone()[0]
        rows = db.execute(
            f'''SELECT uuid, name, summary, created_at, updated_at,
                       message_count, user_message_count,
                       attachment_count, file_count, total_text_bytes,
                       imported_at
                FROM claude_ai_conversations
                {where}
                ORDER BY {sort_col} {order_sql}
                LIMIT ? OFFSET ?''',
            params + [per_page, offset],
        ).fetchall()
    return {
        'conversations': [dict(r) for r in rows],
        'total': total,
        'page': page,
        'per_page': per_page,
    }


@app.get("/api/claude-ai/conversations/{uuid}")
def api_cai_conversation_detail(uuid: str):
    with read_db() as db:
        row = db.execute(
            'SELECT * FROM claude_ai_conversations WHERE uuid = ?', (uuid,)
        ).fetchone()
    if not row:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return dict(row)


@app.get("/api/claude-ai/conversations/{uuid}/messages")
def api_cai_conversation_messages(
    uuid: str,
    limit: int = Query(1000, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    with read_db() as db:
        conv = db.execute(
            'SELECT uuid, name, created_at FROM claude_ai_conversations WHERE uuid = ?',
            (uuid,),
        ).fetchone()
        if not conv:
            return JSONResponse({'error': 'Not found'}, status_code=404)
        rows = db.execute('''
            SELECT id, message_uuid, parent_message_uuid, sender, created_at,
                   text, content_json, has_thinking, has_tool_use,
                   attachment_count, file_count
            FROM claude_ai_messages
            WHERE conversation_uuid = ?
            ORDER BY created_at ASC, id ASC
            LIMIT ? OFFSET ?
        ''', (uuid, limit, offset)).fetchall()
        total = db.execute(
            'SELECT COUNT(*) FROM claude_ai_messages WHERE conversation_uuid = ?',
            (uuid,),
        ).fetchone()[0]
    return {
        'conversation': dict(conv),
        'messages': [dict(r) for r in rows],
        'total': total,
        'limit': limit,
        'offset': offset,
    }


@app.get("/api/claude-ai/search")
def api_cai_search(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(50, ge=1, le=200),
):
    fts_query = _build_fts_query(q)
    with read_db() as db:
        if fts_query:
            try:
                rows = db.execute('''
                    SELECT m.id, m.conversation_uuid, m.sender, m.created_at,
                           substr(m.content_preview, 1, 300) AS snippet,
                           c.name AS conversation_name
                    FROM claude_ai_messages_fts fts
                    JOIN claude_ai_messages m ON m.id = fts.rowid
                    JOIN claude_ai_conversations c ON c.uuid = m.conversation_uuid
                    WHERE claude_ai_messages_fts MATCH ?
                    ORDER BY m.created_at DESC
                    LIMIT ?
                ''', (fts_query, limit)).fetchall()
                return {'results': [dict(r) for r in rows], 'query': q, 'fts': True}
            except sqlite3.OperationalError as e:
                logger.warning("claude.ai FTS query failed (%s) — LIKE fallback", e)
        rows = db.execute('''
            SELECT m.id, m.conversation_uuid, m.sender, m.created_at,
                   substr(m.content_preview, 1, 300) AS snippet,
                   c.name AS conversation_name
            FROM claude_ai_messages m
            JOIN claude_ai_conversations c ON c.uuid = m.conversation_uuid
            WHERE m.content_preview LIKE ? ESCAPE '\\'
            ORDER BY m.created_at DESC
            LIMIT ?
        ''', (f'%{_esc_like(q)}%', limit)).fetchall()
    return {'results': [dict(r) for r in rows], 'query': q, 'fts': False}


@app.get("/api/claude-ai/stats")
def api_cai_stats():
    with read_db() as db:
        conv = db.execute(
            "SELECT COUNT(*) AS total, "
            "SUM(message_count) AS msgs, "
            "SUM(attachment_count) AS atts, "
            "SUM(file_count) AS files, "
            "SUM(total_text_bytes) AS bytes, "
            "MIN(created_at) AS first_at, "
            "MAX(updated_at) AS last_at "
            "FROM claude_ai_conversations"
        ).fetchone()
    return {
        'conversations': conv['total'] or 0,
        'messages': conv['msgs'] or 0,
        'attachments': conv['atts'] or 0,
        'files': conv['files'] or 0,
        'total_text_bytes': conv['bytes'] or 0,
        'first_at': conv['first_at'] or '',
        'last_at': conv['last_at'] or '',
    }


# ─── Prometheus metrics endpoint ─────────────────────────────────────────────

@app.get("/metrics")
def api_metrics():
    if not _PROMETHEUS_OK:
        return Response("prometheus_client not installed\n",
                        media_type="text/plain", status_code=503)
    # Refresh gauges on scrape so they reflect current state
    try:
        with read_db() as db:
            sessions = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            messages = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        METRIC_SESSIONS.set(sessions)
        METRIC_MESSAGES.set(messages)
        if DB_PATH.exists():
            METRIC_DB_SIZE.set(DB_PATH.stat().st_size)
    except Exception as e:
        logger.warning("metrics refresh failed: %s", e)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PORT', 8765))
    uvicorn.run('main:app', host='0.0.0.0', port=port, reload=False, log_level='info')
