"""Codex JSONL parsing helpers used by runtime ingest paths."""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath
from typing import Any, Generator, Iterator, Optional

logger = logging.getLogger(__name__)

PROJECTS_ROOT = Path.home() / '.codex' / 'projects'
CONTENT_MAX_BYTES = 100_000

_stats_lock = threading.Lock()
PARSE_STATS: dict[str, int] = {
    'malformed_json': 0,
    'read_errors': 0,
    'process_errors': 0,
    'skipped_no_sid': 0,
}


def _inc_stat(key: str) -> None:
    with _stats_lock:
        PARSE_STATS[key] += 1


def reset_parse_stats() -> None:
    for key in PARSE_STATS:
        PARSE_STATS[key] = 0


MODEL_PRICING: dict[str, dict[str, float]] = {
    'claude-opus-4-6': {'input': 15.0e-6, 'output': 75.0e-6, 'cache_creation': 18.75e-6, 'cache_read': 1.875e-6},
    'claude-opus-4-5': {'input': 15.0e-6, 'output': 75.0e-6, 'cache_creation': 18.75e-6, 'cache_read': 1.875e-6},
    'claude-sonnet-4-6': {'input': 3.0e-6, 'output': 15.0e-6, 'cache_creation': 3.75e-6, 'cache_read': 0.30e-6},
    'claude-sonnet-4-5': {'input': 3.0e-6, 'output': 15.0e-6, 'cache_creation': 3.75e-6, 'cache_read': 0.30e-6},
    'claude-haiku-4-5': {'input': 0.80e-6, 'output': 4.0e-6, 'cache_creation': 1.0e-6, 'cache_read': 0.08e-6},
    'claude-haiku-3': {'input': 0.25e-6, 'output': 1.25e-6, 'cache_creation': 0.30e-6, 'cache_read': 0.03e-6},
}
DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6']
_ZERO_PRICING = {'input': 0.0, 'output': 0.0, 'cache_creation': 0.0, 'cache_read': 0.0}
_DATE_SUFFIX_RE = re.compile(r'-\d{8}$')
_WARNED_MODELS: set[str] = set()
_warned_lock = threading.Lock()
MICRO = 1_000_000


@dataclass(frozen=True)
class NormalizedCodexRecord:
    event_type: str
    session_id: str
    project_path: str
    project_name: str
    timestamp: str
    payload: dict[str, Any]
    searchable_text: str
    source_path: Path | None = None
    line_number: int | None = None


def get_pricing(model: str) -> dict:
    if not model:
        return DEFAULT_PRICING
    lowered = model.lower()
    if lowered in MODEL_PRICING:
        return MODEL_PRICING[lowered]
    base = _DATE_SUFFIX_RE.sub('', lowered)
    if base in MODEL_PRICING:
        return MODEL_PRICING[base]
    if lowered.startswith('<') or lowered == 'synthetic':
        return _ZERO_PRICING
    for family, key in [('opus', 'claude-opus-4-6'), ('sonnet', 'claude-sonnet-4-6'), ('haiku', 'claude-haiku-4-5')]:
        if family in lowered:
            with _warned_lock:
                if model not in _WARNED_MODELS:
                    _WARNED_MODELS.add(model)
                    logger.warning("Unknown model %r — using %s pricing as fallback", model, key)
            return MODEL_PRICING[key]
    with _warned_lock:
        if model not in _WARNED_MODELS:
            _WARNED_MODELS.add(model)
            logger.warning("Unknown model %r with no family match — using Sonnet pricing", model)
    return DEFAULT_PRICING


def is_real_model(model: str) -> bool:
    if not model:
        return False
    lowered = model.lower()
    if lowered.startswith('<') or lowered == 'synthetic':
        return False
    return ('claude' in lowered) or ('opus' in lowered) or ('sonnet' in lowered) or ('haiku' in lowered)


