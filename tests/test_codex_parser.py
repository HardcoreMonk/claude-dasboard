"""Tests for Codex JSONL discovery and normalization."""
from pathlib import Path
from pathlib import PureWindowsPath

import codex_discovery as cd
import codex_parser as cp


FIXTURES = Path(__file__).parent / 'fixtures' / 'codex'


def test_iter_codex_records_reads_message_types():
    records = list(cp.iter_codex_records(FIXTURES / 'session_basic.jsonl'))
    assert [r['type'] for r in records] == ['message']


def test_iter_codex_records_reads_tool_and_agent_types():
    records = list(cp.iter_codex_records(FIXTURES / 'session_tool_agent.jsonl'))
    assert [r['type'] for r in records] == ['tool', 'agent']


def test_normalize_codex_record_derives_project_name_from_project_path():
    raw = next(cp.iter_codex_records(FIXTURES / 'session_basic.jsonl'))
    normalized = cp.normalize_codex_record(raw)

    assert normalized.event_type == 'message'
    assert normalized.project_path == '/home/user/projects/demo-project'
    assert normalized.project_name == 'demo-project'
    assert normalized.payload == {
        'message': {},
        'content': 'hello from codex',
    }
    assert 'hello from codex' in normalized.searchable_text


def test_normalize_codex_record_uses_windows_project_name_rules():
    raw = {
        'type': 'message',
        'sessionId': 'codex-s2',
        'timestamp': '2026-04-16T10:00:00Z',
        'project_path': r'C:\Users\dev\projects\codex-dashboard',
        'content': 'win path',
    }
    normalized = cp.normalize_codex_record(raw)

    assert normalized.project_name == PureWindowsPath(raw['project_path']).name


def test_discover_codex_logs_finds_jsonl_under_codex_roots(tmp_path):
    home = tmp_path
    project_log = home / '.codex' / 'projects' / 'demo' / 'session.jsonl'
    project_log.parent.mkdir(parents=True)
    project_log.write_text('{"type":"message"}\n', encoding='utf-8')

    session_log = home / '.codex' / 'sessions' / 'session.jsonl'
    session_log.parent.mkdir(parents=True, exist_ok=True)
    session_log.write_text('{"type":"tool"}\n', encoding='utf-8')

    history_log = home / '.codex' / 'history.jsonl'
    history_log.write_text('{"type":"tool"}\n', encoding='utf-8')

    discovered = cd.discover_codex_logs(home)

    assert project_log in discovered
    assert session_log in discovered
    assert history_log not in discovered
