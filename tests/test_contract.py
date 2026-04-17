"""API contract smoke tests — for every route, validate minimum shape.

The goal is to catch silent breakage from field renames / schema drift. We
don't assert exact values (that's test_api.py's job); we just walk the full
route set and require that expected keys exist in responses so the frontend
contract holds.

This test file is intentionally tolerant of 404s for not-yet-seeded fixture
IDs but strict about 5xx and malformed payloads.
"""
import sqlite3
import sys
from pathlib import Path

import pytest


COLLECTOR_DOWNLOAD_PATH = '/api/collector.py'
REMOVED_CLAUDE_API_PATHS = (
    '/api/claude-ai/stats',
    '/api/claude-ai/conversations',
    '/api/claude-ai/conversations/conv-1',
    '/api/claude-ai/conversations/conv-1/messages',
    '/api/claude-ai/search?q=sample',
)
REMOVED_RUNTIME_PATHS = REMOVED_CLAUDE_API_PATHS + (COLLECTOR_DOWNLOAD_PATH,)


def _reload_runtime_modules():
    try:
        from prometheus_client import REGISTRY
        for collector in list(REGISTRY._collector_to_names.keys()):
            try:
                REGISTRY.unregister(collector)
            except Exception:
                pass
    except Exception:
        pass

    for name in list(sys.modules):
        if name in ('database', 'parser', 'watcher', 'codex_parser', 'codex_watcher', 'main'):
            sys.modules.pop(name, None)


@pytest.fixture()
def contract_client(tmp_path, monkeypatch):
    db_file = tmp_path / 'contract.db'
    fake_projects = tmp_path / 'projects'
    fake_projects.mkdir()
    monkeypatch.delenv('DASHBOARD_PASSWORD', raising=False)
    try:
        from prometheus_client import REGISTRY
        for c in list(REGISTRY._collector_to_names.keys()):
            try:
                REGISTRY.unregister(c)
            except Exception:
                pass
    except Exception:
        pass
    for name in list(sys.modules):
        if name in ('database', 'parser', 'watcher', 'codex_parser', 'codex_watcher', 'main'):
            sys.modules.pop(name, None)
    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import codex_parser as app_parser
    monkeypatch.setattr(app_parser, 'CLAUDE_PROJECTS', fake_projects)
    import main  # noqa: F401

    database.init_db()
    conn = sqlite3.connect(str(db_file))
    # Minimal seeding: one parent, one subagent, a handful of messages, a tag.
    conn.executescript('''
        INSERT INTO sessions
          (id, project_name, project_path, cwd, model, created_at, updated_at,
           total_input_tokens, total_output_tokens, cost_micro, message_count,
           user_message_count, is_subagent, parent_session_id, agent_type,
           agent_description, final_stop_reason, tags)
        VALUES
          ('p1', 'demo', '/tmp/demo', '/tmp/demo', 'claude-opus-4-6',
           '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z',
           1000, 500, 60000, 2, 1, 0, NULL, '', '', 'end_turn', 'alpha,beta'),
          ('s1', 'demo', '/tmp/demo', '/tmp/demo', 'claude-haiku-4-5',
           '2026-04-01T01:00:00Z', '2026-04-01T02:00:00Z',
           100, 50, 4000, 1, 0, 1, 'p1', 'Explore', 'audit', 'end_turn', '');
        INSERT INTO messages
          (session_id, message_uuid, role, content, content_preview,
           input_tokens, output_tokens, cost_micro, model, timestamp, stop_reason)
        VALUES
          ('p1', 'mu1', 'user', '{"type":"text","text":"hi"}', 'hi',
            0, 0, 0, '', '2026-04-01T00:00:00Z', ''),
          ('p1', 'mu2', 'assistant', '{"type":"text","text":"hello"}', 'hello',
            500, 200, 30000, 'claude-opus-4-6', '2026-04-01T00:00:01Z', 'end_turn'),
          ('s1', 'mu3', 'assistant', '{"type":"text","text":"explore"}', 'explore',
            100, 50, 4000, 'claude-haiku-4-5', '2026-04-01T01:00:01Z', 'end_turn');
    ''')
    conn.commit()
    try:
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.close()

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        yield client