def calculate_cost_micro(usage: dict, model: str) -> int:
    pricing = get_pricing(model)

    def _i(key: str) -> int | float:
        value = usage.get(key, 0)
        return value if isinstance(value, (int, float)) else 0

    usd = (
        _i('input_tokens') * pricing['input']
        + _i('output_tokens') * pricing['output']
        + _i('cache_creation_input_tokens') * pricing['cache_creation']
        + _i('cache_read_input_tokens') * pricing['cache_read']
    )
    return round(usd * MICRO)


def extract_content_text(content) -> str:
    if content is None:
        return ''
    if isinstance(content, str):
        return content[:2000]
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get('type', '')
            if block_type == 'text':
                parts.append(block.get('text', '')[:1000])
            elif block_type == 'thinking':
                thinking = block.get('thinking', '')
                parts.append(f"[생각중: {thinking[:200]}]" if thinking else '[Extended Thinking]')
            elif block_type == 'tool_use':
                parts.append(f"[Tool: {block.get('name', 'unknown')}]")
            elif block_type == 'tool_result':
                parts.append('[Tool Result]')
        return '\n'.join(parts)[:2000]
    return str(content)[:2000] if content else ''


def _safe_json_content(raw) -> str:
    if raw is None:
        return ''
    full = json.dumps(raw)
    if len(full) <= CONTENT_MAX_BYTES:
        return full
    logger.info("Content truncated: %d bytes → text fallback (%d bytes)", len(full), CONTENT_MAX_BYTES)
    return json.dumps(extract_content_text(raw))


def project_info_from_cwd(cwd: str) -> tuple[str, str]:
    if not cwd:
        return '', ''
    name = PureWindowsPath(cwd).name
    return cwd, name or cwd


def _fallback_project_from_filepath(file_path: str) -> tuple[str, str]:
    path = Path(file_path)
    try:
        rel = path.relative_to(PROJECTS_ROOT)
        encoded_dir = rel.parts[0]
        decoded_path = '/' + encoded_dir.lstrip('-').replace('-', '/')
        parts = [part for part in encoded_dir.lstrip('-').split('-') if part]
        project_name = parts[-1] if parts else encoded_dir
        return decoded_path, project_name
    except Exception:
        return str(path.parent), path.parent.name


def get_project_info(file_path: str, record: Optional[dict] = None) -> tuple[str, str]:
    if record:
        cwd = record.get('cwd')
        if cwd:
            return project_info_from_cwd(cwd)
    return _fallback_project_from_filepath(file_path)


def is_subagent_file(file_path: str) -> bool:
    return 'subagents' in Path(file_path).parts


def subagent_id_from_path(file_path: str) -> Optional[str]:
    if not is_subagent_file(file_path):
        return None
    return Path(file_path).stem


def get_parent_session(file_path: str) -> Optional[str]:
    path = Path(file_path)
    if 'subagents' not in path.parts:
        return None
    try:
        idx = path.parts.index('subagents')
        return path.parts[idx - 1]
    except (ValueError, IndexError):
        return None


def get_agent_meta(file_path: str) -> tuple[str, str]:
    meta_path = Path(file_path).with_suffix('.meta.json')
    if meta_path.exists():
        try:
            with open(meta_path, 'r') as handle:
                meta = json.load(handle)
                return meta.get('agentType', ''), meta.get('description', '')
        except Exception:
            pass
    stem = Path(file_path).stem
    if stem.startswith('agent-acompact-'):
        return 'compact', 'Context compaction'
    return '', ''


def parse_jsonl_file(file_path: str, start_line: int = 0) -> Generator[dict, None, None]:
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as handle:
            for i, line in enumerate(handle):
                if i < start_line:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as exc:
                    _inc_stat('malformed_json')
                    logger.info("Skipping malformed JSON at %s:%d — %s", file_path, i, exc)
                    continue
                if not isinstance(record, dict):
                    _inc_stat('malformed_json')
                    logger.info("Skipping non-object JSONL at %s:%d", file_path, i)
                    continue
                record['_line_number'] = i
                yield record
    except OSError as exc:
        _inc_stat('read_errors')
        logger.error("Error reading %s: %s", file_path, exc)


