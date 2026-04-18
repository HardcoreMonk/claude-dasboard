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
from pathlib import Path

import pytest


COLLECTOR_DOWNLOAD_PATH = '/api/collector.py'
REMOVED_CLAUDE_API_PATHS = (
    '/api/claude-ai/stats',
)
REMOVED_RUNTIME_PATHS = REMOVED_CLAUDE_API_PATHS + (COLLECTOR_DOWNLOAD_PATH,)


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
    import codex_parser as app_parser
    monkeypatch.setattr(app_parser, 'PROJECTS_ROOT', fake_projects)
    import main  # noqa: F401

    database.init_db()
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s1',
        session_name='Codex search session',
        role='user',
        content='Need to rework the search structure',
        content_preview='Need to rework the search structure',
        timestamp='2026-04-16T10:00:00Z',
        message_uuid='codex-msg-1',
    )
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s1',
        session_name='Codex search session',
        role='assistant',
        content='I will change the search UI first.',
        content_preview='I will change the search UI first.',
        timestamp='2026-04-16T10:00:01Z',
        message_uuid='codex-msg-2',
    )
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s1',
        session_name='Codex search session',
        role='tool',
        content='{"name":"rg","input":"search UI"}',
        content_preview='rg search UI',
        timestamp='2026-04-16T10:00:02Z',
        message_uuid='codex-tool-1',
    )

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        yield client


# ─── HTML shell ───────────────────────────────────────────────────────

