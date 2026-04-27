"""Unit tests for parser.py — the cost/ingestion critical path."""
import json
import sqlite3

import pytest

import parser as p


# ─── Pricing ────────────────────────────────────────────────────────────────

def test_get_pricing_exact_match():
    assert p.get_pricing('claude-opus-4-6')['input'] == 15.0e-6
    assert p.get_pricing('claude-sonnet-4-6')['output'] == 15.0e-6
    assert p.get_pricing('claude-haiku-4-5')['cache_read'] == 0.08e-6


def test_get_pricing_strips_date_suffix():
    assert p.get_pricing('claude-opus-4-6-20261001') == p.get_pricing('claude-opus-4-6')
    assert p.get_pricing('claude-haiku-4-5-20251001') == p.get_pricing('claude-haiku-4-5')


def test_get_pricing_family_fallback_warns_once(caplog):
    caplog.set_level('WARNING')
    # Unknown model with family hint — should fall back and warn once
    p._WARNED_MODELS.clear()
    price = p.get_pricing('claude-opus-future')
    assert price == p.MODEL_PRICING['claude-opus-4-6']
    # Second call should not add another warning
    n_warns = sum('Unknown model' in r.message for r in caplog.records)
    p.get_pricing('claude-opus-future')
    n_warns2 = sum('Unknown model' in r.message for r in caplog.records)
    assert n_warns == n_warns2, 'duplicate warning emitted'


def test_get_pricing_synthetic_is_zero():
    for m in ['<synthetic>', 'synthetic', '<anything>']:
        pr = p.get_pricing(m)
        assert pr['input'] == 0
        assert pr['output'] == 0


def test_is_real_model():
    assert p.is_real_model('claude-opus-4-6')
    assert p.is_real_model('claude-haiku-4-5-20251001')
    assert p.is_real_model('claude-sonnet-4-6')
    assert not p.is_real_model('<synthetic>')
    assert not p.is_real_model('synthetic')
    assert not p.is_real_model('')
    assert not p.is_real_model(None)
    assert not p.is_real_model('random-string')  # no claude/opus/sonnet/haiku token


# ─── Cost calculation ──────────────────────────────────────────────────────

def test_calculate_cost_micro_opus():
    usage = {'input_tokens': 1000, 'output_tokens': 500}
    # 1000 * 15e-6 + 500 * 75e-6 = 0.015 + 0.0375 = 0.0525 USD = 52500 micro
    assert p.calculate_cost_micro(usage, 'claude-opus-4-6') == 52500


def test_calculate_cost_micro_cache_tokens():
    usage = {
        'input_tokens': 100,
        'output_tokens': 50,
        'cache_creation_input_tokens': 200,
        'cache_read_input_tokens': 400,
    }
    # Sonnet: 100*3e-6 + 50*15e-6 + 200*3.75e-6 + 400*0.30e-6
    # = 0.0003 + 0.00075 + 0.00075 + 0.00012 = 0.00192 USD → 1920 micro
    assert p.calculate_cost_micro(usage, 'claude-sonnet-4-6') == 1920


def test_calculate_cost_micro_synthetic_zero():
    usage = {'input_tokens': 10_000, 'output_tokens': 5_000}
    assert p.calculate_cost_micro(usage, '<synthetic>') == 0
    assert p.calculate_cost_micro(usage, 'synthetic') == 0


def test_calculate_cost_micro_rounds():
    # round-down case: 1 * 0.30e-6 = 3e-7 USD = 0.3 micro → rounds to 0
    assert p.calculate_cost_micro(
        {'cache_read_input_tokens': 1}, 'claude-sonnet-4-6') == 0
    # round-up case: 2 * 0.30e-6 = 0.6 micro → rounds to 1
    assert p.calculate_cost_micro(
        {'cache_read_input_tokens': 2}, 'claude-sonnet-4-6') == 1


# ─── Project info (C2/C3 fix) ──────────────────────────────────────────────

def test_project_info_from_cwd_preserves_dashes():
    """The original bug: dashes in the path were lost in decoding.
    This test pins the fix: we preserve ``claude-dashboard`` as-is."""
    path, name = p.project_info_from_cwd('/home/user/projects/claude-dashboard')
    assert path == '/home/user/projects/claude-dashboard'
    assert name == 'claude-dashboard'


