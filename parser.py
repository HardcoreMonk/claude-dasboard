"""
JSONL parser for Claude Code session files.

All DB operations assume the caller manages the transaction.
No commit() calls inside — the caller's write_db() context does that.
"""
import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Generator, Optional

logger = logging.getLogger(__name__)

CLAUDE_PROJECTS = Path.home() / '.claude' / 'projects'
CONTENT_MAX_BYTES = 100_000  # 100 KB cap

# Process-wide counters for malformed / skipped input. The watcher can
# sample these to expose Prometheus gauges without adding tight coupling.
PARSE_STATS: dict[str, int] = {
    'malformed_json': 0,      # json.loads() raised — the line was not valid JSON
    'read_errors': 0,         # OSError reading the file
    'process_errors': 0,      # a parseable record blew up inside process_record
    'skipped_no_sid': 0,      # record had no sessionId — cannot place
}


def reset_parse_stats() -> None:
    for k in PARSE_STATS:
        PARSE_STATS[k] = 0

# ─── Pricing ──────────────────────────────────────────────────────────────────

MODEL_PRICING: dict[str, dict[str, float]] = {
    'claude-opus-4-6':   {'input': 15.0e-6, 'output': 75.0e-6, 'cache_creation': 18.75e-6, 'cache_read': 1.875e-6},
    'claude-opus-4-5':   {'input': 15.0e-6, 'output': 75.0e-6, 'cache_creation': 18.75e-6, 'cache_read': 1.875e-6},
    'claude-sonnet-4-6': {'input':  3.0e-6, 'output': 15.0e-6, 'cache_creation':  3.75e-6, 'cache_read': 0.30e-6},
    'claude-sonnet-4-5': {'input':  3.0e-6, 'output': 15.0e-6, 'cache_creation':  3.75e-6, 'cache_read': 0.30e-6},
    'claude-haiku-4-5':  {'input':  0.80e-6, 'output': 4.0e-6, 'cache_creation':  1.0e-6,  'cache_read': 0.08e-6},
    'claude-haiku-3':    {'input':  0.25e-6, 'output': 1.25e-6, 'cache_creation':  0.30e-6, 'cache_read': 0.03e-6},
}
DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6']
_ZERO_PRICING = {'input': 0.0, 'output': 0.0, 'cache_creation': 0.0, 'cache_read': 0.0}

_DATE_SUFFIX_RE = re.compile(r'-\d{8}$')

# One-shot warning cache so unknown models don't spam the log per-message
_WARNED_MODELS: set[str] = set()


def get_pricing(model: str) -> dict:
    if not model:
        return DEFAULT_PRICING
    m = model.lower()
    if m in MODEL_PRICING:
        return MODEL_PRICING[m]
    # Strip date suffix  (e.g. claude-opus-4-6-20261001 → claude-opus-4-6)
    base = _DATE_SUFFIX_RE.sub('', m)
    if base in MODEL_PRICING:
        return MODEL_PRICING[base]
    # Synthetic / internal markers → zero cost
    if m.startswith('<') or m == 'synthetic':
        return _ZERO_PRICING
    # Family fallback with explicit warning (once per process per unknown model)
    for family, key in [('opus', 'claude-opus-4-6'),
                        ('sonnet', 'claude-sonnet-4-6'),
                        ('haiku', 'claude-haiku-4-5')]:
        if family in m:
            if model not in _WARNED_MODELS:
                _WARNED_MODELS.add(model)
                logger.warning(
                    "Unknown model %r — using %s pricing as fallback", model, key)
            return MODEL_PRICING[key]
    if model not in _WARNED_MODELS:
        _WARNED_MODELS.add(model)
        logger.warning(
            "Unknown model %r with no family match — using Sonnet pricing", model)
    return DEFAULT_PRICING


def is_real_model(model: str) -> bool:
    """True if the model string looks like a real Claude model (not synthetic/meta)."""
    if not model:
        return False
    m = model.lower()
    if m.startswith('<') or m == 'synthetic':
        return False
    return ('claude' in m) or ('opus' in m) or ('sonnet' in m) or ('haiku' in m)


MICRO = 1_000_000  # 1 USD = 1M micro-dollars


def calculate_cost_micro(usage: dict, model: str) -> int:
    """Return cost in micro-dollars (integer). 1 USD = 1,000,000.

    Defensive against malformed usage dicts — any non-int field counts as 0.
    """
    p = get_pricing(model)
    def _i(k):
        v = usage.get(k, 0)
        return v if isinstance(v, (int, float)) else 0
    usd = (
        _i('input_tokens') * p['input']
        + _i('output_tokens') * p['output']
        + _i('cache_creation_input_tokens') * p['cache_creation']
        + _i('cache_read_input_tokens') * p['cache_read']
    )
    return round(usd * MICRO)