def _require(payload, path, keys):
    """Assert every key in `keys` is present in `payload`. Raises AssertionError
    with the route path in the message so the failure pin-points immediately."""
    missing = [k for k in keys if k not in payload]
    assert not missing, f"{path}: missing keys {missing}. got={list(payload.keys())[:12]}"


# ─── Startup contract ──────────────────────────────────────────────────────

def test_contract_start_script_defaults_to_codex_port():
    start_script = Path(__file__).resolve().parents[1] / 'start.sh'
    contents = start_script.read_text()

    assert 'PORT="${PORT:-8617}"' in contents
    assert 'PORT="${PORT:-8765}"' not in contents
    assert '--port "$PORT"' in contents


def test_contract_start_script_preserves_one_shot_env_overrides():
    start_script = Path(__file__).resolve().parents[1] / 'start.sh'
    contents = start_script.read_text()

    assert '_ORIG_PORT_SET="${PORT+x}"' in contents
    assert 'if [ -n "$_ORIG_PORT_SET" ]; then export PORT="$_ORIG_PORT"; fi' in contents
    assert '_ORIG_DASHBOARD_PASSWORD_SET="${DASHBOARD_PASSWORD+x}"' in contents
    assert 'if [ -n "$_ORIG_DASHBOARD_PASSWORD_SET" ]; then export DASHBOARD_PASSWORD="$_ORIG_DASHBOARD_PASSWORD"; fi' in contents


def test_contract_codex_service_unit_exists_with_codex_identity():
    service_file = Path(__file__).resolve().parents[1] / 'codex-web-dashboard.service'
    contents = service_file.read_text()

    assert 'Description=Codex Web Dashboard' in contents
    assert 'Environment=PORT=8617' in contents or '--port 8617' in contents
    assert 'SyslogIdentifier=codex-web-dashboard' in contents


def test_contract_claude_service_identity_stays_separate():
    service_file = Path(__file__).resolve().parents[1] / 'claude-dashboard.service'
    contents = service_file.read_text()

    assert 'Description=Claude Usage Dashboard' in contents
    assert 'SyslogIdentifier=claude-dashboard' in contents
    assert 'codex-web-dashboard' not in contents


def test_contract_docs_describe_split_services_in_korean():
    repo_root = Path(__file__).resolve().parents[1]
    readme = (repo_root / 'README.md').read_text()
    architecture = (repo_root / 'docs' / 'ARCHITECTURE.md').read_text()

    expected_phrases = [
        'Claude와 Codex는 별도 systemd 서비스로 운영',
        '별도 DB 루트',
        '별도 백업 루트',
    ]

    for phrase in expected_phrases:
        assert phrase in readme, f"README.md missing phrase: {phrase}"
        assert phrase in architecture, f"docs/ARCHITECTURE.md missing phrase: {phrase}"


def test_contract_subagent_surface_uses_codex_only_override():
    repo_root = Path(__file__).resolve().parents[1]
    index_html = (repo_root / 'static' / 'index.html').read_text()
    codex_override = (repo_root / 'static' / 'subagents-codex.js').read_text()

    assert '/static/subagents-codex.js' in index_html
    assert '/api/subagents/stats' not in codex_override
    assert '/api/subagents/heatmap' not in codex_override
    assert '/api/agents/summary' in codex_override


# ─── Health / metrics / stats ──────────────────────────────────────────────

def test_contract_runtime_path_env_overrides_still_win(tmp_path, monkeypatch):
    override_db = tmp_path / 'override.db'
    override_backup = tmp_path / 'override-backups'
    monkeypatch.setenv('DASHBOARD_DB_PATH', str(override_db))
    monkeypatch.setenv('DASHBOARD_BACKUP_DIR', str(override_backup))
    _reload_runtime_modules()

    import database
    import main

    assert database.DB_PATH == Path(str(override_db))
    assert main.BACKUP_DIR == Path(str(override_backup))


