# 데이터베이스 스키마

SQLite 파일: `~/.claude/dashboard.db`
모드: WAL, `PRAGMA busy_timeout=5000`, `PRAGMA auto_vacuum=INCREMENTAL`, `PRAGMA user_version=14`

## 비용은 INTEGER micro-dollars

`cost_micro` 컬럼에 `USD * 1_000_000` 정수로 저장해 float 누적 오차를 차단한다. SQL 에서 읽을 때 변환:

```sql
SELECT cost_micro * 1.0 / 1000000 AS cost_usd FROM messages;
```

## sessions

| 컬럼 | 타입 | 도입 | 설명 |
|---|---|---|---|
| `id` | TEXT PK | v1 | 세션 UUID (subagent 는 filename basename) |
| `project_path` | TEXT | v1 | cwd 원본 — project identity 의 핵심 키 |
| `project_name` | TEXT | v1 | `Path(cwd).name` |
| `created_at`, `updated_at` | TEXT | v1 | ISO 8601 UTC |
| `total_input_tokens`, `total_output_tokens`, `total_cache_creation_tokens`, `total_cache_read_tokens` | INTEGER | v1 | 누적 토큰 |
| `cost_micro` | INTEGER | v1 | micro USD |
| `message_count`, `user_message_count` | INTEGER | v1 | |
| `model` | TEXT | v1 | dominant real model (synthetic 회피) |
| `cwd`, `entrypoint`, `version` | TEXT | v1 | |
| `is_subagent` | INTEGER | v1 | 0/1 |
| `parent_session_id` | TEXT | v1 | 부모 sid (subagent only) |
| `agent_type` | TEXT | v1 | Explore / Plan / general-purpose / compact / claude-code-guide |
| `agent_description` | TEXT | v1 | task 설명 (`.meta.json` 또는 부모 tool_use 에서) |
| `pinned` | INTEGER | v1 | 0/1 |
| `final_stop_reason` | TEXT | **v7** | 마지막 assistant `stop_reason` (sticky update) |
| `parent_tool_use_id` | TEXT | **v7** | 부모의 `toolu_*` id |
| `task_prompt` | TEXT | **v7** | 부모가 dispatch 시 보낸 prompt (≤2KB) |
| `tags` | TEXT | **v8** | 콤마 구분 사용자 태그 |
| `turn_duration_ms` | INTEGER | **v12** | 마지막 user→assistant turn의 실행 시간 (ms) |
| `source_node` | TEXT | **v13** | `'local'` 또는 원격 `node_id` — 다중 서버 구분자 |

## messages

| 컬럼 | 타입 | 도입 | 설명 |
|---|---|---|---|
| `id` | INTEGER PK | v1 | autoincrement |
| `session_id` | TEXT FK | v1 | |
| `message_uuid` | TEXT UNIQUE | v1 | 중복 방지 |
| `role` | TEXT | v1 | user / assistant |
| `content`, `content_preview` | TEXT | v1 | 100KB 초과 시 preview 만 |
| `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens` | INTEGER | v1 | |
| `cost_micro`, `model`, `request_id`, `timestamp`, `cwd`, `git_branch`, `is_sidechain` | — | v1 | |
| `stop_reason` | TEXT | **v7** | `end_turn` / `tool_use` / `max_tokens` / `stop_sequence` / `refusal` |