# ─── Content helpers ──────────────────────────────────────────────────────────

def extract_content_text(content) -> str:
    if isinstance(content, str):
        return content[:2000]
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get('type', '')
            if btype == 'text':
                parts.append(block.get('text', '')[:1000])
            elif btype == 'thinking':
                th = block.get('thinking', '')
                parts.append(f"[생각중: {th[:200]}]" if th else '[Extended Thinking]')
            elif btype == 'tool_use':
                parts.append(f"[Tool: {block.get('name', 'unknown')}]")
            elif btype == 'tool_result':
                parts.append('[Tool Result]')
        return '\n'.join(parts)[:2000]
    return str(content)[:2000] if content else ''


def _safe_json_content(raw) -> str:
    """Serialise content to JSON, capping at CONTENT_MAX_BYTES.

    If the full JSON is too large, store a text-only fallback
    instead of truncated (unparseable) JSON.
    """
    full = json.dumps(raw)
    if len(full) <= CONTENT_MAX_BYTES:
        return full
    logger.info("Content truncated: %d bytes → text fallback (%d bytes)",
                len(full), CONTENT_MAX_BYTES)
    return json.dumps(extract_content_text(raw))


# ─── Project / subagent helpers ───────────────────────────────────────────────

def project_info_from_cwd(cwd: str) -> tuple[str, str]:
    """Derive (project_path, project_name) from a CWD string.

    Unlike the legacy ``encoded_dir.replace('-', '/')`` approach, this handles
    original paths that contain dashes correctly (e.g. ``claude-dashboard``).
    """
    if not cwd:
        return '', ''
    p = Path(cwd)
    return str(p), p.name or str(p)


def _fallback_project_from_filepath(file_path: str) -> tuple[str, str]:
    """Last-resort derivation when no cwd is in the JSONL record.

    Claude Code encodes CWD by replacing ``/`` with ``-`` in the directory
    name under ``~/.claude/projects``. This round-trip is lossy (original
    ``-`` collides with separators), but it's only used when the record
    itself lacks a cwd field.
    """
    path = Path(file_path)
    try:
        rel = path.relative_to(CLAUDE_PROJECTS)
        encoded_dir = rel.parts[0]
        decoded_path = '/' + encoded_dir.lstrip('-').replace('-', '/')
        # Best-effort: last non-empty segment
        parts = [p for p in encoded_dir.lstrip('-').split('-') if p]
        project_name = parts[-1] if parts else encoded_dir
        return decoded_path, project_name
    except Exception:
        return str(path.parent), path.parent.name


def get_project_info(file_path: str, record: Optional[dict] = None) -> tuple[str, str]:
    """Derive (project_path, project_name) from a JSONL record's cwd.

    Falls back to the directory-encoding heuristic only when cwd is absent.
    """
    if record:
        cwd = record.get('cwd')
        if cwd:
            return project_info_from_cwd(cwd)
    return _fallback_project_from_filepath(file_path)


def is_subagent_file(file_path: str) -> bool:
    """True if the JSONL lives under a ``subagents/`` directory."""
    return 'subagents' in Path(file_path).parts


def subagent_id_from_path(file_path: str) -> Optional[str]:
    """Derive the unique subagent ID from the filename.

    Claude Code stores subagent transcripts as
    ``.../<parent-sid>/subagents/agent-<hash>.jsonl``. The record ``sessionId``
    field inside those files points to the *parent* session (which is
    misleading — it makes subagent records merge into the parent row unless
    we override with this filename-based identity).
    """
    if not is_subagent_file(file_path):
        return None
    return Path(file_path).stem  # 'agent-a4db550dc66c6a1d7'


def get_parent_session(file_path: str) -> Optional[str]:
    """Return the parent session ID for a subagent file, or None."""
    path = Path(file_path)
    if 'subagents' not in path.parts:
        return None
    try:
        idx = path.parts.index('subagents')
        return path.parts[idx - 1]
    except (ValueError, IndexError):
        return None


def get_agent_meta(file_path: str) -> tuple[str, str]:
    """Load ``agent-<hash>.meta.json`` sidecar data (agentType, description).

    Fallback: if no meta sidecar exists but the filename starts with the
    ``agent-acompact-`` prefix, synthesise ``agentType='compact'``. Claude
    Code uses this prefix for context-compaction subagents, which don't ship
    a meta sidecar yet often consume the most tokens.
    """
    meta_path = Path(file_path).with_suffix('.meta.json')
    if meta_path.exists():
        try:
            with open(meta_path, 'r') as f:
                meta = json.load(f)
                return meta.get('agentType', ''), meta.get('description', '')
        except Exception:
            pass
    stem = Path(file_path).stem
    if stem.startswith('agent-acompact-'):
        return 'compact', 'Context compaction'
    return '', ''


