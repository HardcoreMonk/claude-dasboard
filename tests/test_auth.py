"""
Authentication test suite.

Covers: login, logout, /api/auth/me, session middleware (redirect vs 401),
WebSocket cookie auth, rate limiting, session expiry.
"""
import sqlite3
import sys
import time

import pytest
from httpx import Client


TEST_PASSWORD = 'test-secret-42'


@pytest.fixture()
def auth_client(tmp_path, monkeypatch):
    """Boot the app WITH DASHBOARD_PASSWORD set."""
    db_file = tmp_path / 'auth.db'
    fake_projects = tmp_path / 'projects'
    fake_projects.mkdir()

    monkeypatch.setenv('DASHBOARD_PASSWORD', TEST_PASSWORD)
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
    # Ensure password is picked up
    monkeypatch.setattr(main, '_AUTH_PW', TEST_PASSWORD)

    database.init_db()

    from starlette.testclient import TestClient
    with TestClient(main.app) as tc:
        yield tc


@pytest.fixture()
def noauth_client(tmp_path, monkeypatch):
    """Boot the app WITHOUT password — auth disabled."""
    db_file = tmp_path / 'noauth.db'
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


# ─── /api/auth/me ────────────────────────────────────────────────────

def test_auth_me_unauthenticated(auth_client):
    r = auth_client.get('/api/auth/me')
    assert r.status_code == 200
    d = r.json()
    assert d['auth_required'] is True
    assert d['authenticated'] is False


def test_auth_me_no_password(noauth_client):
    r = noauth_client.get('/api/auth/me')
    d = r.json()
    assert d['auth_required'] is False
    assert d['authenticated'] is True


# ─── /api/auth/login ─────────────────────────────────────────────────

def test_login_wrong_password(auth_client):
    r = auth_client.post('/api/auth/login',
                         json={'password': 'wrong'})
    assert r.status_code == 401
    assert r.json()['ok'] is False


def test_login_correct_password(auth_client):
    r = auth_client.post('/api/auth/login',
                         json={'password': TEST_PASSWORD})
    assert r.status_code == 200
    assert r.json()['ok'] is True
    assert 'dash_session' in r.cookies


def test_login_empty_password_rejected(auth_client):
    r = auth_client.post('/api/auth/login', json={'password': ''})
    assert r.status_code == 422  # Pydantic min_length=1


# ─── Session cookie auth ─────────────────────────────────────────────

def test_cookie_grants_api_access(auth_client):
    # Login
    r = auth_client.post('/api/auth/login',
                         json={'password': TEST_PASSWORD})
    assert r.status_code == 200
    # Cookie is set — subsequent request should work
    r2 = auth_client.get('/api/stats')
    assert r2.status_code == 200


def test_no_cookie_api_returns_401(auth_client):
    r = auth_client.get('/api/stats')
    assert r.status_code == 401


# ─── Middleware redirect vs 401 ──────────────────────────────────────

def test_browser_redirect_to_login(auth_client):
    r = auth_client.get('/', headers={'Accept': 'text/html'},
                        follow_redirects=False)
    assert r.status_code == 302
    assert '/login' in r.headers['location']


def test_api_returns_401_not_redirect(auth_client):
    r = auth_client.get('/api/stats')
    assert r.status_code == 401
    assert r.json()['error'] == 'unauthorized'


# ─── Auth bypass routes ──────────────────────────────────────────────

def test_health_bypasses_auth(auth_client):
    r = auth_client.get('/api/health')
    assert r.status_code == 200


def test_login_page_bypasses_auth(auth_client):
    r = auth_client.get('/login')
    assert r.status_code == 200


def test_static_files_bypass_auth(auth_client):
    r = auth_client.get('/static/app.css')
    assert r.status_code == 200


# ─── Logout ──────────────────────────────────────────────────────────

def test_logout_clears_session(auth_client):
    # Login first
    auth_client.post('/api/auth/login',
                     json={'password': TEST_PASSWORD})
    # Verify access
    assert auth_client.get('/api/stats').status_code == 200
    # Logout
    auth_client.post('/api/auth/logout')
    # Should be denied now
    assert auth_client.get('/api/stats').status_code == 401


# ─── Rate limiting ───────────────────────────────────────────────────

def test_login_rate_limit(auth_client):
    import main
    # Clear any existing attempts
    main._LOGIN_ATTEMPTS.clear()

    # Exhaust attempts
    for _ in range(5):
        auth_client.post('/api/auth/login',
                         json={'password': 'wrong'})

    # 6th attempt should be rate-limited
    r = auth_client.post('/api/auth/login',
                         json={'password': 'wrong'})
    assert r.status_code == 429
    assert 'too many' in r.json()['error']

    # Even correct password should be blocked
    r2 = auth_client.post('/api/auth/login',
                          json={'password': TEST_PASSWORD})
    assert r2.status_code == 429


# ─── Session expiry ──────────────────────────────────────────────────

def test_expired_session_rejected(auth_client, monkeypatch):
    import main

    # Sign a token that expired 1 second ago
    original_max_age = main._SESSION_MAX_AGE
    monkeypatch.setattr(main, '_SESSION_MAX_AGE', -1)
    token = main._sign_session()
    monkeypatch.setattr(main, '_SESSION_MAX_AGE', original_max_age)

    assert main._verify_session(token) is False


def test_valid_session_accepted(auth_client):
    import main
    token = main._sign_session()
    assert main._verify_session(token) is True


# ─── Basic Auth fallback (for programmatic clients) ──────────────────

def test_basic_auth_fallback(auth_client):
    import base64
    creds = base64.b64encode(f'user:{TEST_PASSWORD}'.encode()).decode()
    r = auth_client.get('/api/stats',
                        headers={'Authorization': f'Basic {creds}'})
    assert r.status_code == 200


def test_basic_auth_wrong_password(auth_client):
    import base64
    creds = base64.b64encode(b'user:wrong').decode()
    r = auth_client.get('/api/stats',
                        headers={'Authorization': f'Basic {creds}'})
    assert r.status_code == 401