## messages_fts (v3 — FTS5 virtual table)

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content_preview, content='messages', content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
);
-- ai / ad / au 트리거가 INSERT/UPDATE/DELETE 동기화
```

## claude_ai_conversations (v9)

claude.ai 웹 데이터 export (`conversations.json`) 를 인포트한 결과. `sessions` / `messages` 와 완전히 분리되어 있으며 기존 집계 쿼리에 섞이지 않는다. **토큰·모델·비용 컬럼이 없다** — 웹 export 에 해당 정보가 없기 때문.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `uuid` | TEXT PK | 대화 UUID |
| `name` | TEXT | 제목 |
| `summary` | TEXT | 요약 (보통 빈 문자열) |
| `created_at`, `updated_at` | TEXT | ISO 8601 |
| `message_count`, `user_message_count` | INTEGER | 총/사용자 메시지 수 |
| `attachment_count`, `file_count` | INTEGER | 첨부 통계 |
| `total_text_bytes` | INTEGER | 플래튼된 텍스트 바이트 |
| `imported_at` | TEXT | 인포터 실행 시각 |

## claude_ai_messages (v9)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `conversation_uuid` | TEXT FK | claude_ai_conversations.uuid |
| `message_uuid` | TEXT UNIQUE | idempotent 키 |
| `parent_message_uuid` | TEXT | 부모 메시지 |
| `sender` | TEXT | `human` / `assistant` |
| `created_at` | TEXT | ISO 8601 |
| `text` | TEXT | 플래튼된 모든 content block 텍스트 (thinking/tool_use 태깅 포함) |
| `content_preview` | TEXT | 앞 2KB — FTS5 인덱스 대상 |
| `content_json` | TEXT | 원본 content blocks JSON (리치 렌더용) |
| `has_thinking`, `has_tool_use` | INTEGER | 블록 존재 여부 플래그 |
| `attachment_count`, `file_count` | INTEGER | 메시지별 첨부 카운트 |

## claude_ai_messages_fts (v9)

```sql
CREATE VIRTUAL TABLE claude_ai_messages_fts USING fts5(
    content_preview, content='claude_ai_messages', content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
);
-- cai_msg_fts_ai / _ad / _au 트리거가 동기화
```

## remote_nodes (v13)

다중 서버 수집을 위한 등록된 원격 노드. `collector.py` 가 `X-Ingest-Key` 헤더로 인증하며, 해시는 이 테이블에 저장.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `node_id` | TEXT PK | `[a-zA-Z0-9_-]+` |
| `label` | TEXT | 사람이 읽는 이름 |
| `ingest_key_hash` | TEXT | SHA-256 해시 (원본 키는 서버에 저장 안 됨) |
| `last_seen` | TEXT | 마지막 `/api/ingest` 호출 시각 |
| `session_count`, `message_count` | INTEGER | 수집 누적 카운트 |
| `created_at` | TEXT | ISO 8601 |

## admin_audit (v14)

관리자 액션 감사 로그. `/api/admin/backup`, `/retention`, `/retention/schedule`, `/api/nodes/*` 호출이 기록됨.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `ts` | TEXT | ISO 8601 with ms |
| `action` | TEXT | `backup` / `retention` / `retention_scheduled` / `retention_schedule_update` / `node_register` / `node_delete` / `node_rotate_key` |
| `actor_ip` | TEXT | 요청자 IP (스케줄러 자동 실행 시 `local`) |
| `status` | TEXT | `ok` / `error` |
| `detail` | TEXT | JSON (옵션) — 예: `{"sessions_deleted": 42, "messages_deleted": 1800}` |

인덱스: `idx_admin_audit_ts ON admin_audit(ts DESC)`

## app_config (v14)

키-값 스토어. 현재 `retention_schedule` 한 키만 사용하지만 향후 in-app 설정 전반에 재사용 가능.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `key` | TEXT PK | `'retention_schedule'` 등 |
| `value` | TEXT | JSON 문자열 |
| `updated_at` | TEXT | ISO 8601 |

`retention_schedule` 값 구조:

```json
{
  "enabled": true,
  "interval_hours": 24,
  "older_than_days": 90,
  "last_run_at": "2026-04-14T11:45:00Z",
  "last_result": {"sessions": 12, "messages": 340}
}
```

## plan_config

| 컬럼 | 설명 |
|---|---|
| `daily_cost_limit`, `weekly_cost_limit` | 사용자 예산 |
| `reset_hour`, `reset_weekday` | 재설정 시각 |
| `timezone_offset`, `timezone_name` | UTC 오프셋 + IANA 이름 |

## 인덱스 (v2)

```
idx_messages_session_id, idx_messages_timestamp, idx_messages_role_ts,
idx_messages_session_sc, idx_messages_session_time, idx_messages_preview,
idx_sessions_updated_at, idx_sessions_project, idx_sessions_model,
idx_sessions_pinned, idx_sessions_pinned_updated,
idx_sessions_path, idx_sessions_path_updated,
idx_sessions_parent_tool_use
```

## 마이그레이션 히스토리

`PRAGMA user_version` 기반 자동 진화. `init_db()` 가 시작 시 차분 적용.

| 버전 | 추가 |
|---|---|
| v1 | 베이스 스키마 (sessions, messages, file_watch_state, plan_config) |
| v2 | 복합 인덱스 (`idx_sessions_pinned_updated`, `idx_sessions_path_updated`, `idx_messages_session_time`) |
| v3 | FTS5 virtual table + INSERT/UPDATE/DELETE 트리거 + initial rebuild |
| v4 | cwd 기반 `project_path` / `project_name` 치유 + synthetic `session.model` 치유 |
| v5 | **subagent 재분류** — 878 파일 walk, 91,465 메시지 reassign, sessions 통계 재계산 |
| v6 | `agent-acompact-*` filename prefix → `agent_type='compact'` 자동 태깅 |
| v7 | `stop_reason` (messages) + `final_stop_reason` / `parent_tool_use_id` / `task_prompt` (sessions). 58,040 메시지 백필 + 875 subagent 부모 링크 |
| v8 | `sessions.tags TEXT` |
| v9 | `claude_ai_conversations` + `claude_ai_messages` + `claude_ai_messages_fts` (독립 FTS5) + 트리거. claude.ai 웹 export 전용, 기존 sessions/messages 와 격리 |
| v10 | `idx_sessions_parent_is_sub` — `(parent_session_id, is_subagent)` 복합 인덱스. `/api/sessions` 핫 패스 서브쿼리가 **SCAN → SEARCH** 로 전환되어 O(N²) → O(N log N) |
| v11 | `claude_ai_messages.updated_at` — 재import 시 버전 비교 후 UPDATE 가능 (이전엔 `INSERT OR IGNORE` 로 조용히 drop) |
| v12 | `sessions.turn_duration_ms` — user→assistant 턴 실행 시간 (ms) |
| v13 | `sessions.source_node` + `remote_nodes` 테이블 — 다중 서버 수집 식별 (`idx_sessions_source_node`) |
| v14 | `admin_audit` + `app_config` — 관리자 액션 감사 로그 + in-app 설정 스토어 (`idx_admin_audit_ts`) |

### DB 재구축 (드물게)

```bash
rm ~/.claude/dashboard.db
sudo systemctl restart claude-dashboard
# 시작 시 JSONL 재스캔 + v0→v15 마이그레이션 + integrity check
```

## 모델 가격표

`parser.py:MODEL_PRICING` 에 정의. 단위 $/1M 토큰.

| 모델 | 입력 | 출력 | 캐시 생성 | 캐시 읽기 |
|---|---:|---:|---:|---:|
| `claude-opus-4-6` | 15.00 | 75.00 | 18.75 | 1.875 |
| `claude-opus-4-5` | 15.00 | 75.00 | 18.75 | 1.875 |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 3.75 | 0.30 |
| `claude-sonnet-4-5` | 3.00 | 15.00 | 3.75 | 0.30 |
| `claude-haiku-4-5` | 0.80 | 4.00 | 1.00 | 0.08 |
| `claude-haiku-3` | 0.25 | 1.25 | 0.30 | 0.03 |

`<synthetic>` 등 메타 모델은 zero cost. 미지 모델은 family fallback (`opus` / `sonnet` / `haiku` substring) 후 1 회성 WARNING 로그.

## SQL 예제

```sql
-- 최근 7 일간 일별 비용 (KST)
SELECT strftime('%Y-%m-%d', timestamp, '+9 hours') AS d,
       ROUND(SUM(cost_micro) * 1.0 / 1000000, 4) AS cost_usd
FROM messages
WHERE role = 'assistant'
  AND timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
GROUP BY d ORDER BY d;

-- 모델별 캐시 효율
SELECT model,
       ROUND(SUM(cache_read_tokens) * 100.0 /
             NULLIF(SUM(input_tokens + cache_read_tokens), 0), 1) AS cache_hit_pct
FROM messages
WHERE role = 'assistant'
GROUP BY model;

-- subagent agent_type 별 성공률
SELECT agent_type,
       SUM(CASE WHEN final_stop_reason = 'end_turn' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS success_pct,
       COUNT(*) AS total
FROM sessions
WHERE is_subagent = 1
GROUP BY agent_type
ORDER BY total DESC;

-- FTS5 전문 검색
SELECT m.timestamp, m.role, m.content_preview
FROM messages_fts fts
JOIN messages m ON m.id = fts.rowid
WHERE messages_fts MATCH '"오류" OR "exception"'
ORDER BY m.timestamp DESC
LIMIT 20;
```