# ─── JSONL reader ─────────────────────────────────────────────────────────────

def parse_jsonl_file(file_path: str, start_line: int = 0) -> Generator[dict, None, None]:
    """Yield records from a JSONL file, skipping (and counting) malformed lines.

    A single broken line must never abort ingestion of the rest of the file.
    PARSE_STATS tracks the running malformed/read counts for observability.
    """
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i < start_line:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as e:
                    PARSE_STATS['malformed_json'] += 1
                    logger.info("Skipping malformed JSON at %s:%d — %s", file_path, i, e)
                    continue
                if not isinstance(record, dict):
                    # A JSONL line must be an object. Arrays/strings/numbers
                    # are nonsensical here; skip and count.
                    PARSE_STATS['malformed_json'] += 1
                    logger.info("Skipping non-object JSONL at %s:%d", file_path, i)
                    continue
                record['_line_number'] = i
                yield record
    except OSError as e:
        PARSE_STATS['read_errors'] += 1
        logger.error("Error reading %s: %s", file_path, e)


# ─── Record processing (caller owns the transaction) ─────────────────────────

def effective_session_id(record_session_id: str, file_path: str) -> str:
    """The session identifier we store in the DB.

    For subagent transcripts this is the *filename* (e.g. ``agent-a4db55...``),
    NOT the ``sessionId`` field inside the records (which points to the parent).
    """
    sub_id = subagent_id_from_path(file_path)
    return sub_id or record_session_id


def process_record(record: dict, file_path: str, db: sqlite3.Connection) -> Optional[dict]:
    """Insert/update DB rows for one JSONL record.  No commit — caller does that.

    All exceptions inside a record are contained: a single malformed record
    must not abort processing of the rest of the file. sqlite3.Error is
    re-raised because that indicates corruption that needs the outer
    transaction to roll back.
    """
    if not isinstance(record, dict):
        PARSE_STATS['process_errors'] += 1
        return None
    rtype = record.get('type')
    try:
        if rtype == 'assistant':
            return _process_assistant(record, file_path, db)
        if rtype == 'user':
            return _process_user(record, file_path, db)
    except sqlite3.Error:
        raise  # let the outer write_db() rollback
    except Exception as e:
        PARSE_STATS['process_errors'] += 1
        logger.warning("Skipping record at %s (uuid=%s): %s",
                       file_path, record.get('uuid', '?'), e)
    return None


