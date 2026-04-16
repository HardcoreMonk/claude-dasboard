"""Integration tests — hit real FastAPI endpoints via TestClient on a
temporary SQLite DB with controlled fixture data.

Unlike the unit tests, these exercise the full middleware + routing stack.
"""
import sys
from pathlib import Path

import pytest


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
        if name in ('database', 'parser', 'watcher', 'main'):
            sys.modules.pop(name, None)


@pytest.fixture()
def api_client(tmp_path, monkeypatch):
    """Boot a fresh FastAPI app backed by an empty temp DB.

    We reset the module-level state of ``database`` and ``main`` so each
    test sees a clean Prometheus registry + schema.
    """
    db_file = tmp_path / 'api.db'
    fake_claude_projects = tmp_path / 'claude-projects'
    fake_claude_projects.mkdir()

    monkeypatch.delenv('DASHBOARD_PASSWORD', raising=False)

    # Unregister any Prometheus collectors from a previous test run so the
    # re-import of main.py can re-register without duplicate errors.
    try:
        from prometheus_client import REGISTRY
        for collector in list(REGISTRY._collector_to_names.keys()):
            try:
                REGISTRY.unregister(collector)
            except Exception:
                pass
    except Exception:
        pass

    # Drop any cached modules so the new DB_PATH / CLAUDE_PROJECTS stick
    for name in list(sys.modules):
        if name in ('database', 'parser', 'watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_claude_projects)

    import parser as app_parser
    monkeypatch.setattr(app_parser, 'CLAUDE_PROJECTS', fake_claude_projects)

    import sqlite3

    import main  # noqa: F401 — imported for its side effect of app construction

    # Pre-seed some deterministic data so endpoints have something to return
    database.init_db()
    conn = sqlite3.connect(str(db_file))
    conn.execute('''INSERT INTO sessions
        (id, project_name, project_path, cwd, model, created_at, updated_at,
         total_input_tokens, total_output_tokens, cost_micro, message_count,
         is_subagent, parent_session_id, agent_type, agent_description)
        VALUES
        ('parent-A', 'demo', '/tmp/demo', '/tmp/demo', 'claude-opus-4-6',
         '2026-04-01T00:00:00Z', '2026-04-02T00:00:00Z',
         1000, 500, 60000, 3, 0, NULL, '', ''),
        ('agent-1a', 'demo', '/tmp/demo', '/tmp/demo', 'claude-haiku-4-5',
         '2026-04-01T01:00:00Z', '2026-04-01T02:00:00Z',
         100, 50, 4000, 2, 1, 'parent-A', 'Explore', 'Audit the repo'),
        ('agent-1b', 'demo', '/tmp/demo', '/tmp/demo', 'claude-haiku-4-5',
         '2026-04-01T03:00:00Z', '2026-04-01T04:00:00Z',
         200, 80, 6000, 4, 1, 'parent-A', 'Plan', 'Design a migration'),
        ('parent-B', 'other', '/tmp/other', '/tmp/other', 'claude-opus-4-6',
         '2026-04-03T00:00:00Z', '2026-04-03T12:00:00Z',
         500, 200, 30000, 1, 0, NULL, '', '')
    ''')
    conn.execute('''INSERT INTO messages
        (session_id, message_uuid, role, content, content_preview,
         input_tokens, output_tokens, cost_micro, model, timestamp)
        VALUES
        ('parent-A', 'm1', 'assistant', '{"type":"text","text":"hi"}',
         'hi haystack one', 500, 200, 30000, 'claude-opus-4-6', '2026-04-01T00:00:01Z'),
        ('parent-A', 'm2', 'assistant', '{"type":"text","text":"bye"}',
         'bye haystack two', 500, 300, 30000, 'claude-opus-4-6', '2026-04-01T00:00:02Z'),
        ('agent-1a', 'm3', 'assistant', '{"type":"text","text":"explore"}',
         'subagent explore log', 100, 50, 4000, 'claude-haiku-4-5', '2026-04-01T01:00:01Z'),
        ('agent-1b', 'm4', 'assistant', '{"type":"text","text":"plan"}',
         'plan text payload', 200, 80, 6000, 'claude-haiku-4-5', '2026-04-01T03:00:01Z'),
        ('parent-B', 'm5', 'assistant', '{"type":"text","text":"other"}',
         'other project content', 500, 200, 30000, 'claude-opus-4-6', '2026-04-03T00:00:01Z')
    ''')
    conn.commit()
    # FTS5 rebuild for search tests
    try:
        conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    conn.close()

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
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s1',
        session_name='Codex search session',
        role='agent',
        content='{"agent_name":"planner","status":"completed"}',
        content_preview='planner completed',
        timestamp='2026-04-16T10:00:03Z',
        message_uuid='codex-agent-1',
    )
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s2',
        session_name='Other Codex session',
        role='assistant',
        content='Search result in another session',
        content_preview='Search result in another session',
        timestamp='2026-04-16T11:00:00Z',
        message_uuid='codex-msg-3',
    )

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        yield client