def test_contract_health(contract_client):
    r = contract_client.get('/api/health')
    assert r.status_code == 200
    _require(r.json(), '/api/health', ['ok', 'sessions', 'messages'])


def test_contract_metrics_prometheus_shape(contract_client):
    r = contract_client.get('/metrics')
    assert r.status_code == 200
    txt = r.text
    for name in [
        'http_requests_total',
        'http_request_duration_seconds',
        'dashboard_sessions_total',
        'dashboard_messages_total',
        'dashboard_db_size_bytes',
    ]:
        assert name in txt, f"metric {name} missing from /metrics"


def test_contract_stats_shape(contract_client):
    r = contract_client.get('/api/stats')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/stats', ['today', 'all_time', 'models'])
    _require(body['today'], '/api/stats.today',
             ['cost_usd', 'messages', 'sessions'])
    _require(body['all_time'], '/api/stats.all_time',
             ['cost_usd', 'total_sessions', 'messages'])


# ─── Usage / forecast ──────────────────────────────────────────────────────

def test_contract_usage_periods(contract_client):
    r = contract_client.get('/api/usage/periods')
    assert r.status_code == 200
    body = r.json()
    for k in ['day', 'week', 'month']:
        _require(body, '/api/usage/periods', [k])
        _require(body[k], f'/api/usage/periods.{k}',
                 ['cost', 'prev_cost', 'delta_pct', 'messages',
                  'input_tokens', 'output_tokens', 'cache_read_tokens'])


def test_contract_usage_hourly(contract_client):
    r = contract_client.get('/api/usage/hourly?hours=24')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/usage/hourly', ['data'])
    assert isinstance(body['data'], list)


def test_contract_usage_daily(contract_client):
    r = contract_client.get('/api/usage/daily?days=7')
    assert r.status_code == 200
    _require(r.json(), '/api/usage/daily', ['data'])


def test_contract_forecast(contract_client):
    r = contract_client.get('/api/forecast?days=7')
    assert r.status_code == 200
    _require(r.json(), '/api/forecast',
             ['projected_eom_cost', 'mtd_cost', 'days_left_in_month',
              'avg_cost_per_day', 'avg_msgs_per_day',
              'daily_limit', 'weekly_limit',
              'daily_used', 'weekly_used',
              'daily_budget_burnout_seconds', 'weekly_budget_burnout_seconds'])


# ─── Sessions + search ────────────────────────────────────────────────────

def test_contract_sessions_list(contract_client):
    r = contract_client.get('/api/sessions')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/sessions',
             ['sessions', 'total', 'page', 'per_page', 'pages'])
    if body['sessions']:
        s = body['sessions'][0]
        _require(s, '/api/sessions[0]',
                 ['id', 'project_name', 'project_path', 'model',
                  'created_at', 'updated_at', 'total_input_tokens',
                  'total_output_tokens', 'total_cost_usd', 'message_count',
                  'pinned', 'is_subagent', 'tags', 'subagent_count',
                  'subagent_cost', 'duration_seconds'])


def test_contract_sessions_search_fts(contract_client):
    r = contract_client.get('/api/sessions/search?q=hello')
    assert r.status_code == 200
    _require(r.json(), '/api/sessions/search', ['results', 'query'])


def test_contract_session_detail(contract_client):
    r = contract_client.get('/api/sessions/p1')
    assert r.status_code == 200
    _require(r.json(), '/api/sessions/{id}',
             ['id', 'project_name', 'cost_micro'])


def test_contract_session_messages(contract_client):
    r = contract_client.get('/api/sessions/p1/messages')
    assert r.status_code == 200
    _require(r.json(), '/api/sessions/{id}/messages',
             ['messages', 'total', 'limit', 'offset'])