def effective_session_id(record_session_id: str, file_path: str) -> str:
    sub_id = subagent_id_from_path(file_path)
    return sub_id or record_session_id


def process_record(
    record: dict,
    file_path: str,
    db: sqlite3.Connection,
    source_node: str = 'local',
) -> Optional[dict]:
    if not isinstance(record, dict):
        _inc_stat('process_errors')
        return None
    record_type = record.get('type')
    try:
        if record_type == 'assistant':
            return _process_assistant(record, file_path, db, source_node)
        if record_type == 'user':
            return _process_user(record, file_path, db, source_node)
        if record_type == 'system':
            return _process_system(record, file_path, db, source_node)
    except sqlite3.Error:
        raise
    except Exception as exc:
        _inc_stat('process_errors')
        logger.warning("Skipping record at %s (uuid=%s): %s", file_path, record.get('uuid', '?'), exc)
    return None


def _ensure_session(
    sid: str,
    file_path: str,
    record: dict,
    db: sqlite3.Connection,
    source_node: str = 'local',
):
    project_path, project_name = get_project_info(file_path, record)
    is_sub = is_subagent_file(file_path)
    parent_sid = get_parent_session(file_path) if is_sub else None
    if parent_sid == sid:
        is_sub = False
        parent_sid = None
    agent_type, agent_desc = get_agent_meta(file_path) if is_sub else ('', '')

    cur = db.execute(
        '''
        INSERT OR IGNORE INTO sessions
            (id, project_path, project_name, created_at, updated_at, cwd,
             entrypoint, version, is_subagent, parent_session_id,
             agent_type, agent_description, source_node)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            sid,
            project_path,
            project_name,
            record.get('timestamp', ''),
            record.get('timestamp', ''),
            record.get('cwd', ''),
            record.get('entrypoint', 'cli'),
            record.get('version', ''),
            1 if is_sub else 0,
            parent_sid,
            agent_type,
            agent_desc,
            source_node,
        ),
    )

    if cur.rowcount > 0:
        return project_path, project_name

    row = db.execute(
        'SELECT project_path, project_name FROM sessions WHERE id = ?',
        (sid,),
    ).fetchone()
    stored_path = (row['project_path'] if row else '') or ''
    stored_name = (row['project_name'] if row else '') or ''

    if stored_path and stored_name:
        return stored_path, stored_name

    if project_path and project_name:
        db.execute(
            'UPDATE sessions SET project_path = ?, project_name = ? WHERE id = ?',
            (project_path, project_name, sid),
        )
        return project_path, project_name

    return stored_path or project_path, stored_name or project_name


def _process_assistant(
    record: dict,
    file_path: str,
    db: sqlite3.Connection,
    source_node: str = 'local',
) -> Optional[dict]:
    raw_sid = record.get('sessionId', '')
    if not raw_sid:
        _inc_stat('skipped_no_sid')
        return None
    sid = effective_session_id(raw_sid, file_path)

    msg_raw = record.get('message')
    if msg_raw is not None and not isinstance(msg_raw, dict):
        _inc_stat('process_errors')
        return None
    msg = msg_raw or {}
    usage = msg.get('usage') or {}
    if not isinstance(usage, dict):
        usage = {}
    model = msg.get('model') or ''
    if not isinstance(model, str):
        model = ''
    stop_reason = msg.get('stop_reason') or ''

    input_tok = usage.get('input_tokens', 0)
    output_tok = usage.get('output_tokens', 0)
    cache_create = usage.get('cache_creation_input_tokens', 0)
    cache_read = usage.get('cache_read_input_tokens', 0)
    cost_micro = calculate_cost_micro(usage, model)

    content_raw = msg.get('content', [])
    content_str = _safe_json_content(content_raw)
    preview = extract_content_text(content_raw)

    project_path, project_name = _ensure_session(sid, file_path, record, db, source_node)

    cur = db.execute(
        '''
        INSERT OR IGNORE INTO messages
            (session_id, message_uuid, parent_uuid, role, content, content_preview,
             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
             cost_micro, model, request_id, timestamp, cwd, git_branch, is_sidechain,
             stop_reason)
        VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        (
            sid,
            record.get('uuid', ''),
            record.get('parentUuid', ''),
            content_str,
            preview,
            input_tok,
            output_tok,
            cache_create,
            cache_read,
            cost_micro,
            model,
            record.get('requestId', ''),
            record.get('timestamp', ''),
            record.get('cwd', ''),
            record.get('gitBranch', ''),
            1 if record.get('isSidechain') else 0,
            stop_reason,
        ),
    )
    if cur.rowcount <= 0:
        return None

    if is_real_model(model):
        db.execute(
            '''
            UPDATE sessions SET
                updated_at = ?,
                total_input_tokens = total_input_tokens + ?,
                total_output_tokens = total_output_tokens + ?,
                total_cache_creation_tokens = total_cache_creation_tokens + ?,
                total_cache_read_tokens = total_cache_read_tokens + ?,
                cost_micro = cost_micro + ?,
                message_count = message_count + 1,
                model = ?,
                final_stop_reason = COALESCE(NULLIF(?, ''), final_stop_reason)
            WHERE id = ?
            ''',
            (
                record.get('timestamp', ''),
                input_tok,
                output_tok,
                cache_create,
                cache_read,
                cost_micro,
                model,
                stop_reason,
                sid,
            ),
        )
    else:
        db.execute(
            '''
            UPDATE sessions SET
                updated_at = ?,
                total_input_tokens = total_input_tokens + ?,
                total_output_tokens = total_output_tokens + ?,
                total_cache_creation_tokens = total_cache_creation_tokens + ?,
                total_cache_read_tokens = total_cache_read_tokens + ?,
                cost_micro = cost_micro + ?,
                message_count = message_count + 1,
                final_stop_reason = COALESCE(NULLIF(?, ''), final_stop_reason)
            WHERE id = ?
            ''',
            (
                record.get('timestamp', ''),
                input_tok,
                output_tok,
                cache_create,
                cache_read,
                cost_micro,
                stop_reason,
                sid,
            ),
        )

    return {
        'type': 'new_message',
        'session_id': sid,
        'project_name': project_name,
        'project_path': project_path,
        'input_tokens': input_tok,
        'output_tokens': output_tok,
        'cache_creation_tokens': cache_create,
        'cache_read_tokens': cache_read,
        'cost_usd': cost_micro / MICRO,
        'model': model,
        'timestamp': record.get('timestamp', ''),
        'stop_reason': stop_reason,
        'preview': preview[:300],
        'is_subagent': is_subagent_file(file_path),
    }


