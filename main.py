import asyncio
import base64
import csv
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from datetime import timezone as _tz
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, model_validator

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None  # Python < 3.9 fallback

try:
    from prometheus_client import (
        CONTENT_TYPE_LATEST,
        Counter,
        Gauge,
        Histogram,
        generate_latest,
    )
    _PROMETHEUS_OK = True
except ImportError:
    _PROMETHEUS_OK = False

from database import (
    DB_PATH,
    _write_lock,
    check_integrity,
    close_thread_connections,
    get_codex_agents_summary,
    get_codex_ingest_status,
    get_codex_message_context,
    get_codex_message_position,
    get_codex_models,
    get_codex_projects,
    get_codex_projects_top,
    get_codex_session_detail_row,
    get_codex_session_messages_page,
    get_codex_session_replay,
    get_codex_timeline_summary,
    get_codex_usage_summary,
    init_db,
    list_codex_sessions,
    list_codex_sessions_table,
    purge_legacy_dashboard_data,
    read_db,
    search_codex_messages,
    wal_checkpoint,
    write_db,
)
from codex_parser import normalize_codex_record, process_record
from codex_watcher import CodexFileWatcher, WatcherMetrics

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s',
)
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / 'static'
BACKUP_DIR = Path(
    os.environ.get(
        'DASHBOARD_BACKUP_DIR',
        str(Path.home() / '.codex' / 'dashboard-backups'),
    )
)
CREDENTIALS_PATH = Path.home() / '.claude' / '.credentials.json'
_AUTH_PW = os.environ.get('DASHBOARD_PASSWORD')
_SESSION_SECRET = os.environ.get('DASHBOARD_SECRET', secrets.token_hex(32))
if 'DASHBOARD_SECRET' not in os.environ:
    logger.warning("DASHBOARD_SECRET not set — sessions will invalidate on restart")
_SESSION_COOKIE = 'dash_session'
_SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 days
_COOKIE_SECURE = os.environ.get('DASHBOARD_SECURE', '').lower() not in ('0', 'false', '')


def _sign_session() -> str:
    expires = int(time.time()) + _SESSION_MAX_AGE
    payload = f'dashboard:{expires}'
    sig = hmac.new(_SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f'{payload}.{sig}'.encode()).decode()


