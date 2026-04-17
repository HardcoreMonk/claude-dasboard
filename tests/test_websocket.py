"""
WebSocket endpoint test suite.

Covers: unauthenticated connect, cookie-authenticated connect,
        rejection without auth, init message, ping/pong.
"""
import json
import sys

import pytest


TEST_PASSWORD = 'ws-test-pw'


@pytest.fixture()
def noauth_client(tmp_path, monkeypatch):
    """Boot the app WITHOUT password — auth disabled."""
    db_file = tmp_path / 'ws_noauth.db'
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
        if name in ('database', 'codex_parser', 'codex_watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import codex_parser as app_parser
    monkeypatch.setattr(app_parser, 'CLAUDE_PROJECTS', fake_projects)

    import main  # noqa: F401
    database.init_db()

    from starlette.testclient import TestClient
    with TestClient(main.app) as tc:
        yield tc


@pytest.fixture()
def auth_client(tmp_path, monkeypatch):
    """Boot the app WITH DASHBOARD_PASSWORD set."""
    db_file = tmp_path / 'ws_auth.db'
    fake_projects = tmp_path / 'projects'
    fake_projects.mkdir()

    monkeypatch.setenv('DASHBOARD_PASSWORD', TEST_PASSWORD)
    monkeypatch.setenv('DASHBOARD_SECRET', 'fixed-ws-test-secret')

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
        if name in ('database', 'codex_parser', 'codex_watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import codex_parser as app_parser
    monkeypatch.setattr(app_parser, 'CLAUDE_PROJECTS', fake_projects)

    import main
    monkeypatch.setattr(main, '_AUTH_PW', TEST_PASSWORD)
    database.init_db()

    from starlette.testclient import TestClient
    with TestClient(main.app) as tc:
        yield tc


# ─── No-auth WebSocket ────────────────────────────────────────────────

def test_ws_connect_no_auth(noauth_client):
    """Without password set, WebSocket connects without any credentials."""
    with noauth_client.websocket_connect('/ws') as ws:
        # Should be connected — read the init message to confirm
        data = ws.receive_text()
        msg = json.loads(data)
        assert msg['type'] == 'init'


# ─── Auth WebSocket ───────────────────────────────────────────────────

def test_ws_connect_with_cookie(auth_client):
    """With password set, login first, then WS connects using the cookie."""
    # Login to get the session cookie
    r = auth_client.post('/api/auth/login',
                          json={'password': TEST_PASSWORD})
    assert r.status_code == 200
    assert 'dash_session' in r.cookies

    # Use the cookie for WebSocket connection
    cookies = {'dash_session': r.cookies['dash_session']}
    with auth_client.websocket_connect('/ws', cookies=cookies) as ws:
        data = ws.receive_text()
        msg = json.loads(data)
        assert msg['type'] == 'init'


def test_ws_reject_no_cookie(auth_client):
    """With password set, WS without auth cookie should be rejected (4001)."""
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with auth_client.websocket_connect('/ws') as ws:
            ws.receive_text()
    assert exc_info.value.code == 4001


# ─── Init message ─────────────────────────────────────────────────────

def test_ws_receives_init(noauth_client):
    """First message on WebSocket must be type='init' with stats data."""
    with noauth_client.websocket_connect('/ws') as ws:
        data = ws.receive_text()
        msg = json.loads(data)
        assert msg['type'] == 'init'
        assert 'data' in msg
        stats = msg['data']
        # _get_stats returns these standard keys
        assert 'all_time' in stats
        assert 'today' in stats


# ─── Ping / Pong ─────────────────────────────────────────────────────

def test_ws_ping_pong(noauth_client):
    """Sending 'ping' text frame should get 'pong' back."""
    with noauth_client.websocket_connect('/ws') as ws:
        # Consume the init message first
        init_data = ws.receive_text()
        assert json.loads(init_data)['type'] == 'init'
        # Send ping
        ws.send_text('ping')
        pong = ws.receive_text()
        assert pong == 'pong'
