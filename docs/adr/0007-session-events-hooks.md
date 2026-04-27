# ADR-0007: Session events — Claude Code 훅 + JSONL 파생 이벤트

**상태**: 확정  
**일자**: 2026-04-27  
**결정자**: hardcoremonk

## 맥락

기존 세션 데이터 수집은 `~/.claude/projects/**/*.jsonl` 폴링·watchdog 한 경로뿐. 두 가지 한계:

- **지연**: `watcher.py` debounce + parser 처리로 5–15s 지연. 실시간 timeline UX 에 부족.
- **누락**: 권한 prompt, SessionStart/Stop 같은 일부 이벤트는 JSONL 에 기록되지 않거나 늦게 적힘.

Claude Code 의 SessionStart / Stop / Notification hook 은 이벤트 발생 후 1s 이내 push 가능. 이 채널을 보조 입력으로 활용하면 timeline 즉시성과 누락 보강을 동시에 해결.

## 결정

세션 이벤트 전용 테이블 `session_events` 도입 (DB v15 → **v16**). JSONL 파서와 Claude Code hook 양쪽이 동일한 append-only 로그에 기록.

### 1. 스키마

```sql
CREATE TABLE session_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL,   -- 8종 (아래)
    ts            TEXT NOT NULL,   -- ISO 8601 UTC
    payload       TEXT NOT NULL,   -- JSON, type-specific
    source        TEXT NOT NULL,   -- 'hook' | 'jsonl'
    schema_ver    INTEGER NOT NULL DEFAULT 1,
    UNIQUE (session_id, event_type, ts, source)
);
CREATE INDEX idx_session_events_sid_ts ON session_events(session_id, ts);
CREATE INDEX idx_session_events_ts     ON session_events(ts);
```

### 2. 8종 event_type

| 타입 | 도입 경로 | 비고 |
|---|---|---|
| `session_start` | hook | SessionStart |
| `session_stop` | hook | Stop |
| `permission_prompt` | hook | Notification |
| `message_user` | jsonl 파생 | parser 가 user 메시지 마다 emit |
| `message_assistant` | jsonl 파생 | assistant 메시지 마다 emit |
| `end_turn` | jsonl 파생 | `stop_reason = end_turn` |
| `tool_use` | jsonl 파생 | content block tool_use 마다 |
| `subagent_dispatch` | jsonl 파생 | Task tool_use → subagent |

### 3. Hook receiver

- `POST /api/hooks/session-start` · `/session-stop` · `/notification`
- 인증: `Authorization: Bearer <token>`. 토큰은 `~/.claude/.hook-token` (chmod 600, `install_hooks.py` 가 생성·로테이트).
- **fail-soft**: 토큰 불일치·DB 에러여도 200 반환. hook 실패가 Claude Code 동작을 막지 않도록.

### 4. 중복 차단 + UI 그룹화

JSONL parser 가 `tool_use` 등 derived event 도 emit 하므로 hook 과 겹칠 수 있음. `UNIQUE (session_id, event_type, ts, source)` 로 같은 source 내부 중복은 차단, 서로 다른 source 의 동일 이벤트는 양쪽 row 보존 후 UI 단계에서 그룹화 (hook 우선).

### 5. 실시간 broadcast

WebSocket 채널 `timeline_event` 로 hook 수신 즉시 frontend 에 push. timeline 뷰가 카드 스트림으로 렌더.

## 근거

- 즉시성 — hook 1s ≪ JSONL 5–15s
- 누락 보강 — 권한 prompt 등 JSONL 에 없는 이벤트도 캡처
- timeline UX — 카드 형태 이벤트 스트림 + WS realtime 으로 conversation 뷰와 차별화
- append-only 단일 테이블 → 쿼리·retention 단순

## 트레이드오프

- **Claude Code hook signature 비공식** — payload 스키마가 변경 시 깨질 수 있음. `schema_ver` 컬럼 + 알 수 없는 키는 WARN 로그로 격리.
- **토큰 관리 책임** — `~/.claude/.hook-token` 유출 시 hook 위조 가능. chmod 600 강제, ADR-0014 redaction 정책 적용 (로그·에러 메시지에서 토큰 제거).
- **이중 emit** — 동일 이벤트가 hook + JSONL 양쪽에서 들어올 수 있어 storage 약간 증가. UNIQUE + UI 그룹화로 사용자 영향 없음.

## 완화

- Hook 실패는 항상 200 — Claude Code 본체 동작을 절대 차단하지 않음
- `install_hooks.py rotate-token` 한 명령으로 키 회전
- payload 비정상 시 row 는 저장하되 `schema_ver` 미스매치 WARN
- 미사용 시 hook 미설치 — JSONL 파생 이벤트만으로도 timeline 동작
