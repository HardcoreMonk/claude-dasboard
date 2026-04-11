#!/usr/bin/env python3
"""
One-shot importer for claude.ai's "Export data" archive.

Usage:
    ./.venv/bin/python import_claude_ai.py --zip /path/to/data-*.zip
    ./.venv/bin/python import_claude_ai.py --zip /path/to/data-*.zip --dry-run

The archive contains users.json / projects.json / memories.json /
conversations.json. We only import conversations.json. Rows are keyed by
conversation + message UUIDs so re-running the importer is idempotent
(ON CONFLICT DO UPDATE on conversations, INSERT OR IGNORE on messages).

The export does NOT include token counts, model names, or cost, so we
store content only. The data lives in claude_ai_* tables and never
pollutes the existing sessions/messages aggregates.
"""
import argparse
import json
import logging
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from database import init_db, write_db, read_db

logger = logging.getLogger(__name__)

PREVIEW_LIMIT = 2048   # bytes stored in content_preview for FTS indexing


def _flatten_content(content_blocks: list) -> tuple[str, int, int]:
    """Return (flattened_text, has_thinking, has_tool_use).

    Flattened text concatenates all ``text`` blocks plus thinking blocks
    (prefixed) plus tool_use descriptions, so FTS can find them.
    """
    parts: list[str] = []
    has_thinking = 0
    has_tool_use = 0
    if not isinstance(content_blocks, list):
        return '', 0, 0
    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get('type')
        if btype == 'text':
            txt = block.get('text') or ''
            if txt:
                parts.append(txt)
        elif btype == 'thinking':
            has_thinking = 1
            txt = block.get('thinking') or ''
            if txt:
                parts.append(f'[thinking] {txt}')
        elif btype == 'tool_use':
            has_tool_use = 1
            name = block.get('name') or ''
            msg = block.get('message') or ''
            inp = block.get('input') or {}
            parts.append(f'[tool_use:{name}] {msg}')
            # Include a shallow input repr for search (bounded)
            if isinstance(inp, dict):
                for k, v in inp.items():
                    if isinstance(v, str) and v:
                        parts.append(f'{k}={v[:500]}')
        elif btype == 'tool_result':
            content = block.get('content')
            if isinstance(content, str) and content:
                parts.append(f'[tool_result] {content[:2000]}')
            elif isinstance(content, list):
                for sub in content:
                    if isinstance(sub, dict) and sub.get('type') == 'text':
                        parts.append(f'[tool_result] {(sub.get("text") or "")[:2000]}')
    return '\n'.join(parts), has_thinking, has_tool_use


def _extract_conversations(zip_path: Path) -> list[dict]:
    """Unpack conversations.json to a tempdir and parse it."""
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        with zipfile.ZipFile(zip_path) as zf:
            if 'conversations.json' not in zf.namelist():
                raise SystemExit(f"zip does not contain conversations.json: {zip_path}")
            zf.extract('conversations.json', td_path)
        target = td_path / 'conversations.json'
        with open(target, 'r', encoding='utf-8') as f:
            return json.load(f)


