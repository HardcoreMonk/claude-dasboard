"""Discovery helpers for Codex JSONL logs."""
from pathlib import Path


def codex_roots(home: Path) -> list[Path]:
    candidates = [
        home / '.codex' / 'sessions',
        home / '.codex' / 'projects',
        home / '.codex' / 'logs',
    ]
    roots: list[Path] = []
    seen: set[Path] = set()
    for path in candidates:
        if path.exists() and path.is_dir() and path not in seen:
            roots.append(path)
            seen.add(path)
    return roots


def discover_codex_logs(home: Path) -> list[Path]:
    logs: list[Path] = []
    seen: set[Path] = set()
    for root in codex_roots(home):
        pattern = 'rollout-*.jsonl' if root.name == 'sessions' else '*.jsonl'
        for path in sorted(root.rglob(pattern)):
            if path not in seen:
                logs.append(path)
                seen.add(path)
    history_log = home / '.codex' / 'history.jsonl'
    if not logs and history_log.exists() and history_log.is_file():
        logs.append(history_log)
    return logs
