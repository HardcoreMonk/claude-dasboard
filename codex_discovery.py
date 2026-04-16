"""Discovery helpers for Codex JSONL logs."""
from pathlib import Path


def codex_roots(home: Path) -> list[Path]:
    candidates = [
        home / '.codex' / 'projects',
        home / '.codex' / 'logs',
        home / '.codex' / 'sessions',
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
        for path in sorted(root.rglob('*.jsonl')):
            if path not in seen:
                logs.append(path)
                seen.add(path)
    return logs