# ─── Smoke ──────────────────────────────────────────────────────────────

def test_codex_runtime_defaults_without_env_overrides(monkeypatch):
    monkeypatch.delenv('DASHBOARD_DB_PATH', raising=False)
    monkeypatch.delenv('DASHBOARD_BACKUP_DIR', raising=False)
    _reload_runtime_modules()

    import database
    import main

    assert database.DB_PATH == Path.home() / '.codex' / 'dashboard.db'
    assert main.BACKUP_DIR == Path.home() / '.codex' / 'dashboard-backups'

def test_health(api_client):
    r = api_client.get('/api/health')
    assert r.status_code == 200
    body = r.json()
    assert body['ok'] is True
    assert body['messages'] == 5


def test_metrics_endpoint(api_client):
    """/metrics must be reachable without auth, return Prometheus text."""
    r = api_client.get('/metrics')
    assert r.status_code == 200
    txt = r.text
    # Critical custom series must exist
    assert 'dashboard_sessions_total' in txt
    assert 'dashboard_messages_total' in txt


def test_admin_ingest_status_reports_codex_counters(api_client):
    r = api_client.get('/api/admin/status')
    assert r.status_code == 200
    body = r.json()
    assert body['source_kind'] == 'codex'
    assert body['indexed_sessions'] == 2
    assert body['indexed_messages'] == 5


# ─── Stats / aggregations ───────────────────────────────────────────────

def test_stats_excludes_synthetic_zero(api_client):
    r = api_client.get('/api/stats')
    assert r.status_code == 200
    body = r.json()
    # total sessions excludes subagents? No — /api/stats counts ALL sessions.
    assert body['all_time']['total_sessions'] == 4
    models = {m['model']: m['cost'] for m in body['models']}
    assert 'claude-opus-4-6' in models
    assert 'claude-haiku-4-5' in models


def test_projects_separates_parent_and_subagent_counts(api_client):
    r = api_client.get('/api/projects?sort=name&order=asc')
    assert r.status_code == 200
    projects = r.json()['projects']
    demo = next(p for p in projects if p['project_name'] == 'demo')
    assert demo['session_count'] == 1     # parent-A only
    assert demo['subagent_count'] == 2    # agent-1a, agent-1b
    # Cost includes everything
    assert demo['total_cost'] == pytest.approx(0.06 + 0.004 + 0.006, rel=0.01)


def test_projects_top_shows_subagent_count(api_client):
    r = api_client.get('/api/projects/top?limit=5')
    assert r.status_code == 200
    assert any(p['subagent_count'] > 0 for p in r.json()['projects'])


# ─── Sessions listing ───────────────────────────────────────────────────

def test_sessions_excludes_subagents_by_default(api_client):
    r = api_client.get('/api/sessions')
    assert r.status_code == 200
    data = r.json()
    ids = [s['id'] for s in data['sessions']]
    assert 'agent-1a' not in ids and 'agent-1b' not in ids
    assert 'parent-A' in ids and 'parent-B' in ids
    # Parent-A should report its subagent tally on the row
    parent_a = next(s for s in data['sessions'] if s['id'] == 'parent-A')
    assert parent_a['subagent_count'] == 2
    assert parent_a['subagent_cost'] == pytest.approx(0.01, rel=0.01)


def test_sessions_include_subagents_flag(api_client):
    r = api_client.get('/api/sessions?include_subagents=true&per_page=20')
    ids = [s['id'] for s in r.json()['sessions']]
    assert 'agent-1a' in ids and 'agent-1b' in ids


# ─── Subagent endpoints ─────────────────────────────────────────────────