def test_contract_session_subagents(contract_client):
    r = contract_client.get('/api/sessions/p1/subagents')
    assert r.status_code == 200
    body = r.json()
    assert 'subagents' in body


def test_contract_session_chain(contract_client):
    r = contract_client.get('/api/sessions/p1/chain?depth=3')
    assert r.status_code == 200
    body = r.json()
    assert 'nodes' in body or 'chain' in body  # either shape is fine


# ─── Subagents ────────────────────────────────────────────────────────────

def test_contract_subagents_list(contract_client):
    r = contract_client.get('/api/subagents')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/subagents', ['subagents', 'total'])


def test_contract_subagents_stats(contract_client):
    r = contract_client.get('/api/subagents/stats')
    assert r.status_code == 200
    body = r.json()
    # Expected sub-objects
    for k in ['by_type', 'by_stop_reason', 'top_by_cost', 'top_by_duration']:
        assert k in body, f"/api/subagents/stats missing {k}"


def test_contract_subagents_heatmap(contract_client):
    r = contract_client.get('/api/subagents/heatmap')
    assert r.status_code == 200
    body = r.json()
    assert 'rows' in body or 'data' in body or 'agent_types' in body


# ─── Projects ─────────────────────────────────────────────────────────────

def test_contract_projects_list_includes_tags(contract_client):
    r = contract_client.get('/api/projects')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/projects', ['projects'])
    if body['projects']:
        p = body['projects'][0]
        _require(p, '/api/projects[0]',
                 ['project_name', 'project_path', 'session_count',
                  'subagent_count', 'total_cost', 'total_tokens', 'last_active',
                  'tags'])


def test_contract_projects_top(contract_client):
    r = contract_client.get('/api/projects/top?limit=5')
    assert r.status_code == 200
    _require(r.json(), '/api/projects/top', ['projects'])


def test_contract_project_stats_session_has_tags(contract_client):
    r = contract_client.get('/api/projects/demo/stats')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/projects/{name}/stats',
             ['summary', 'models', 'daily', 'sessions'])
    if body['sessions']:
        assert 'tags' in body['sessions'][0], 'project session row missing tags'


# ─── Models / tags ────────────────────────────────────────────────────────

def test_contract_models(contract_client):
    r = contract_client.get('/api/models')
    assert r.status_code == 200
    _require(r.json(), '/api/models', ['models'])


def test_contract_tags(contract_client):
    r = contract_client.get('/api/tags')
    assert r.status_code == 200
    _require(r.json(), '/api/tags', ['tags'])


# ─── Plan / budget ────────────────────────────────────────────────────────

def test_contract_plan_detect(contract_client):
    r = contract_client.get('/api/plan/detect')
    assert r.status_code == 200
    _require(r.json(), '/api/plan/detect',
             ['tier', 'label', 'suggested_daily', 'suggested_weekly'])


def test_contract_plan_config(contract_client):
    r = contract_client.get('/api/plan/config')
    assert r.status_code == 200
    _require(r.json(), '/api/plan/config',
             ['daily_cost_limit', 'weekly_cost_limit'])


def test_contract_plan_usage(contract_client):
    r = contract_client.get('/api/plan/usage')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/plan/usage', ['daily', 'weekly'])
    _require(body['daily'], '/api/plan/usage.daily',
             ['percentage', 'used_cost', 'limit_cost', 'used_tokens',
              'messages', 'remaining_seconds', 'reset_at'])


# ─── legacy Claude routes removed ──────────────────────────────────────────

@pytest.mark.parametrize(
    'path',
    REMOVED_RUNTIME_PATHS,
)
def test_contract_legacy_claude_and_collector_routes_are_gone(contract_client, path):
    r = contract_client.get(path)
    assert r.status_code == 404


# ─── Admin (non-destructive) ──────────────────────────────────────────────