def _process_user(
    record: dict,
    file_path: str,
    db: sqlite3.Connection,
    source_node: str = 'local',
) -> Optional[dict]:
    raw_sid = record.get('sessionId', '')
    if not raw_sid:
        _inc_stat('skipped_no_sid')
        return None
    sid = effective_session_id(raw_sid, file_path)

    project_path, project_name = _ensure_session(sid, file_path, record, db, source_node)

    msg = record.get('message') or {}
    if not isinstance(msg, dict):
        msg = {}
    raw = msg.get('content', '')
    if isinstance(raw, list):
        content_str = _safe_json_content(raw)
        preview = extract_content_text(raw)
    elif raw is None:
        content_str = ''
        preview = ''
    else:
        content_str = str(raw)[:CONTENT_MAX_BYTES]
        preview = extract_content_text(raw)

    cur = db.execute(
        '''
        INSERT OR IGNORE INTO messages
            (session_id, message_uuid, parent_uuid, role, content, content_preview,
             timestamp, cwd, git_branch, is_sidechain)
        VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)
        ''',
        (
            sid,
            record.get('uuid', ''),
            record.get('parentUuid', ''),
            content_str,
            preview,
            record.get('timestamp', ''),
            record.get('cwd', ''),
            record.get('gitBranch', ''),
            1 if record.get('isSidechain') else 0,
        ),
    )

    if cur.rowcount > 0:
        db.execute(
            '''
            UPDATE sessions SET updated_at = ?, user_message_count = user_message_count + 1
            WHERE id = ?
            ''',
            (record.get('timestamp', ''), sid),
        )
        return {
            'type': 'new_message',
            'session_id': sid,
            'project_name': project_name,
            'project_path': project_path,
            'role': 'user',
            'timestamp': record.get('timestamp', ''),
            'preview': preview[:300],
            'is_subagent': is_subagent_file(file_path),
        }

    return None