def test_session_subagents_endpoint(api_client):
    r = api_client.get('/api/sessions/parent-A/subagents')
    assert r.status_code == 200
    body = r.json()
    assert body['total'] == 2
    types = {s['agent_type'] for s in body['subagents']}
    assert types == {'Explore', 'Plan'}


def test_subagents_list_filter_by_type(api_client):
    r = api_client.get('/api/subagents?agent_type=Explore')
    assert r.status_code == 200
    subs = r.json()['subagents']
    assert len(subs) == 1
    assert subs[0]['id'] == 'agent-1a'


def test_subagents_stats(api_client):
    r = api_client.get('/api/subagents/stats')
    assert r.status_code == 200
    body = r.json()
    assert body['totals']['count'] == 2
    type_names = {row['agent_type'] for row in body['by_type']}
    assert type_names == {'Explore', 'Plan'}
    assert len(body['top_by_cost']) == 2


# ─── Search + project disambiguation ────────────────────────────────────

def test_search_fts_finds_keyword(api_client):
    r = api_client.get('/api/sessions/search?q=haystack')
    assert r.status_code == 200
    body = r.json()
    # 2 parent-A messages contain 'haystack'
    assert len(body['results']) == 2
    assert all('haystack' in (row['content_preview'] or '') for row in body['results'])


def test_project_stats_by_path(api_client):
    r = api_client.get('/api/projects/demo/stats?path=/tmp/demo')
    assert r.status_code == 200
    summary = r.json()['summary']
    # parent + 2 subagents = 3
    assert summary['sessions'] == 3


def test_project_stats_unknown_path_404(api_client):
    r = api_client.get('/api/projects/demo/stats?path=/tmp/nope')
    assert r.status_code == 404


def test_codex_search_messages_returns_message_hits(api_client):
    r = api_client.get('/api/search/messages?q=search&role=assistant')
    assert r.status_code == 200
    body = r.json()

    assert body['items']
    first = body['items'][0]
    assert first['message_id'] == 5
    assert first['session_id'] == 'codex-s2'
    assert first['role'] == 'assistant'
    assert first['body_text'] == 'Search result in another session'
    assert first['project_name'] == 'codex-demo'
    assert first['session_title'] == 'Other Codex session'


def test_codex_search_messages_falls_back_when_fts_has_no_tokens(api_client):
    r = api_client.get('/api/search/messages?q=I&role=assistant')
    assert r.status_code == 200
    body = r.json()

    assert body['items']
    assert any(
        item['body_text'] == 'I will change the search UI first.'
        for item in body['items']
    )


def test_codex_message_context_returns_neighboring_messages(api_client):
    r = api_client.get('/api/search/messages/2/context')
    assert r.status_code == 200
    body = r.json()

    assert body['session_id'] == 'codex-s1'
    assert [row['body_text'] for row in body['before']] == [
        'Need to rework the search structure',
    ]
    assert body['current']['message_id'] == 2
    assert body['current']['body_text'] == 'I will change the search UI first.'
    assert [row['body_text'] for row in body['after']] == [
        'rg search UI',
        'planner completed',
    ]


def test_codex_session_replay_returns_replay_payload(api_client):
    r = api_client.get('/api/sessions/codex-s1/replay')
    assert r.status_code == 200
    body = r.json()

    assert body['session_id'] == 'codex-s1'
    assert body['session_title'] == 'Codex search session'
    assert [event['kind'] for event in body['events']] == [
        'message',
        'message',
        'tool_call',
        'agent_run',
    ]
    assert body['events'][0]['role'] == 'user'
    assert body['events'][1]['role'] == 'assistant'
    assert body['events'][2]['tool_name'] == 'rg'
    assert body['events'][3]['agent_name'] == 'planner'
    assert body['events'][2]['payload']['name'] == 'rg'
    assert body['events'][3]['payload']['status'] == 'completed'


def test_codex_sessions_endpoint_returns_replay_launcher_rows(api_client):
    r = api_client.get('/api/codex/sessions')
    assert r.status_code == 200
    body = r.json()

    assert body['total'] == 2
    assert [row['session_id'] for row in body['sessions']] == ['codex-s2', 'codex-s1']
    first = body['sessions'][0]
    assert first['session_title'] == 'Other Codex session'
    assert first['project_name'] == 'codex-demo'
    assert first['message_count'] == 1
    assert first['replay_url'] == '/api/sessions/codex-s2/replay'
    second = body['sessions'][1]
    assert second['message_count'] == 4
    assert second['role_counts'] == {
        'agent': 1,
        'assistant': 1,
        'tool': 1,
        'user': 1,
    }