# Element IDs the overview / conversations / projects / sessions JS
# read or write. Renaming any of these without updating the JS would
# break the UI silently; this test catches that.
REQUIRED_IDS = [
    # Shell groups
    'overviewKpiGrid', 'overviewAlertGrid', 'overviewFlowGrid', 'overviewEntryGrid',
    # Explore search surface
    'exploreTabs', 'exploreTabSummary', 'explore-search-surface', 'explore-legacy-workspace',
    'global-search-input', 'search-results-panel', 'search-context-panel',
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


def test_analysis_and_admin_tabs_are_shell_containers_only(e2e_client):
    html = e2e_client.get('/').text

    analysis_section = re.search(
        r'<section(?=[^>]*id="view-analysis")[^>]*>(.*?)</section>',
        html,
        re.S,
    )
    admin_section = re.search(
        r'<section(?=[^>]*id="view-admin")[^>]*>(.*?)</section>',
        html,
        re.S,
    )

    assert analysis_section, 'analysis shell section missing'
    assert admin_section, 'admin shell section missing'

    for section_html, shell_id in (
        (analysis_section.group(1), 'analysisTabs'),
        (admin_section.group(1), 'adminTabs'),
    ):
        assert f'id="{shell_id}"' in section_html
        assert '<button' not in section_html, f'{shell_id} should stay a shell container'


def test_html_shell_has_all_required_ids(e2e_client):
    r = e2e_client.get('/')
    assert r.status_code == 200
    assert r.headers.get('cache-control', '').startswith('no-store')
    html = r.text
    missing = [i for i in REQUIRED_IDS if f'id="{i}"' not in html]
    assert not missing, (
        f"HTML shell missing {len(missing)} id(s) that JS modules depend on:\n  "
        + "\n  ".join(missing)
    )


def test_explore_view_renders_search_surface(e2e_client):
    r = e2e_client.get('/')

    assert r.status_code == 200
    html = r.text
    explore_start = html.index('<section class="view hidden" id="view-explore"')
    overview_start = html.index('<!-- ─── OVERVIEW ─── -->')
    explore_html = html[explore_start:overview_start]

    assert 'id="global-search-input"' in explore_html
    assert 'id="search-results-panel"' in explore_html
    assert 'id="search-context-panel"' in explore_html
    assert 'data-action="openCommandPalette"' in html


def test_explore_keeps_global_command_palette_and_legacy_subviews(e2e_client):
    html = e2e_client.get('/').text
    explore_start = html.index('<section class="view hidden" id="view-explore"')
    overview_start = html.index('<!-- ─── OVERVIEW ─── -->')
    explore_html = html[explore_start:overview_start]
    all_js = Path('static/app.js').read_text()

    assert 'data-action="openCommandPalette"' in html
    assert 'id="exploreTabs"' in explore_html
    assert 'id="exploreTabSummary"' in explore_html
    assert 'id="explore-search-surface"' in explore_html
    assert 'id="global-search-input"' in explore_html
    assert 'data-explore-subview="search"' in explore_html
    assert 'data-explore-subview="sessions"' in explore_html
    assert 'data-explore-subview="conversations"' in explore_html
    assert 'id="view-sessions"' in html
    assert 'id="view-conversations"' in html

    assert re.search(
        r'function\s+loadExploreDashboard\(\)\s*\{\s*activateExploreSubview\(state\.activeSubview\s*\|\|\s*[\'"]search[\'"]\);\s*renderSearchView\(\);\s*\}',
        all_js,
        re.S,
    )
    assert re.search(
        r'if\s*\(view\s*===\s*[\'"]explore[\'"]\)\s*state\.activeSubview\s*=\s*[\'"]search[\'"];',
        all_js,
    )
    assert re.search(
        r'if\s*\(\(e\.metaKey\s*\|\|\s*e\.ctrlKey\)\s*&&\s*e\.key\.toLowerCase\(\)\s*===\s*[\'"]k[\'"]\)\s*\{\s*e\.preventDefault\(\);\s*openCommandPalette\(\);',
        all_js,
        re.S,
    )


def test_shell_removes_claude_conversation_and_admin_copy(e2e_client):
    html = e2e_client.get('/').text

    assert 'Codex 세션' in html
    assert 'Claude Code' not in html
    assert 'claude.ai' not in html
    assert '다른 서버의 Codex 세션 데이터를 수집합니다' in html
    assert '다른 서버의 Claude 세션 데이터를 수집합니다' not in html


def test_codex_branding_is_visible_in_shell_and_login(e2e_client):
    shell_html = e2e_client.get('/').text
    login_html = e2e_client.get('/login').text
    start_script = Path('start.sh').read_text()

    assert '<title>Codex Dashboard</title>' in shell_html
    assert 'content="Codex CLI 세션 검색과 복기를 위한 웹 대시보드"' in shell_html
    assert '<title>Login - Codex Dashboard</title>' in login_html
    assert '<h1>Codex Dashboard</h1>' in login_html
    assert 'Codex Usage Dashboard' in login_html
    assert 'Codex Usage Dashboard' in start_script
    assert 'Claude Usage Dashboard' not in start_script


@pytest.mark.parametrize(
    'path',
    REMOVED_RUNTIME_PATHS,
)
def test_legacy_claude_and_collector_routes_are_not_exposed(e2e_client, path):
    r = e2e_client.get(path)
    assert r.status_code == 404


def test_overview_is_default_shell_view(e2e_client):
    html = e2e_client.get('/').text

    nav_block = re.search(r'<nav[^>]*>(.*?)</nav>', html, re.S)
    overview_nav = re.search(
        r'<button(?=[^>]*class="([^"]*nav-pill[^"]*)")(?=[^>]*data-view="overview")[^>]*>',
        html,
    )
    overview_view = re.search(
        r'<section(?=[^>]*id="view-overview")(?=[^>]*class="([^"]*)")[^>]*>',
        html,
    )
    explore_view = re.search(
        r'<section(?=[^>]*id="view-explore")(?=[^>]*class="([^"]*)")[^>]*>',
        html,
    )
    analysis_view = re.search(
        r'<section(?=[^>]*id="view-analysis")(?=[^>]*class="([^"]*)")[^>]*>',
        html,
    )
    admin_view = re.search(
        r'<section(?=[^>]*id="view-admin")(?=[^>]*class="([^"]*)")[^>]*>',
        html,
    )

    assert nav_block, 'top navigation block missing'
    assert overview_nav, 'overview nav button missing'
    assert overview_view, 'overview view section missing'
    assert explore_view, 'explore view section missing'
    assert analysis_view, 'analysis view section missing'
    assert admin_view, 'admin view section missing'

    nav_buttons = re.findall(
        r'<button(?=[^>]*class="[^"]*nav-pill[^"]*")[^>]*data-view="([^"]+)"[^>]*>',
        nav_block.group(1),
    )
    assert nav_buttons == ['overview', 'explore', 'analysis', 'admin']

    assert 'active' in overview_nav.group(1).split()
    assert 'hidden' not in overview_view.group(1).split()
    assert 'hidden' in explore_view.group(1).split()
    assert 'hidden' in analysis_view.group(1).split()
    assert 'hidden' in admin_view.group(1).split()
    assert 'id="overviewKpiGrid"' in html
    assert 'id="overviewAlertGrid"' in html
    assert 'id="overviewFlowGrid"' in html
    assert 'id="overviewEntryGrid"' in html


def test_overview_shell_contains_ops_console_regions(e2e_client):
    html = e2e_client.get('/').text

    region_pairs = [
        ('overviewKpiGrid', 'overviewKpiTitle'),
        ('overviewAlertGrid', 'overviewAlertTitle'),
        ('overviewFlowGrid', 'overviewFlowTitle'),
        ('overviewEntryGrid', 'overviewEntryTitle'),
    ]
    for region_id, title_id in region_pairs:
        assert f'id="{region_id}"' in html
        assert f'aria-labelledby="{title_id}"' in html


def test_grouped_navigation_routing_is_backed_by_app_js():
    all_js = Path('static/app.js').read_text()

    default_view = re.search(
        r'function\s+defaultView\(\)\s*\{\s*return\s+[\'"]overview[\'"];\s*\}',
        all_js,
        re.S,
    )
    valid_views = re.search(
        r'const\s+VALID_VIEWS\s*=\s*new\s+Set\(\[\s*[\'"]overview[\'"]\s*,\s*[\'"]explore[\'"]\s*,\s*[\'"]analysis[\'"]\s*,\s*[\'"]admin[\'"]\s*\]\s*\);',
        all_js,
        re.S,
    )
    grouped_handlers = re.search(
        r'function\s+onViewChange\(view\)\s*\{.*?view\s*===\s*[\'"]overview[\'"].*?loadOverviewDashboard\(\).*?view\s*===\s*[\'"]explore[\'"].*?loadExploreDashboard\(\).*?view\s*===\s*[\'"]analysis[\'"].*?loadAnalysisDashboard\(\).*?view\s*===\s*[\'"]admin[\'"].*?loadAdminDashboard\(\).*?\}',
        all_js,
        re.S,
    )
    legacy_persistence = re.search(
        r'function\s+openLegacySubview\(view\)\s*\{.*?history\.replaceState\(null,\s*[\'"]\s*[\'"],\s*`\#/\$\{group\}/\$\{view\}`\);.*?\}',
        all_js,
        re.S,
    )

    assert default_view
    assert valid_views
    assert grouped_handlers
    assert legacy_persistence


def test_search_is_available_as_global_tool_and_explore_workspace(e2e_client):
    html = e2e_client.get('/').text
    all_js = Path('static/app.js').read_text()

    assert 'data-action="openCommandPalette"' in html
    assert 'id="view-explore"' in html
    assert 'id="exploreTabs"' in html
    assert 'id="explore-search-surface"' in html
    assert 'id="explore-legacy-workspace"' in html
    assert 'id="global-search-input"' in html
    assert 'data-action="showExploreSubview"' in html

    assert re.search(
        r'function\s+loadExploreDashboard\(\)\s*\{\s*renderExploreShell\(state\.activeSubview\s*\|\|\s*[\'"]search[\'"]\);\s*\}',
        all_js,
        re.S,
    )
    assert re.search(
        r'function\s+renderExploreShell\(subView\s*=\s*[\'"]search[\'"]\)\s*\{.*?renderSearchView\(\);.*?loadSessions\(\);.*?loadConvList\(\);',
        all_js,
        re.S,
    )


def test_search_flow_round_trip_matches_frontend_contract(e2e_client):
    all_js = Path('static/app.js').read_text()
    hit = e2e_client.get('/api/search/messages?q=search&role=assistant')
    assert hit.status_code == 200
    search_body = hit.json()
    assert search_body['items'], 'fixture search should return at least one hit'

    first = search_body['items'][0]
    context = e2e_client.get(f"/api/search/messages/{first['message_id']}/context")
    assert context.status_code == 200
    context_body = context.json()

    assert context_body['current']['message_id'] == first['message_id']
    assert context_body['current']['body_text'] == first['body_text']
    assert context_body['session_id'] == first['session_id']
    assert [row['body_text'] for row in context_body['before']] == [
        'Need to rework the search structure',
    ]
    assert [row['body_text'] for row in context_body['after']] == [
        'rg search UI',
    ]

    default_view = re.search(
        r'function\s+defaultView\(\)\s*\{\s*return\s+[\'"]overview[\'"];\s*\}',
        all_js,
        re.S,
    )
    parse_hash_fallback = re.search(
        r'return\s*\{\s*view:\s*view\s*\|\|\s*defaultView\(\),\s*rest\s*\};',
        all_js,
    )
    perform_search = re.search(
        r'async function performSearch\(query\)\s*\{.*?safeFetch\(`/api/search/messages\?\$\{params\.toString\(\)\}`\).*?state\.search\.selectedMessageId = state\.search\.results\[0\]\?\.message_id \?\? null;.*?(await selectSearchMessage\(state\.search\.selectedMessageId\);|renderSearchContext\(\);).*?\}',
        all_js,
        re.S,
    )
    search_enter_binding = re.search(
        r'input\.addEventListener\(\'keydown\',\s*\(e\)\s*=>\s*\{.*?e\.key !== \'Enter\'.*?performSearch\(e\.target\.value\);.*?\}\);',
        all_js,
        re.S,
    )
    select_context = re.search(
        r'async function selectSearchMessage\(messageId\)\s*\{.*?safeFetch\(`/api/search/messages/\$\{encodeURIComponent\(nextId\)\}/context`\).*?state\.search\.context = context;.*?renderSearchContext\(\);.*?\}',
        all_js,
        re.S,
    )

    assert default_view, 'default overview view function missing'
    assert parse_hash_fallback, 'hash routing does not default to overview'
    assert perform_search, 'search UI no longer wires query -> results -> first-hit selection'
    assert search_enter_binding, 'search input no longer triggers performSearch on Enter'
    assert select_context, 'search UI no longer wires selected hit -> context fetch/render'
    assert 'queryRequestSeq' in all_js
    assert 'contextRequestSeq' in all_js


def test_static_modules_load_with_correct_globals(e2e_client):
    """JS bundle (or individual modules) must be fetchable and contain
    expected symbols."""
    html = e2e_client.get('/').text
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


def test_secondary_frontend_modules_reference_codex_summary_endpoints():
    timeline_js = Path('static/timeline.js').read_text()
    overview_js = Path('static/overview.js').read_text()
    plan_js = Path('static/plan.js').read_text()
    subagents_js = Path('static/subagents.js').read_text()
    sessions_js = Path('static/sessions.js').read_text()

    assert '/api/timeline/summary' in timeline_js
    assert 'renderCodexTimelineMode' in timeline_js
    assert 'codexTimelineMode' in timeline_js
    assert '/api/usage/summary' in overview_js
    assert 'codexUsagePanel' in overview_js
    assert '/api/usage/summary' in plan_js
    assert 'codexPlanPanel' in plan_js
    assert '/api/agents/summary' in subagents_js
    assert 'subagentSurfaceMode' in subagents_js
    assert 'renderCodexAgentSurface' in subagents_js
    assert '/api/codex/sessions' in sessions_js
    assert 'codexSessionsPanel' in sessions_js
    assert '/api/sessions/' in sessions_js and '/replay' in sessions_js


def test_timeline_and_subagent_modules_keep_codex_paths_self_consistent():
    timeline_js = Path('static/timeline.js').read_text()
    subagents_js = Path('static/subagents.js').read_text()

    assert '/api/timeline/summary?limit=40&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}' in timeline_js
    assert 'renderCodexTimelineMode(summary);' in timeline_js
    assert '_renderCodexTimelineSecondary(summary, dateFrom, dateTo);' in timeline_js
    assert '_clearCodexTimelineSecondary();' in timeline_js
    assert "const codexAgents = await safeFetch('/api/agents/summary');" in subagents_js
    assert "const d = await safeFetch('/api/subagents/stats');" in subagents_js
    assert "Promise.all([\n      safeFetch('/api/subagents/stats'),\n      safeFetch('/api/agents/summary'),\n    ])" not in subagents_js


def test_timeline_codex_mode_keeps_secondary_panels_alive():
    timeline_js = Path('static/timeline.js').read_text()

    start = timeline_js.index("if (resolvedMode === 'codex' && hasCodexData) {")
    end = timeline_js.index("return;", start)
    codex_branch = timeline_js[start:end]

    assert '_loadTimelineSecondaryPanels();' in codex_branch

    helper_start = timeline_js.index('function _loadTimelineSecondaryPanels() {')
    helper_end = timeline_js.index('}', helper_start)
    helper_body = timeline_js[helper_start:helper_end]

    for loader in [
        '_loadHeatmap();',
        '_loadTrend();',
        '_loadHourlyStacked();',
        '_loadDelta();',
        '_loadDailyReport(_reportBaseDate());',
    ]:
        assert loader in helper_body, f'secondary timeline helper must keep {loader} active'


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


def test_overview_primary_routes_return_nonempty_codex_data_without_legacy_seed(e2e_client):
    import database

    with database.write_db() as db:
        db.execute('DELETE FROM messages')
        db.execute('DELETE FROM sessions')
        try:
            db.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        except Exception:
            pass

    stats = e2e_client.get('/api/stats')
    assert stats.status_code == 200
    assert stats.json()['all_time']['total_sessions'] >= 1

    sessions = e2e_client.get('/api/sessions')
    assert sessions.status_code == 200
    assert sessions.json()['total'] >= 1

    top = e2e_client.get('/api/projects/top?limit=5&with_last_message=true')
    assert top.status_code == 200
    top_body = top.json()
    assert top_body['projects']
    if top_body['projects']:
        p = top_body['projects'][0]
        for field in ['project_name', 'project_path', 'total_cost', 'total_tokens',
                      'is_active', 'last_active']:
            assert field in p, f'/api/projects/top[0].{field} missing'
        # last_message is optional (None when no assistant messages) but key must exist
        assert 'last_message' in p


def test_codex_summary_api_contract_matches_secondary_frontend_expectations(e2e_client):
    sessions = e2e_client.get('/api/codex/sessions')
    assert sessions.status_code == 200
    sessions_body = sessions.json()
    assert 'sessions' in sessions_body and 'total' in sessions_body
    if sessions_body['sessions']:
        row = sessions_body['sessions'][0]
        for field in ['session_id', 'session_title', 'project_name', 'message_count', 'last_activity_at', 'replay_url', 'role_counts']:
            assert field in row, f'/api/codex/sessions.sessions[0].{field} missing'

    timeline = e2e_client.get('/api/timeline/summary')
    assert timeline.status_code == 200
    timeline_body = timeline.json()
    assert 'items' in timeline_body and 'total' in timeline_body and 'sessions' in timeline_body
    assert 'session_summaries' in timeline_body
    if timeline_body['items']:
        item = timeline_body['items'][0]
        for field in ['session_id', 'timestamp', 'kind', 'label', 'body_text']:
            assert field in item, f'/api/timeline/summary.items[0].{field} missing'
    if timeline_body['session_summaries']:
        row = timeline_body['session_summaries'][0]
        for field in ['session_id', 'session_title', 'project_name', 'event_count', 'last_activity_at']:
            assert field in row, f'/api/timeline/summary.session_summaries[0].{field} missing'

    usage = e2e_client.get('/api/usage/summary')
    assert usage.status_code == 200
    usage_body = usage.json()
    for field in ['sessions', 'messages', 'projects', 'latest_activity_at', 'by_role', 'top_sessions']:
        assert field in usage_body, f'/api/usage/summary.{field} missing'
    if usage_body['top_sessions']:
        row = usage_body['top_sessions'][0]
        for field in ['session_id', 'session_title', 'project_name', 'message_count', 'last_activity_at']:
            assert field in row, f'/api/usage/summary.top_sessions[0].{field} missing'

    agents = e2e_client.get('/api/agents/summary')
    assert agents.status_code == 200
    agents_body = agents.json()
    for field in ['total_runs', 'active_agents', 'statuses', 'agents', 'by_agent']:
        assert field in agents_body, f'/api/agents/summary.{field} missing'
    if agents_body['agents']:
        agent = agents_body['agents'][0]
        for field in ['session_id', 'agent_name', 'status', 'timestamp']:
            assert field in agent, f'/api/agents/summary.agents[0].{field} missing'
    if agents_body['by_agent']:
        row = agents_body['by_agent'][0]
        for field in ['agent_name', 'count', 'last_status']:
            assert field in row, f'/api/agents/summary.by_agent[0].{field} missing'


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
