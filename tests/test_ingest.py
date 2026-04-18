"""
Ingest API + Node management test suite.

Covers: POST /api/nodes, GET /api/nodes, DELETE /api/nodes/{id},
        POST /api/nodes/{id}/rotate-key, POST /api/ingest,
        Codex collector download, removed legacy download, auth requirements.
"""
import json
import sys

import pytest


TEST_PASSWORD = 'ingest-test-pw'
CODEX_COLLECTOR_DOWNLOAD_PATH = '/api/codex-collector.py'
LEGACY_COLLECTOR_DOWNLOAD_PATH = '/api/collector.py'
REMOVED_RUNTIME_PATHS = (LEGACY_COLLECTOR_DOWNLOAD_PATH,)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """Boot a fresh FastAPI app backed by an empty temp DB (no auth)."""
    db_file = tmp_path / 'ingest.db'
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

    from starlette.testclient import TestClient
    with TestClient(main.app) as tc:
        yield tc


@pytest.fixture()
def auth_client(tmp_path, monkeypatch):
    """Boot the app WITH DASHBOARD_PASSWORD set."""
    db_file = tmp_path / 'ingest_auth.db'
    fake_projects = tmp_path / 'projects'
    fake_projects.mkdir()

    monkeypatch.setenv('DASHBOARD_PASSWORD', TEST_PASSWORD)
    monkeypatch.setenv('DASHBOARD_SECRET', 'fixed-ingest-test-secret')

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

    import main
    monkeypatch.setattr(main, '_AUTH_PW', TEST_PASSWORD)
    database.init_db()

    from starlette.testclient import TestClient
    with TestClient(main.app) as tc:
        yield tc


def _register_node(tc, node_id='test-node-1', label=None):
    """Helper: register a node and return (response, ingest_key)."""
    payload = {'node_id': node_id}
    if label:
        payload['label'] = label
    r = tc.post('/api/nodes', json=payload)
    key = r.json().get('ingest_key', '')
    return r, key


def _make_assistant_record(session_id='s1', uuid='u1',
                           cwd='/tmp/demo-project'):
    """Build a minimal valid assistant JSONL record."""
    return {
        'type': 'assistant',
        'sessionId': session_id,
        'uuid': uuid,
        'timestamp': '2026-04-11T12:00:00Z',
        'cwd': cwd,
        'message': {
            'model': 'claude-opus-4-6',
            'usage': {'input_tokens': 100, 'output_tokens': 50},
            'content': [{'type': 'text', 'text': 'hello from remote'}],
        },
    }


# ─── Node Registration ────────────────────────────────────────────────

def test_register_node(client):
    r, key = _register_node(client, 'prod-server-1')
    assert r.status_code == 200
    body = r.json()
    assert body['node_id'] == 'prod-server-1'
    assert len(key) > 0, 'ingest_key must be returned on registration'
    assert 'Save this key' in body['message']


def test_register_duplicate_node_409(client):
    _register_node(client, 'dup-node')
    r2, _ = _register_node(client, 'dup-node')
    assert r2.status_code == 409
    assert 'already exists' in r2.json()['error']


def test_list_nodes_includes_local(client):
    r = client.get('/api/nodes')
    assert r.status_code == 200
    nodes = r.json()['nodes']
    node_ids = [n['node_id'] for n in nodes]
    assert 'local' in node_ids, 'local pseudo-node must always be present'


def test_delete_node(client):
    _register_node(client, 'delete-me')
    # Verify it exists
    nodes_before = client.get('/api/nodes').json()['nodes']
    assert any(n['node_id'] == 'delete-me' for n in nodes_before)
    # Delete it
    r = client.delete('/api/nodes/delete-me')
    assert r.status_code == 200
    assert r.json()['deleted'] == 'delete-me'
    # Verify it's gone
    nodes_after = client.get('/api/nodes').json()['nodes']
    assert not any(n['node_id'] == 'delete-me' for n in nodes_after)


def test_rotate_key(client):
    _register_node(client, 'rotate-me')
    r = client.post('/api/nodes/rotate-me/rotate-key')
    assert r.status_code == 200
    body = r.json()
    assert body['node_id'] == 'rotate-me'
    assert len(body['ingest_key']) > 0


# ─── Ingest Endpoint ──────────────────────────────────────────────────

def test_ingest_valid_records(client):
    _, key = _register_node(client, 'ingest-node')
    record = _make_assistant_record(session_id='remote-s1', uuid='remote-u1')
    r = client.post('/api/ingest',
                     json={
                         'node_id': 'ingest-node',
                         'file_path': '/home/user/.codex/projects/demo/session.jsonl',
                         'records': [record],
                     },
                     headers={'X-Ingest-Key': key})
    assert r.status_code == 200
    body = r.json()
    assert body['accepted'] >= 1