def test_codex_timeline_summary_returns_recent_codex_events(api_client):
    r = api_client.get('/api/timeline/summary')
    assert r.status_code == 200
    body = r.json()

    assert body['total'] == 5
    assert body['sessions'] == 2
    assert body['session_summaries'] == [
        {
            'session_id': 'codex-s2',
            'session_title': 'Other Codex session',
            'project_name': 'codex-demo',
            'event_count': 1,
            'last_activity_at': '2026-04-16T11:00:00Z',
        },
        {
            'session_id': 'codex-s1',
            'session_title': 'Codex search session',
            'project_name': 'codex-demo',
            'event_count': 4,
            'last_activity_at': '2026-04-16T10:00:03Z',
        },
    ]
    assert [item['kind'] for item in body['items']] == [
        'message',
        'agent_run',
        'tool_call',
        'message',
        'message',
    ]
    assert body['items'][0]['session_id'] == 'codex-s2'
    assert body['items'][0]['label'] == 'assistant'
    assert body['items'][1]['session_id'] == 'codex-s1'
    assert body['items'][1]['label'] == 'planner'
    assert body['items'][2]['label'] == 'rg'


def test_codex_timeline_summary_honors_date_range_and_bounds_session_summaries(api_client):
    import database

    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-old',
        session_name='Old Codex session',
        role='assistant',
        content='Old event outside selected range',
        content_preview='Old event outside selected range',
        timestamp='2026-04-10T09:00:00Z',
        message_uuid='codex-old-1',
    )

    ranged = api_client.get('/api/timeline/summary?date_from=2026-04-16&date_to=2026-04-16&limit=10')
    assert ranged.status_code == 200
    ranged_body = ranged.json()

    assert ranged_body['total'] == 5
    assert ranged_body['sessions'] == 2
    assert {row['session_id'] for row in ranged_body['session_summaries']} == {'codex-s1', 'codex-s2'}
    assert {item['session_id'] for item in ranged_body['items']} == {'codex-s1', 'codex-s2'}

    limited = api_client.get('/api/timeline/summary?date_from=2026-04-16&date_to=2026-04-16&limit=1')
    assert limited.status_code == 200
    limited_body = limited.json()

    assert len(limited_body['items']) == 1
    assert len(limited_body['session_summaries']) == 1
    assert limited_body['session_summaries'][0]['session_id'] == 'codex-s2'


def test_codex_usage_summary_returns_session_message_and_role_counts(api_client):
    r = api_client.get('/api/usage/summary')
    assert r.status_code == 200
    body = r.json()

    assert body['sessions'] == 2
    assert body['messages'] == 5
    assert body['projects'] == 1
    assert body['latest_activity_at'] == '2026-04-16T11:00:00Z'
    assert body['by_role'] == {
        'agent': 1,
        'assistant': 2,
        'tool': 1,
        'user': 1,
    }
    assert body['top_sessions'] == [
        {
            'session_id': 'codex-s1',
            'session_title': 'Codex search session',
            'project_name': 'codex-demo',
            'message_count': 4,
            'last_activity_at': '2026-04-16T10:00:03Z',
        },
        {
            'session_id': 'codex-s2',
            'session_title': 'Other Codex session',
            'project_name': 'codex-demo',
            'message_count': 1,
            'last_activity_at': '2026-04-16T11:00:00Z',
        },
    ]


def test_codex_agents_summary_returns_agent_status_totals(api_client):
    r = api_client.get('/api/agents/summary')
    assert r.status_code == 200
    body = r.json()

    assert body['total_runs'] == 1
    assert body['active_agents'] == 1
    assert body['statuses'] == [{'status': 'completed', 'count': 1}]
    assert body['agents'][0]['agent_name'] == 'planner'
    assert body['agents'][0]['status'] == 'completed'
    assert body['agents'][0]['session_id'] == 'codex-s1'
    assert body['by_agent'] == [{'agent_name': 'planner', 'count': 1, 'last_status': 'completed'}]


