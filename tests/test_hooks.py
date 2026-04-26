import os
from pathlib import Path
from hooks import load_or_create_hook_token


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
