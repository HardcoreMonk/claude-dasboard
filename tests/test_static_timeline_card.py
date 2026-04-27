"""Static-analysis safety net for ``static/timeline-card.js``.

We can't run the JS in this Python-only test suite, so we fall back to
regex-based assertions on the source file. The goal is to catch the
specific regressions surfaced in the Plan A final code review:

  - C1a: ``_fmtTime`` must NOT do ``ts * 1000`` against a value that could
    be a string. The fix is ``new Date(ts)`` for non-numeric input.
  - C1c: dedup MUST consult ``ev.id`` before pushing a WS event.

These are intentionally crude — a deliberate refactor will rewrite them
and prompt re-running this contract. Regex over a small file is fast and
keeps the safety net in pure Python.
"""
from pathlib import Path

import re


SRC = Path(__file__).resolve().parent.parent / 'static' / 'timeline-card.js'


def _read_source() -> str:
    return SRC.read_text(encoding='utf-8')


def test_timeline_card_source_exists():
    assert SRC.exists(), f"timeline-card.js missing at {SRC}"


def test_fmt_time_handles_iso_strings():
    """``_fmtTime`` must branch on type — ts can be an ISO string OR number."""
    src = _read_source()
    # Locate the _fmtTime body.
    m = re.search(r'static\s+_fmtTime\s*\([^)]*\)\s*\{([^}]*\{[^}]*\}[^}]*|[^}]*)\}',
                  src, re.DOTALL)
    assert m, "_fmtTime not found in timeline-card.js"
    body = m.group(0)
    # Must construct a Date from raw `ts` somewhere (string path).
    assert re.search(r'new\s+Date\s*\(\s*ts\s*\)', body), (
        "_fmtTime must call `new Date(ts)` to handle ISO strings; "
        "blind `ts * 1000` produces NaN on string input"
    )
    # If `ts * 1000` is present, it MUST be guarded by a typeof === 'number'
    # branch (so strings never go through the multiplication).
    if re.search(r'ts\s*\*\s*1000', body):
        assert re.search(r"typeof\s+ts\s*===\s*['\"]number['\"]", body), (
            "_fmtTime multiplies ts by 1000 without a typeof===number guard — "
            "strings will become NaN"
        )


def test_ws_dedup_uses_event_id():
    """The WS handler MUST dedup on ``ev.id`` so REST + WS overlap is safe."""
    src = _read_source()
    # Look for the `ev.id` membership-check pattern: events.some(... ev.id ...)
    assert re.search(r'ev\.id\s*&&\s*this\.events\.some', src) \
        or re.search(r'this\.events\.some\([^)]*ev\.id', src), (
        "WS message handler must dedup by ev.id; broadcasts now carry id "
        "(C1b fix), so dropping this guard would re-introduce double-render"
    )