def test_codex_agents_summary_aggregates_over_full_history_beyond_visible_limit(api_client):
    import database

    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s2',
        session_name='Other Codex session',
        role='agent',
        content='{"agent_name":"runner","status":"failed"}',
        content_preview='runner failed',
        timestamp='2026-04-16T11:00:01Z',
        message_uuid='codex-agent-2',
    )
    database.store_codex_message(
        project_path='/tmp/codex-demo',
        project_name='codex-demo',
        session_id='codex-s1',
        session_name='Codex search session',
        role='agent',
        content='{"agent_name":"planner","status":"running"}',
        content_preview='planner running',
        timestamp='2026-04-16T11:00:02Z',
        message_uuid='codex-agent-3',
    )

    r = api_client.get('/api/agents/summary?limit=1')
    assert r.status_code == 200
    body = r.json()

    assert len(body['agents']) == 1
    assert body['total_runs'] == 3
    assert body['active_agents'] == 2
    assert body['statuses'] == [
        {'status': 'completed', 'count': 1},
        {'status': 'failed', 'count': 1},
        {'status': 'running', 'count': 1},
    ]
    assert body['by_agent'] == [
        {'agent_name': 'planner', 'count': 2, 'last_status': 'running'},
        {'agent_name': 'runner', 'count': 1, 'last_status': 'failed'},
    ]
    assert body['agents'][0]['agent_name'] == 'planner'
    assert body['agents'][0]['status'] == 'running'


# ─── F7 / F8 / F9 — subagent aggregations ──────────────────────────────

def test_subagents_stats_includes_duration(api_client):
    r = api_client.get('/api/subagents/stats')
    assert r.status_code == 200
    body = r.json()
    for row in body['by_type']:
        assert 'avg_duration_seconds' in row
        assert 'max_duration_seconds' in row
    assert 'top_by_duration' in body


def test_subagents_heatmap_structure(api_client):
    r = api_client.get('/api/subagents/heatmap')
    assert r.status_code == 200
    body = r.json()
    assert 'projects' in body
    assert 'agent_types' in body
    assert 'cells' in body
    assert 'demo' in body['projects']
    types = set(body['agent_types'])
    assert 'Explore' in types
    assert 'Plan' in types
    explore_demo = body['cells'].get('Explore|demo')
    assert explore_demo is not None
    assert explore_demo['count'] == 1


def test_subagent_messages_bypasses_sidechain_filter(api_client, tmp_path):
    """A subagent's own /messages endpoint must return its records even
    though they are flagged ``is_sidechain=1`` in the DB."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    conn.execute("UPDATE messages SET is_sidechain=1 WHERE session_id='agent-1a'")
    conn.commit()
    conn.close()
    r = api_client.get('/api/sessions/agent-1a/messages')
    assert r.status_code == 200
    assert r.json()['total'] >= 1


# ─── G1/G2/G3 — stop_reason + parent_tool_use_id ───────────────────────

def test_v7_columns_present(api_client, tmp_path):
    """Schema columns from v7 must exist after init_db."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    sess_cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    msg_cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)")}
    conn.close()
    assert 'final_stop_reason' in sess_cols
    assert 'parent_tool_use_id' in sess_cols
    assert 'task_prompt' in sess_cols
    assert 'stop_reason' in msg_cols


def test_subagent_endpoint_exposes_stop_reason_and_parent_tool_use(api_client, tmp_path):
    """/api/sessions/{sid}/subagents must surface the v7 fields."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    conn.execute('''UPDATE sessions SET
        final_stop_reason='end_turn',
        parent_tool_use_id='toolu_fake123',
        task_prompt='Do the thing.'
        WHERE id='agent-1a'
    ''')
    conn.commit()
    conn.close()
    r = api_client.get('/api/sessions/parent-A/subagents')
    assert r.status_code == 200
    explore = next(s for s in r.json()['subagents'] if s['id'] == 'agent-1a')
    assert explore['final_stop_reason'] == 'end_turn'
    assert explore['parent_tool_use_id'] == 'toolu_fake123'
    assert explore['task_prompt'] == 'Do the thing.'


def test_subagents_stats_by_stop_reason(api_client, tmp_path):
    """/api/subagents/stats must return a by_stop_reason breakdown."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    conn.execute("UPDATE sessions SET final_stop_reason='end_turn' WHERE id='agent-1a'")
    conn.execute("UPDATE sessions SET final_stop_reason='max_tokens' WHERE id='agent-1b'")
    conn.commit()
    conn.close()
    r = api_client.get('/api/subagents/stats')
    assert r.status_code == 200
    body = r.json()
    assert 'by_stop_reason' in body
    reasons = {row['stop_reason'] for row in body['by_stop_reason']}
    assert 'end_turn' in reasons
    assert 'max_tokens' in reasons