def test_project_info_from_cwd_keeps_multi_segment_name():
    path, name = p.project_info_from_cwd('/home/user/projects/ai-token-monitor-0-11-2')
    assert name == 'ai-token-monitor-0-11-2'


def test_project_info_from_cwd_empty():
    assert p.project_info_from_cwd('') == ('', '')


def test_get_project_info_prefers_record_cwd():
    record = {'cwd': '/foo/bar-baz'}
    path, name = p.get_project_info('/tmp/fake.jsonl', record)
    assert path == '/foo/bar-baz'
    assert name == 'bar-baz'


def test_get_project_info_falls_back_without_cwd():
    # No record → heuristic path (won't match CLAUDE_PROJECTS, lands in except)
    path, name = p.get_project_info('/tmp/fake.jsonl', None)
    assert path == '/tmp'
    assert name == 'tmp'


# ─── Content helpers ───────────────────────────────────────────────────────

def test_extract_content_text_string():
    assert p.extract_content_text('hello world') == 'hello world'


def test_extract_content_text_blocks():
    blocks = [
        {'type': 'text', 'text': 'first'},
        {'type': 'thinking', 'thinking': 'reasoning here'},
        {'type': 'tool_use', 'name': 'Bash'},
        {'type': 'tool_result', 'content': 'output'},
    ]
    txt = p.extract_content_text(blocks)
    assert 'first' in txt
    assert '생각중' in txt or 'Extended' in txt
    assert '[Tool: Bash]' in txt
    assert '[Tool Result]' in txt


def test_extract_content_text_caps_at_2000():
    long_text = 'a' * 5000
    txt = p.extract_content_text([{'type': 'text', 'text': long_text}])
    assert len(txt) <= 2000


def test_safe_json_content_small_passes_through():
    data = {'foo': 'bar'}
    assert p._safe_json_content(data) == json.dumps(data)


def test_safe_json_content_large_falls_back():
    big = [{'type': 'text', 'text': 'x' * 200_000}]
    out = p._safe_json_content(big)
    # Should be a JSON string value (fallback path) rather than the full array
    assert len(out) < p.CONTENT_MAX_BYTES + 100
    assert json.loads(out).startswith('x')


# ─── Record processing (in-memory DB smoke test) ───────────────────────────

@pytest.fixture()
def mem_db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute('''CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_path TEXT, project_name TEXT,
        created_at TEXT, updated_at TEXT,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_cache_creation_tokens INTEGER DEFAULT 0,
        total_cache_read_tokens INTEGER DEFAULT 0,
        cost_micro INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        user_message_count INTEGER DEFAULT 0,
        model TEXT, cwd TEXT, entrypoint TEXT, version TEXT,
        is_subagent INTEGER DEFAULT 0, parent_session_id TEXT,
        agent_type TEXT, agent_description TEXT, pinned INTEGER DEFAULT 0,
        final_stop_reason TEXT, parent_tool_use_id TEXT, task_prompt TEXT,
        tags TEXT, turn_duration_ms INTEGER DEFAULT 0,
        source_node TEXT DEFAULT 'local'
    )''')
    conn.execute('''CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, message_uuid TEXT UNIQUE,
        parent_uuid TEXT, role TEXT, content TEXT, content_preview TEXT,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
        cost_micro INTEGER DEFAULT 0, model TEXT, request_id TEXT,
        timestamp TEXT, cwd TEXT, git_branch TEXT, is_sidechain INTEGER DEFAULT 0,
        stop_reason TEXT
    )''')
    # v16: session_events — derived timeline events. Parser writes here on
    # successful message INSERTs (Spec A Task 4).
    conn.execute('''CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL, event_type TEXT NOT NULL, ts TEXT NOT NULL,
        payload TEXT NOT NULL, source TEXT NOT NULL, schema_ver INTEGER NOT NULL DEFAULT 1,
        UNIQUE (session_id, event_type, ts, source)
    )''')
    yield conn
    conn.close()


def _assistant_record(model='claude-opus-4-6', uuid='u1', cwd='/tmp/demo-app'):
    return {
        'type': 'assistant',
        'sessionId': 's1',
        'uuid': uuid,
        'timestamp': '2026-04-11T12:00:00Z',
        'cwd': cwd,
        'message': {
            'model': model,
            'usage': {'input_tokens': 100, 'output_tokens': 50},
            'content': [{'type': 'text', 'text': 'hi'}],
        },
    }


