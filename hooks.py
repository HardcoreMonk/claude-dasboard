"""
Hook receiver — Claude Code event hooks → session_events.

Token is stored at ~/.claude/.hook-token (chmod 600). The token verifies
that hook POST requests came from the local Claude Code runtime.
"""
import hmac
import os
import secrets
from pathlib import Path

HOOK_TOKEN_PATH = Path.home() / ".claude" / ".hook-token"


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