def test_messages_endpoint_returns_stop_reason(api_client):
    """Individual messages must expose the stop_reason column."""
    r = api_client.get('/api/sessions/parent-A/messages')
    assert r.status_code == 200
    msgs = r.json()['messages']
    assert msgs
    assert 'stop_reason' in msgs[0]


# ─── H2/H3/H4/H6 — sessions list enrichment ───────────────────────────

def test_sessions_list_exposes_duration_and_stop_reason(api_client, tmp_path):
    """/api/sessions rows must include duration_seconds and final_stop_reason."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    conn.execute("""UPDATE sessions SET
        created_at='2026-04-01T00:00:00Z',
        updated_at='2026-04-01T00:30:00Z',
        final_stop_reason='end_turn'
        WHERE id='parent-A'""")
    conn.commit()
    conn.close()
    r = api_client.get('/api/sessions')
    assert r.status_code == 200
    parent = next(s for s in r.json()['sessions'] if s['id'] == 'parent-A')
    assert parent['final_stop_reason'] == 'end_turn'
    # 30 minutes = 1800 seconds
    assert parent['duration_seconds'] == pytest.approx(1800, abs=2)


def test_sessions_pinned_only_filter(api_client, tmp_path):
    """?pinned_only=true restricts to starred sessions."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    conn.execute("UPDATE sessions SET pinned=1 WHERE id='parent-A'")
    conn.commit()
    conn.close()
    r = api_client.get('/api/sessions?pinned_only=true')
    assert r.status_code == 200
    ids = [s['id'] for s in r.json()['sessions']]
    assert 'parent-A' in ids
    assert 'parent-B' not in ids


def test_sessions_user_message_count_exposed(api_client):
    """user_message_count must be present so the UI can compute ratio."""
    r = api_client.get('/api/sessions')
    assert r.status_code == 200
    for s in r.json()['sessions']:
        assert 'user_message_count' in s
        assert 'message_count' in s


# ─── M1/M4 — success matrix + cache creation field ────────────────────

def test_subagents_stats_success_matrix(api_client, tmp_path):
    """by_type_and_stop_reason must be a list of {agent_type, stop_reason, count, cost}."""
    import sqlite3
    conn = sqlite3.connect(str(tmp_path / 'api.db'))
    conn.execute("UPDATE sessions SET final_stop_reason='end_turn' WHERE id='agent-1a'")
    conn.execute("UPDATE sessions SET final_stop_reason='tool_use' WHERE id='agent-1b'")
    conn.commit()
    conn.close()
    r = api_client.get('/api/subagents/stats')
    assert r.status_code == 200
    matrix = r.json().get('by_type_and_stop_reason', [])
    assert matrix
    # Every cell has the 4 expected fields
    for row in matrix:
        assert 'agent_type' in row
        assert 'stop_reason' in row
        assert 'count' in row
        assert 'cost' in row
    # Specific cells exist
    pairs = {(r['agent_type'], r['stop_reason']) for r in matrix}
    assert ('Explore', 'end_turn') in pairs
    assert ('Plan', 'tool_use') in pairs


def test_sessions_exposes_cache_creation_separately(api_client):
    """The sessions endpoint must surface cache_creation and cache_read as
    distinct columns so the UI can show both instead of mushing them."""
    r = api_client.get('/api/sessions')
    assert r.status_code == 200
    for s in r.json()['sessions']:
        assert 'total_cache_creation_tokens' in s
        assert 'total_cache_read_tokens' in s


# ─── U11/U12/U18 — filters + tags ────────────────────────────────────

def test_sessions_date_range_filter(api_client):
    """?date_from / ?date_to must narrow by updated_at."""
    # parent-A is 2026-04-02, parent-B is 2026-04-03
    r = api_client.get('/api/sessions?date_from=2026-04-03')
    ids = [s['id'] for s in r.json()['sessions']]
    assert 'parent-B' in ids
    assert 'parent-A' not in ids

    r = api_client.get('/api/sessions?date_to=2026-04-02')
    ids = [s['id'] for s in r.json()['sessions']]
    assert 'parent-A' in ids
    assert 'parent-B' not in ids


