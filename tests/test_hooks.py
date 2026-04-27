"""Hook receiver tests — token storage + 3 receiver routes (Spec A Task 3)."""
import importlib
import sys

import pytest


# ─── Token storage / verify (Task 2) ────────────────────────────────────────

from hooks import load_or_create_hook_token  # noqa: E402


def test_load_existing_token(tmp_path, monkeypatch):
    p = tmp_path / ".hook-token"
    p.write_text("deadbeef" * 8)
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", p)
    assert load_or_create_hook_token() == "deadbeef" * 8


def test_autogen_when_missing(tmp_path, monkeypatch):
    p = tmp_path / ".hook-token"
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", p)
    token = load_or_create_hook_token()
    assert len(token) == 64  # 32 bytes hex
    assert p.exists()
    assert oct(p.stat().st_mode)[-3:] == "600"


def test_compare_constant_time():
    from hooks import verify_hook_token
    assert verify_hook_token("abc", "abc") is True
    assert verify_hook_token("abc", "xyz") is False


def test_check_auth_rejects_empty_expected():
    """Pre-_wire window: empty expected token must reject any bearer.

    If module-level ``_token`` ever defaulted to ``""``, an attacker sending
    ``Authorization: Bearer `` (empty bearer) would pass ``compare_digest``.
    Defensive guard in ``_check_auth`` must reject before reaching compare.
    """
    from fastapi import HTTPException

    from hooks import _check_auth

    # Empty expected — any provided bearer (even empty) must 401.
    with pytest.raises(HTTPException) as exc_info:
        _check_auth("Bearer ", expected="")
    assert exc_info.value.status_code == 401

    with pytest.raises(HTTPException) as exc_info:
        _check_auth("Bearer something", expected="")
    assert exc_info.value.status_code == 401


def test_module_level_token_is_random_sentinel():
    """At import time, ``_token`` must be a fresh random sentinel — not ``""``.

    This protects the window between FastAPI app construction and lifespan
    completion (where ``_wire`` is called). A test client that bypasses
    lifespan would otherwise see an empty token.
    """
    # Force a fresh import to observe import-time state.
    sys.modules.pop("hooks", None)
    import hooks as fresh_hooks
    assert fresh_hooks._token != ""
    assert len(fresh_hooks._token) >= 32  # token_hex(32) → 64 chars


# ─── Receiver route fixtures (Task 3) ───────────────────────────────────────

@pytest.fixture()
def hooks_app(tmp_path, monkeypatch):
    """Boot a fresh FastAPI app with the hook router mounted on a temp DB.

    Mirrors the pattern used by ``api_client`` in test_api.py: clear cached
    modules so re-import binds fresh DB_PATH, unregister Prometheus collectors
    so re-registration succeeds.
    """
    db_file = tmp_path / "hooks.db"
    fake_claude_projects = tmp_path / "claude-projects"
    fake_claude_projects.mkdir()

    monkeypatch.delenv("DASHBOARD_PASSWORD", raising=False)

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
        if name in ("database", "parser", "watcher", "main", "hooks"):
            sys.modules.pop(name, None)

    import database
    monkeypatch.setattr(database, "DB_PATH", db_file)
    monkeypatch.setattr(database, "CLAUDE_PROJECTS", fake_claude_projects)

    import parser as app_parser
    monkeypatch.setattr(app_parser, "CLAUDE_PROJECTS", fake_claude_projects)

    # Pin token before main.py lifespan runs — main reads HOOK_TOKEN_PATH
    # via hooks.load_or_create_hook_token() during startup.
    import hooks
    token = "test-token-deadbeef" * 4
    token_path = tmp_path / ".hook-token"
    token_path.write_text(token)
    monkeypatch.setattr(hooks, "HOOK_TOKEN_PATH", token_path)

    import main  # noqa: F401 — side effect: app construction

    database.init_db()

    from fastapi.testclient import TestClient
    with TestClient(main.app) as client:
        yield client, token, database


def test_session_start_hook_ok(hooks_app):
    client, token, database = hooks_app
    payload = {"sessionId": "s-1", "cwd": "/tmp/proj", "version": "1.x"}
    r = client.post(
        "/api/hooks/session-start",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    rows = list(database.list_session_events("s-1"))
    assert len(rows) == 1
    assert rows[0]["event_type"] == "session_start"
    assert rows[0]["source"] == "hook"


def test_session_stop_hook_ok(hooks_app):
    client, token, database = hooks_app
    r = client.post(
        "/api/hooks/session-stop",
        headers={"Authorization": f"Bearer {token}"},
        json={"sessionId": "s-1", "reason": "end_turn"},
    )
    assert r.status_code == 200
    rows = list(database.list_session_events("s-1"))
    assert any(e["event_type"] == "session_stop" for e in rows)


def test_notification_hook_permission_prompt(hooks_app):
    client, token, database = hooks_app
    r = client.post(
        "/api/hooks/notification",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "sessionId": "s-1",
            "message": "Use of Bash requires permission",
            "tool": "Bash",
        },
    )
    assert r.status_code == 200
    rows = [
        e for e in database.list_session_events("s-1")
        if e["event_type"] == "permission_prompt"
    ]
    assert len(rows) == 1


def test_hook_invalid_token_401(hooks_app):
    client, _token, _database = hooks_app
    r = client.post(
        "/api/hooks/session-start",
        headers={"Authorization": "Bearer bad"},
        json={"sessionId": "s-1"},
    )
    assert r.status_code == 401


def test_hook_missing_token_401(hooks_app):
    client, _token, _database = hooks_app
    r = client.post(
        "/api/hooks/session-start",
        json={"sessionId": "s-1"},
    )
    assert r.status_code == 401


def test_hook_malformed_payload_failsoft(hooks_app):
    client, token, database = hooks_app
    r = client.post(
        "/api/hooks/session-start",
        headers={"Authorization": f"Bearer {token}"},
        json={"missing_session_id": True},
    )
    assert r.status_code == 200  # fail-soft
    body = r.json()
    assert body.get("ok") is False
    # No row inserted under any session id we'd expect — query the session
    # we'd naively associate the bad payload with: there's nothing there.
    assert list(database.list_session_events("s-1")) == []