def test_process_assistant_real_model_updates_session_model(mem_db):
    p.process_record(_assistant_record(), '/tmp/fake.jsonl', mem_db)
    row = mem_db.execute('SELECT model, project_name, cost_micro FROM sessions WHERE id=?', ('s1',)).fetchone()
    assert row['model'] == 'claude-opus-4-6'
    assert row['project_name'] == 'demo-app'   # derived from cwd
    assert row['cost_micro'] > 0


def test_process_assistant_synthetic_does_not_overwrite_model(mem_db):
    # First: real Opus message establishes session.model
    p.process_record(_assistant_record(model='claude-opus-4-6', uuid='u1'),
                     '/tmp/fake.jsonl', mem_db)
    # Then: synthetic follow-up must NOT change session.model
    p.process_record(_assistant_record(model='<synthetic>', uuid='u2'),
                     '/tmp/fake.jsonl', mem_db)
    row = mem_db.execute('SELECT model, message_count FROM sessions WHERE id=?', ('s1',)).fetchone()
    assert row['model'] == 'claude-opus-4-6', 'synthetic must not hijack session.model'
    assert row['message_count'] == 2


def test_process_assistant_idempotent_on_reinsert(mem_db):
    rec = _assistant_record()
    p.process_record(rec, '/tmp/fake.jsonl', mem_db)
    p.process_record(rec, '/tmp/fake.jsonl', mem_db)   # same uuid → INSERT OR IGNORE
    row = mem_db.execute('SELECT message_count, cost_micro FROM sessions WHERE id=?', ('s1',)).fetchone()
    assert row['message_count'] == 1, 'duplicate uuid should not double-count'


def test_process_assistant_captures_stop_reason(mem_db):
    """v7: the assistant record's ``message.stop_reason`` must land on
    messages.stop_reason AND bubble up to sessions.final_stop_reason."""
    rec = _assistant_record()
    rec['message']['stop_reason'] = 'end_turn'
    p.process_record(rec, '/tmp/fake.jsonl', mem_db)
    msg = mem_db.execute(
        "SELECT stop_reason FROM messages WHERE message_uuid='u1'"
    ).fetchone()
    assert msg['stop_reason'] == 'end_turn'
    sess = mem_db.execute(
        "SELECT final_stop_reason FROM sessions WHERE id='s1'"
    ).fetchone()
    assert sess['final_stop_reason'] == 'end_turn'


def test_process_assistant_stop_reason_is_sticky(mem_db):
    """A later record that lacks stop_reason must NOT wipe the stored value."""
    rec1 = _assistant_record(uuid='u1')
    rec1['message']['stop_reason'] = 'max_tokens'
    p.process_record(rec1, '/tmp/fake.jsonl', mem_db)
    rec2 = _assistant_record(uuid='u2')
    # no stop_reason on rec2
    p.process_record(rec2, '/tmp/fake.jsonl', mem_db)
    sess = mem_db.execute("SELECT final_stop_reason FROM sessions WHERE id='s1'").fetchone()
    assert sess['final_stop_reason'] == 'max_tokens', 'empty stop_reason must not overwrite'


# ─── Subagent file handling (F9 + earlier v5 fix) ───────────────────────

def test_is_subagent_file_detection():
    assert p.is_subagent_file('/foo/bar/subagents/agent-xyz.jsonl')
    assert not p.is_subagent_file('/foo/bar/parent.jsonl')


def test_subagent_id_from_path():
    sid = p.subagent_id_from_path('/a/b/subagents/agent-a4db55.jsonl')
    assert sid == 'agent-a4db55'
    assert p.subagent_id_from_path('/a/b/parent.jsonl') is None


def test_effective_session_id_switches_on_subagent_path():
    # Parent file: use the record's sessionId verbatim
    assert p.effective_session_id('sess-123', '/projects/parent.jsonl') == 'sess-123'
    # Subagent file: override with the filename
    assert p.effective_session_id('sess-123', '/projects/subagents/agent-a7.jsonl') == 'agent-a7'


def test_get_agent_meta_compact_fallback(tmp_path):
    """F9: an ``agent-acompact-*`` file without a meta sidecar should still
    be tagged as compact via the filename heuristic."""
    compact_file = tmp_path / 'subagents' / 'agent-acompact-abc123.jsonl'
    compact_file.parent.mkdir(parents=True)
    compact_file.write_text('')
    atype, adesc = p.get_agent_meta(str(compact_file))
    assert atype == 'compact'
    assert adesc