def test_sessions_cost_range_filter(api_client):
    """?cost_min / ?cost_max must narrow by cost_micro."""
    # parent-A = 0.06, parent-B = 0.03
    r = api_client.get('/api/sessions?cost_min=0.05')
    ids = [s['id'] for s in r.json()['sessions']]
    assert 'parent-A' in ids
    assert 'parent-B' not in ids


def test_session_tag_set_and_filter(api_client):
    """POST /api/sessions/{id}/tags must store, GET /api/sessions?tag= must filter."""
    r = api_client.post('/api/sessions/parent-A/tags', json={'tags': 'wip,backend'})
    assert r.status_code == 200
    assert r.json()['tags'] == 'wip,backend'
    # List sessions filtering by tag
    r = api_client.get('/api/sessions?tag=wip')
    ids = [s['id'] for s in r.json()['sessions']]
    assert 'parent-A' in ids
    assert 'parent-B' not in ids


def test_tags_list_endpoint(api_client):
    """GET /api/tags must aggregate distinct tags with counts."""
    api_client.post('/api/sessions/parent-A/tags', json={'tags': 'wip,backend'})
    api_client.post('/api/sessions/parent-B/tags', json={'tags': 'wip,frontend'})
    r = api_client.get('/api/tags')
    assert r.status_code == 200
    tags = {t['tag']: t['count'] for t in r.json()['tags']}
    assert tags.get('wip') == 2
    assert tags.get('backend') == 1
    assert tags.get('frontend') == 1


def test_sessions_exposes_tags_column(api_client):
    """The sessions endpoint response must include the tags column."""
    api_client.post('/api/sessions/parent-A/tags', json={'tags': 'hello'})
    r = api_client.get('/api/sessions')
    parent = next(s for s in r.json()['sessions'] if s['id'] == 'parent-A')
    assert parent.get('tags') == 'hello'


# ─── A1 / B3 / B6 — CSV columns + forecast + chain ───────────────────

def test_csv_export_includes_new_columns(api_client):
    """The CSV must surface tags / stop_reason / parent_tool_use_id /
    duration_seconds / agent_type / agent_description columns."""
    r = api_client.get('/api/export/csv')
    assert r.status_code == 200
    header_line = r.text.splitlines()[0]
    for col in ('tags', 'final_stop_reason', 'parent_tool_use_id',
                'duration_seconds', 'agent_type', 'agent_description'):
        assert col in header_line, f'CSV header missing column: {col}'


def test_forecast_endpoint(api_client):
    """/api/forecast must return projection + burn-rate fields."""
    r = api_client.get('/api/forecast?days=14')
    assert r.status_code == 200
    body = r.json()
    for k in ('window_days', 'avg_cost_per_day', 'projected_eom_cost',
              'days_left_in_month', 'daily_used', 'weekly_used',
              'daily_budget_burnout_seconds', 'weekly_budget_burnout_seconds'):
        assert k in body


def test_session_chain_endpoint(api_client):
    """/api/sessions/{id}/chain must return root + nodes."""
    r = api_client.get('/api/sessions/parent-A/chain')
    assert r.status_code == 200
    body = r.json()
    assert body['root'] == 'parent-A'
    assert 'nodes' in body
    assert isinstance(body['nodes'], list)


# ─── Auth-enabled smoke test ──────────────────────────────────────────────

_AUTH_PASSWORD = 'test-secret-42'


def test_api_works_with_auth_cookie(tmp_path, monkeypatch):
    """Verify the API works end-to-end with auth enabled via cookie session.

    This complements the no-auth api_client tests above by proving:
    1. POST /api/auth/login sets a session cookie.
    2. A cookie-authenticated client can call /api/sessions → 200.
    3. A fresh client without the cookie gets 401.
    """
    db_file = tmp_path / 'authapi.db'
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
        if name in ('database', 'parser', 'watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import parser as app_parser
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

        # Step 2 — cookie-authenticated request succeeds
        r = client.get('/api/sessions')
        assert r.status_code == 200
        assert 'sessions' in r.json()

    # Step 3 — a fresh client (no cookie) must be rejected
    with TestClient(main.app) as fresh:
        r = fresh.get('/api/sessions')
        assert r.status_code == 401
