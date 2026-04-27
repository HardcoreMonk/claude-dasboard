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
        if name in ('database', 'parser', 'watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import parser as app_parser
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
        if name in ('database', 'parser', 'watcher', 'main'):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_projects)
    import parser as app_parser
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


# ─── Timeline subscribe / broadcast (Spec A Task 7) ──────────────────

def _drain_until_timeline(ws, max_msgs: int = 5):
    """Read up to ``max_msgs`` messages and return the first timeline_event.

    Skips ``init`` and any other non-timeline frames so the test focus
    stays on the broadcast path. Returns None if no timeline frame
    appears within the budget.
    """
    for _ in range(max_msgs):
        text = ws.receive_text()
        try:
            obj = json.loads(text)
        except (TypeError, ValueError):
            continue
        if obj.get('type') == 'timeline_event':
            return obj
    return None


def test_ws_subscribe_timeline_receives_broadcast(noauth_client):
    """Subscribing to a session_id makes the WS receive timeline broadcasts."""
    import main
    with noauth_client.websocket_connect('/ws') as ws:
        # Drain init
        init = ws.receive_text()
        assert json.loads(init)['type'] == 'init'

        ws.send_json({'type': 'subscribe_timeline', 'session_id': 's-1'})
        # Round-trip a ping/pong to ensure the server has processed the
        # subscribe before we fire the broadcast (TestClient handles
        # frames in-order, so by the time pong returns the subscribe
        # branch has run).
        ws.send_text('ping')
        assert ws.receive_text() == 'pong'

        # Server-side broadcast simulation.
        main._broadcast_timeline_event(
            's-1', {'event_type': 'tool_use', 'ts': '2026-04-27T12:00:00Z'})

        msg = _drain_until_timeline(ws)
        assert msg is not None, "no timeline_event received"
        assert msg['session_id'] == 's-1'
        assert msg['event']['event_type'] == 'tool_use'
        assert msg['event']['ts'] == '2026-04-27T12:00:00Z'


def test_ws_unsubscribe_stops_broadcast(noauth_client):
    """After unsubscribe, broadcasts to that session_id are NOT delivered."""
    import main
    with noauth_client.websocket_connect('/ws') as ws:
        init = ws.receive_text()
        assert json.loads(init)['type'] == 'init'

        ws.send_json({'type': 'subscribe_timeline', 'session_id': 's-2'})
        ws.send_json({'type': 'unsubscribe_timeline', 'session_id': 's-2'})
        # Sync barrier — pong returns only after the unsubscribe was processed.
        ws.send_text('ping')
        assert ws.receive_text() == 'pong'

        # Broadcast AFTER unsubscribe — should be filtered out.
        main._broadcast_timeline_event(
            's-2', {'event_type': 'tool_use', 'ts': '...'})

        # Send another ping; the very next frame must be 'pong', NOT the
        # broadcast event. If unsubscribe failed, the broadcast frame would
        # arrive before the new pong (FIFO ordering on a single WS).
        ws.send_text('ping')
        next_frame = ws.receive_text()
        assert next_frame == 'pong', (
            f"expected pong, got broadcast leak: {next_frame!r}")


def test_ws_subscribe_unknown_type_ignored(noauth_client):
    """An unrecognised JSON message type must not crash the handler."""
    with noauth_client.websocket_connect('/ws') as ws:
        ws.receive_text()  # init
        ws.send_json({'type': 'no_such_type', 'session_id': 's-x'})
        ws.send_text('ping')
        assert ws.receive_text() == 'pong'


def test_ws_disconnect_cleans_subscription(noauth_client):
    """Closing the WS must remove its entries from _timeline_subs."""
    import main
    with noauth_client.websocket_connect('/ws') as ws:
        ws.receive_text()  # init
        ws.send_json({'type': 'subscribe_timeline', 'session_id': 's-cleanup'})
        ws.send_text('ping')
        assert ws.receive_text() == 'pong'
        # While inside the context, subscription should exist.
        with main._subs_lock:
            assert 's-cleanup' in main._timeline_subs
            assert len(main._timeline_subs['s-cleanup']) == 1
    # After context exit (disconnect), cleanup should have run.
    with main._subs_lock:
        assert not main._timeline_subs.get('s-cleanup')


def test_ws_broadcast_full_row_contract(noauth_client):
    """Contract: parser/hook broadcasts MUST carry full event rows so the
    frontend's ``ev.id``-based dedup and ``ev.payload.<field>`` renderer
    work end-to-end. Drives the broadcast through the real parser path
    so a future regression to ``{event_type, ts}``-only fan-out is caught
    immediately.
    """
    import main
    import parser as app_parser
    import database

    with noauth_client.websocket_connect('/ws') as ws:
        # Drain init
        init = ws.receive_text()
        assert json.loads(init)['type'] == 'init'

        ws.send_json({'type': 'subscribe_timeline', 'session_id': 's-contract'})
        # Sync barrier: the subscribe is processed before broadcast.
        ws.send_text('ping')
        assert ws.receive_text() == 'pong'

        # Drive the real parser → _safe_broadcast path. The parser writes
        # via its own connection but the broadcast callback is the shared
        # ``main._broadcast_timeline_event``.
        record = {
            'type': 'assistant',
            'uuid': 'broadcast-contract-uuid',
            'sessionId': 's-contract',
            'timestamp': '2026-04-27T12:00:00Z',
            'cwd': '/tmp/proj',
            'message': {
                'model': 'claude-opus-4-6',
                'usage': {'input_tokens': 1, 'output_tokens': 1},
                'stop_reason': 'tool_use',
                'content': [{
                    'type': 'tool_use',
                    'id': 'toolu_xyz',
                    'name': 'Edit',
                    'input': {'file_path': '/x'},
                }],
            },
        }
        with database.write_db() as conn:
            app_parser.process_record(
                record, '/tmp/fake.jsonl', conn,
                broadcast=main._broadcast_timeline_event,
            )

        # First broadcast = message_assistant; we want to see at least one
        # frame that carries the full row contract.
        msg = _drain_until_timeline(ws)
        assert msg is not None, "no timeline_event received"
        ev = msg['event']
        for field in ('id', 'event_type', 'ts', 'payload', 'source'):
            assert field in ev, f"broadcast event missing {field}: {ev!r}"
        # Type contract.
        assert isinstance(ev['id'], int)
        assert isinstance(ev['event_type'], str)
        assert isinstance(ev['ts'], str) and 'T' in ev['ts']
        assert isinstance(ev['payload'], dict)
        assert ev['source'] == 'jsonl'