def test_ingest_wrong_key_403(client):
    _register_node(client, 'wrong-key-node')
    record = _make_assistant_record(session_id='s-wk', uuid='u-wk')
    r = client.post('/api/ingest',
                     json={
                         'node_id': 'wrong-key-node',
                         'file_path': '/tmp/test.jsonl',
                         'records': [record],
                     },
                     headers={'X-Ingest-Key': 'totally-wrong-key'})
    assert r.status_code == 403


def test_ingest_unknown_node_403(client):
    r = client.post('/api/ingest',
                     json={
                         'node_id': 'nonexistent-node',
                         'file_path': '/tmp/test.jsonl',
                         'records': [_make_assistant_record()],
                     },
                     headers={'X-Ingest-Key': 'some-key'})
    assert r.status_code == 403


def test_ingest_creates_session(client):
    _, key = _register_node(client, 'sess-node')
    record = _make_assistant_record(session_id='remote-sess-1', uuid='ru1',
                                    cwd='/tmp/remote-project')
    client.post('/api/ingest',
                json={
                    'node_id': 'sess-node',
                    'file_path': '/home/user/.codex/projects/rp/session.jsonl',
                    'records': [record],
                },
                headers={'X-Ingest-Key': key})
    # Verify session exists with correct source_node
    import database
    with database.read_db() as db:
        row = db.execute(
            'SELECT source_node, p.project_name FROM codex_sessions s '
            'JOIN codex_projects p ON p.project_path = s.project_path '
            'WHERE s.id = ?',
            ('remote-sess-1',),
        ).fetchone()
    assert row is not None, 'session must be created after ingest'
    assert row['source_node'] == 'sess-node'
    assert row['project_name'] == 'remote-project'


def test_ingest_creates_messages(client):
    _, key = _register_node(client, 'msg-node')
    records = [
        _make_assistant_record(session_id='msg-sess', uuid='mu1'),
        _make_assistant_record(session_id='msg-sess', uuid='mu2'),
    ]
    client.post('/api/ingest',
                json={
                    'node_id': 'msg-node',
                    'file_path': '/tmp/test.jsonl',
                    'records': records,
                },
                headers={'X-Ingest-Key': key})
    import database
    with database.read_db() as db:
        count = db.execute(
            'SELECT COUNT(*) FROM codex_messages WHERE session_id = ?',
            ('msg-sess',),
        ).fetchone()[0]
    assert count == 2


def test_nodes_counts_are_derived_from_codex_remote_sessions(client):
    _, key = _register_node(client, 'count-node')
    record = _make_assistant_record(session_id='count-sess', uuid='count-u1',
                                    cwd='/tmp/count-project')
    r = client.post('/api/ingest',
                    json={
                        'node_id': 'count-node',
                        'file_path': '/home/user/.codex/projects/count/history.jsonl',
                        'records': [record],
                    },
                    headers={'X-Ingest-Key': key})
    assert r.status_code == 200

    nodes = client.get('/api/nodes')
    assert nodes.status_code == 200
    node = next(n for n in nodes.json()['nodes'] if n['node_id'] == 'count-node')
    assert node['session_count'] == 1
    assert node['message_count'] == 1


# ─── Collector download endpoint ─────────────────────────────────────

def test_codex_collector_download(client):
    r = client.get(CODEX_COLLECTOR_DOWNLOAD_PATH)
    assert r.status_code == 200
    assert 'codex_collector.py' in r.text


# ─── Removed legacy download endpoint ────────────────────────────────

@pytest.mark.parametrize('path', REMOVED_RUNTIME_PATHS)
def test_legacy_collector_download_removed(client, path):
    r = client.get(path)
    assert r.status_code == 404


# ─── Auth required for node management ────────────────────────────────

def test_nodes_require_auth(auth_client):
    # POST /api/nodes should require auth (not in bypass list)
    r = auth_client.post('/api/nodes', json={'node_id': 'auth-test'})
    assert r.status_code == 401

    # DELETE /api/nodes/{id} should also require auth
    r = auth_client.delete('/api/nodes/auth-test')
    assert r.status_code == 401

    # GET /api/nodes should require auth
    r = auth_client.get('/api/nodes')
    assert r.status_code == 401

    # But /api/ingest is in the bypass list — should NOT return 401
    # (it returns 403 because we don't provide a valid key, not 401)
    r = auth_client.post('/api/ingest',
                          json={
                              'node_id': 'x',
                              'file_path': '/tmp/f.jsonl',
                              'records': [],
                          },
                          headers={'X-Ingest-Key': 'fake'})
    assert r.status_code != 401, '/api/ingest must bypass session auth'