def test_get_agent_meta_uses_sidecar_when_present(tmp_path):
    f = tmp_path / 'agent-abc.jsonl'
    f.write_text('')
    meta = tmp_path / 'agent-abc.meta.json'
    meta.write_text('{"agentType":"Explore","description":"audit"}')
    atype, adesc = p.get_agent_meta(str(f))
    assert atype == 'Explore'
    assert adesc == 'audit'


# ─── Malformed / adversarial input (견고성) ───────────────────────────────

def test_parse_jsonl_skips_truncated_line(tmp_path):
    """One bad line in the middle of a file must not kill ingestion."""
    p.reset_parse_stats()
    f = tmp_path / 'broken.jsonl'
    f.write_text(
        '{"type":"user","sessionId":"s1","uuid":"u1"}\n'
        '{"type":"assistant","sessionId":"s1","uuid":"u2","message":\n'  # truncated
        '{"type":"user","sessionId":"s1","uuid":"u3"}\n'
    )
    out = list(p.parse_jsonl_file(str(f)))
    assert len(out) == 2  # truncated line skipped
    assert p.PARSE_STATS['malformed_json'] == 1


def test_parse_jsonl_skips_non_object_line(tmp_path):
    """JSONL rows MUST be objects. Arrays and scalars are nonsense here."""
    p.reset_parse_stats()
    f = tmp_path / 'mixed.jsonl'
    f.write_text(
        '{"type":"user","sessionId":"s1","uuid":"u1"}\n'
        '[1, 2, 3]\n'
        '"a plain string"\n'
        '{"type":"user","sessionId":"s1","uuid":"u2"}\n'
    )
    out = list(p.parse_jsonl_file(str(f)))
    assert len(out) == 2
    assert p.PARSE_STATS['malformed_json'] == 2


def test_parse_jsonl_handles_empty_file(tmp_path):
    p.reset_parse_stats()
    f = tmp_path / 'empty.jsonl'
    f.write_text('')
    assert list(p.parse_jsonl_file(str(f))) == []
    assert p.PARSE_STATS['malformed_json'] == 0
    assert p.PARSE_STATS['read_errors'] == 0


def test_parse_jsonl_missing_file_bumps_read_error():
    p.reset_parse_stats()
    missing = '/nonexistent/claude/path/does-not-exist.jsonl'
    out = list(p.parse_jsonl_file(missing))
    assert out == []
    assert p.PARSE_STATS['read_errors'] == 1


def test_process_record_survives_message_being_not_a_dict(mem_db):
    """A record with ``message: null`` or ``message: "oops"`` must not crash;
    we want the row skipped, the stats incremented, and the next record to
    continue processing cleanly."""
    p.reset_parse_stats()
    bad_assistant = {
        'type': 'assistant',
        'sessionId': 's1',
        'uuid': 'bad-1',
        'timestamp': '2026-04-11T12:00:00Z',
        'message': 'oops this should be a dict',
    }
    # Must not raise
    p.process_record(bad_assistant, '/tmp/fake.jsonl', mem_db)
    # A real record afterwards must still land
    p.process_record(_assistant_record(uuid='after'), '/tmp/fake.jsonl', mem_db)
    row = mem_db.execute(
        'SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', ('s1',)
    ).fetchone()
    assert row['n'] == 1  # only the good record persisted


def test_process_record_survives_usage_being_not_a_dict(mem_db):
    """usage field occasionally arrives as string / null in malformed JSONL."""
    p.reset_parse_stats()
    rec = _assistant_record(uuid='bad-usage')
    rec['message']['usage'] = 'oops'  # invalid shape
    # Should not raise; cost should fall through to 0
    p.process_record(rec, '/tmp/fake.jsonl', mem_db)
    row = mem_db.execute(
        'SELECT cost_micro FROM messages WHERE message_uuid = ?', ('bad-usage',)
    ).fetchone()
    assert row is not None
    assert row['cost_micro'] == 0


def test_process_record_skips_record_without_session_id(mem_db):
    p.reset_parse_stats()
    rec = _assistant_record()
    rec['sessionId'] = ''
    p.process_record(rec, '/tmp/fake.jsonl', mem_db)
    # Nothing inserted
    assert mem_db.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 0
    assert p.PARSE_STATS['skipped_no_sid'] == 1


