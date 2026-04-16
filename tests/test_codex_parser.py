"""Tests for Codex JSONL discovery and normalization."""
from pathlib import Path, PureWindowsPath

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


def test_normalize_codex_record_supports_history_jsonl_shape():
    raw = {
        'session_id': 'codex-history-s1',
        'ts': 1776253250,
        'text': 'history line from codex',
        '_source_path': str(FIXTURES / 'history.jsonl'),
        '_line_number': 0,
    }

    normalized = cp.normalize_codex_record(raw)

    assert normalized.event_type == 'message'
    assert normalized.session_id == 'codex-history-s1'
    assert normalized.timestamp == '2026-04-15T11:40:50Z'
    assert normalized.payload == {
        'message': {},
        'content': 'history line from codex',
    }
    assert 'history line from codex' in normalized.searchable_text


def test_normalize_codex_record_supports_rollout_session_meta_shape():
    raw = {
        'type': 'session_meta',
        'payload': {
            'id': '019d9750-b622-71f0-ae0a-889467c995f9',
            'timestamp': '2026-04-16T17:22:22.393Z',
            'cwd': '/home/user/projects/codex-dashboard',
            'agent_nickname': 'Singer',
            'agent_role': 'worker',
            'source': {
                'subagent': {
                    'thread_spawn': {
                        'parent_thread_id': '019d9615-2d01-7fd1-a41f-5e0d5db53eaa',
                        'depth': 1,
                    },
                },
            },
        },
        '_source_path': str(FIXTURES / 'rollout.jsonl'),
        '_line_number': 0,
    }

    normalized = cp.normalize_codex_record(raw)

    assert normalized.event_type == 'agent'
    assert normalized.session_id == '019d9750-b622-71f0-ae0a-889467c995f9'
    assert normalized.project_path == '/home/user/projects/codex-dashboard'
    assert normalized.project_name == 'codex-dashboard'
    assert normalized.payload['agent_name'] == 'Singer'
    assert normalized.payload['status'] == 'worker'
    assert normalized.payload['parent_thread_id'] == '019d9615-2d01-7fd1-a41f-5e0d5db53eaa'


def test_normalize_codex_record_supports_rollout_function_call_shape():
    raw = {
        'type': 'response_item',
        'payload': {
            'type': 'function_call',
            'name': 'exec_command',
            'arguments': '{"cmd":"pytest -q"}',
        },
        '_source_path': str(FIXTURES / 'rollout-2026-04-17T02-22-22-019d9750-b622-71f0-ae0a-889467c995f9.jsonl'),
        '_line_number': 1,
    }

    normalized = cp.normalize_codex_record(raw)

    assert normalized.event_type == 'tool'
    assert normalized.session_id == '019d9750-b622-71f0-ae0a-889467c995f9'
    assert normalized.payload == {
        'name': 'exec_command',
        'input': '{"cmd":"pytest -q"}',
    }


def test_discover_codex_logs_finds_jsonl_under_codex_roots(tmp_path):
    home = tmp_path
    project_log = home / '.codex' / 'projects' / 'demo' / 'session.jsonl'
    project_log.parent.mkdir(parents=True)
    project_log.write_text('{"type":"message"}\n', encoding='utf-8')

    session_log = home / '.codex' / 'sessions' / '2026' / '04' / '17' / 'rollout-2026-04-17T02-22-22-019d9750-b622-71f0-ae0a-889467c995f9.jsonl'
    session_log.parent.mkdir(parents=True, exist_ok=True)
    session_log.write_text('{"type":"tool"}\n', encoding='utf-8')

    history_log = home / '.codex' / 'history.jsonl'
    history_log.write_text('{"type":"tool"}\n', encoding='utf-8')

    discovered = cd.discover_codex_logs(home)

    assert project_log in discovered
    assert session_log in discovered
    assert history_log not in discovered


def test_discover_codex_logs_prefers_rich_rollout_logs_over_history(tmp_path):
    home = tmp_path
    rollout_log = home / '.codex' / 'sessions' / '2026' / '04' / '17' / 'rollout-2026-04-17T02-22-22-019d9750-b622-71f0-ae0a-889467c995f9.jsonl'
    rollout_log.parent.mkdir(parents=True)
    rollout_log.write_text('{"type":"session_meta","payload":{"id":"s1"}}\n', encoding='utf-8')

    history_log = home / '.codex' / 'history.jsonl'
    history_log.parent.mkdir(parents=True, exist_ok=True)
    history_log.write_text('{"session_id":"s1","text":"history"}\n', encoding='utf-8')

    discovered = cd.discover_codex_logs(home)

    assert rollout_log in discovered
    assert history_log not in discovered
