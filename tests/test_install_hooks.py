"""Tests for install_hooks.py CLI."""
import json
import stat

from install_hooks import EVENTS, install, rotate_token, uninstall


def test_install_idempotent(tmp_path, monkeypatch):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"permissions": {"allow": []}}))
    token_path = tmp_path / ".hook-token"
    monkeypatch.setattr("install_hooks.SETTINGS_PATH", settings)
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", token_path)

    install(yes=True)
    after_first = json.loads(settings.read_text())
    install(yes=True)
    after_second = json.loads(settings.read_text())
    assert after_first == after_second  # idempotent
    assert "hooks" in after_first
    for ev in ("SessionStart", "Stop", "Notification"):
        assert ev in after_first["hooks"]


def test_uninstall_removes_hook_entries(tmp_path, monkeypatch):
    settings = tmp_path / "settings.json"
    monkeypatch.setattr("install_hooks.SETTINGS_PATH", settings)
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", tmp_path / ".hook-token")
    install(yes=True)
    uninstall(yes=True)
    after = json.loads(settings.read_text())
    assert "SessionStart" not in after.get("hooks", {})


def test_rotate_token_changes_token(tmp_path, monkeypatch):
    monkeypatch.setattr("install_hooks.SETTINGS_PATH", tmp_path / "settings.json")
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", tmp_path / ".hook-token")
    install(yes=True)
    t1 = (tmp_path / ".hook-token").read_text()
    rotate_token(yes=True)
    t2 = (tmp_path / ".hook-token").read_text()
    assert t1 != t2


# --- Additional safety-net tests ---


def test_install_creates_token_with_perms(tmp_path, monkeypatch):
    """Token file must be created with mode 0600 (no group/world access)."""
    settings = tmp_path / "settings.json"
    token_path = tmp_path / ".hook-token"
    monkeypatch.setattr("install_hooks.SETTINGS_PATH", settings)
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", token_path)

    install(yes=True)
    assert token_path.exists()
    mode = stat.S_IMODE(token_path.stat().st_mode)
    assert mode == 0o600, f"expected 0o600, got {oct(mode)}"
    # 256-bit hex token (token_hex(32) → 64 chars).
    assert len(token_path.read_text().strip()) == 64


def test_uninstall_when_no_hooks_present(tmp_path, monkeypatch):
    """uninstall() on a settings file with no hooks must be a no-op (no crash)."""
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"permissions": {"allow": []}}))
    monkeypatch.setattr("install_hooks.SETTINGS_PATH", settings)
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", tmp_path / ".hook-token")

    uninstall(yes=True)
    after = json.loads(settings.read_text())
    # Settings preserved, no hooks key forced in.
    assert after == {"permissions": {"allow": []}}


def test_install_preserves_existing_user_hooks(tmp_path, monkeypatch):
    """User-defined hook events (e.g. PreToolUse) must survive install."""
    settings = tmp_path / "settings.json"
    user_hook = {"PreToolUse": [{"command": "echo user"}]}
    settings.write_text(json.dumps({"hooks": user_hook}))
    monkeypatch.setattr("install_hooks.SETTINGS_PATH", settings)
    monkeypatch.setattr("hooks.HOOK_TOKEN_PATH", tmp_path / ".hook-token")

    install(yes=True)
    after = json.loads(settings.read_text())
    # User hook untouched.
    assert after["hooks"]["PreToolUse"] == [{"command": "echo user"}]
    # Our 3 managed hooks present.
    for evt in EVENTS:
        assert evt in after["hooks"]
