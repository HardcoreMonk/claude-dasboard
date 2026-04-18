"""Lightweight E2E smoke test.

This is NOT a full browser-driven E2E (that would require playwright, which
adds ~300MB of chromium binary). Instead it boots the full FastAPI app via
TestClient and validates that:

  1. The HTML shell contains all the IDs the JS modules depend on
  2. Every static module (app.vN.js, plan.vN.js, ...) is fetchable
  3. Every module references the expected global symbols
  4. The runtime API contract wired into the overview view (stats, periods,
     forecast, plan/usage, projects/top, ...) returns the shapes the JS
     rendering code expects — catching rename regressions between backend
     and frontend without running a browser

To upgrade to a true browser-driven E2E:
    pip install playwright
    playwright install chromium
Then replace this file with a Playwright sync_playwright() test that
navigates to the page and interacts with the DOM.
"""
import re
import sys
import sqlite3

import pytest


@pytest.fixture()
def e2e_client(tmp_path, monkeypatch):
    """Boot the app against a small but representative fixture DB."""
    db_file = tmp_path / 'e2e.db'
    fake_projects = tmp_path / 'projects'
    fake_projects.mkdir()
    monkeypatch.delenv('DASHBOARD_PASSWORD', raising=False)
    try:
        from prometheus_client import REGISTRY
        for c in list(REGISTRY._collector_to_names.keys()):
            try: REGISTRY.unregister(c)
            except Exception: pass
    except Exception:
        pass
    for name in list(sys.modules):
        if name in ('database', 'parser', 'watcher', 'main'):
            sys.modules.pop(name, None)
    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import parser as app_parser
    monkeypatch.setattr(app_parser, 'CLAUDE_PROJECTS', fake_projects)
    import main  # noqa: F401

    database.init_db()
    conn = sqlite3.connect(str(db_file))
    conn.executescript('''
        INSERT INTO sessions
          (id, project_name, project_path, cwd, model, created_at, updated_at,
           total_input_tokens, total_output_tokens, cost_micro, message_count,
           user_message_count, is_subagent, parent_session_id, agent_type,
           agent_description, final_stop_reason, tags)
        VALUES
          ('p1', 'demo', '/tmp/demo', '/tmp/demo', 'claude-opus-4-6',
           '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z',
           1000, 500, 60000, 2, 1, 0, NULL, '', '', 'end_turn', '');
        INSERT INTO messages
          (session_id, message_uuid, role, content, content_preview,
           input_tokens, output_tokens, cost_micro, model, timestamp, stop_reason)
        VALUES
          ('p1', 'm1', 'assistant', '{"type":"text","text":"hi"}', 'hi from demo',
            500, 200, 30000, 'claude-opus-4-6', '2026-04-01T00:00:01Z', 'end_turn');
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


# ─── HTML shell ───────────────────────────────────────────────────────

# Element IDs the overview / conversations / projects / sessions JS
# read or write. Renaming any of these without updating the JS would
# break the UI silently; this test catches that.
REQUIRED_IDS = [
    # Overview hero (Hero cards)
    'pdDayCost', 'pdDayDetail', 'pdDayDelta',
    'planDailyPct', 'planDailyBar', 'planDailyUsed', 'planDailyRemain',
    'forecastEOM', 'forecastEOMDetail', 'forecastAvg',
    # Secondary chips
    'pdWeekCost', 'pdWeekDelta', 'pdMonthCost', 'pdMonthDelta',
    'statAllCost', 'statAllSessions', 'statCacheEff', 'statCacheSaved',
    'forecastBurnoutDaily', 'forecastBurnoutWeekly',
    # Weekly budget
    'planWeeklyPct', 'planWeeklyBar', 'planWeeklyUsed', 'planWeeklyRemain', 'planWeeklyReset',
    # TOP 10
    'topProjectsList',
    # Sessions view
    'sessionsBody', 'sessionsThead', 'sessionsPagination', 'sessionSearch',
    # Conversations view
    'convListBody', 'convViewerHeader', 'convMessages', 'convSearch',
    # Modals
    'planModal', 'projectModal', 'commandPalette', 'kbdHelp',
    # WS + header
    'wsDot', 'wsLabel', 'hdrToday', 'hdrTotal',
    # Subagent view
    'subagentHeatmap', 'subagentSuccessMatrix',
    # Export view
    'backupResult',
]


def test_html_shell_has_all_required_ids(e2e_client):
    # / serves the public landing since 2026-04-18. SPA shell is at /app.
    r = e2e_client.get('/app')
    assert r.status_code == 200
    assert r.headers.get('cache-control', '').startswith('no-store')
    html = r.text
    missing = [i for i in REQUIRED_IDS if f'id="{i}"' not in html]
    assert not missing, (
        f"HTML shell missing {len(missing)} id(s) that JS modules depend on:\n  "
        + "\n  ".join(missing)
    )


def test_static_modules_load_with_correct_globals(e2e_client):
    """JS bundle (or individual modules) must be fetchable and contain
    expected symbols."""
    html = e2e_client.get('/app').text
    scripts = re.findall(r'src="(/static/[^"]+\.js)"', html)
    assert scripts, "no JS scripts found in HTML"

    # Must fetch 200 for every referenced script
    for path in scripts:
        r = e2e_client.get(path)
        assert r.status_code == 200, f'{path} returned {r.status_code}'

    # Check the bundle (or individual files) contains core symbols
    all_js = ''.join(e2e_client.get(p).text for p in scripts)
    for sym in ['applyTheme', 'connectWS', 'loadPlanUsage', 'loadStats',
                'loadSubagentHeatmap', 'themeColors', 'loadCharts']:
        assert sym in all_js, f'missing symbol: {sym}'


def test_overview_api_contract_matches_frontend_expectations(e2e_client):
    """Every API call the overview view makes on initial load must return
    the exact fields the JS rendering code reads. This is stricter than
    test_contract.py because it pins the *fields consumed by the frontend*,
    not just the fields emitted by the backend."""
    # loadStats reads: today.cost_usd, today.messages, today.sessions,
    # today.input_tokens, today.output_tokens, all_time.cost_usd, etc.
    r = e2e_client.get('/api/stats')
    body = r.json()
    assert 'today' in body and 'all_time' in body
    for k in ['cost_usd', 'messages', 'sessions', 'input_tokens', 'output_tokens']:
        assert k in body['today'], f'/api/stats.today.{k} missing'
    for k in ['cost_usd', 'total_sessions', 'messages', 'input_tokens',
              'output_tokens', 'cache_read_tokens']:
        assert k in body['all_time'], f'/api/stats.all_time.{k} missing'

    # loadPeriods reads: day/week/month each with cost, input_tokens,
    # output_tokens, messages, cache_read_tokens, prev_cost, delta_pct
    r = e2e_client.get('/api/usage/periods')
    body = r.json()
    for period in ['day', 'week', 'month']:
        for field in ['cost', 'input_tokens', 'output_tokens', 'messages',
                      'cache_read_tokens', 'prev_cost', 'delta_pct']:
            assert field in body[period], f'/api/usage/periods.{period}.{field} missing'

    # loadForecast reads: projected_eom_cost, mtd_cost, days_left_in_month,
    # avg_cost_per_day, avg_msgs_per_day, daily_limit, weekly_limit,
    # daily_used, weekly_used, daily_budget_burnout_seconds, weekly_budget_burnout_seconds
    r = e2e_client.get('/api/forecast?days=14')
    body = r.json()
    for field in ['projected_eom_cost', 'mtd_cost', 'days_left_in_month',
                  'avg_cost_per_day', 'avg_msgs_per_day',
                  'daily_limit', 'weekly_limit', 'daily_used', 'weekly_used',
                  'daily_budget_burnout_seconds', 'weekly_budget_burnout_seconds']:
        assert field in body, f'/api/forecast.{field} missing'

    # loadTopProjects reads: project_name, project_path, total_cost, total_tokens,
    # is_active (for LIVE badge), and (when with_last_message) last_message.preview
    r = e2e_client.get('/api/projects/top?limit=5&with_last_message=true')
    body = r.json()
    assert 'projects' in body
    if body['projects']:
        p = body['projects'][0]
        for field in ['project_name', 'project_path', 'total_cost', 'total_tokens',
                      'is_active', 'last_active']:
            assert field in p, f'/api/projects/top[0].{field} missing'
        # last_message is optional (None when no assistant messages) but key must exist
        assert 'last_message' in p


def test_sessions_view_first_page_renders(e2e_client):
    """Simulate what loadSessions() requests on sessions view entry."""
    r = e2e_client.get('/api/sessions?page=1&per_page=25&sort=updated_at&order=desc')
    assert r.status_code == 200
    body = r.json()
    assert 'sessions' in body and 'pages' in body and 'total' in body
    if body['sessions']:
        s = body['sessions'][0]
        # Fields that the sessions table row template reads
        for field in ['id', 'project_name', 'project_path', 'model',
                      'total_input_tokens', 'total_output_tokens', 'total_cost_usd',
                      'message_count', 'pinned', 'is_subagent', 'tags',
                      'subagent_count', 'duration_seconds']:
            assert field in s, f'/api/sessions[0].{field} missing'


def test_conversations_view_list_works(e2e_client):
    r = e2e_client.get('/api/sessions?per_page=50&sort=updated_at&order=desc')
    assert r.status_code == 200


def test_summarize_preview_unit(e2e_client):
    """Pure unit tests for main.summarize_preview()."""
    import main
    f = main.summarize_preview

    # Empty / null
    assert f('') == ''
    assert f(None) == ''

    # Plain text passes through
    assert f('hello world') == 'hello world'

    # Code fences stripped
    assert 'print' not in f('before\n```python\nprint(1)\n```\nafter')
    assert f('before\n```\nnoise\n```\nafter').startswith('before')

    # Markdown table flattened into · separated cells
    tbl = '## Results\n| col1 | col2 |\n|------|------|\n| a | b |\n| c | d |'
    out = f(tbl)
    assert 'col1' in out and 'col2' in out
    assert 'a · b' in out or 'a   · b' in out
    assert 'c · d' in out or 'c   · d' in out
    # Separator row (---|---) should be gone
    assert '---' not in out

    # Leading markdown markers stripped from every line
    assert f('## Title\n## Sub') == 'Title Sub'
    assert f('- item 1\n- item 2') == 'item 1 item 2'

    # max_len cap
    assert len(f('x' * 5000, max_len=100)) == 100


def test_top_projects_response_has_summary_line(e2e_client):
    r = e2e_client.get('/api/projects/top?limit=5&with_last_message=true')
    assert r.status_code == 200
    for p in r.json()['projects']:
        lm = p.get('last_message')
        if lm:
            # summary_line must exist and be non-empty for a real preview
            assert 'summary_line' in lm, 'top projects missing last_message.summary_line'


def test_metrics_contract_matches_alert_rules(e2e_client):
    """The alert rules in docs/alert-rules.yml reference specific metric
    names. If any is removed from /metrics output, the rules silently
    become dead. This test pins the names in code."""
    r = e2e_client.get('/metrics')
    txt = r.text
    for metric in [
        'http_requests_total',
        'http_request_duration_seconds',
        'dashboard_ws_connections',
        'dashboard_new_messages_total',
        'dashboard_file_retries_total',
        'dashboard_sessions_total',
        'dashboard_messages_total',
        'dashboard_db_size_bytes',
    ]:
        assert metric in txt, f"/metrics missing {metric} (referenced by alert-rules.yml)"