def test_calculate_cost_micro_defensive_against_bad_usage_values():
    """Null/string values in usage dict must count as zero, not crash."""
    bad = {
        'input_tokens': None,
        'output_tokens': 'oops',
        'cache_creation_input_tokens': 100,
        'cache_read_input_tokens': 0,
    }
    # Should not raise; uses only the valid numeric field
    cost = p.calculate_cost_micro(bad, 'claude-opus-4-6')
    assert cost > 0  # cache_creation=100 * opus price > 0


# ─── Spec A Task 4: derived session_events ─────────────────────────────────
#
# These tests exercise the real database module (not an in-memory throwaway)
# because ``database.list_session_events`` opens its own ``read_db()`` and
# expects the v16 schema. ``temp_db`` mirrors the fixture in test_database.py:
# point ``DB_PATH`` at a fresh tmp file, run ``init_db()``, then drive the
# parser through ``write_db()`` so session_events ride the same connection.

@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    db_file = tmp_path / 'parser-events.db'
    fake_claude_projects = tmp_path / 'claude-projects'
    fake_claude_projects.mkdir()
    import database
    monkeypatch.setattr(database, 'DB_PATH', db_file)
    monkeypatch.setattr(database, 'CLAUDE_PROJECTS', fake_claude_projects)
    if hasattr(database._read_local, 'conn'):
        try:
            database._read_local.conn.close()
        except Exception:
            pass
        database._read_local.conn = None
    database.init_db()
    yield database
    if hasattr(database._read_local, 'conn') and database._read_local.conn is not None:
        try:
            database._read_local.conn.close()
        except Exception:
            pass
        database._read_local.conn = None


@pytest.fixture()
def sample_user_line():
    return {
        'type': 'user',
        'uuid': 'u-1',
        'sessionId': 's-1',
        'timestamp': '2026-04-27T12:00:00Z',
        'cwd': '/tmp/proj',
        'message': {'content': [{'type': 'text', 'text': 'hello there'}]},
    }


@pytest.fixture()
def sample_end_turn_line():
    return {
        'type': 'assistant',
        'uuid': 'a-1',
        'sessionId': 's-1',
        'timestamp': '2026-04-27T12:01:00Z',
        'cwd': '/tmp/proj',
        'message': {
            'model': 'claude-opus-4-6',
            'usage': {'input_tokens': 10, 'output_tokens': 5},
            'stop_reason': 'end_turn',
            'content': [{'type': 'text', 'text': 'done'}],
        },
    }


@pytest.fixture()
def sample_tool_use_line():
    return {
        'type': 'assistant',
        'uuid': 'a-2',
        'sessionId': 's-1',
        'timestamp': '2026-04-27T12:02:00Z',
        'cwd': '/tmp/proj',
        'message': {
            'model': 'claude-opus-4-6',
            'usage': {'input_tokens': 10, 'output_tokens': 5},
            'stop_reason': 'tool_use',
            'content': [{
                'type': 'tool_use',
                'id': 'toolu_abc',
                'name': 'Edit',
                'input': {'file_path': '/x', 'old_string': 'a', 'new_string': 'b'},
            }],
        },
    }


@pytest.fixture()
def sample_agent_dispatch_line():
    return {
        'type': 'assistant',
        'uuid': 'a-3',
        'sessionId': 's-1',
        'timestamp': '2026-04-27T12:03:00Z',
        'cwd': '/tmp/proj',
        'message': {
            'model': 'claude-opus-4-6',
            'usage': {'input_tokens': 10, 'output_tokens': 5},
            'stop_reason': 'tool_use',
            'content': [{
                'type': 'tool_use',
                'id': 'toolu_def',
                'name': 'Agent',
                'input': {'subagent_type': 'Explore', 'description': 'find files'},
            }],
        },
    }


def _ingest(record, db_module):
    """Run the parser against the real (v16) DB connection."""
    with db_module.write_db() as conn:
        p.process_record(record, '/tmp/fake.jsonl', conn)