def test_contract_admin_db_size(contract_client):
    r = contract_client.get('/api/admin/db-size')
    assert r.status_code == 200
    body = r.json()
    _require(
        body,
        '/api/admin/db-size',
        [
            'size_bytes',
            'wal_size_bytes',
            'used_bytes',
            'free_bytes',
            'page_size',
            'page_count',
            'freelist_count',
        ],
    )
    assert body['size_bytes'] >= 0
    assert body['wal_size_bytes'] >= 0
    assert body['used_bytes'] >= 0
    assert body['free_bytes'] >= 0
    assert body['page_size'] > 0
    assert body['page_count'] >= 0
    assert body['freelist_count'] >= 0


def test_contract_admin_db_compact(contract_client):
    r = contract_client.post('/api/admin/db-compact')
    assert r.status_code == 200
    body = r.json()
    _require(body, '/api/admin/db-compact', ['before', 'after', 'reclaimed_bytes'])
    _require(body['before'], '/api/admin/db-compact.before', ['size_bytes', 'free_bytes', 'used_bytes'])
    _require(body['after'], '/api/admin/db-compact.after', ['size_bytes', 'free_bytes', 'used_bytes'])


def test_contract_admin_status_includes_codex_ingest_fields(contract_client):
    r = contract_client.get('/api/admin/status')
    assert r.status_code == 200
    body = r.json()
    _require(
        body,
        '/api/admin/status',
        ['source_kind', 'indexed_sessions', 'indexed_messages', 'counts', 'watcher'],
    )
    assert body['source_kind'] == 'codex'


def test_contract_admin_retention_preview(contract_client):
    # confirm=false → preview mode, safe to hit
    r = contract_client.delete('/api/admin/retention?older_than_days=365')
    assert r.status_code == 200
    _require(r.json(), '/api/admin/retention',
             ['preview', 'sessions_to_delete', 'cutoff'])


# ─── Auth-enabled smoke test ──────────────────────────────────────────────

_AUTH_PASSWORD = 'test-secret-42'


def test_contract_endpoints_accessible_with_auth(tmp_path, monkeypatch):
    """Verify key contract endpoints work with auth enabled via cookie session.

    This complements the no-auth contract_client tests above by proving:
    1. POST /api/auth/login sets a session cookie.
    2. Cookie-authenticated requests to /api/stats, /api/sessions → 200.
    3. /api/health bypasses auth (returns 200 without cookie).
    """
    db_file = tmp_path / 'authcontract.db'
    fake_projects = tmp_path / 'projects'
    fake_projects.mkdir()

    monkeypatch.setenv('DASHBOARD_PASSWORD', _AUTH_PASSWORD)
    monkeypatch.setenv('DASHBOARD_SECRET', 'fixed-test-secret-for-determinism')

    try:
        from prometheus_client import REGISTRY
        for c in list(REGISTRY._collector_to_names.keys()):
            try:
                REGISTRY.unregister(c)
            except Exception:
                pass
    except Exception:
        pass

    for name in list(sys.modules):
        if name in ('database', 'parser', 'watcher', 'codex_parser', 'codex_watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import codex_parser as app_parser
    monkeypatch.setattr(app_parser, 'CLAUDE_PROJECTS', fake_projects)
    import main
    monkeypatch.setattr(main, '_AUTH_PW', _AUTH_PASSWORD)
    database.init_db()

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        # Step 1 — login and obtain session cookie
        r = client.post('/api/auth/login', json={'password': _AUTH_PASSWORD})
        assert r.status_code == 200
        assert 'dash_session' in r.cookies

        # Step 2 — authenticated requests to protected endpoints
        for path in ['/api/stats', '/api/sessions']:
            r = client.get(path)
            assert r.status_code == 200, f"{path} returned {r.status_code} with auth cookie"

        # Step 3 — /api/health must work even with auth cookie
        r = client.get('/api/health')
        assert r.status_code == 200

    # Step 4 — /api/health bypasses auth entirely (no cookie)
    with TestClient(main.app) as fresh:
        r = fresh.get('/api/health')
        assert r.status_code == 200