def _process_system(
    record: dict,
    file_path: str,
    db: sqlite3.Connection,
    source_node: str = 'local',
) -> Optional[dict]:
    raw_sid = record.get('sessionId', '')
    if not raw_sid:
        _inc_stat('skipped_no_sid')
        return None
    sid = effective_session_id(raw_sid, file_path)

    duration_ms = record.get('durationMs', 0)
    if not isinstance(duration_ms, (int, float)) or duration_ms <= 0:
        return None

    _ensure_session(sid, file_path, record, db, source_node)
    db.execute(
        '''
        UPDATE sessions
        SET turn_duration_ms = turn_duration_ms + ?,
            updated_at = COALESCE(NULLIF(?, ''), updated_at)
        WHERE id = ?
        ''',
        (int(duration_ms), record.get('timestamp', ''), sid),
    )
    return None


def iter_codex_records(path: Path) -> Iterator[dict[str, Any]]:
    try:
        with path.open('r', encoding='utf-8', errors='replace') as handle:
            for line_number, line in enumerate(handle):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                record['_line_number'] = line_number
                record['_source_path'] = str(path)
                yield record
    except OSError:
        return


def _first_str(raw: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = raw.get(key)
        if value:
            return str(value)
    return ''


def _stringify(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def _payload_dict(raw: dict[str, Any]) -> dict[str, Any]:
    payload = raw.get('payload')
    return payload if isinstance(payload, dict) else {}


def _rollout_session_id_from_path(path: Path | None) -> str:
    if path is None:
        return ''
    match = re.search(r'([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$', path.stem)
    return match.group(1) if match else ''


def _message_text(raw: dict[str, Any]) -> str:
    message = raw.get('message')
    if isinstance(message, dict):
        content = message.get('content')
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict):
                    text = block.get('text') or block.get('content') or block.get('input')
                    if text:
                        parts.append(str(text))
            if parts:
                return ' '.join(parts)
        if content:
            return _stringify(content)
    content = raw.get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                text = block.get('text') or block.get('content') or block.get('input')
                if text:
                    parts.append(str(text))
        return ' '.join(parts)
    return _stringify(content)


def _response_item_text(payload: dict[str, Any]) -> str:
    content = payload.get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            text = block.get('text') or block.get('content') or block.get('output') or block.get('input')
            if text:
                parts.append(str(text))
        return ' '.join(parts)
    return ''


def _timestamp(raw: dict[str, Any]) -> str:
    direct = _first_str(raw, 'timestamp', 'created_at', 'createdAt')
    if direct:
        return direct
    ts = raw.get('ts')
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    if isinstance(ts, str) and ts.isdigit():
        return datetime.fromtimestamp(int(ts), UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    return ''


def normalize_codex_record(raw: dict[str, Any]) -> NormalizedCodexRecord:
    source_path = Path(raw['_source_path']) if raw.get('_source_path') else None
    payload_dict = _payload_dict(raw)
    event_type = _first_str(raw, 'type', 'event_type', 'eventType')
    if not event_type and ('text' in raw or 'message' in raw or 'content' in raw):
        event_type = 'message'
    session_id = _first_str(raw, 'sessionId', 'session_id')
    project_path = _first_str(raw, 'project_path', 'projectPath', 'cwd')
    project_name = PureWindowsPath(project_path).name if project_path else ''
    timestamp = _timestamp(raw)

    if event_type == 'session_meta':
        spawn = (
            payload_dict.get('source', {}).get('subagent', {}).get('thread_spawn', {})
            if isinstance(payload_dict.get('source'), dict)
            else {}
        )
        session_id = _first_str(payload_dict, 'id') or session_id or _rollout_session_id_from_path(source_path)
        project_path = _first_str(payload_dict, 'cwd', 'project_path', 'projectPath')
        project_name = PureWindowsPath(project_path).name if project_path else ''
        timestamp = _first_str(payload_dict, 'timestamp') or timestamp
        event_type = 'agent'
        payload = {
            'agent_name': _first_str(payload_dict, 'agent_nickname') or _first_str(spawn, 'agent_nickname'),
            'status': _first_str(payload_dict, 'agent_role') or _first_str(spawn, 'agent_role') or 'started',
            'parent_thread_id': _first_str(spawn, 'parent_thread_id'),
        }
        searchable_parts = [payload['agent_name'], payload['status'], payload['parent_thread_id']]
    elif event_type == 'response_item' and _first_str(payload_dict, 'type') == 'function_call':
        session_id = session_id or _rollout_session_id_from_path(source_path)
        event_type = 'tool'
        payload = {
            'name': _first_str(payload_dict, 'name'),
            'input': payload_dict.get('arguments') or payload_dict.get('input'),
        }
        searchable_parts = [payload['name'], _stringify(payload['input'])]
    elif event_type == 'response_item' and _first_str(payload_dict, 'type') == 'message':
        session_id = session_id or _rollout_session_id_from_path(source_path)
        event_type = 'message'
        payload = {
            'message': {},
            'content': _response_item_text(payload_dict),
            'role': _first_str(payload_dict, 'role') or 'assistant',
        }
        searchable_parts = [payload['content']]
    elif event_type == 'event_msg':
        session_id = session_id or _rollout_session_id_from_path(source_path)
        payload = {
            'message': {},
            'content': _first_str(payload_dict, 'message'),
            'role': 'assistant',
        }
        event_type = 'message'
        searchable_parts = [payload['content']]
    elif event_type == 'message':
        payload = {
            'message': raw.get('message') if isinstance(raw.get('message'), dict) else {},
            'content': _message_text(raw) or _first_str(raw, 'text'),
        }
        role = _first_str(raw, 'role', 'sender')
        if role:
            payload['role'] = role
        searchable_parts = [payload['content']]
    elif event_type == 'tool':
        payload = {
            'name': _first_str(raw, 'name', 'tool_name', 'toolName'),
            'input': raw.get('input'),
        }
        searchable_parts = [payload['name'], _stringify(payload['input'])]
    elif event_type == 'agent':
        payload = {
            'agent_name': _first_str(raw, 'agent_name', 'agentName', 'name'),
            'status': _first_str(raw, 'status'),
        }
        searchable_parts = [payload['agent_name'], payload['status']]
    else:
        payload = {key: value for key, value in raw.items() if not key.startswith('_')}
        searchable_parts = [_stringify(payload)]

    searchable_text = ' '.join(
        part
        for part in [event_type, session_id, project_name, project_path, timestamp, *searchable_parts]
        if part
    )

    return NormalizedCodexRecord(
        event_type=event_type,
        session_id=session_id,
        project_path=project_path,
        project_name=project_name,
        timestamp=timestamp,
        payload=payload,
        searchable_text=searchable_text,
        source_path=source_path,
        line_number=raw.get('_line_number'),
    )