def _ensure_session(sid: str, file_path: str, record: dict, db: sqlite3.Connection):
    """Ensure a session row exists.

    Notes on subagents (C5 fix):
    - ``sid`` here is the *effective* session ID — for subagents it's the
      filename, not the JSONL record's ``sessionId`` field.
    - The ``parent_session_id`` column stores the TRUE parent (directory
      segment), only when we can prove it differs from the session itself.
    """
    project_path, project_name = get_project_info(file_path, record)
    is_sub = is_subagent_file(file_path)
    parent_sid = get_parent_session(file_path) if is_sub else None
    # A parent session that happens to be processed via a subagent file
    # (possible if the record's sessionId == directory name) must not be
    # tagged as a subagent of itself.
    if parent_sid == sid:
        is_sub = False
        parent_sid = None
    agent_type, agent_desc = get_agent_meta(file_path) if is_sub else ('', '')

    cur = db.execute('''
        INSERT OR IGNORE INTO sessions
            (id, project_path, project_name, created_at, updated_at, cwd,
             entrypoint, version, is_subagent, parent_session_id,
             agent_type, agent_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        sid, project_path, project_name,
        record.get('timestamp', ''), record.get('timestamp', ''),
        record.get('cwd', ''), record.get('entrypoint', 'cli'),
        record.get('version', ''),
        1 if is_sub else 0, parent_sid, agent_type, agent_desc,
    ))

    # Freshly-inserted row already has correct values.
    if cur.rowcount > 0:
        return project_path, project_name

    # Existing row — two possible heals:
    #   a) project_path drifted (from pre-v4 dash-decoding); fix it.
    #   b) legacy row tagged as its own subagent (parent_session_id = id);
    #      clear the flag. Only touch the row when we can prove a mismatch.
    need_path_update = (
        project_path and record.get('cwd') and
        (db.execute('SELECT project_path FROM sessions WHERE id = ?', (sid,))
           .fetchone() or {'project_path': ''})['project_path'] != project_path
    )
    if need_path_update:
        db.execute(
            'UPDATE sessions SET project_path = ?, project_name = ? WHERE id = ?',
            (project_path, project_name, sid),
        )

    return project_path, project_name


def _process_assistant(record: dict, file_path: str, db: sqlite3.Connection) -> Optional[dict]:
    raw_sid = record.get('sessionId', '')
    if not raw_sid:
        PARSE_STATS['skipped_no_sid'] += 1
        return None
    sid = effective_session_id(raw_sid, file_path)

    msg_raw = record.get('message')
    if msg_raw is not None and not isinstance(msg_raw, dict):
        # Malformed: ``message`` should always be an object on assistant
        # records. Skip entirely instead of silently creating a zero-cost row.
        PARSE_STATS['process_errors'] += 1
        return None
    msg = msg_raw or {}
    usage = msg.get('usage') or {}
    if not isinstance(usage, dict):
        usage = {}
    model = msg.get('model') or ''
    if not isinstance(model, str):
        model = ''
    stop_reason = msg.get('stop_reason') or ''

    input_tok    = usage.get('input_tokens', 0)
    output_tok   = usage.get('output_tokens', 0)
    cache_create = usage.get('cache_creation_input_tokens', 0)
    cache_read   = usage.get('cache_read_input_tokens', 0)
    cm = calculate_cost_micro(usage, model)

    content_raw = msg.get('content', [])
    content_str = _safe_json_content(content_raw)
    preview = extract_content_text(content_raw)

    project_path, project_name = _ensure_session(sid, file_path, record, db)

    cur = db.execute('''
        INSERT OR IGNORE INTO messages
            (session_id, message_uuid, parent_uuid, role, content, content_preview,
             input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
             cost_micro, model, request_id, timestamp, cwd, git_branch, is_sidechain,
             stop_reason)
        VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        sid, record.get('uuid', ''), record.get('parentUuid', ''),
        content_str, preview,
        input_tok, output_tok, cache_create, cache_read,
        cm, model, record.get('requestId', ''),
        record.get('timestamp', ''), record.get('cwd', ''),
        record.get('gitBranch', ''), 1 if record.get('isSidechain') else 0,
        stop_reason,
    ))

    if cur.rowcount <= 0:
        return None

    # Only overwrite session.model with a REAL model (not synthetic/meta).
    # This is the fix for C1 — prevents `<synthetic>` from hijacking a session's
    # displayed primary model and throwing off /api/stats aggregations.
    # final_stop_reason stays sticky on COALESCE(NULLIF(?, ''), final_stop_reason) —
    # we only overwrite when the incoming record actually carries a stop_reason.
    if is_real_model(model):
        db.execute('''
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
        ''', (record.get('timestamp', ''),
              input_tok, output_tok, cache_create, cache_read, cm,
              model, stop_reason, sid))
    else:
        db.execute('''
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
        ''', (record.get('timestamp', ''),
              input_tok, output_tok, cache_create, cache_read, cm,
              stop_reason, sid))

    return {
        'type': 'new_message',
        'session_id': sid,
        'project_name': project_name,
        'project_path': project_path,
        'input_tokens': input_tok,
        'output_tokens': output_tok,
        'cache_creation_tokens': cache_create,
        'cache_read_tokens': cache_read,
        'cost_usd': cm / MICRO,
        'model': model,
        'timestamp': record.get('timestamp', ''),
        # Forwarded to the WS broadcast so the frontend can show an
        # "input awaiting" notification when stop_reason === 'end_turn'.
        'stop_reason': stop_reason,
        'preview': preview[:300],
    }


def _process_user(record: dict, file_path: str, db: sqlite3.Connection) -> Optional[dict]:
    raw_sid = record.get('sessionId', '')
    if not raw_sid:
        PARSE_STATS['skipped_no_sid'] += 1
        return None
    sid = effective_session_id(raw_sid, file_path)

    _ensure_session(sid, file_path, record, db)

    msg = record.get('message') or {}
    if not isinstance(msg, dict):
        msg = {}
    raw = msg.get('content', '')
    if isinstance(raw, list):
        content_str = _safe_json_content(raw)
        preview = extract_content_text(raw)
    else:
        content_str = str(raw)[:CONTENT_MAX_BYTES]
        preview = extract_content_text(raw)  # consistent with list path

    cur = db.execute('''
        INSERT OR IGNORE INTO messages
            (session_id, message_uuid, parent_uuid, role, content, content_preview,
             timestamp, cwd, git_branch, is_sidechain)
        VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)
    ''', (
        sid, record.get('uuid', ''), record.get('parentUuid', ''),
        content_str, preview,
        record.get('timestamp', ''), record.get('cwd', ''),
        record.get('gitBranch', ''), 1 if record.get('isSidechain') else 0,
    ))

    if cur.rowcount > 0:
        db.execute('''
            UPDATE sessions SET updated_at = ?, user_message_count = user_message_count + 1
            WHERE id = ?
        ''', (record.get('timestamp', ''), sid))

    return None
