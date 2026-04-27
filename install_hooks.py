"""
Install / uninstall Claude Code hooks for claude-dashboard.

Hooks: SessionStart, Stop, Notification → POST localhost:8765/api/hooks/*

Usage:
    ./.venv/bin/python install_hooks.py install [--yes]
    ./.venv/bin/python install_hooks.py uninstall [--yes]
    ./.venv/bin/python install_hooks.py rotate-token [--yes]
"""
import argparse
import json
import os
import secrets
import sys
from pathlib import Path

# Module-level mutable bindings — tests monkeypatch these.
SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
TOKEN_PATH = Path.home() / ".claude" / ".hook-token"
ENDPOINT_BASE = "http://localhost:8765/api/hooks"

# Map Claude Code event name → server route under /api/hooks/.
EVENTS = {
    "SessionStart": "session-start",
    "Stop": "session-stop",
    "Notification": "notification",
}

# Literal token path baked into the hook command — `cat` resolves it at hook
# fire time, so token rotation works without rewriting settings.json.
_TOKEN_PATH_LITERAL = "~/.claude/.hook-token"


def _hook_command(route: str) -> str:
    """Build the curl one-liner for a single hook event.

    Trailing `|| true` makes hook failure fail-soft so the Claude session
    is never broken by a downed receiver.
    """
    return (
        f'curl -fsS -X POST '
        f'-H "Authorization: Bearer $(cat {_TOKEN_PATH_LITERAL})" '
        f'-H "Content-Type: application/json" '
        f'-d @- {ENDPOINT_BASE}/{route} || true'
    )


def _desired_hooks() -> dict:
    return {
        evt: [{"command": _hook_command(route)}]
        for evt, route in EVENTS.items()
    }


def _ensure_token() -> str:
    if TOKEN_PATH.exists():
        return TOKEN_PATH.read_text().strip()
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(32)
    TOKEN_PATH.write_text(token)
    os.chmod(TOKEN_PATH, 0o600)
    return token


def _load_settings() -> dict:
    if SETTINGS_PATH.exists():
        return json.loads(SETTINGS_PATH.read_text())
    return {}


def _save_settings(settings: dict) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2, ensure_ascii=False))


def _confirm(prompt: str, yes: bool) -> bool:
    if yes:
        return True
    return input(prompt + " [y/N] ").strip().lower() == "y"


def install(yes: bool = False) -> None:
    """Install the 3 managed hooks. Idempotent — only writes when diff exists."""
    _ensure_token()
    settings = _load_settings()
    hooks = settings.setdefault("hooks", {})
    desired = _desired_hooks()
    diff = {k: v for k, v in desired.items() if hooks.get(k) != v}
    if not diff:
        print("hooks 이미 최신 — 변경 없음.")
        return
    print(f"갱신 대상: {sorted(diff.keys())}")
    if not _confirm("적용?", yes):
        print("중단.")
        return
    hooks.update(desired)
    _save_settings(settings)
    print("설치 완료. claude 를 재시작하세요.")


def uninstall(yes: bool = False) -> None:
    """Remove only the 3 managed entries. Token file preserved."""
    settings = _load_settings()
    hooks = settings.get("hooks", {})
    targets = [e for e in EVENTS if e in hooks]
    if not targets:
        print("hooks 없음 — 변경 없음.")
        return
    print(f"제거 대상: {targets}")
    if not _confirm("적용?", yes):
        print("중단.")
        return
    for e in targets:
        hooks.pop(e, None)
    _save_settings(settings)
    print("제거 완료.")


def rotate_token(yes: bool = False) -> None:
    """Regenerate the hook token. Active hooks 401 until claude restart."""
    if not _confirm(
        "토큰을 회전하면 active hook 이 일시 401 됩니다. 계속?", yes
    ):
        print("중단.")
        return
    if TOKEN_PATH.exists():
        TOKEN_PATH.unlink()
    _ensure_token()
    print("토큰 회전 완료. claude-dashboard 재시작 + claude 재시작 필요.")


def main() -> int:
    p = argparse.ArgumentParser(
        description="Install / uninstall Claude Code hooks for claude-dashboard."
    )
    p.add_argument("action", choices=["install", "uninstall", "rotate-token"])
    p.add_argument("--yes", action="store_true", help="skip confirmation prompt")
    a = p.parse_args()
    dispatch = {
        "install": install,
        "uninstall": uninstall,
        "rotate-token": rotate_token,
    }
    dispatch[a.action](yes=a.yes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
