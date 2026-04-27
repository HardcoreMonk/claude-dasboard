"""
Hook receiver — Claude Code event hooks → session_events.

Token is stored at ~/.claude/.hook-token (chmod 600). The token verifies
that hook POST requests came from the local Claude Code runtime.

This module exposes:
  - load_or_create_hook_token() / verify_hook_token()  — token plumbing.
  - router (FastAPI APIRouter) — three POST routes under /api/hooks/*.
    Routes are registered at import time so ``app.include_router(router)``
    sees them. Dependencies (db handle, broadcast callback, expected token)
    are injected later via ``_wire``.
  - _wire(db, broadcast_fn, expected_token) — main.py calls this during
    lifespan startup. The route closures read these via module-level names,
    so re-wiring (e.g. across tests) updates behavior without re-registering.

The ``db`` argument is normally the ``database`` module itself (it provides
the module-level ``insert_session_event`` helper). Tests can pass any object
with the same callable to inject a fake.
"""
import hmac
import json
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ValidationError

HOOK_TOKEN_PATH = Path.home() / ".claude" / ".hook-token"

router = APIRouter(prefix="/api/hooks", tags=["hooks"])
log = logging.getLogger("hooks")


def load_or_create_hook_token() -> str:
    """Load token from file or create a new one (32-byte hex)."""
    if HOOK_TOKEN_PATH.exists():
        return HOOK_TOKEN_PATH.read_text().strip()
    HOOK_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    HOOK_TOKEN_PATH.write_text(token)
    os.chmod(HOOK_TOKEN_PATH, 0o600)
    return token


def verify_hook_token(provided: str, expected: str) -> bool:
    return hmac.compare_digest(provided, expected)


# ─── Pydantic payloads ──────────────────────────────────────────────────────


class SessionStartPayload(BaseModel):
    sessionId: str
    cwd: str | None = None
    version: str | None = None


class SessionStopPayload(BaseModel):
    sessionId: str
    reason: str | None = None


class NotificationPayload(BaseModel):
    sessionId: str
    message: str
    tool: str | None = None


# ─── Helpers ────────────────────────────────────────────────────────────────


def _check_auth(authorization: str | None, expected: str) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    provided = authorization.removeprefix("Bearer ").strip()
    # Defensive: empty expected (pre-_wire window) or empty provided must
    # never auth. compare_digest("", "") would otherwise return True.
    if not expected or not provided:
        raise HTTPException(401, "invalid token")
    if not verify_hook_token(provided, expected):
        raise HTTPException(401, "invalid token")


def _log_validation_error(route: str, e: ValidationError) -> None:
    """Log a Pydantic ValidationError WITHOUT the offending input.

    ``ValidationError.__str__`` includes ``input_value=...`` which would leak
    raw payload bytes (tokens, paths, message excerpts) into journalctl.
    Spec section 13 + project CLAUDE.md forbid that. We log just the error
    count and locator path.
    """
    locs = [err["loc"] for err in e.errors(include_input=False)]
    log.warning("%s payload invalid (%d errors at %s)",
                route, e.error_count(), locs)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ─── Closure-captured deps (set by ``_wire``) ───────────────────────────────


def _noop_broadcast(session_id: str, event: dict) -> None:
    return None


_db: Any = None
_broadcast: Callable[[str, dict], None] = _noop_broadcast
# Sentinel: a fresh random token at import time. ``_wire`` replaces this with
# the real expected token during lifespan startup. Until then, no caller can
# possibly know this value, so any bearer header is rejected by default —
# closes the empty-Bearer auth window if Uvicorn (or a TestClient) ever lets
# requests through before lifespan completes.
_token: str = secrets.token_hex(32)


def _wire(db: Any, broadcast_fn: Callable[[str, dict], None],
          expected_token: str) -> APIRouter:
    """Inject deps into the route closures.

    ``db`` must expose ``insert_session_event(*, session_id, event_type, ts,
    payload, source)`` — normally the ``database`` module. ``broadcast_fn``
    receives ``(session_id, event_dict)``; Task 3 ships a no-op placeholder,
    Task 7 will replace it with the real WS broadcast.

    Idempotent: calling repeatedly only updates the captured references.
    """
    global _db, _broadcast, _token
    _db = db
    _broadcast = broadcast_fn
    _token = expected_token
    return router


# ─── Routes (registered at import time so include_router picks them up) ─────


def _safe_broadcast(session_id: str, event: dict) -> None:
    """Forward to the wired broadcast callback, swallowing errors.

    Broadcast is best-effort: a fan-out failure must NEVER bubble up to
    the hook receiver and turn a successful insert into a 5xx. Hooks must
    always reply 200 once auth + payload validation pass.
    """
    try:
        _broadcast(session_id, event)
    except Exception:
        log.warning("broadcast failed for sid=%s event=%s",
                    session_id, event.get("event_type", "?"))


@router.post("/session-start")
def session_start(payload: dict, authorization: str | None = Header(default=None)):
    _check_auth(authorization, _token)
    try:
        data = SessionStartPayload(**payload)
    except ValidationError as e:
        _log_validation_error("session-start", e)
        return {"ok": False, "warn": "invalid payload"}
    ts = _now_iso()
    decoded = {"cwd": data.cwd, "version": data.version}
    row_id = _db.insert_session_event(
        session_id=data.sessionId, event_type="session_start", ts=ts,
        payload=json.dumps(decoded),
        source="hook",
    )
    if row_id is not None:
        _safe_broadcast(data.sessionId, {
            "id": row_id, "event_type": "session_start", "ts": ts,
            "payload": decoded, "source": "hook",
        })
    return {"ok": True}


@router.post("/session-stop")
def session_stop(payload: dict, authorization: str | None = Header(default=None)):
    _check_auth(authorization, _token)
    try:
        data = SessionStopPayload(**payload)
    except ValidationError as e:
        _log_validation_error("session-stop", e)
        return {"ok": False, "warn": "invalid payload"}
    ts = _now_iso()
    decoded = {"reason": data.reason}
    row_id = _db.insert_session_event(
        session_id=data.sessionId, event_type="session_stop", ts=ts,
        payload=json.dumps(decoded), source="hook",
    )
    if row_id is not None:
        _safe_broadcast(data.sessionId, {
            "id": row_id, "event_type": "session_stop", "ts": ts,
            "payload": decoded, "source": "hook",
        })
    return {"ok": True}


@router.post("/notification")
def notification(payload: dict, authorization: str | None = Header(default=None)):
    _check_auth(authorization, _token)
    try:
        data = NotificationPayload(**payload)
    except ValidationError as e:
        _log_validation_error("notification", e)
        return {"ok": False, "warn": "invalid payload"}
    ts = _now_iso()
    decoded = {"message": data.message, "tool": data.tool}
    row_id = _db.insert_session_event(
        session_id=data.sessionId, event_type="permission_prompt", ts=ts,
        payload=json.dumps(decoded),
        source="hook",
    )
    if row_id is not None:
        _safe_broadcast(data.sessionId, {
            "id": row_id, "event_type": "permission_prompt", "ts": ts,
            "payload": decoded, "source": "hook",
        })
    return {"ok": True}
