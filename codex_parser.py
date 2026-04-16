"""Codex JSONL reader and normalization scaffold."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Iterator


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


def normalize_codex_record(raw: dict[str, Any]) -> NormalizedCodexRecord:
    event_type = _first_str(raw, 'type', 'event_type', 'eventType')
    session_id = _first_str(raw, 'sessionId', 'session_id')
    project_path = _first_str(raw, 'project_path', 'projectPath', 'cwd')
    project_name = PureWindowsPath(project_path).name if project_path else ''
    timestamp = _first_str(raw, 'timestamp', 'created_at', 'createdAt')

    if event_type == 'message':
        payload = {
            'message': raw.get('message') if isinstance(raw.get('message'), dict) else {},
            'content': _message_text(raw),
        }
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
        payload = {
            key: value for key, value in raw.items()
            if not key.startswith('_')
        }
        searchable_parts = [_stringify(payload)]

    searchable_text = ' '.join(
        part for part in [
            event_type,
            session_id,
            project_name,
            project_path,
            timestamp,
            *searchable_parts,
        ] if part
    )

    return NormalizedCodexRecord(
        event_type=event_type,
        session_id=session_id,
        project_path=project_path,
        project_name=project_name,
        timestamp=timestamp,
        payload=payload,
        searchable_text=searchable_text,
        source_path=Path(raw['_source_path']) if raw.get('_source_path') else None,
        line_number=raw.get('_line_number'),
    )
