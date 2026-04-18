# 데이터베이스 스키마

프로젝트 운영 기준과 문서 우선순위는 `AGENTS.md`를 따른다.

SQLite 기본 파일: `~/.codex/dashboard.db`  
모드: WAL, `PRAGMA busy_timeout=5000`, `PRAGMA auto_vacuum=INCREMENTAL`, `PRAGMA user_version=15`

## 저장 원칙

- 제품 기본 저장소는 Codex 전용이다.
- 세션/프로젝트/메시지 기본 경로는 `codex_projects`, `codex_sessions`, `codex_messages`, `codex_messages_fts`다.
- 운영 보조 테이블은 `file_watch_state`, `plan_config`, `remote_nodes`, `admin_audit`, `app_config`다.

## file_watch_state

파일별 마지막 읽은 줄과 수정 시각.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `file_path` | TEXT PK | JSONL 파일 절대 경로 |
| `last_line` | INTEGER | 마지막 처리한 줄 번호 |
| `last_modified` | REAL | 마지막 관측 mtime |

## plan_config

예산 및 타임존 기본 설정.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | INTEGER PK | 항상 `1` |
| `daily_cost_limit` | REAL | 일간 예산 |
| `weekly_cost_limit` | REAL | 주간 예산 |
| `reset_hour` | INTEGER | 리셋 시각 |
| `reset_weekday` | INTEGER | 주간 리셋 요일 |
| `timezone_offset` | INTEGER | UTC 오프셋 |
| `timezone_name` | TEXT | IANA 타임존 이름 |

## remote_nodes

원격 Codex collector 노드 등록 정보.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `node_id` | TEXT PK | `[a-zA-Z0-9_-]+` |
| `label` | TEXT | 사람이 읽는 노드 이름 |
| `ingest_key_hash` | TEXT | SHA-256 해시 |
| `last_seen` | TEXT | 마지막 `/api/ingest` 시각 |
| `session_count` | INTEGER | 적재된 세션 수 |
| `message_count` | INTEGER | 적재된 메시지 수 |
| `created_at` | TEXT | 등록 시각 |

## admin_audit

관리자 액션 감사 로그.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `ts` | TEXT | ISO 8601 with ms |
| `action` | TEXT | `backup`, `retention`, `retention_scheduled`, `node_*` 등 |
| `actor_ip` | TEXT | 요청자 IP 또는 `local` |
| `status` | TEXT | `ok` / `error` |
| `detail` | TEXT | JSON detail payload |

인덱스:

```sql
CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts DESC);
```

## app_config

앱 설정 키-값 저장소.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `key` | TEXT PK | 설정 키 |
| `value` | TEXT | JSON 문자열 |
| `updated_at` | TEXT | 마지막 갱신 시각 |

대표 값:

```json
{
  "enabled": true,
  "interval_hours": 24,
  "older_than_days": 90,
  "last_run_at": "2026-04-14T11:45:00Z",
  "last_result": {"sessions": 12, "messages": 340}
}
```

## codex_projects

프로젝트 메타 테이블.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `project_path` | TEXT PK | 프로젝트 식별자 |
| `project_name` | TEXT | 표시 이름 |
| `created_at` | TEXT | 최초 적재 시각 |
| `updated_at` | TEXT | 마지막 갱신 시각 |

## codex_sessions

Codex 세션 메타 테이블.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | TEXT PK | 세션 ID |
| `project_path` | TEXT FK | `codex_projects.project_path` |
| `session_name` | TEXT | 세션 제목/라벨 |
| `created_at` | TEXT | 최초 시각 |
| `updated_at` | TEXT | 마지막 시각 |
| `model` | TEXT | 세션 대표 모델 |
| `cwd` | TEXT | 작업 디렉터리 |
| `source_node` | TEXT | `local` 또는 원격 `node_id` |
| `pinned` | INTEGER | 0/1 |
| `final_stop_reason` | TEXT | 마지막 종료 사유 |
| `tags` | TEXT | 콤마 구분 태그 |
| `message_count` | INTEGER | 전체 메시지 수 |
| `user_message_count` | INTEGER | 사용자 메시지 수 |

인덱스:

```sql
CREATE INDEX IF NOT EXISTS idx_codex_sessions_project_path ON codex_sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated_at ON codex_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_codex_sessions_source_node ON codex_sessions(source_node);
```

## codex_messages

Codex 메시지 원본 저장소.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `session_id` | TEXT FK | `codex_sessions.id` |
| `message_uuid` | TEXT UNIQUE | 중복 방지 키 |
| `parent_uuid` | TEXT | 부모 메시지 UUID |
| `role` | TEXT | `user`, `assistant`, `tool`, `agent` 등 |
| `content` | TEXT | 원본 본문 |
| `content_preview` | TEXT | 검색/목록용 preview |
| `timestamp` | TEXT | ISO 8601 UTC |
| `model` | TEXT | 메시지 수준 모델 |

인덱스:

```sql
CREATE INDEX IF NOT EXISTS idx_codex_messages_session_id ON codex_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_codex_messages_timestamp ON codex_messages(timestamp);
```

## codex_messages_fts

Codex 메시지 전용 FTS5 인덱스.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS codex_messages_fts USING fts5(
    content_preview,
    content='codex_messages',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
);
```

트리거:

- `codex_messages_fts_ai` — insert 동기화
- `codex_messages_fts_ad` — delete 동기화
- `codex_messages_fts_au` — `content_preview` update 동기화

## 마이그레이션 히스토리

`PRAGMA user_version` 기반 자동 적용.

| 버전 | 추가 |
|---|---|
| v1 | 초기 런타임 스키마 |
| v2 | 인덱스 보강 |
| v3 | FTS5 도입 |
| v4-v14 | 레거시 런타임 보강 단계 |
| v15 | `codex_projects`, `codex_sessions`, `codex_messages`, `codex_messages_fts` 도입 |

현재 제품 기준에서는 v15 Codex 저장소가 기본 경로다. 레거시 단계 설명은 아키텍처 결정 기록과 이력 문서에서만 다룬다.

## DB 재구축

```bash
rm ~/.codex/dashboard.db
sudo systemctl restart codex-web-dashboard
```

시작 시 Codex JSONL 재스캔과 스키마 부트스트랩이 다시 수행된다.
