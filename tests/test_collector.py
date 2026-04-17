"""
Collector agent unit tests.

Tests the standalone codex_collector.py functions (load_state, save_state,
scan_files, read_new_lines) without needing the server.
"""
import json

import pytest

import codex_collector as collector


# ─── State persistence ────────────────────────────────────────────────

def test_load_state_empty(tmp_path):
    """Missing state file returns empty dict."""
    missing = tmp_path / 'does-not-exist.json'
    result = collector.load_state(missing)
    assert result == {}


def test_save_and_load_state(tmp_path):
    """Round-trip: save_state then load_state recovers the same data."""
    state_file = tmp_path / 'state.json'
    state = {
        '/home/user/.claude/projects/demo/s1.jsonl': {
            'last_line': 42,
            'mtime': 1700000000.0,
            'size': 8192,
        },
    }
    collector.save_state(state_file, state)
    loaded = collector.load_state(state_file)
    assert loaded == state


def test_save_state_creates_directory(tmp_path):
    """save_state must create parent directories if they don't exist."""
    deep_path = tmp_path / 'a' / 'b' / 'c' / 'state.json'
    collector.save_state(deep_path, {'key': 'value'})
    assert deep_path.exists()
    loaded = json.loads(deep_path.read_text())
    assert loaded == {'key': 'value'}


# ─── File scanning ────────────────────────────────────────────────────

def test_scan_files_empty_dir(tmp_path, monkeypatch):
    """Empty projects directory returns no changed files."""
    monkeypatch.setattr(collector, 'CODEX_ROOTS', (tmp_path,))
    result = collector.scan_files({})
    assert result == []


def test_scan_files_detects_new(tmp_path, monkeypatch):
    """A new .jsonl file should be detected with start_line=0."""
    monkeypatch.setattr(collector, 'CODEX_ROOTS', (tmp_path,))
    # Create a JSONL file inside the projects directory
    project_dir = tmp_path / 'demo-project'
    project_dir.mkdir()
    jsonl_file = project_dir / 'session.jsonl'
    jsonl_file.write_text('{"type":"user","sessionId":"s1","uuid":"u1"}\n')

    result = collector.scan_files({})
    assert len(result) == 1
    file_path, start_line = result[0]
    assert file_path == str(jsonl_file)
    assert start_line == 0


# ─── JSONL line reading ──────────────────────────────────────────────

def test_read_new_lines(tmp_path):
    """read_new_lines should parse JSONL from the given offset."""
    f = tmp_path / 'test.jsonl'
    lines = [
        json.dumps({'type': 'user', 'sessionId': 's1', 'uuid': 'u0'}),
        json.dumps({'type': 'assistant', 'sessionId': 's1', 'uuid': 'u1',
                    'message': {'model': 'claude-opus-4-6',
                                'usage': {'input_tokens': 10, 'output_tokens': 5},
                                'content': [{'type': 'text', 'text': 'hi'}]}}),
        json.dumps({'type': 'user', 'sessionId': 's1', 'uuid': 'u2'}),
    ]
    f.write_text('\n'.join(lines) + '\n')

    # Read from offset 0: should get all 3 records
    records = collector.read_new_lines(str(f), 0)
    assert len(records) == 3
    assert records[0]['uuid'] == 'u0'
    assert records[1]['uuid'] == 'u1'
    assert records[2]['uuid'] == 'u2'
    # Each record should have _line_number injected
    assert records[0]['_line_number'] == 0
    assert records[1]['_line_number'] == 1
    assert records[2]['_line_number'] == 2

    # Read from offset 2: should get only the last record
    records2 = collector.read_new_lines(str(f), 2)
    assert len(records2) == 1
    assert records2[0]['uuid'] == 'u2'
