#!/usr/bin/env python3
"""
Claude Dashboard — Remote Collector Agent.

Lightweight agent that watches ~/.claude/projects/**/*.jsonl on a remote
server and pushes new records to a central dashboard via POST /api/ingest.

Dependencies: Python 3.9+ stdlib only (no pip install needed).

Usage:
    python collector.py \
        --url https://dashboard.example.com \
        --node-id server-prod-1 \
        --ingest-key <key-from-POST-/api/nodes>

    # Optional:
    --interval 5          # poll interval in seconds (default 5)
    --state-file .collector-state.json   # track progress across restarts
    --batch-size 200      # max records per HTTP request (default 200)
"""
import argparse
import json
import logging
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CLAUDE_PROJECTS = Path.home() / '.claude' / 'projects'
DEFAULT_STATE_FILE = Path.home() / '.claude' / '.collector-state.json'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s collector: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S',
)
logger = logging.getLogger(__name__)


def load_state(path: Path) -> dict:
    # Clean stale .tmp from previous crash
    tmp = path.with_suffix('.tmp')
    if tmp.exists():
        try:
            tmp.unlink()
            logger.info("Removed stale %s", tmp)
        except OSError:
            pass
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            logger.warning("Corrupt state file %s — starting fresh", path)
    return {}


def save_state(path: Path, state: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    try:
        # Clean stale tmp from previous crash
        if tmp.exists():
            tmp.unlink()
        tmp.write_text(json.dumps(state, indent=2))
        # shutil.move works cross-device; Path.rename does not
        shutil.move(str(tmp), str(path))
    except OSError as e:
        logger.warning("Atomic save failed (%s), falling back to direct write", e)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        path.write_text(json.dumps(state, indent=2))


def scan_files(state: dict) -> list[tuple[str, int]]:
    """Return list of (file_path, start_line) for files with new content."""
    if not CLAUDE_PROJECTS.is_dir():
        return []
    changed = []
    for f in CLAUDE_PROJECTS.rglob('*.jsonl'):
        fp = str(f)
        try:
            st = f.stat()
            mtime, size = st.st_mtime, st.st_size
        except OSError:
            continue
        prev = state.get(fp, {})
        if prev.get('mtime') == mtime and prev.get('size') == size:
            continue
        changed.append((fp, prev.get('last_line', 0)))
    return changed


def read_new_lines(file_path: str, start_line: int) -> list[dict]:
    """Read JSONL file from start_line, return parsed records."""
    records = []
    try:
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i < start_line:
                    continue
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict):
                        obj['_line_number'] = i
                        records.append(obj)
                except json.JSONDecodeError:
                    pass
    except OSError as e:
        logger.warning("Cannot read %s: %s", file_path, e)
    return records


def send_batch(url: str, node_id: str, ingest_key: str,
               file_path: str, records: list[dict],
               timeout: int = 30) -> dict:
    """POST a batch of records to the dashboard."""
    payload = json.dumps({
        'node_id': node_id,
        'file_path': file_path,
        'records': records,
    }).encode()

    req = urllib.request.Request(
        f'{url.rstrip("/")}/api/ingest',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'X-Ingest-Key': ingest_key,
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='replace')[:500]
        logger.error("HTTP %d from %s: %s", e.code, url, body)
        raise
    except urllib.error.URLError as e:
        logger.error("Connection failed to %s: %s", url, e.reason)
        raise


def run_once(url: str, node_id: str, ingest_key: str,
             state: dict, state_path: Path, batch_size: int):
    """Single poll cycle: scan → read → send → save state."""
    changed = scan_files(state)
    if not changed:
        return 0

    total_sent = 0
    for file_path, start_line in changed:
        records = read_new_lines(file_path, start_line)
        if not records:
            # File changed (mtime) but no new parseable lines — update state
            try:
                st = os.stat(file_path)
                state[file_path] = {
                    'last_line': start_line,
                    'mtime': st.st_mtime,
                    'size': st.st_size,
                }
            except OSError:
                pass
            continue

        # Send in batches
        for i in range(0, len(records), batch_size):
            batch = records[i:i + batch_size]
            try:
                result = send_batch(url, node_id, ingest_key,
                                    file_path, batch)
                total_sent += result.get('accepted', 0)
                logger.info("Sent %d records from %s (accepted=%d, skipped=%d)",
                            len(batch),
                            Path(file_path).name,
                            result.get('accepted', 0),
                            result.get('skipped', 0))
            except Exception:
                logger.warning("Failed to send batch for %s — will retry",
                               Path(file_path).name)
                break  # Don't advance state for this file
        else:
            # All batches sent successfully — update state
            last_line = max(r.get('_line_number', 0) for r in records) + 1
            try:
                st = os.stat(file_path)
                state[file_path] = {
                    'last_line': last_line,
                    'mtime': st.st_mtime,
                    'size': st.st_size,
                }
            except OSError:
                pass

    save_state(state_path, state)
    return total_sent


def main():
    parser = argparse.ArgumentParser(
        description='Claude Dashboard remote collector agent')
    parser.add_argument('--url', required=True,
                        help='Dashboard base URL (e.g. https://dash.example.com)')
    parser.add_argument('--node-id', required=True,
                        help='Node identifier (registered via POST /api/nodes)')
    parser.add_argument('--ingest-key', default=None,
                        help='Ingest API key (prefer INGEST_KEY env var or --ingest-key-file)')
    parser.add_argument('--ingest-key-file', type=Path, default=None,
                        help='File containing the ingest key (one line)')
    parser.add_argument('--interval', type=float, default=5.0,
                        help='Poll interval in seconds (default: 5)')
    parser.add_argument('--state-file', type=Path,
                        default=DEFAULT_STATE_FILE,
                        help='State file path (default: ~/.claude/.collector-state.json)')
    parser.add_argument('--batch-size', type=int, default=200,
                        help='Max records per HTTP request (default: 200)')
    parser.add_argument('--once', action='store_true',
                        help='Run a single scan and exit')
    args = parser.parse_args()

    # Resolve ingest key: env var > file > CLI arg
    ingest_key = os.environ.get('INGEST_KEY') or None
    if not ingest_key and args.ingest_key_file:
        try:
            ingest_key = args.ingest_key_file.read_text().strip()
        except OSError as e:
            logger.error("Cannot read key file %s: %s", args.ingest_key_file, e)
            sys.exit(1)
    if not ingest_key:
        ingest_key = args.ingest_key
    if not ingest_key:
        logger.error("No ingest key provided. Use INGEST_KEY env var, "
                      "--ingest-key-file, or --ingest-key")
        sys.exit(1)

    logger.info("Collector starting: node=%s url=%s interval=%.0fs",
                args.node_id, args.url, args.interval)
    logger.info("Watching: %s", CLAUDE_PROJECTS)
    logger.info("State file: %s", args.state_file)

    state = load_state(args.state_file)

    if args.once:
        sent = run_once(args.url, args.node_id, ingest_key,
                        state, args.state_file, args.batch_size)
        logger.info("Single run complete: %d records sent", sent)
        return

    while True:
        try:
            sent = run_once(args.url, args.node_id, ingest_key,
                            state, args.state_file, args.batch_size)
            if sent:
                logger.info("Cycle complete: %d records sent", sent)
        except KeyboardInterrupt:
            logger.info("Shutting down")
            save_state(args.state_file, state)
            break
        except Exception:
            logger.exception("Unexpected error in poll cycle")

        try:
            time.sleep(args.interval)
        except KeyboardInterrupt:
            logger.info("Shutting down")
            save_state(args.state_file, state)
            break


if __name__ == '__main__':
    main()