def test_user_message_emits_message_user_event(temp_db, sample_user_line):
    _ingest(sample_user_line, temp_db)
    events = [
        e for e in temp_db.list_session_events('s-1')
        if e['event_type'] == 'message_user'
    ]
    assert len(events) == 1
    payload = json.loads(events[0]['payload'])
    assert payload['message_uuid'] == 'u-1'
    assert 'hello' in payload['preview']
    assert events[0]['source'] == 'jsonl'


def test_assistant_end_turn_emits_two_events(temp_db, sample_end_turn_line):
    _ingest(sample_end_turn_line, temp_db)
    types = {e['event_type'] for e in temp_db.list_session_events('s-1')}
    assert 'message_assistant' in types
    assert 'end_turn' in types


def test_assistant_without_end_turn_emits_only_message_assistant(temp_db, sample_tool_use_line):
    _ingest(sample_tool_use_line, temp_db)
    types = [e['event_type'] for e in temp_db.list_session_events('s-1')]
    # tool_use record does NOT carry stop_reason='end_turn' → no end_turn event
    assert 'end_turn' not in types
    assert 'message_assistant' in types


def test_tool_use_emits_event(temp_db, sample_tool_use_line):
    _ingest(sample_tool_use_line, temp_db)
    events = [
        e for e in temp_db.list_session_events('s-1')
        if e['event_type'] == 'tool_use'
    ]
    assert len(events) == 1
    payload = json.loads(events[0]['payload'])
    assert payload['tool'] == 'Edit'
    assert payload['tool_use_id'] == 'toolu_abc'
    # input_preview is JSON-string-truncated, must contain a key
    assert 'file_path' in payload['input_preview']


def test_agent_tool_emits_subagent_dispatch(temp_db, sample_agent_dispatch_line):
    _ingest(sample_agent_dispatch_line, temp_db)
    events = [
        e for e in temp_db.list_session_events('s-1')
        if e['event_type'] == 'subagent_dispatch'
    ]
    assert len(events) == 1
    payload = json.loads(events[0]['payload'])
    assert payload['agent_type'] == 'Explore'
    assert payload['description'] == 'find files'
    assert payload['child_session_id'] is None  # watcher fills later
    assert payload['tool_use_id'] == 'toolu_def'


def test_task_tool_also_emits_subagent_dispatch(temp_db):
    """``Task`` is the canonical sub-agent dispatch tool name in current Claude Code;
    older transcripts use ``Agent``. Both must trigger the dispatch event."""
    rec = {
        'type': 'assistant',
        'uuid': 'a-task',
        'sessionId': 's-1',
        'timestamp': '2026-04-27T12:04:00Z',
        'cwd': '/tmp/proj',
        'message': {
            'model': 'claude-opus-4-6',
            'usage': {'input_tokens': 1, 'output_tokens': 1},
            'stop_reason': 'tool_use',
            'content': [{
                'type': 'tool_use',
                'id': 'toolu_task',
                'name': 'Task',
                'input': {'subagent_type': 'Plan', 'description': 'plan it'},
            }],
        },
    }
    _ingest(rec, temp_db)
    events = [
        e for e in temp_db.list_session_events('s-1')
        if e['event_type'] == 'subagent_dispatch'
    ]
    assert len(events) == 1


def test_session_events_idempotent_on_duplicate_record(temp_db, sample_tool_use_line):
    """Re-ingesting the same JSONL line must not double-emit session_events.
    The message INSERT is gated by a UNIQUE message_uuid and we only emit
    events when that insert actually lands a new row."""
    _ingest(sample_tool_use_line, temp_db)
    _ingest(sample_tool_use_line, temp_db)
    events = list(temp_db.list_session_events('s-1'))
    # Exactly one message_assistant + one tool_use, no duplicates.
    types = [e['event_type'] for e in events]
    assert types.count('message_assistant') == 1
    assert types.count('tool_use') == 1


def test_user_event_preview_truncated_at_200(temp_db):
    rec = {
        'type': 'user',
        'uuid': 'u-long',
        'sessionId': 's-1',
        'timestamp': '2026-04-27T12:05:00Z',
        'cwd': '/tmp/proj',
        'message': {'content': [{'type': 'text', 'text': 'x' * 5000}]},
    }
    _ingest(rec, temp_db)
    events = [
        e for e in temp_db.list_session_events('s-1')
        if e['event_type'] == 'message_user'
    ]
    assert len(events) == 1
    payload = json.loads(events[0]['payload'])
    assert len(payload['preview']) <= 200