def _verify_session(token: str) -> bool:
    try:
        decoded = base64.urlsafe_b64decode(token.encode()).decode()
        payload, sig = decoded.rsplit('.', 1)
        expected = hmac.new(_SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return False
        _, expires_str = payload.split(':', 1)
        return int(expires_str) > int(time.time())
    except Exception:
        return False


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
watcher: Optional[CodexFileWatcher] = None


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
    """Build the metric bundle injected into CodexFileWatcher.

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
    global watcher, _sched_task
    init_db()
    if 'PYTEST_CURRENT_TEST' not in os.environ:
        purged = purge_legacy_dashboard_data()
        if any(purged.values()):
            logger.info("Purged legacy Claude dashboard data: %s", purged)
    if DB_PATH.exists() and not check_integrity():
        logger.error("DATABASE INTEGRITY CHECK FAILED — consider restoring from backup")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    watcher = CodexFileWatcher(manager.broadcast, metrics=_make_watcher_metrics())
    await watcher.start_async()
    _sched_task = asyncio.create_task(_retention_scheduler_loop())
    yield
    if _sched_task:
        _sched_task.cancel()
        try:
            await _sched_task
        except asyncio.CancelledError:
            pass
    watcher.stop()
    wal_checkpoint()
    close_thread_connections()


app = FastAPI(title="Codex Dashboard", lifespan=lifespan)

# CORS — restricted by default; set DASHBOARD_CORS_ORIGINS to allow specific origins.
# Example: DASHBOARD_CORS_ORIGINS=https://dash.example.com,http://localhost:3000
_cors_raw = os.environ.get('DASHBOARD_CORS_ORIGINS', '')
_cors_origins = [o.strip() for o in _cors_raw.split(',') if o.strip()] if _cors_raw else []
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Ingest-Key"],
    allow_credentials=True,
)

# ─── Middleware stack (order matters) ────────────────────────────────────
# Starlette wraps middleware in REVERSE declaration order, so the LAST
# registered middleware is the OUTERMOST at request time. To make metrics
# track EVERY request (including 401s from auth), register auth FIRST and
# metrics SECOND. At runtime the order is: metrics → auth → route.

_AUTH_BYPASS = {'/api/health', '/metrics', '/api/ingest', '/api/codex-collector.py',
                '/api/auth/login', '/api/auth/me', '/login', '/features'}
_AUTH_BYPASS_PREFIX = ('/static/',)

if _AUTH_PW:
    @app.middleware("http")
    async def _session_auth_middleware(request: Request, call_next):
        path = request.url.path
        if path in _AUTH_BYPASS or path.startswith(_AUTH_BYPASS_PREFIX):
            return await call_next(request)
        # Check session cookie
        token = request.cookies.get(_SESSION_COOKIE, '')
        if _verify_session(token):
            return await call_next(request)
        # Fallback: Basic Auth for API clients (curl, collector)
        auth = request.headers.get('Authorization', '')
        if auth.startswith('Basic '):
            try:
                decoded = base64.b64decode(auth[6:]).decode()
                _, pw = decoded.split(':', 1)
                if hmac.compare_digest(pw, _AUTH_PW):
                    return await call_next(request)
            except Exception:
                pass
        # Browser → redirect to login page; API → 401
        if 'text/html' in request.headers.get('accept', ''):
            return Response(status_code=302,
                            headers={'Location': '/login'})
        return JSONResponse({'error': 'unauthorized'}, 401)


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


@app.get("/login")
async def login_page():
    return FileResponse(
        STATIC_DIR / 'login.html',
        headers={'Cache-Control': 'no-store'},
    )


@app.get("/features")
async def features_page():
    return FileResponse(
        Path(__file__).parent / 'docs' / 'features.html',
        headers={'Cache-Control': 'no-store'},
    )


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
def api_health():
    with read_db() as db:
        n_msg = db.execute("SELECT COUNT(*) FROM codex_messages").fetchone()[0]
        n_sess = db.execute("SELECT COUNT(*) FROM codex_sessions").fetchone()[0]
    return {"ok": True, "messages": n_msg, "sessions": n_sess}


# ─── Auth: login / logout / me ────────────────────────────────────────────────

_LOGIN_ATTEMPTS: dict[str, list[float]] = {}  # ip → [timestamps]
_LOGIN_MAX_ATTEMPTS = 5
_LOGIN_WINDOW = 60  # seconds


def _check_rate_limit(ip: str) -> bool:
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    attempts = _LOGIN_ATTEMPTS.get(ip, [])
    attempts = [t for t in attempts if now - t < _LOGIN_WINDOW]
    _LOGIN_ATTEMPTS[ip] = attempts
    return len(attempts) < _LOGIN_MAX_ATTEMPTS


class LoginPayload(BaseModel):
    password: str = Field(..., min_length=1)


@app.post("/api/auth/login")
async def api_login(payload: LoginPayload, request: Request):
    if not _AUTH_PW:
        return {'ok': True, 'message': 'no password configured'}
    client_ip = request.client.host if request.client else '0.0.0.0'
    if not _check_rate_limit(client_ip):
        return JSONResponse(
            {'ok': False, 'error': 'too many attempts, try again later'},
            429)
    if not hmac.compare_digest(payload.password, _AUTH_PW):
        _LOGIN_ATTEMPTS.setdefault(client_ip, []).append(time.time())
        return JSONResponse({'ok': False, 'error': 'invalid password'}, 401)
    token = _sign_session()
    response = JSONResponse({'ok': True})
    response.set_cookie(
        _SESSION_COOKIE, token,
        max_age=_SESSION_MAX_AGE, httponly=True, samesite='lax',
        secure=_COOKIE_SECURE, path='/')
    return response


@app.post("/api/auth/logout")
async def api_logout():
    response = JSONResponse({'ok': True})
    response.delete_cookie(_SESSION_COOKIE, path='/')
    return response


@app.get("/api/auth/me")
async def api_auth_me(request: Request):
    if not _AUTH_PW:
        return {'authenticated': True, 'auth_required': False}
    token = request.cookies.get(_SESSION_COOKIE, '')
    return {'authenticated': _verify_session(token), 'auth_required': True}


# ─── WebSocket ────────────────────────────────────────────────────────────────

def _ws_auth_ok(ws: WebSocket) -> bool:
    """Validate session cookie on WebSocket upgrade if DASHBOARD_PASSWORD is set."""
    if not _AUTH_PW:
        return True
    # Session cookie
    token = ws.cookies.get(_SESSION_COOKIE, '')
    if _verify_session(token):
        return True
    # Fallback: Basic Auth header (backward compat for programmatic clients)
    auth = ws.headers.get('authorization', '')
    if auth.startswith('Basic '):
        try:
            decoded = base64.b64decode(auth[6:]).decode()
            _, pw = decoded.split(':', 1)
            if hmac.compare_digest(pw, _AUTH_PW):
                return True
        except Exception:
            pass
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
        codex_total_sessions = int(
            db.execute('SELECT COUNT(*) FROM codex_sessions').fetchone()[0] or 0
        )
        if codex_total_sessions > 0:
            row = db.execute('''
                SELECT COUNT(*) AS total_sessions,
                       0 AS input_tokens,
                       0 AS output_tokens,
                       0 AS cache_creation_tokens,
                       0 AS cache_read_tokens,
                       0.0 AS cost_usd,
                       COALESCE((SELECT COUNT(*) FROM codex_messages), 0) AS messages
                FROM codex_sessions
            ''').fetchone()
            today = db.execute('''
                SELECT 0 AS input_tokens,
                       0 AS output_tokens,
                       0 AS cache_creation_tokens,
                       0 AS cache_read_tokens,
                       0.0 AS cost_usd,
                       COALESCE((
                           SELECT COUNT(*)
                           FROM codex_messages m
                           JOIN codex_sessions s ON s.id = m.session_id
                           WHERE s.updated_at >= ?
                       ), 0) AS messages,
                       COUNT(*) AS sessions
                FROM codex_sessions
                WHERE updated_at >= ?
            ''', (today_utc, today_utc)).fetchone()
            model_rows = db.execute('''
                SELECT model,
                       COUNT(DISTINCT session_id) AS cnt,
                       0.0 AS cost,
                       0 AS input_tokens,
                       0 AS cache_read_tokens,
                       0 AS cache_creation_tokens
                FROM codex_messages
                WHERE role = 'assistant' AND model IS NOT NULL AND model != ''
                GROUP BY model ORDER BY cnt DESC, model ASC
            ''').fetchall()
            stop_reasons = db.execute('''
                SELECT '(unknown)' AS stop_reason,
                       COUNT(*) AS count,
                       0.0 AS cost
                FROM codex_sessions
            ''').fetchall()
        else:
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
            model_rows = db.execute('''
                SELECT model,
                       COUNT(DISTINCT session_id) AS cnt,
                       SUM(cost_micro)*1.0/1000000 AS cost,
                       SUM(input_tokens) AS input_tokens,
                       SUM(cache_read_tokens) AS cache_read_tokens,
                       SUM(cache_creation_tokens) AS cache_creation_tokens
                FROM messages
                WHERE role = 'assistant' AND model IS NOT NULL AND model != ''
                GROUP BY model ORDER BY cost DESC
            ''').fetchall()
            stop_reasons = db.execute('''
                SELECT COALESCE(NULLIF(final_stop_reason, ''), '(unknown)') AS stop_reason,
                       COUNT(*) AS count,
                       SUM(cost_micro)*1.0/1000000 AS cost
                FROM sessions
                GROUP BY stop_reason ORDER BY count DESC
            ''').fetchall()

        models = [{'model': m['model'], 'cnt': m['cnt'], 'cost': m['cost']}
                  for m in model_rows]
        model_cache = [{'model': m['model'],
                        'input_tokens': m['input_tokens'],
                        'cache_read_tokens': m['cache_read_tokens'],
                        'cache_creation_tokens': m['cache_creation_tokens']}
                       for m in model_rows]

    return {
        'all_time': dict(row) if row else {},
        'today': dict(today) if today else {},
        'models': models,
        'model_cache': model_cache,
        'stop_reasons': [dict(sr) for sr in stop_reasons],
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
    node: Optional[str] = Query(None, max_length=64),
):
    """List parent sessions. Subagents are excluded by default — use
    ``?include_subagents=true`` or the dedicated ``/api/subagents`` endpoint.
    ``?pinned_only=true`` narrows to starred sessions.
    ``?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`` filters by ``updated_at``.
    ``?cost_min=&cost_max=`` filters by session cost (USD).
    ``?node=server1`` filters by source node.
    """
    sort_col = _SESSIONS_SORT_MAP.get(sort, 'updated_at')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    with read_db() as db:
        codex_total = int(db.execute('SELECT COUNT(*) FROM codex_sessions').fetchone()[0] or 0)
        if codex_total > 0:
            codex_conds: list[str] = []
            codex_params: list = []
            codex_sort_map = {
                'updated_at': 's.updated_at',
                'created_at': 's.created_at',
                'cost_micro': 'total_cost_usd',
                'message_count': 's.message_count',
                'project_name': 'p.project_name',
                'model': 's.model',
                'total_input_tokens': 'total_input_tokens',
                'total_output_tokens': 'total_output_tokens',
                'total_cache_read_tokens': 'total_cache_read_tokens',
            }
            codex_order = codex_sort_map.get(sort_col, 's.updated_at')
            if node:
                codex_conds.append("COALESCE(NULLIF(s.source_node, ''), 'local') = ?")
                codex_params.append(node)
            if pinned_only:
                codex_conds.append("s.pinned = 1")
            if project:
                codex_conds.append("p.project_name = ?")
                codex_params.append(project)
            if model:
                codex_conds.append("s.model LIKE ? ESCAPE '\\'")
                codex_params.append(f"%{_esc_like(model)}%")
            if search:
                s = f"%{_esc_like(search)}%"
                codex_conds.append("(p.project_name LIKE ? ESCAPE '\\' OR COALESCE(s.cwd, '') LIKE ? ESCAPE '\\')")
                codex_params.extend([s, s])
            if date_from:
                if not re.match(r'^\d{4}-\d{2}-\d{2}', date_from):
                    return JSONResponse({'error': 'invalid date format', 'field': 'date_from'}, status_code=400)
                codex_conds.append("s.updated_at >= ?")
                codex_params.append(date_from)
            if date_to:
                if not re.match(r'^\d{4}-\d{2}-\d{2}', date_to):
                    return JSONResponse({'error': 'invalid date format', 'field': 'date_to'}, status_code=400)
                codex_conds.append("s.updated_at <= ?")
                codex_params.append(date_to + "T23:59:59Z" if len(date_to) == 10 else date_to)
            if cost_min is not None:
                codex_conds.append("0 >= ?")
                codex_params.append(cost_min)
            if cost_max is not None:
                codex_conds.append("0 <= ?")
                codex_params.append(cost_max)
            if tag:
                codex_conds.append(
                    "(',' || COALESCE(s.tags, '') || ',') LIKE ? ESCAPE '\\'"
                )
                codex_params.append(f"%,{_esc_like(tag)},%")
            codex_where = "WHERE " + " AND ".join(codex_conds) if codex_conds else ""
            total = db.execute(f'''
                SELECT COUNT(*)
                FROM codex_sessions s
                JOIN codex_projects p ON p.project_path = s.project_path
                {codex_where}
            ''', codex_params).fetchone()[0]
            offset = (page - 1) * per_page
            rows = db.execute(f'''
                SELECT s.id,
                       p.project_name,
                       s.project_path,
                       s.cwd,
                       s.model,
                       s.created_at,
                       s.updated_at,
                       0 AS total_input_tokens,
                       0 AS total_output_tokens,
                       0 AS total_cache_creation_tokens,
                       0 AS total_cache_read_tokens,
                       0.0 AS total_cost_usd,
                       s.message_count,
                       s.user_message_count,
                       s.pinned,
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
                       0.0 AS subagent_cost
                FROM codex_sessions s
                JOIN codex_projects p ON p.project_path = s.project_path
                {codex_where}
                ORDER BY s.pinned DESC, {codex_order} {order_sql}
                LIMIT ? OFFSET ?
            ''', codex_params + [per_page, offset]).fetchall()
            return {
                'sessions': [dict(r) for r in rows],
                'total': total, 'page': page, 'per_page': per_page,
                'pages': max(1, -(-total // per_page)),
                'sort': sort, 'order': order_sql.lower(),
            }

        conds: list[str] = []
        params: list = []
        if node:
            conds.append("source_node = ?")
            params.append(node)
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
            if not re.match(r'^\d{4}-\d{2}-\d{2}', date_from):
                return JSONResponse({'error': 'invalid date format', 'field': 'date_from'}, status_code=400)
            conds.append("updated_at >= ?")
            params.append(date_from)
        if date_to:
            if not re.match(r'^\d{4}-\d{2}-\d{2}', date_to):
                return JSONResponse({'error': 'invalid date format', 'field': 'date_to'}, status_code=400)
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
                   s.turn_duration_ms, s.source_node,
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
        codex_total = int(db.execute('SELECT COUNT(*) FROM codex_messages').fetchone()[0] or 0)
        if codex_total > 0:
            rows = [
                {
                    'id': row['message_id'],
                    'session_id': row['session_id'],
                    'role': row['role'],
                    'content_preview': row['content_preview'],
                    'timestamp': row['created_at'],
                    'cost_usd': 0.0,
                    'project_name': row['project_name'],
                    'project_path': row['project_path'],
                }
                for row in search_codex_messages(q, limit=limit)
            ]
            return {'results': rows, 'query': q, 'fts': bool(fts_query)}
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
                if rows:
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
        if not rows:
            rows = db.execute('''
                SELECT m.id,
                       m.session_id,
                       m.role,
                       m.content_preview,
                       m.timestamp,
                       0.0 AS cost_usd,
                       p.project_name,
                       p.project_path
                FROM codex_messages m
                JOIN codex_sessions s ON s.id = m.session_id
                JOIN codex_projects p ON p.project_path = s.project_path
                WHERE m.content_preview LIKE ? ESCAPE '\\'
                ORDER BY m.timestamp DESC
                LIMIT ?
            ''', (f'%{_esc_like(q)}%', limit)).fetchall()
    return {'results': [dict(r) for r in rows], 'query': q, 'fts': False}


@app.get("/api/search/messages")
def api_search_messages(
    q: str = Query(..., min_length=1, max_length=200),
    project: str = Query('', max_length=500),
    role: str = Query('', max_length=50),
    limit: int = Query(50, ge=1, le=200),
):
    items = [
        dict(row)
        for row in search_codex_messages(q, limit=limit, project=project, role=role)
    ]
    return {'items': items, 'query': q}


@app.get("/api/search/messages/{message_id}/context")
def api_search_message_context(message_id: int):
    context = get_codex_message_context(message_id)
    if context is None:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return context


@app.get("/api/sessions/{session_id}/message-position")
def api_message_position(session_id: str, message_id: int = Query(...)):
    """Return the 0-based row offset of a message within its session.

    Used by the frontend to load the right page of messages when jumping
    from a search result to a specific message.
    """
    with read_db() as db:
        row = db.execute(
            'SELECT is_subagent FROM sessions WHERE id = ?', (session_id,)
        ).fetchone()
        is_sub = bool(row and row['is_subagent'])
        side_filter = '' if is_sub else 'AND is_sidechain = 0'
        pos = db.execute(f'''
            SELECT COUNT(*) FROM messages
            WHERE session_id = ? {side_filter}
              AND (timestamp, id) < (
                SELECT timestamp, id FROM messages WHERE id = ?
              )
        ''', (session_id, message_id)).fetchone()[0]
        total = db.execute(
            f'SELECT COUNT(*) FROM messages WHERE session_id = ? {side_filter}',
            (session_id,),
        ).fetchone()[0]
        if total == 0:
            payload = get_codex_message_position(session_id, message_id)
            if payload is not None:
                return payload
    return {'position': pos, 'total': total, 'message_id': message_id}


@app.get("/api/sessions/{session_id}")
def api_session_detail(session_id: str):
    with read_db() as db:
        row = db.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone()
    if not row:
        codex_row = get_codex_session_detail_row(session_id)
        if codex_row is None:
            return JSONResponse({'error': 'Not found'}, status_code=404)
        return codex_row
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
        if total == 0:
            return get_codex_session_messages_page(session_id, limit=limit, offset=offset)
    return {'messages': [dict(r) for r in rows], 'total': total, 'limit': limit, 'offset': offset}


@app.get("/api/sessions/{session_id}/replay")
def api_session_replay(session_id: str):
    replay = get_codex_session_replay(session_id)
    if replay is None:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return replay


@app.get("/api/codex/sessions")
def api_codex_sessions(limit: int = Query(50, ge=1, le=200)):
    return list_codex_sessions(limit=limit)


@app.get("/api/timeline/summary")
def api_timeline_summary(
    limit: int = Query(200, ge=1, le=500),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
):
    if date_from and not re.match(r'^\d{4}-\d{2}-\d{2}', date_from):
        return JSONResponse({'error': 'invalid date format', 'field': 'date_from'}, status_code=400)
    if date_to and not re.match(r'^\d{4}-\d{2}-\d{2}', date_to):
        return JSONResponse({'error': 'invalid date format', 'field': 'date_to'}, status_code=400)
    return get_codex_timeline_summary(limit=limit, date_from=date_from, date_to=date_to)


@app.get("/api/usage/summary")
def api_usage_summary():
    return get_codex_usage_summary()


def _codex_stats_payload() -> dict:
    with read_db() as db:
        today_utc = _today_start_utc(db)
        row = db.execute(
            '''
            SELECT COUNT(DISTINCT session_id) AS total_sessions,
                   0 AS input_tokens,
                   0 AS output_tokens,
                   0 AS cache_creation_tokens,
                   0 AS cache_read_tokens,
                   0.0 AS cost_usd,
                   COUNT(*) AS messages
            FROM codex_messages
            '''
        ).fetchone()
        today = db.execute(
            '''
            SELECT
                0 AS input_tokens,
                0 AS output_tokens,
                0 AS cache_creation_tokens,
                0 AS cache_read_tokens,
                0.0 AS cost_usd,
                COUNT(*) AS messages,
                COUNT(DISTINCT session_id) AS sessions
            FROM codex_messages
            WHERE timestamp >= ?
            ''',
            (today_utc,),
        ).fetchone()
    models = get_codex_models(sort='messages', order='desc', page=1, per_page=50)['models']
    return {
        'all_time': dict(row) if row else {},
        'today': dict(today) if today else {},
        'models': models,
        'model_cache': [],
        'stop_reasons': [],
    }


def _codex_usage_periods_payload() -> dict:
    with read_db() as db:
        off = _user_tz(db)
        now = datetime.now(off)

        def _period(start: datetime, end: datetime) -> dict:
            start_utc = start.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            end_utc = end.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            row = db.execute(
                '''
                SELECT COUNT(*) AS msgs
                FROM codex_messages
                WHERE timestamp >= ? AND timestamp < ?
                ''',
                (start_utc, end_utc),
            ).fetchone()
            return {'cost': 0.0, 'input_tok': 0, 'output_tok': 0, 'cache_create': 0, 'cache_read': 0, 'msgs': int(row['msgs'] or 0)}

        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week_start = day_start - timedelta(days=day_start.weekday())
        month_start = day_start.replace(day=1)
        day_cur = _period(day_start, day_start + timedelta(days=1))
        day_prev = _period(day_start - timedelta(days=1), day_start)
        week_cur = _period(week_start, week_start + timedelta(days=7))
        week_prev = _period(week_start - timedelta(days=7), week_start)
        month_prev_end = month_start
        month_prev_start = (month_start - timedelta(days=1)).replace(day=1)
        month_cur = _period(month_start, now + timedelta(seconds=1))
        month_prev = _period(month_prev_start, month_prev_end)

    def _blk(cur, prev, label):
        p = prev['cost']
        c = cur['cost']
        delta = ((c - p) / p * 100) if p > 0 else (100 if c > 0 else 0)
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
        'day': _blk(day_cur, day_prev, '오늘'),
        'week': _blk(week_cur, week_prev, '이번 주'),
        'month': _blk(month_cur, month_prev, '이번 달'),
    }


def _codex_plan_usage_payload() -> dict:
    with read_db() as db:
        cfg = _plan_cfg(db)
        r_hour = cfg['reset_hour']
        r_wd = cfg['reset_weekday']
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
            return db.execute(
                '''
                SELECT COUNT(*) AS messages
                FROM codex_messages
                WHERE timestamp >= ?
                ''',
                (since,),
            ).fetchone()

        dr, wr = _q(ds_utc), _q(ws_utc)
        dl, wl = cfg['daily_cost_limit'], cfg['weekly_cost_limit']

        def _blk(row, lim, start, end):
            return {
                'used_cost': 0.0,
                'limit_cost': lim,
                'used_tokens': 0,
                'cache_tokens': 0,
                'messages': int(row['messages'] or 0),
                'percentage': 0,
                'remaining_seconds': int(max(0, (end - now).total_seconds())),
                'reset_at': end.isoformat(),
                'period_start': start.isoformat(),
            }

    return {
        'daily': _blk(dr, dl, ds, de),
        'weekly': _blk(wr, wl, ws, we),
        'config': {k: v for k, v in cfg.items() if k != 'id'},
        'plan': detect_plan(),
    }


def _has_codex_runtime_data(db) -> bool:
    return bool(int(db.execute('SELECT COUNT(*) FROM codex_sessions').fetchone()[0] or 0))


def _codex_forecast_payload(days: int = 14) -> dict:
    with read_db() as db:
        tz = _user_tz(db)
        now = datetime.now(tz)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        since_utc = month_start.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        mtd = db.execute(
            'SELECT COUNT(*) AS messages FROM codex_messages WHERE timestamp >= ?',
            (since_utc,),
        ).fetchone()
        days_elapsed = max((now.date() - month_start.date()).days + 1, 1)
        avg_msgs = (mtd['messages'] or 0) / days_elapsed
        next_month = (month_start.replace(day=28) + timedelta(days=4)).replace(day=1)
        days_left = max((next_month.date() - now.date()).days, 0)
    return {
        'projected_eom_cost': 0.0,
        'mtd_cost': 0.0,
        'days_left_in_month': days_left,
        'avg_cost_per_day': 0.0,
        'avg_msgs_per_day': round(avg_msgs, 1),
        'daily_budget_burnout_seconds': None,
        'weekly_budget_burnout_seconds': None,
        'daily_limit': 0,
        'daily_used': 0,
        'weekly_limit': 0,
        'weekly_used': 0,
        'window_days': days,
    }


@app.get("/api/codex/stats")
def api_codex_stats():
    return _codex_stats_payload()


@app.get("/api/codex/models")
def api_codex_models(
    sort: str = Query('messages'),
    order: str = Query('desc'),
    page: int = Query(1, ge=1),
    per_page: int = Query(500, ge=1, le=500),
):
    return get_codex_models(sort=sort, order=order, page=page, per_page=per_page)


@app.get("/api/codex/projects")
def api_codex_projects(
    sort: str = Query('last_active'),
    order: str = Query('desc'),
    page: int = Query(1, ge=1),
    per_page: int = Query(500, ge=1, le=500),
):
    return get_codex_projects(sort=sort, order=order, page=page, per_page=per_page)


@app.get("/api/codex/projects/top")
def api_codex_projects_top(
    limit: int = Query(5, ge=1, le=50),
    with_last_message: bool = Query(False),
    active_window_minutes: int = Query(30, ge=1, le=1440),
):
    return get_codex_projects_top(
        limit=limit,
        with_last_message=with_last_message,
        active_window_minutes=active_window_minutes,
    )


def _codex_project_sql(project_name: str, path: Optional[str]) -> tuple[str, list[str]]:
    if path:
        return 'p.project_path = ?', [path]
    return 'p.project_name = ?', [project_name]


def _codex_project_stats_payload(project_name: str, path: Optional[str]) -> Optional[dict]:
    where, params = _codex_project_sql(project_name, path)
    with read_db() as db:
        summary = db.execute(
            f'''
            SELECT
                COUNT(DISTINCT s.id) AS sessions,
                COALESCE(SUM(s.message_count), 0) AS messages,
                COALESCE(SUM(s.user_message_count), 0) AS user_messages,
                0.0 AS cost,
                0 AS input_tokens,
                0 AS output_tokens,
                0 AS cache_read_tokens,
                MIN(s.created_at) AS first_active,
                MAX(s.updated_at) AS last_active,
                MIN(p.project_path) AS canonical_path
            FROM codex_projects p
            JOIN codex_sessions s ON s.project_path = p.project_path
            WHERE {where}
            ''',
            params,
        ).fetchone()
        if not summary or summary['sessions'] == 0:
            return None
        models = db.execute(
            f'''
            SELECT
                COALESCE(NULLIF(m.model, ''), '(unknown)') AS model,
                COUNT(DISTINCT m.session_id) AS cnt,
                0.0 AS cost
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE {where} AND m.role = 'assistant'
            GROUP BY COALESCE(NULLIF(m.model, ''), '(unknown)')
            ORDER BY cnt DESC, model ASC
            ''',
            params,
        ).fetchall()
        daily = db.execute(
            f'''
            SELECT
                strftime('%Y-%m-%d', m.timestamp) AS date,
                0.0 AS cost,
                COUNT(*) AS messages
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE {where} AND m.role = 'assistant'
            GROUP BY date
            ORDER BY date DESC
            LIMIT 30
            ''',
            params,
        ).fetchall()
        sessions = db.execute(
            f'''
            SELECT
                s.id,
                s.model,
                s.created_at,
                s.updated_at,
                0.0 AS cost_usd,
                s.message_count,
                s.user_message_count,
                0 AS total_input_tokens,
                0 AS total_output_tokens,
                0 AS total_cache_read_tokens,
                s.pinned,
                '' AS tags
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE {where}
            ORDER BY s.updated_at DESC, s.id DESC
            ''',
            params,
        ).fetchall()
    return {
        'summary': dict(summary),
        'models': [dict(row) for row in models],
        'daily': [dict(row) for row in daily],
        'sessions': [dict(row) for row in sessions],
    }


def _codex_project_messages_payload(
    project_name: str,
    path: Optional[str],
    limit: int,
    offset: int,
    order_sql: str,
) -> dict:
    where, params = _codex_project_sql(project_name, path)
    with read_db() as db:
        total = db.execute(
            f'''
            SELECT COUNT(*)
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE {where}
            ''',
            params,
        ).fetchone()[0]
        rows = db.execute(
            f'''
            SELECT
                m.id,
                m.message_uuid,
                m.session_id,
                m.role,
                m.content_preview,
                m.content,
                0 AS input_tokens,
                0 AS output_tokens,
                0 AS cache_creation_tokens,
                0 AS cache_read_tokens,
                0.0 AS cost_usd,
                m.model,
                m.timestamp,
                '' AS git_branch
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE {where}
            ORDER BY m.timestamp {order_sql}, m.id {order_sql}
            LIMIT ? OFFSET ?
            ''',
            [*params, limit, offset],
        ).fetchall()
    return {
        'messages': [dict(row) for row in rows],
        'total': total,
        'limit': limit,
        'offset': offset,
        'order': order_sql.lower(),
    }


def _codex_project_delete_preview(project_name: str, path: Optional[str]) -> Optional[dict]:
    where, params = _codex_project_sql(project_name, path)
    with read_db() as db:
        row = db.execute(
            f'''
            SELECT
                COUNT(DISTINCT s.id) AS sessions,
                COUNT(m.id) AS messages,
                0.0 AS cost
            FROM codex_projects p
            JOIN codex_sessions s ON s.project_path = p.project_path
            LEFT JOIN codex_messages m ON m.session_id = s.id
            WHERE {where}
            ''',
            params,
        ).fetchone()
    if not row or row['sessions'] == 0:
        return None
    return {
        'preview': True,
        'project_name': project_name,
        'path': path,
        'sessions': row['sessions'],
        'messages': row['messages'],
        'cost': row['cost'],
    }


def _codex_project_delete(project_name: str, path: Optional[str]) -> dict:
    where, params = _codex_project_sql(project_name, path)
    with write_db() as db:
        preview = db.execute(
            f'''
            SELECT
                COUNT(DISTINCT s.id) AS sessions,
                COUNT(m.id) AS messages
            FROM codex_projects p
            JOIN codex_sessions s ON s.project_path = p.project_path
            LEFT JOIN codex_messages m ON m.session_id = s.id
            WHERE {where}
            ''',
            params,
        ).fetchone()
        paths = db.execute(
            f'''
            SELECT p.project_path
            FROM codex_projects p
            WHERE {where}
            ''',
            params,
        ).fetchall()
        if not paths:
            return {'deleted_sessions': 0, 'deleted_messages': 0}
        placeholders = ','.join(['?'] * len(paths))
        db.execute(
            f'DELETE FROM codex_projects WHERE project_path IN ({placeholders})',
            [row['project_path'] for row in paths],
        )
    close_thread_connections()
    return {
        'deleted_sessions': int(preview['sessions'] or 0),
        'deleted_messages': int(preview['messages'] or 0),
    }


_CODEX_SUBAGENTS_SORT_MAP = {
    'updated_at': 'updated_at',
    'created_at': 'created_at',
    'cost': 'cost_usd',
    'messages': 'message_count',
    'type': 'agent_type',
    'description': 'agent_description',
}


def _codex_agent_run_rows(
    *,
    parent_session_id: Optional[str] = None,
    agent_type: Optional[str] = None,
    search: Optional[str] = None,
) -> list[dict]:
    rows: list[dict] = []
    with read_db() as db:
        sql = '''
            SELECT
                m.id AS message_id,
                m.message_uuid,
                m.session_id,
                m.content,
                m.content_preview,
                m.timestamp,
                m.model,
                s.project_path,
                p.project_name
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE m.role = 'agent'
        '''
        params: list[object] = []
        if parent_session_id:
            sql += ' AND m.session_id = ?'
            params.append(parent_session_id)
        sql += ' ORDER BY m.timestamp DESC, m.id DESC'
        for row in db.execute(sql, params).fetchall():
            payload = {}
            try:
                payload = json.loads(row['content'] or '')
            except Exception:
                payload = {}
            name = payload.get('agent_name', '') or 'agent'
            status = payload.get('status', '') or 'unknown'
            desc = row['content_preview'] or f'{name} {status}'
            item = {
                'id': f"agent-run-{row['message_id']}",
                'parent_session_id': row['session_id'],
                'agent_type': name,
                'agent_description': desc,
                'model': row['model'] or '',
                'created_at': row['timestamp'],
                'updated_at': row['timestamp'],
                'cost_usd': 0.0,
                'message_count': 1,
                'total_input_tokens': 0,
                'total_output_tokens': 0,
                'total_cache_read_tokens': 0,
                'project_name': row['project_name'],
                'project_path': row['project_path'],
                'duration_seconds': 0.0,
                'final_stop_reason': status,
                'parent_tool_use_id': '',
                'task_prompt': '',
            }
            if agent_type and item['agent_type'] != agent_type:
                continue
            if search:
                hay = f"{item['agent_type']} {item['agent_description']}".lower()
                if search.lower() not in hay:
                    continue
            rows.append(item)
    return rows


def _codex_session_subagents_payload(session_id: str) -> dict:
    rows = _codex_agent_run_rows(parent_session_id=session_id)
    return {
        'parent_session_id': session_id,
        'subagents': rows,
        'total': len(rows),
    }


def _codex_subagents_list_payload(
    *,
    agent_type: Optional[str],
    parent: Optional[str],
    search: Optional[str],
    sort: str,
    order: str,
    page: int,
    per_page: int,
) -> dict:
    rows = _codex_agent_run_rows(parent_session_id=parent, agent_type=agent_type, search=search)
    sort_key = _CODEX_SUBAGENTS_SORT_MAP.get(sort, 'cost_usd')
    reverse = str(order).lower() != 'asc'
    rows = sorted(rows, key=lambda row: (row.get(sort_key), row['id']), reverse=reverse)
    offset = (page - 1) * per_page
    return {
        'subagents': rows[offset:offset + per_page],
        'total': len(rows),
        'page': page,
        'per_page': per_page,
        'pages': max(1, -(-len(rows) // per_page)),
        'sort': sort,
        'order': 'asc' if not reverse else 'desc',
    }


def _codex_subagents_stats_payload() -> dict:
    rows = _codex_agent_run_rows()
    by_type: dict[str, dict] = {}
    by_stop_reason: dict[str, dict] = {}
    by_type_and_stop_reason: dict[tuple[str, str], dict] = {}
    parents: dict[str, dict] = {}
    for row in rows:
        type_row = by_type.setdefault(row['agent_type'], {
            'agent_type': row['agent_type'],
            'count': 0,
            'cost': 0.0,
            'tokens': 0,
            'messages': 0,
            'avg_cost': 0.0,
            'avg_duration_seconds': 0.0,
            'max_duration_seconds': 0.0,
        })
        type_row['count'] += 1
        type_row['messages'] += row['message_count']

        stop_row = by_stop_reason.setdefault(row['final_stop_reason'], {
            'stop_reason': row['final_stop_reason'],
            'count': 0,
            'cost': 0.0,
        })
        stop_row['count'] += 1

        combo = by_type_and_stop_reason.setdefault((row['agent_type'], row['final_stop_reason']), {
            'agent_type': row['agent_type'],
            'stop_reason': row['final_stop_reason'],
            'count': 0,
            'cost': 0.0,
        })
        combo['count'] += 1

        parent_row = parents.setdefault(row['parent_session_id'], {
            'parent_session_id': row['parent_session_id'],
            'sub_count': 0,
            'total_cost': 0.0,
            'project': row['project_name'],
        })
        parent_row['sub_count'] += 1

    return {
        'totals': {
            'count': len(rows),
            'cost': 0.0,
            'tokens': 0,
            'messages': len(rows),
        },
        'by_type': list(by_type.values()),
        'top_by_cost': rows[:10],
        'top_by_duration': rows[:10],
        'parents_with_most_subs': sorted(parents.values(), key=lambda row: (-row['sub_count'], row['parent_session_id']))[:10],
        'by_stop_reason': list(by_stop_reason.values()),
        'by_type_and_stop_reason': list(by_type_and_stop_reason.values()),
    }


def _codex_subagents_heatmap_payload() -> dict:
    rows = _codex_agent_run_rows()
    projects: list[str] = []
    agent_types: list[str] = []
    seen_projects: set[str] = set()
    seen_types: set[str] = set()
    cells: dict[str, dict] = {}
    for row in rows:
        project_name = row['project_name']
        agent_type = row['agent_type']
        if project_name not in seen_projects:
            seen_projects.add(project_name)
            projects.append(project_name)
        if agent_type not in seen_types:
            seen_types.add(agent_type)
            agent_types.append(agent_type)
        key = f'{agent_type}|{project_name}'
        cell = cells.setdefault(key, {'count': 0, 'cost': 0.0, 'tokens': 0})
        cell['count'] += 1
    return {
        'projects': projects,
        'agent_types': agent_types,
        'cells': cells,
    }


def _codex_chain_payload(session_id: str, depth: int) -> dict:
    nodes: list[dict] = []
    with read_db() as db:
        root = db.execute(
            '''
            SELECT
                s.id,
                '' AS agent_type,
                COALESCE(NULLIF(s.session_name, ''), s.id) AS agent_description,
                0.0 AS cost_usd,
                s.message_count,
                NULL AS parent_session_id,
                s.project_path,
                0 AS is_subagent
            FROM codex_sessions s
            WHERE s.id = ?
            ''',
            (session_id,),
        ).fetchone()
        if not root:
            return {'root': session_id, 'nodes': [], 'count': 0}
        nodes.append({**dict(root), 'level': 0})
    if depth > 1:
        children = _codex_agent_run_rows(parent_session_id=session_id)
        for child in children[:max(0, depth - 1)]:
            nodes.append({
                'id': child['id'],
                'agent_type': child['agent_type'],
                'agent_description': child['agent_description'],
                'cost_usd': child['cost_usd'],
                'message_count': child['message_count'],
                'parent_session_id': child['parent_session_id'],
                'project_path': child['project_path'],
                'is_subagent': 1,
                'level': 1,
            })
    return {'root': session_id, 'nodes': nodes, 'count': len(nodes)}


def _codex_csv_rows() -> list[dict]:
    with read_db() as db:
        rows = db.execute(
            '''
            SELECT
                s.id AS session_id,
                p.project_name,
                s.project_path,
                COALESCE(s.cwd, s.project_path) AS cwd,
                COALESCE(NULLIF(s.model, ''), '(unknown)') AS model,
                s.created_at,
                s.updated_at,
                0 AS duration_seconds,
                0 AS total_input_tokens,
                0 AS total_output_tokens,
                0 AS total_cache_creation_tokens,
                0 AS total_cache_read_tokens,
                0.0 AS total_cost_usd,
                s.message_count,
                s.user_message_count,
                0 AS is_subagent,
                '' AS parent_session_id,
                '' AS parent_tool_use_id,
                '' AS agent_type,
                '' AS agent_description,
                '' AS final_stop_reason,
                s.pinned,
                '' AS tags
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            ORDER BY s.updated_at DESC, s.id DESC
            '''
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/codex/projects/{project_name}/stats")
def api_codex_project_stats(project_name: str, path: Optional[str] = Query(None)):
    payload = _codex_project_stats_payload(project_name, path)
    if payload is None:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return payload


@app.get("/api/codex/projects/{project_name}/messages")
def api_codex_project_messages(
    project_name: str,
    path: Optional[str] = Query(None),
    limit: int = Query(300, ge=1, le=5000),
    offset: int = Query(0, ge=0),
    order: str = Query('asc'),
):
    order_sql = 'DESC' if str(order).lower() == 'desc' else 'ASC'
    return _codex_project_messages_payload(project_name, path, limit, offset, order_sql)


@app.get("/api/codex/sessions/table")
def api_codex_sessions_table(
    page: int = Query(1, ge=1),
    per_page: int = Query(25, ge=1, le=100),
    search: Optional[str] = None,
    sort: str = Query('updated_at'),
    order: str = Query('desc'),
):
    return list_codex_sessions_table(
        page=page,
        per_page=per_page,
        search=search or '',
        sort=sort,
        order=order,
    )


@app.get("/api/codex/sessions/{session_id}")
def api_codex_session_detail(session_id: str):
    row = get_codex_session_detail_row(session_id)
    if not row:
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return row


@app.get("/api/codex/sessions/{session_id}/messages")
def api_codex_session_messages(
    session_id: str,
    limit: int = Query(500, ge=1, le=5000),
    offset: int = Query(0, ge=0),
):
    if not get_codex_session_detail_row(session_id):
        return JSONResponse({'error': 'Not found'}, status_code=404)
    return get_codex_session_messages_page(session_id, limit=limit, offset=offset)


@app.get("/api/codex/usage/periods")
def api_codex_usage_periods():
    return _codex_usage_periods_payload()


@app.get("/api/codex/usage/hourly")
def api_codex_usage_hourly(hours: int = Query(24, ge=1, le=168)):
    with read_db() as db:
        rows = db.execute(
            '''
            SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour,
                   0 AS input_tokens,
                   COUNT(*) AS output_tokens,
                   0 AS cache_creation_tokens,
                   0 AS cache_read_tokens,
                   0.0 AS cost_usd,
                   COUNT(*) AS message_count
            FROM codex_messages
            WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY hour
            ORDER BY hour
            ''',
            (f'-{hours} hours',),
        ).fetchall()
    return {'data': [dict(r) for r in rows]}


@app.get("/api/codex/usage/daily")
def api_codex_usage_daily(days: int = Query(30, ge=1, le=365)):
    with read_db() as db:
        rows = db.execute(
            '''
            SELECT strftime('%Y-%m-%d', timestamp) AS date,
                   0 AS input_tokens,
                   COUNT(*) AS output_tokens,
                   0 AS cache_creation_tokens,
                   0 AS cache_read_tokens,
                   0.0 AS cost_usd,
                   COUNT(*) AS message_count
            FROM codex_messages
            WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY date
            ORDER BY date
            ''',
            (f'-{days} days',),
        ).fetchall()
    return {'data': [dict(r) for r in rows]}


@app.get("/api/codex/forecast")
def api_codex_forecast(days: int = Query(14, ge=1, le=90)):
    return _codex_forecast_payload(days=days)


@app.get("/api/codex/plan/usage")
def api_codex_plan_usage():
    with read_db() as db:
        cfg = _plan_cfg(db)
        r_hour = cfg['reset_hour']
        r_wd = cfg['reset_weekday']
        tz = _user_tz(db)
        now = datetime.now(tz)

        ds = now.replace(hour=r_hour, minute=0, second=0, microsecond=0)
        if now < ds:
            ds -= timedelta(days=1)
        de = ds + timedelta(days=1)

        days_since = (now.weekday() - r_wd) % 7
        ws = (now - timedelta(days=days_since)).replace(hour=r_hour, minute=0, second=0, microsecond=0)
        if now < ws:
            ws -= timedelta(weeks=1)
        we = ws + timedelta(weeks=1)

        ds_utc = ds.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        ws_utc = ws.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

        def _q(since):
            return db.execute(
                '''
                SELECT COUNT(*) AS messages
                FROM codex_messages
                WHERE timestamp >= ?
                ''',
                (since,),
            ).fetchone()

        dr, wr = _q(ds_utc), _q(ws_utc)
        dl, wl = cfg['daily_cost_limit'], cfg['weekly_cost_limit']

        def _blk(row, lim, start, end):
            return {
                'used_cost': 0.0,
                'limit_cost': lim,
                'used_tokens': 0,
                'cache_tokens': 0,
                'messages': int(row['messages'] or 0),
                'percentage': 0,
                'remaining_seconds': int(max(0, (end - now).total_seconds())),
                'reset_at': end.isoformat(),
                'period_start': start.isoformat(),
            }

    return {
        'daily': _blk(dr, dl, ds, de),
        'weekly': _blk(wr, wl, ws, we),
        'config': {k: v for k, v in cfg.items() if k != 'id'},
        'plan': detect_plan(),
    }


@app.get("/api/agents/summary")
def api_agents_summary(limit: int = Query(20, ge=1, le=100)):
    return get_codex_agents_summary(limit=limit)


# ─── Usage time-series (timezone-aware) ───────────────────────────────────────

@app.get("/api/usage/hourly")
def api_usage_hourly(hours: int = Query(24, ge=1, le=168)):
    with read_db() as db:
        if _has_codex_runtime_data(db):
            rows = db.execute(
                '''
                SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour,
                       0 AS input_tokens,
                       COUNT(*) AS output_tokens,
                       0 AS cache_creation_tokens,
                       0 AS cache_read_tokens,
                       0.0 AS cost_usd,
                       COUNT(*) AS message_count
                FROM codex_messages
                WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
                GROUP BY hour
                ORDER BY hour
                ''',
                (f'-{hours} hours',),
            ).fetchall()
            return {'data': [dict(r) for r in rows]}
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
        if _has_codex_runtime_data(db):
            rows = db.execute(
                '''
                SELECT strftime('%Y-%m-%d', timestamp) AS date,
                       0 AS input_tokens,
                       COUNT(*) AS output_tokens,
                       0 AS cache_creation_tokens,
                       0 AS cache_read_tokens,
                       0.0 AS cost_usd,
                       COUNT(*) AS message_count
                FROM codex_messages
                WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
                GROUP BY date
                ORDER BY date
                ''',
                (f'-{days} days',),
            ).fetchall()
            return {'data': [dict(r) for r in rows]}
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
    page: int = Query(1, ge=1),
    per_page: int = Query(500, ge=1, le=500),
):
    with read_db() as db:
        if _has_codex_runtime_data(db):
            return get_codex_models(sort=sort, order=order, page=page, per_page=per_page)
    sort_col = _MODELS_SORT_MAP.get(sort, 'message_count')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    offset = (page - 1) * per_page
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
            LIMIT ? OFFSET ?
        ''', (per_page, offset)).fetchall()
    return {'models': [dict(r) for r in rows], 'sort': sort, 'order': order_sql.lower(),
            'page': page, 'per_page': per_page}


_PROJECTS_SORT_MAP = {
    'name':        'project_name',
    'sessions':    'session_count',
    'tokens':      'total_tokens',
    'cost':        'total_cost',
    'last_active': 'last_active',
}

# ─── Work timeline (Gantt) ────────────────────────────────────────────────────

@app.get("/api/timeline")
def api_timeline(
    date_from: str = Query(..., min_length=10, max_length=30),
    date_to: str = Query(..., min_length=10, max_length=30),
    include_subagents: bool = Query(False),
    limit: int = Query(2000, ge=1, le=5000),
    node: Optional[str] = Query(None, max_length=64),
):
    """Return sessions with start/end times for Gantt-style timeline rendering.

    Unlike ``/api/sessions``, this endpoint is unpaginated (up to *limit* rows)
    and returns only the columns needed for timeline visualisation.
    ``?node=server1`` filters by source node.
    """
    # Normalise date_to to end-of-day if only a date was supplied
    dt = date_to if len(date_to) > 10 else date_to + 'T23:59:59Z'
    sub_filter = '' if include_subagents else 'AND is_subagent = 0'
    if node and node != 'local':
        with read_db() as db:
            off = _tz_offset(db)
        return {
            'sessions': [],
            'total': 0,
            'truncated': False,
            'timezone_offset': off,
        }
    with read_db() as db:
        off = _tz_offset(db)
        rows = db.execute('''
            SELECT s.id,
                   p.project_name,
                   s.project_path,
                   s.created_at,
                   s.updated_at,
                   0.0 AS cost_usd,
                   s.model,
                   0 AS is_subagent,
                   NULL AS parent_session_id,
                   'local' AS source_node,
                   (julianday(COALESCE(NULLIF(s.updated_at,''), s.created_at)) - julianday(s.created_at)) * 86400.0 AS duration_seconds
            FROM codex_sessions s
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE s.created_at >= ? AND s.created_at <= ?
              AND s.created_at != '' AND s.updated_at != ''
            ORDER BY p.project_name, s.created_at
            LIMIT ?
        ''', (date_from, dt, limit)).fetchall()
        total = db.execute('''
            SELECT COUNT(*)
            FROM codex_sessions
            WHERE created_at >= ? AND created_at <= ?
              AND created_at != '' AND updated_at != ''
        ''', (date_from, dt)).fetchone()[0]
    return {
        'sessions': [dict(r) for r in rows],
        'total': total,
        'truncated': total > limit,
        'timezone_offset': off,
    }


@app.get("/api/timeline/hourly")
def api_timeline_hourly(
    date: str = Query(..., min_length=10, max_length=10),
    include_subagents: bool = Query(False),
):
    """Hourly breakdown for a single day: messages, cost, tokens per hour per project/session."""
    with read_db() as db:
        off = _tz_offset(db)
        off_sql = f'+{off} hours' if off >= 0 else f'{off} hours'
        rows = db.execute('''
            SELECT strftime('%H', m.timestamp, ?) AS hour,
                   p.project_name,
                   COUNT(*) AS message_count,
                   0.0 AS cost_usd,
                   0 AS input_tokens,
                   0 AS output_tokens,
                   COUNT(DISTINCT m.session_id) AS session_count
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE m.role = 'assistant'
              AND m.timestamp >= ? AND m.timestamp < ?
            GROUP BY hour, p.project_name
            ORDER BY hour, message_count DESC
        ''', (off_sql, date + 'T00:00:00Z', date + 'T24:00:00Z')).fetchall()
        detail_rows = db.execute('''
            SELECT strftime('%H', m.timestamp, ?) AS hour,
                   m.session_id,
                   p.project_name,
                   s.model,
                   0 AS is_subagent,
                   COUNT(*) AS message_count,
                   0.0 AS cost_usd,
                   0 AS input_tokens,
                   0 AS output_tokens
            FROM codex_messages m
            JOIN codex_sessions s ON s.id = m.session_id
            JOIN codex_projects p ON p.project_path = s.project_path
            WHERE m.role = 'assistant'
              AND m.timestamp >= ? AND m.timestamp < ?
            GROUP BY hour, m.session_id
            ORDER BY hour, message_count DESC
        ''', (off_sql, date + 'T00:00:00Z', date + 'T24:00:00Z')).fetchall()
    # Build hourly map
    hours: dict[str, dict] = {}
    for h in range(24):
        hk = f'{h:02d}'
        hours[hk] = {'hour': hk, 'projects': {}, 'sessions': [],
                      'message_count': 0, 'cost_usd': 0,
                      'input_tokens': 0, 'output_tokens': 0}
    for r in rows:
        hk = r['hour']
        slot = hours[hk]
        slot['projects'][r['project_name'] or '(unknown)'] = {
            'message_count': r['message_count'], 'cost_usd': round(r['cost_usd'] or 0, 6),
            'input_tokens': r['input_tokens'], 'output_tokens': r['output_tokens'],
            'session_count': r['session_count'],
        }
        slot['message_count'] += r['message_count']
        slot['cost_usd'] = round(slot['cost_usd'] + (r['cost_usd'] or 0), 6)
        slot['input_tokens'] += r['input_tokens'] or 0
        slot['output_tokens'] += r['output_tokens'] or 0
    for r in detail_rows:
        hours[r['hour']]['sessions'].append({
            'session_id': r['session_id'], 'project_name': r['project_name'] or '(unknown)',
            'model': r['model'], 'is_subagent': bool(r['is_subagent']),
            'message_count': r['message_count'], 'cost_usd': round(r['cost_usd'] or 0, 6),
            'input_tokens': r['input_tokens'], 'output_tokens': r['output_tokens'],
        })
    return {
        'date': date,
        'hours': list(hours.values()),
        'timezone_offset': off,
    }


@app.get("/api/timeline/heatmap")
def api_timeline_heatmap(days: int = Query(90, ge=7, le=365)):
    """Day-of-week × hour-of-day activity heatmap.

    Returns a 7×24 matrix of message counts and cost, aggregated from
    assistant messages over the last *days* days.
    """
    with read_db() as db:
        off = _tz_offset(db)
        off_sql = f'+{off} hours' if off >= 0 else f'{off} hours'
        rows = db.execute('''
            SELECT CAST(strftime('%w', m.timestamp, ?) AS INTEGER) AS dow,
                   CAST(strftime('%H', m.timestamp, ?) AS INTEGER) AS hour,
                   COUNT(*) AS count,
                   0.0 AS cost_usd
            FROM codex_messages m
            WHERE m.role = 'assistant'
              AND m.timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
            GROUP BY dow, hour
        ''', (off_sql, off_sql, f'-{days} days')).fetchall()
    cells = {}
    for r in rows:
        key = f"{r['dow']}_{r['hour']}"
        cells[key] = {
            'count': r['count'],
            'cost': round(r['cost_usd'] or 0, 4),
        }
    return {'cells': cells, 'days': days, 'timezone_offset': off}


# Group by the composite (path, name) so two projects with the same last-segment
# name but different paths are listed separately (C2 fix).
_PROJECT_GROUP_SQL = "COALESCE(NULLIF(project_path, ''), project_name), project_name"


@app.get("/api/projects")
def api_projects(
    sort: str = Query('last_active'),
    order: str = Query('desc'),
    page: int = Query(1, ge=1),
    per_page: int = Query(500, ge=1, le=500),
):
    """Project roll-up. ``session_count`` is PARENT sessions only;
    ``subagent_count`` is the spawned-subagent count. All cost/token totals
    include everything (parents + subagents)."""
    sort_col = _PROJECTS_SORT_MAP.get(sort, 'last_active')
    order_sql = 'ASC' if str(order).lower() == 'asc' else 'DESC'
    offset = (page - 1) * per_page
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
            LIMIT ? OFFSET ?
        ''', (per_page, offset)).fetchall()
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
    return {'projects': projects, 'sort': sort, 'order': order_sql.lower(),
            'page': page, 'per_page': per_page}


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
        if not rows:
            rows = db.execute('''
                SELECT p.project_name,
                       p.project_path,
                       COUNT(*) AS session_count,
                       0 AS subagent_count,
                       0.0 AS total_cost,
                       0 AS input_tokens,
                       0 AS output_tokens,
                       0 AS cache_read_tokens,
                       0 AS total_tokens,
                       MAX(s.updated_at) AS last_active
                FROM codex_sessions s
                JOIN codex_projects p ON p.project_path = s.project_path
                GROUP BY p.project_path, p.project_name
                ORDER BY last_active DESC
                LIMIT ?
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
            # Single query: fetch best preview per project using ROW_NUMBER.
            paths = [p['project_path'] for p in projects]
            ph = ','.join(['?'] * len(paths))
            preview_rows = db.execute(f'''
                WITH ranked AS (
                    SELECT m.content_preview, m.timestamp, m.model, m.session_id,
                           s.project_path,
                           ROW_NUMBER() OVER (
                               PARTITION BY s.project_path
                               ORDER BY
                                   CASE WHEN m.content_preview NOT LIKE '[Tool:%%'
                                        AND m.content_preview NOT LIKE '[Extended Thinking]%%'
                                        AND m.content_preview NOT LIKE '[생각중:%%'
                                        AND LENGTH(m.content_preview) >= 20
                                   THEN 0 ELSE 1 END,
                                   m.timestamp DESC, m.id DESC
                           ) AS rn
                    FROM messages m
                    JOIN sessions s ON m.session_id = s.id
                    WHERE s.project_path IN ({ph})
                      AND m.role = 'assistant'
                      AND m.content_preview IS NOT NULL
                      AND m.content_preview != ''
                )
                SELECT * FROM ranked WHERE rn = 1
            ''', paths).fetchall()
            if not preview_rows:
                preview_rows = db.execute(f'''
                    WITH ranked AS (
                        SELECT m.content_preview, m.timestamp, m.model, m.session_id,
                               p.project_path,
                               ROW_NUMBER() OVER (
                                   PARTITION BY p.project_path
                                   ORDER BY m.timestamp DESC, m.id DESC
                               ) AS rn
                        FROM codex_messages m
                        JOIN codex_sessions s ON s.id = m.session_id
                        JOIN codex_projects p ON p.project_path = s.project_path
                        WHERE p.project_path IN ({ph})
                          AND m.role = 'assistant'
                          AND m.content_preview IS NOT NULL
                          AND m.content_preview != ''
                    )
                    SELECT * FROM ranked WHERE rn = 1
                ''', paths).fetchall()
            preview_map = {r['project_path']: r for r in preview_rows}
            for p in projects:
                row = preview_map.get(p['project_path'])
                if row:
                    preview = row['content_preview'] or ''
                    for prefix in ('[Extended Thinking]', '[생각중:'):
                        if preview.startswith(prefix):
                            preview = preview[len(prefix):].lstrip(' ]:')
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
        if _has_codex_runtime_data(db):
            return _codex_forecast_payload(days)
        off = _tz_offset(db)
        off_sql = f'+{off} hours' if off >= 0 else f'{off} hours'
        rows = db.execute('''
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
        # Pre-fetch MTD + daily/weekly usage in the same connection
        _now = datetime.now(tz)
        _mtd_start = _now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        _mtd_utc = _mtd_start.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        _today_local = _now.replace(hour=0, minute=0, second=0, microsecond=0)
        _today_utc = _today_local.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        _days_since = (_now.weekday() - cfg.get('reset_weekday', 0)) % 7
        _ws = (_now - timedelta(days=_days_since)).replace(
            hour=cfg.get('reset_hour', 0), minute=0, second=0, microsecond=0)
        if _now < _ws:
            _ws -= timedelta(weeks=1)
        _ws_utc = _ws.astimezone(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        _mtd_row = db.execute(
            "SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS cost"
            " FROM messages WHERE role='assistant' AND timestamp >= ?",
            (_mtd_utc,)).fetchone()
        _d_used = db.execute(
            "SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS c"
            " FROM messages WHERE role='assistant' AND timestamp >= ?",
            (_today_utc,)).fetchone()
        _w_used = db.execute(
            "SELECT COALESCE(SUM(cost_micro),0)*1.0/1000000 AS c"
            " FROM messages WHERE role='assistant' AND timestamp >= ?",
            (_ws_utc,)).fetchone()

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

    # Month-to-date cost (pre-fetched above)
    mtd_cost = _mtd_row['cost'] if _mtd_row else 0

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

    # Day/week spend (pre-fetched above)
    d_used = _d_used
    w_used = _w_used

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
        if _has_codex_runtime_data(db):
            return _codex_usage_periods_payload()
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
        if _has_codex_runtime_data(db):
            return _codex_plan_usage_payload()
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
    tags = body.tags.strip()
    with write_db() as db:
        legacy_cur = db.execute(
            'UPDATE sessions SET tags = ? WHERE id = ?',
            (tags, session_id),
        )
        codex_cur = db.execute(
            'UPDATE codex_sessions SET tags = ? WHERE id = ?',
            (tags, session_id),
        )
    return {
        'ok': True,
        'updated': (legacy_cur.rowcount + codex_cur.rowcount) > 0,
        'tags': tags,
    }


@app.get("/api/tags")
def api_tags_list(
    page: int = Query(1, ge=1),
    per_page: int = Query(500, ge=1, le=500),
):
    """Return every distinct tag across all sessions with its session count."""
    counts: dict[str, int] = {}
    with read_db() as db:
        codex_total = int(db.execute('SELECT COUNT(*) FROM codex_sessions').fetchone()[0] or 0)
        if codex_total > 0:
            rows = db.execute(
                "SELECT tags FROM codex_sessions WHERE tags IS NOT NULL AND tags != ''"
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT tags FROM sessions WHERE tags IS NOT NULL AND tags != ''"
            ).fetchall()
    for r in rows:
        for t in (r['tags'] or '').split(','):
            t = t.strip()
            if not t:
                continue
            counts[t] = counts.get(t, 0) + 1
    all_tags = sorted(
        [{'tag': k, 'count': v} for k, v in counts.items()],
        key=lambda x: (-x['count'], x['tag'])
    )
    offset = (page - 1) * per_page
    return {
        'tags': all_tags[offset:offset + per_page],
        'total': len(all_tags),
        'page': page, 'per_page': per_page,
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
        if row and row['sessions'] > 0:
            return {'preview': True, 'project_name': project_name, 'path': path,
                    'sessions': row['sessions'], 'messages': row['messages'],
                    'cost': row['cost']}
        payload = _codex_project_delete_preview(project_name, path)
        if payload is not None:
            return payload
        return {'preview': True, 'project_name': project_name, 'path': path,
                'sessions': 0, 'messages': 0, 'cost': 0.0}
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
    if sess_del == 0 and msg_del == 0:
        codex_deleted = _codex_project_delete(project_name, path)
        sess_del = codex_deleted['deleted_sessions']
        msg_del = codex_deleted['deleted_messages']
    elif sess_del > 0 or msg_del > 0:
        close_thread_connections()
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
            payload = _codex_project_stats_payload(project_name, path)
            if payload is None:
                return JSONResponse({'error': 'Not found'}, status_code=404)
            return payload
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
    if not rows:
        return _codex_session_subagents_payload(session_id)
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
    if total == 0:
        return _codex_subagents_list_payload(
            agent_type=agent_type,
            parent=parent,
            search=search,
            sort=sort,
            order=order,
            page=page,
            per_page=per_page,
        )
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
    if not totals or totals['count'] == 0:
        return _codex_subagents_stats_payload()
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

    with read_db() as db:
        def _walk(sid: str, level: int):
            if level >= depth or sid in visited:
                return
            visited.add(sid)
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
            ctx = db.execute('''
                SELECT content FROM messages
                WHERE session_id = ? AND role = 'assistant'
                  AND content IS NOT NULL
                  AND (content LIKE '%"Agent"%' OR content LIKE '%"Task"%')
            ''', (sid,)).fetchall()
            child_descriptions: list[str] = []
            for c in ctx:
                try:
                    blocks = json.loads(c['content'] or '')
                except Exception:
                    continue
                if not isinstance(blocks, list):
                    continue
                for b in blocks:
                    if isinstance(b, dict) and b.get('type') == 'tool_use' \
                       and b.get('name') in ('Agent', 'Task'):
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
    if not nodes:
        return _codex_chain_payload(session_id, depth)
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
    if not rows:
        return _codex_subagents_heatmap_payload()
    projects: list[str] = []
    seen_p: set[str] = set()
    types: list[str] = []
    seen_t: set[str] = set()
    cells: dict[str, dict] = {}
    for r in rows:
        p = r['project_name']
        t = r['agent_type']
        if p not in seen_p:
            seen_p.add(p)
            projects.append(p)
        if t not in seen_t:
            seen_t.add(t)
            types.append(t)
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
    if total == 0:
        return _codex_project_messages_payload(project_name, path, limit, offset, order_sql)
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
    def _generate():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(_CSV_COLS)
        yield buf.getvalue()
        with read_db() as db:
            total = db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
            if total == 0:
                buf = io.StringIO()
                w = csv.writer(buf)
                for d in _codex_csv_rows():
                    w.writerow([d.get(c, '') if d.get(c) is not None else ''
                                for c in _CSV_COLS])
                yield buf.getvalue()
                return
            cursor = db.execute(f'''
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
            ''')
            while True:
                rows = cursor.fetchmany(500)
                if not rows:
                    break
                buf = io.StringIO()
                w = csv.writer(buf)
                for r in rows:
                    d = dict(r)
                    w.writerow([d.get(c, '') if d.get(c) is not None else ''
                                for c in _CSV_COLS])
                yield buf.getvalue()
    return StreamingResponse(
        _generate(), media_type='text/csv',
        headers={'Content-Disposition': 'attachment; filename="codex-usage.csv"'},
    )


# ─── Remote node ingestion ────────────────────────────────────────────────────

_COLLECTOR_PATH = Path(__file__).parent / 'codex_collector.py'


@app.get("/api/codex-collector.py")
def api_download_codex_collector():
    """Download the Codex collector agent script for remote servers."""
    if not _COLLECTOR_PATH.is_file():
        return JSONResponse({'error': 'codex_collector.py not found'}, 404)
    return FileResponse(
        _COLLECTOR_PATH,
        media_type='text/x-python',
        headers={'Content-Disposition': 'attachment; filename="codex_collector.py"'},
    )


def _hash_ingest_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _verify_ingest_key(node_id: str, provided_key: str) -> bool:
    """Check provided ingest key against stored hash."""
    with read_db() as db:
        row = db.execute(
            'SELECT ingest_key_hash FROM remote_nodes WHERE node_id = ?',
            (node_id,),
        ).fetchone()
    if not row:
        return False
    return hmac.compare_digest(
        row['ingest_key_hash'], _hash_ingest_key(provided_key))


class IngestPayload(BaseModel):
    node_id: str = Field(..., min_length=1, max_length=64)
    file_path: str = Field(..., min_length=1)
    records: list[dict] = Field(..., max_length=500)


def _ingest_codex_remote_record(record: dict, file_path: str, source_node: str) -> Optional[dict]:
    raw = dict(record)
    raw['_source_path'] = file_path
    normalized = normalize_codex_record(raw)
    project_path = normalized.project_path
    project_name = normalized.project_name
    if not project_path:
        path = Path(file_path)
        project_path = str(path.parent)
        project_name = path.parent.name
    if not (normalized.session_id and normalized.timestamp and project_path):
        return None

    if normalized.event_type == 'message':
        role = normalized.payload.get('message', {}).get('role') or normalized.payload.get('role') or 'assistant'
        content = normalized.payload.get('content', '')
    elif normalized.event_type == 'tool':
        role = 'tool'
        content = json.dumps(normalized.payload, ensure_ascii=False, sort_keys=True)
    elif normalized.event_type == 'agent':
        role = 'agent'
        content = json.dumps(normalized.payload, ensure_ascii=False, sort_keys=True)
    else:
        role = normalized.event_type or 'message'
        content = json.dumps(normalized.payload, ensure_ascii=False, sort_keys=True)

    preview = ''
    if role == 'message' or role == 'assistant' or role == 'user':
        preview = str(normalized.payload.get('content', '') or '')[:240]
    elif role == 'tool':
        preview = ' '.join(
            part for part in [
                str(normalized.payload.get('name', '') or ''),
                str(normalized.payload.get('input', '') or ''),
            ] if part
        )[:240]
    elif role == 'agent':
        preview = ' '.join(
            part for part in [
                str(normalized.payload.get('agent_name', '') or ''),
                str(normalized.payload.get('status', '') or ''),
            ] if part
        )[:240]
    if not preview:
        preview = normalized.searchable_text[:240]

    message_id = hashlib.sha1(
        '|'.join([
            normalized.session_id,
            file_path,
            str(raw.get('_line_number', '')),
            normalized.timestamp,
            role,
            preview,
        ]).encode('utf-8')
    ).hexdigest()

    from database import store_codex_message

    inserted_id = store_codex_message(
        project_path=project_path,
        project_name=project_name or Path(project_path).name or project_path,
        session_id=normalized.session_id,
        session_name=normalized.session_id,
        role=role,
        content=content,
        content_preview=preview,
        timestamp=normalized.timestamp,
        message_uuid=message_id,
        source_node=source_node,
    )
    if inserted_id <= 0:
        return None
    return {
        'type': 'new_message',
        'session_id': normalized.session_id,
        'project_name': project_name or Path(project_path).name or project_path,
        'project_path': project_path,
        'timestamp': normalized.timestamp,
        'role': role,
        'preview': preview[:300],
        'source_node': source_node,
    }


@app.post("/api/ingest")
async def api_ingest(payload: IngestPayload, request: Request):
    """Receive JSONL records from a remote collector agent."""
    ingest_key = request.headers.get('X-Ingest-Key', '')
    if not ingest_key or not _verify_ingest_key(payload.node_id, ingest_key):
        return JSONResponse({'error': 'invalid node_id or ingest key'}, 403)

    new_records: list[dict] = []
    for line_number, record in enumerate(payload.records):
        raw = dict(record)
        raw.setdefault('_line_number', line_number)
        result = _ingest_codex_remote_record(raw, payload.file_path, payload.node_id)
        if result:
            new_records.append(result)
    with write_db() as db:
        db.execute('''
            UPDATE remote_nodes
            SET last_seen = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                session_count = (SELECT COUNT(*) FROM codex_sessions
                                 WHERE source_node = ?),
                message_count = (SELECT COUNT(*) FROM codex_messages m
                                 JOIN codex_sessions s ON m.session_id = s.id
                                 WHERE s.source_node = ?)
            WHERE node_id = ?
        ''', (payload.node_id, payload.node_id, payload.node_id))

    if new_records:
        await manager.broadcast(
            {'type': 'batch_update', 'records': new_records})

    return {
        'accepted': len(new_records),
        'skipped': len(payload.records) - len(new_records),
    }


class NodeRegister(BaseModel):
    node_id: str = Field(..., min_length=1, max_length=64,
                         pattern=r'^[a-zA-Z0-9_\-]+$')
    label: Optional[str] = None


@app.get("/api/nodes")
def api_nodes():
    """List registered remote nodes + local pseudo-node."""
    with read_db() as db:
        rows = db.execute(
            'SELECT * FROM remote_nodes ORDER BY last_seen DESC'
        ).fetchall()
        local_stats = db.execute('''
            SELECT COUNT(*) AS session_count,
                   (SELECT COUNT(*) FROM codex_messages m
                    JOIN codex_sessions s ON m.session_id = s.id
                    WHERE s.source_node = 'local') AS message_count
            FROM codex_sessions WHERE source_node = 'local'
        ''').fetchone()
    nodes = [{'node_id': 'local', 'label': 'Local',
              'session_count': local_stats['session_count'],
              'message_count': local_stats['message_count'],
              'last_seen': None, 'created_at': None}]
    nodes.extend(dict(r) for r in rows)
    return {'nodes': nodes}


@app.post("/api/nodes")
def api_register_node(payload: NodeRegister, request: Request):
    """Register a new remote node. Returns a one-time ingest key."""
    raw_key = secrets.token_urlsafe(32)
    key_hash = _hash_ingest_key(raw_key)
    with write_db() as db:
        existing = db.execute(
            'SELECT node_id FROM remote_nodes WHERE node_id = ?',
            (payload.node_id,),
        ).fetchone()
        if existing:
            return JSONResponse(
                {'error': f'node "{payload.node_id}" already exists'}, 409)
        db.execute('''
            INSERT INTO remote_nodes (node_id, label, ingest_key_hash)
            VALUES (?, ?, ?)
        ''', (payload.node_id, payload.label or payload.node_id, key_hash))
    _audit('node_register', request, detail={'node_id': payload.node_id, 'label': payload.label})
    return {
        'node_id': payload.node_id,
        'ingest_key': raw_key,
        'message': 'Save this key — it cannot be retrieved again.',
    }


@app.delete("/api/nodes/{node_id}")
def api_delete_node(node_id: str, request: Request):
    """Unregister a remote node. Does NOT delete its ingested data."""
    with write_db() as db:
        deleted = db.execute(
            'DELETE FROM remote_nodes WHERE node_id = ?', (node_id,),
        ).rowcount
    if not deleted:
        return JSONResponse({'error': 'node not found'}, 404)
    _audit('node_delete', request, detail={'node_id': node_id})
    return {'deleted': node_id}


@app.post("/api/nodes/{node_id}/rotate-key")
def api_rotate_node_key(node_id: str, request: Request):
    """Rotate the ingest key for a node. Returns a new one-time key."""
    raw_key = secrets.token_urlsafe(32)
    key_hash = _hash_ingest_key(raw_key)
    with write_db() as db:
        updated = db.execute(
            'UPDATE remote_nodes SET ingest_key_hash = ? WHERE node_id = ?',
            (key_hash, node_id),
        ).rowcount
    if not updated:
        return JSONResponse({'error': 'node not found'}, 404)
    _audit('node_rotate_key', request, detail={'node_id': node_id})
    return {
        'node_id': node_id,
        'ingest_key': raw_key,
        'message': 'Save this key — it cannot be retrieved again.',
    }


# ─── Admin: audit log + backup + retention + scheduler + status ──────────────

def _client_ip(request: Optional[Request]) -> str:
    if not request or not request.client:
        return 'local'
    return request.client.host or 'local'


def _audit(action: str, request: Optional[Request], *, status: str = 'ok', detail: Optional[dict] = None) -> None:
    """Record an admin action. Never raises — audit failure must not block the action."""
    try:
        with write_db() as db:
            db.execute(
                'INSERT INTO admin_audit (action, actor_ip, status, detail) VALUES (?, ?, ?, ?)',
                (action, _client_ip(request), status,
                 json.dumps(detail, ensure_ascii=False, default=str) if detail else None),
            )
    except Exception:
        logger.exception("Audit log insert failed for action=%s", action)


def _db_storage_breakdown() -> dict:
    try:
        size = DB_PATH.stat().st_size
        wal_path = DB_PATH.with_suffix(DB_PATH.suffix + '-wal')
        wal_size = wal_path.stat().st_size if wal_path.exists() else 0
        with sqlite3.connect(str(DB_PATH)) as conn:
            page_size = int(conn.execute('PRAGMA page_size').fetchone()[0] or 0)
            page_count = int(conn.execute('PRAGMA page_count').fetchone()[0] or 0)
            freelist_count = int(conn.execute('PRAGMA freelist_count').fetchone()[0] or 0)
        free_bytes = page_size * freelist_count
        used_bytes = page_size * max(0, page_count - freelist_count)
        return {
            'size_bytes': size,
            'size_mb': round(size / 1048576, 1),
            'wal_size_bytes': wal_size,
            'used_bytes': used_bytes,
            'free_bytes': free_bytes,
            'page_size': page_size,
            'page_count': page_count,
            'freelist_count': freelist_count,
        }
    except OSError:
        return {
            'size_bytes': 0,
            'size_mb': 0,
            'wal_size_bytes': 0,
            'used_bytes': 0,
            'free_bytes': 0,
            'page_size': 0,
            'page_count': 0,
            'freelist_count': 0,
        }


def _run_retention(older_than_days: int) -> dict:
    """Core retention delete. Returns counts. Shared by HTTP route + scheduler."""
    cutoff = (datetime.now(_tz.utc) - timedelta(days=older_than_days)).strftime(
        '%Y-%m-%dT%H:%M:%SZ')
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
        codex_old = db.execute(
            'SELECT id FROM codex_sessions WHERE updated_at < ?', (cutoff,)
        ).fetchall()
        codex_sids = [r['id'] for r in codex_old]
        codex_msg_del = codex_sess_del = 0
        if codex_sids:
            ph = ','.join(['?'] * len(codex_sids))
            codex_msg_del = db.execute(
                f'SELECT COUNT(*) FROM codex_messages WHERE session_id IN ({ph})',
                codex_sids,
            ).fetchone()[0]
            codex_sess_del = db.execute(
                f'DELETE FROM codex_sessions WHERE id IN ({ph})',
                codex_sids,
            ).rowcount
    close_thread_connections()
    msg_del += int(codex_msg_del or 0)
    sess_del += int(codex_sess_del or 0)
    logger.info("Retention: deleted %d sessions, %d messages (cutoff=%s)",
                sess_del, msg_del, cutoff)
    return {'sessions': sess_del, 'messages': msg_del, 'cutoff': cutoff}


def _run_db_compaction() -> dict:
    before = _db_storage_breakdown()
    close_thread_connections()
    with _write_lock:
        conn = sqlite3.connect(str(DB_PATH))
        try:
            conn.execute('PRAGMA busy_timeout=5000')
            conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            conn.execute('PRAGMA incremental_vacuum')
            conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        finally:
            conn.close()
    close_thread_connections()
    after = _db_storage_breakdown()
    reclaimed = max(0, before['size_bytes'] - after['size_bytes'])
    return {
        'before': before,
        'after': after,
        'reclaimed_bytes': reclaimed,
    }


@app.post("/api/admin/backup")
def api_backup(request: Request):
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
        _audit('backup', request, detail={'path': str(dest), 'size_bytes': size})
        return {'ok': True, 'path': str(dest), 'size_bytes': size}
    except Exception as e:
        _audit('backup', request, status='error', detail={'error': str(e)[:200]})
        logger.exception("Backup failed")
        return JSONResponse({'error': 'backup failed', 'detail': 'check server logs'}, status_code=500)


@app.delete("/api/admin/retention")
def api_retention(
    request: Request,
    older_than_days: int = Query(90, ge=7, le=3650),
    confirm: bool = Query(False),
):
    """Delete sessions older than N days. Set confirm=true to execute."""
    cutoff = (datetime.now(_tz.utc) - timedelta(days=older_than_days)).strftime(
        '%Y-%m-%dT%H:%M:%SZ')

    if not confirm:
        # Preview only — show what WOULD be deleted
        with read_db() as db:
            legacy_cnt = db.execute(
                'SELECT COUNT(*) FROM sessions WHERE updated_at < ?', (cutoff,)
            ).fetchone()[0]
            codex_cnt = db.execute(
                'SELECT COUNT(*) FROM codex_sessions WHERE updated_at < ?', (cutoff,)
            ).fetchone()[0]
        return {'preview': True, 'sessions_to_delete': legacy_cnt + codex_cnt, 'cutoff': cutoff}

    result = _run_retention(older_than_days)
    _audit('retention', request, detail={
        'older_than_days': older_than_days,
        'sessions_deleted': result['sessions'],
        'messages_deleted': result['messages'],
    })
    return {'preview': False,
            'deleted_sessions': result['sessions'],
            'deleted_messages': result['messages'],
            'cutoff': result['cutoff']}


@app.post("/api/admin/db-compact")
def api_db_compact(request: Request):
    try:
        result = _run_db_compaction()
        _audit('db_compact', request, detail={
            'before_size_bytes': result['before']['size_bytes'],
            'after_size_bytes': result['after']['size_bytes'],
            'reclaimed_bytes': result['reclaimed_bytes'],
        })
        return result
    except Exception as e:
        _audit('db_compact', request, status='error', detail={'error': str(e)[:200]})
        logger.exception("DB compaction failed")
        return JSONResponse({'error': 'db compaction failed', 'detail': 'check server logs'}, status_code=500)


@app.get("/api/admin/db-size")
def api_db_size():
    payload = _db_storage_breakdown()
    if _PROMETHEUS_OK:
        METRIC_DB_SIZE.set(payload['size_bytes'])
    return payload


# ─── Audit log retrieval ─────────────────────────────────────────────────────

@app.get("/api/admin/audit")
def api_audit(
    limit: int = Query(100, ge=1, le=500),
    action: Optional[str] = Query(None, max_length=50),
):
    """Recent admin actions (descending by timestamp)."""
    where = ''
    params: list = []
    if action:
        where = 'WHERE action = ?'
        params.append(action)
    with read_db() as db:
        rows = db.execute(
            f'SELECT id, ts, action, actor_ip, status, detail FROM admin_audit {where} '
            f'ORDER BY id DESC LIMIT ?', (*params, limit)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get('detail'):
            try:
                d['detail'] = json.loads(d['detail'])
            except Exception:
                pass
        out.append(d)
    return {'entries': out, 'count': len(out)}


# ─── Retention scheduler (in-app asyncio) ────────────────────────────────────

_SCHED_KEY = 'retention_schedule'
_SCHED_DEFAULTS = {
    'enabled': False,
    'interval_hours': 24,
    'older_than_days': 90,
    'last_run_at': None,
    'last_result': None,
}


def _sched_load() -> dict:
    with read_db() as db:
        row = db.execute(
            'SELECT value FROM app_config WHERE key = ?', (_SCHED_KEY,)
        ).fetchone()
    if not row:
        return dict(_SCHED_DEFAULTS)
    try:
        v = json.loads(row['value'])
        # Merge defaults for forward compat
        return {**_SCHED_DEFAULTS, **v}
    except Exception:
        return dict(_SCHED_DEFAULTS)


def _sched_save(cfg: dict) -> None:
    with write_db() as db:
        db.execute(
            'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) '
            'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
            (_SCHED_KEY, json.dumps(cfg, ensure_ascii=False),
             datetime.now(_tz.utc).strftime('%Y-%m-%dT%H:%M:%SZ')),
        )


class RetentionScheduleUpdate(BaseModel):
    enabled: Optional[bool] = None
    interval_hours: Optional[int] = Field(None, ge=1, le=720)
    older_than_days: Optional[int] = Field(None, ge=7, le=3650)


@app.get("/api/admin/retention/schedule")
def api_sched_get():
    cfg = _sched_load()
    cfg['next_run_at'] = _sched_next_run(cfg)
    return cfg


@app.put("/api/admin/retention/schedule")
def api_sched_put(payload: RetentionScheduleUpdate, request: Request):
    cur = _sched_load()
    changed = {}
    for field in ('enabled', 'interval_hours', 'older_than_days'):
        v = getattr(payload, field)
        if v is not None and cur.get(field) != v:
            cur[field] = v
            changed[field] = v
    _sched_save(cur)
    if changed:
        _audit('retention_schedule_update', request, detail=changed)
    cur['next_run_at'] = _sched_next_run(cur)
    return cur


def _sched_next_run(cfg: dict) -> Optional[str]:
    if not cfg.get('enabled'):
        return None
    last = cfg.get('last_run_at')
    interval_h = int(cfg.get('interval_hours') or 24)
    now = datetime.now(_tz.utc)
    if last:
        try:
            t = datetime.fromisoformat(last.replace('Z', '+00:00'))
            nxt = t + timedelta(hours=interval_h)
            if nxt < now:
                nxt = now
            return nxt.strftime('%Y-%m-%dT%H:%M:%SZ')
        except Exception:
            pass
    return now.strftime('%Y-%m-%dT%H:%M:%SZ')


_sched_task: Optional[asyncio.Task] = None


async def _retention_scheduler_loop():
    """Background loop: checks every 60s whether retention should run."""
    logger.info("Retention scheduler started")
    try:
        while True:
            await asyncio.sleep(60)
            try:
                cfg = _sched_load()
                if not cfg.get('enabled'):
                    continue
                interval_h = int(cfg.get('interval_hours') or 24)
                now = datetime.now(_tz.utc)
                last = cfg.get('last_run_at')
                due = True
                if last:
                    try:
                        t = datetime.fromisoformat(last.replace('Z', '+00:00'))
                        due = (now - t) >= timedelta(hours=interval_h)
                    except Exception:
                        due = True
                if not due:
                    continue
                older = int(cfg.get('older_than_days') or 90)
                logger.info("Scheduler: running retention (older_than_days=%d)", older)
                # Run retention in a thread to avoid blocking event loop (SQLite writes)
                result = await asyncio.to_thread(_run_retention, older)
                cfg['last_run_at'] = now.strftime('%Y-%m-%dT%H:%M:%SZ')
                cfg['last_result'] = {
                    'sessions': result['sessions'],
                    'messages': result['messages'],
                }
                _sched_save(cfg)
                _audit('retention_scheduled', None, detail=cfg['last_result'])
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Retention scheduler iteration failed")
    except asyncio.CancelledError:
        logger.info("Retention scheduler cancelled")


# ─── Dashboard status (watcher + DB + WAL + schema + uptime) ─────────────────

_APP_START_TS = time.time()


@app.get("/api/admin/status")
def api_admin_status():
    # DB stats
    try:
        db_size = DB_PATH.stat().st_size
    except OSError:
        db_size = 0
    wal_path = DB_PATH.with_suffix(DB_PATH.suffix + '-wal')
    try:
        wal_size = wal_path.stat().st_size if wal_path.exists() else 0
    except OSError:
        wal_size = 0
    try:
        with sqlite3.connect(str(DB_PATH)) as conn:
            page_size = int(conn.execute('PRAGMA page_size').fetchone()[0] or 0)
            page_count = int(conn.execute('PRAGMA page_count').fetchone()[0] or 0)
            freelist_count = int(conn.execute('PRAGMA freelist_count').fetchone()[0] or 0)
        free_bytes = page_size * freelist_count
        used_bytes = page_size * max(0, page_count - freelist_count)
    except sqlite3.Error:
        page_size = page_count = freelist_count = 0
        free_bytes = used_bytes = 0

    with read_db() as db:
        schema_v = db.execute("PRAGMA user_version").fetchone()[0]
        codex_ingest = {
            'source_kind': 'codex',
            'indexed_sessions': int(db.execute('SELECT COUNT(*) FROM codex_sessions').fetchone()[0]),
            'indexed_messages': int(db.execute('SELECT COUNT(*) FROM codex_messages').fetchone()[0]),
        }
        counts = {
            'sessions': codex_ingest.get('indexed_sessions', 0),
            'messages': codex_ingest.get('indexed_messages', 0),
            'subagents': 0,
            'remote_nodes': db.execute('SELECT COUNT(*) c FROM remote_nodes').fetchone()['c'],
            'audit_entries': db.execute('SELECT COUNT(*) c FROM admin_audit').fetchone()['c'],
        }

    # Watcher
    w_running = bool(
        watcher
        and getattr(watcher, '_task', None) is not None
        and not watcher._task.done()
    )
    w_queue = 0
    if watcher and getattr(watcher, '_event_queue', None) is not None:
        try:
            w_queue = watcher._event_queue.qsize()
        except Exception:
            pass
    w_files_tracked = 0
    if watcher and hasattr(watcher, '_file_mtimes'):
        try:
            w_files_tracked = len(watcher._file_mtimes)
        except Exception:
            pass

    uptime_sec = int(time.time() - _APP_START_TS)
    return {
        **codex_ingest,
        'uptime_seconds': uptime_sec,
        'schema_version': schema_v,
        'db': {
            'path': str(DB_PATH),
            'size_bytes': db_size,
            'wal_size_bytes': wal_size,
            'used_bytes': used_bytes,
            'free_bytes': free_bytes,
            'page_size': page_size,
            'page_count': page_count,
            'freelist_count': freelist_count,
        },
        'counts': counts,
        'watcher': {
            'running': w_running,
            'queue_size': w_queue,
            'files_tracked': w_files_tracked,
        },
        'auth_enabled': bool(_AUTH_PW),
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
            codex_sessions = int(db.execute("SELECT COUNT(*) FROM codex_sessions").fetchone()[0] or 0)
            if codex_sessions > 0:
                sessions = codex_sessions
                messages = int(db.execute("SELECT COUNT(*) FROM codex_messages").fetchone()[0] or 0)
            else:
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