def import_archive(zip_path: Path, dry_run: bool = False) -> dict:
    conversations = _extract_conversations(zip_path)
    if not isinstance(conversations, list):
        raise SystemExit("conversations.json is not a list")

    init_db()   # ensures v9 tables exist

    stats = {
        'conversations_total': len(conversations),
        'conversations_nonempty': 0,
        'conversations_upserted': 0,
        'messages_inserted': 0,
        'messages_skipped_dupe': 0,
    }

    imported_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    if dry_run:
        # Count only — don't touch the DB
        for conv in conversations:
            msgs = conv.get('chat_messages') or []
            if msgs:
                stats['conversations_nonempty'] += 1
                stats['messages_inserted'] += len(msgs)
        return stats

    with write_db() as db:
        for conv in conversations:
            uuid = conv.get('uuid')
            if not uuid:
                continue
            msgs = conv.get('chat_messages') or []
            if not msgs:
                # Still upsert the conversation row so the user can see
                # it exists in their export — but skip message import.
                pass
            else:
                stats['conversations_nonempty'] += 1

            user_count = sum(1 for m in msgs if m.get('sender') == 'human')
            att_count = sum(len(m.get('attachments') or []) for m in msgs)
            file_count = sum(len(m.get('files') or []) for m in msgs)

            db.execute('''
                INSERT INTO claude_ai_conversations
                    (uuid, name, summary, created_at, updated_at,
                     message_count, user_message_count, attachment_count,
                     file_count, total_text_bytes, imported_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(uuid) DO UPDATE SET
                    name              = excluded.name,
                    summary           = excluded.summary,
                    created_at        = excluded.created_at,
                    updated_at        = excluded.updated_at,
                    message_count     = excluded.message_count,
                    user_message_count= excluded.user_message_count,
                    attachment_count  = excluded.attachment_count,
                    file_count        = excluded.file_count,
                    imported_at       = excluded.imported_at
            ''', (
                uuid,
                conv.get('name') or '',
                conv.get('summary') or '',
                conv.get('created_at') or '',
                conv.get('updated_at') or '',
                len(msgs),
                user_count,
                att_count,
                file_count,
                imported_at,
            ))
            stats['conversations_upserted'] += 1

            total_text_bytes = 0
            for msg in msgs:
                mu = msg.get('uuid')
                if not mu:
                    continue
                content_blocks = msg.get('content') or []
                text, has_thinking, has_tool_use = _flatten_content(content_blocks)
                if not text:
                    # fall back to the top-level "text" field
                    text = msg.get('text') or ''
                total_text_bytes += len(text.encode('utf-8'))
                preview = text[:PREVIEW_LIMIT]

                cur = db.execute('''
                    INSERT OR IGNORE INTO claude_ai_messages
                        (conversation_uuid, message_uuid, parent_message_uuid,
                         sender, created_at, text, content_preview, content_json,
                         has_thinking, has_tool_use,
                         attachment_count, file_count)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    uuid,
                    mu,
                    msg.get('parent_message_uuid') or '',
                    msg.get('sender') or '',
                    msg.get('created_at') or '',
                    text,
                    preview,
                    json.dumps(content_blocks, ensure_ascii=False),
                    has_thinking,
                    has_tool_use,
                    len(msg.get('attachments') or []),
                    len(msg.get('files') or []),
                ))
                if cur.rowcount > 0:
                    stats['messages_inserted'] += 1
                else:
                    stats['messages_skipped_dupe'] += 1

            if total_text_bytes:
                db.execute(
                    'UPDATE claude_ai_conversations SET total_text_bytes = ? WHERE uuid = ?',
                    (total_text_bytes, uuid),
                )

    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--zip', required=True, type=Path,
                    help='Path to claude.ai data export zip')
    ap.add_argument('--dry-run', action='store_true',
                    help="Parse and count but don't write to DB")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s: %(message)s',
    )

    if not args.zip.exists():
        print(f"error: zip not found: {args.zip}", file=sys.stderr)
        sys.exit(1)

    logger.info("Importing %s …", args.zip)
    stats = import_archive(args.zip, dry_run=args.dry_run)

    print()
    print("Import summary:")
    print(f"  conversations total       : {stats['conversations_total']}")
    print(f"  conversations non-empty   : {stats['conversations_nonempty']}")
    if args.dry_run:
        print(f"  messages (would insert)   : {stats['messages_inserted']}")
        print("  (dry run — no changes written)")
    else:
        print(f"  conversations upserted    : {stats['conversations_upserted']}")
        print(f"  messages inserted         : {stats['messages_inserted']}")
        print(f"  messages skipped (dupe)   : {stats['messages_skipped_dupe']}")

    if not args.dry_run:
        with read_db() as db:
            row = db.execute(
                'SELECT COUNT(*) AS c, COUNT(DISTINCT conversation_uuid) AS d '
                'FROM claude_ai_messages'
            ).fetchone()
            print(f"  DB totals: {row['c']} messages across {row['d']} conversations")


if __name__ == '__main__':
    main()
