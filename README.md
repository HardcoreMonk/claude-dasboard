# Claude Usage Dashboard

Claude 및 Claude Code의 토큰 사용량·비용·대화·subagent를 실시간 추적하는 자체 호스팅 웹 대시보드.

`~/.claude/projects/` 하위의 세션 JSONL 파일을 자동 파싱·증분 수집하여 SQLite(WAL + FTS5)에 저장하고, 브라우저에서 분석·검색·관리한다.

---

## 빠른 시작

```bash
cd /home/hardcoremonk/projects/claude-dashboard
./start.sh
```

브라우저에서 http://localhost:8765 접속.

```bash
PORT=9000 ./start.sh                  # 포트 변경
DASHBOARD_PASSWORD=secret ./start.sh  # HTTP Basic Auth + WebSocket 인증
```

### systemd 서비스

```bash
sudo cp claude-dashboard.service /etc/systemd/system/
sudo systemctl enable --now claude-dashboard
journalctl -u claude-dashboard -f
```

unit은 `MemoryMax=512M`, `CPUQuota=150%`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` 하드닝 적용.

### 테스트

```bash
./.venv/bin/python -m pip install pytest httpx
./.venv/bin/python -m pytest tests/ -v
# 81 passed in ~2.5s
```

---

## 핵심 기능

### 데이터 정확성
- **cost_micro INTEGER 저장** (1 USD = 1,000,000) — float 누적 오차 차단
- **cwd 기반 프로젝트 식별** — 디렉터리 dash 인코딩 손실 방지 (`claude-dashboard` ≠ `dashboard`)
- **session.model 보호** — `<synthetic>`이 세션의 주모델을 하이재킹하지 못함
- **subagent 분리** — 878개 `agent-<hash>.jsonl` 파일을 부모에서 떼어내 독립 세션으로 승격, 91k 메시지 reassign
- **parent_tool_use_id 링크** — subagent의 `meta.json.description`을 부모의 `Agent` tool_use 호출과 1:1 매칭

### 실시간 수집
- watchdog **inotify** 우선, 30초 폴링 safety net
- 8파일 병렬 배치 + 3-phase 처리 (lock-free read → parse → serialized write)
- WebSocket 무한 재연결 (지수 백오프 max 30s)
- watcher metric 의존성 주입 (순환 임포트 회피)

### 분석·시각화
- **Forecast** — 14일 평균 → 월말 비용 예측, 일/주간 budget burn-out 시각
- **Subagent heatmap** — agent_type × project 2D 집계
- **종료 매트릭스** — agent_type × stop_reason 성공률 행렬
- **디스패치 체인** — parent → 자식 subagent 트리 (재귀 walk, depth 제한)
- **모델 전환 타임라인** — 세션 내 consecutive run 축약 (`Opus×12 → Haiku×8`)
- **conversation tree 인디케이터** — `parent_uuid` 분기 시 표시

### UX 폴리시
- **Cmd+K 명령 팔레트** — fuzzy search (뷰/프로젝트)
- **다크/라이트 테마** — `body.theme-light` 토글, accent 컬러 oklch 매핑
- **이름 매칭 삭제 안전장치** — 모든 destructive action이 target 이름 정확 입력 후에만 활성화
- **토스트 시스템** — 18개 액션 success/error 피드백, 5초 dedupe
- **bulk operations** — 세션 multi-select → 일괄 핀/태그/비교/삭제
- **filter preset** — 정렬+고급필터 조합을 이름 붙여 localStorage 저장
- **세션 비교 (diff)** — 2개 세션 14개 메트릭 side-by-side
- **태그** — 콤마 구분 자유 태그, `?tag=`로 필터
- **마크다운 렌더링** — 메시지 본문 코드블록·인라인·굵게·링크·리스트
- **반응형** — 320~480px 모바일 지원
- **접근성** — focus trap, aria-sort, aria-current, :focus-visible ring
- **키보드 단축키** — `g+o/s/c/m/p/e` 뷰, `/` 검색, `Esc` 닫기, `?` 도움말, `Cmd+K` 팔레트

### 관측성
- `/api/health` 인증 우회 (모니터링용)
- `/metrics` Prometheus 텍스트 포맷 (인증 우회)
  - `http_requests_total{method,path,status}` (route template — bounded cardinality)
  - `http_request_duration_seconds` 히스토그램 (10 buckets)
  - `dashboard_ws_connections` 게이지
  - `dashboard_scan_files_total{phase}` (initial/event/poll)
  - `dashboard_new_messages_total` 카운터
  - `dashboard_file_retries_total{outcome}` (retry/gave_up)
  - `dashboard_{sessions,messages,db_size_bytes}_total`

---

## 비용 계산

비용은 INTEGER micro-dollars로 저장 (1 USD = 1,000,000).

| 모델 | 입력 $/1M | 출력 $/1M | 캐시 생성 $/1M | 캐시 읽기 $/1M |
|---|---:|---:|---:|---:|
| `claude-opus-4-6` | 15.00 | 75.00 | 18.75 | 1.875 |
| `claude-opus-4-5` | 15.00 | 75.00 | 18.75 | 1.875 |
| `claude-sonnet-4-6` | 3.00 | 15.00 | 3.75 | 0.30 |
| `claude-sonnet-4-5` | 3.00 | 15.00 | 3.75 | 0.30 |
| `claude-haiku-4-5` | 0.80 | 4.00 | 1.00 | 0.08 |
| `claude-haiku-3` | 0.25 | 1.25 | 0.30 | 0.03 |

`<synthetic>` 등 메타 모델은 zero cost. 미지 모델은 family fallback (`opus`/`sonnet`/`haiku` substring) + 1회성 WARNING 로그. 가격표는 `parser.py:MODEL_PRICING`에서 수정.

### 예산 추적 vs 실제 플랜 한도

Anthropic은 rate limit 조회 API를 공개하지 않는다. 대시보드의 예산 추적은 로컬 JSONL 기반 추정치이며, claude.ai 웹페이지의 플랜 잔여량과는 별개이다.

- `~/.claude/.credentials.json` → `rateLimitTier` 자동 감지
- 사용자 일일/주간 예산 직접 설정 (Pro / Max 5x / Max 20x 프리셋)
- **burn-out trajectory**: 현재 사용량 + 14일 평균 → "이대로면 N시간/일 후 한도 도달"

---

## 아키텍처

```
~/.claude/projects/**/*.jsonl              ~/.claude/.credentials.json
              │                                       │
              │ watchdog inotify + 30s safety poll    │ rateLimitTier (로컬만)
              ▼                                       │
        ┌──────────┐                                  │
        │ watcher  │  asyncio + threading.Lock        │
        └────┬─────┘  3-phase: read → parse → write   │
             │ parse (lock-free)                      │
             ▼                                        │
        ┌──────────┐                                  │
        │ parser   │  cwd 기반 식별, subagent split,  │
        │          │  stop_reason 캡처                │
        └────┬─────┘                                  │
             │ write_db() — Lock + BEGIN IMMEDIATE    │
             ▼                                        │
        ┌─────────────────────┐                       │
        │  database (SQLite)  │  WAL + thread-local   │
        │  v8 schema + FTS5   │  read pool            │
        │  ~/.claude/         │                       │
        │     dashboard.db    │                       │
        └────┬────────────────┘                       │
             │                                        │
             │     ┌────────────────────────────────────┐
             │     │  init_db() v0→v8 자동 마이그레이션 │
             │     │  - v3: FTS5 트리거 + rebuild        │
             │     │  - v5: subagent 재분류 (91k msg)    │
             │     │  - v7: stop_reason + parent 링크    │
             │     │  - v8: tags 컬럼                    │
             │     └────────────────────────────────────┘
             ▼
        ┌──────────────────────────────────┐
        │  main (FastAPI 42 routes)        │
        │  + /metrics (Prometheus)         │
        │  + WebSocket /ws                 │
        │  + middleware: metrics → auth    │
        └──┬───────────────────────────────┘
           │
        ┌──▼─────────────────────────────────┐
        │  frontend (single-file SPA)        │
        │  Tailwind + Pretendard + Solar +   │
        │  Chart.js + Cmd+K + light/dark     │
        │  static/{index.html, app.js, .css} │
        └────────────────────────────────────┘
```

---

## 프로젝트 구조

```
claude-dashboard/
├── main.py                      1714줄  FastAPI 42 routes + /metrics + WS + 미들웨어
├── database.py                   652줄  WAL + thread-local + v1→v8 마이그레이션 + FTS5
├── parser.py                     459줄  JSONL 파싱, cwd 식별, subagent split, stop_reason
├── watcher.py                    341줄  watchdog + safety poll + WatcherMetrics 주입
├── tests/                       1163줄  81 pytest (parser/database/watcher/api integration)
│   ├── test_parser.py             29 cases — 가격, ID, stop_reason, idempotent
│   ├── test_database.py           10 cases — 마이그레이션, FTS5, thread-local
│   ├── test_watcher.py             9 cases — 메트릭 주입, 동시성, 회귀
│   └── test_api.py                33 cases — TestClient 통합
├── static/
│   ├── index.html                736줄  HTML 쉘 (Tailwind CDN + 모달·overlay)
│   ├── app.js                   2780줄  SPA — 정렬·라우팅·키보드·WS·subagent·bulk·forecast
│   └── app.css                   227줄  스타일 + 폰트 +25% + 라이트모드 + 반응형
├── claude-dashboard.service              systemd 유닛 (Restart=always + 하드닝)
├── backup.sh                             CLI 백업
├── start.sh                              원클릭 실행 (venv 부트스트랩 + uvicorn)
├── requirements.txt                      Python 의존성
├── README.md                             이 파일
└── CLAUDE.md                             상세 가이드 + API 전체 + 마이그레이션 히스토리
```

총 8,072줄 (코드 + 테스트 + 정적 자산).

---

## 화면 안내

| 화면 | 설명 |
|---|---|
| **개요** | 일/주/월 사용량 카드, 예산 추적 + burn-out, 5종 통계, 차트 4종, **forecast 카드 3개** (월말 / 14일 평균 / burn-out), TOP 10 프로젝트, **subagent 히트맵**, **종료 매트릭스** |
| **세션** | sortable 테이블 — 핀, stop_reason 배지, subagent 카운트, 태그, duration. 상단 ★핀만 토글 + **고급 필터 드로어** (날짜/비용 range + preset 저장). bulk action bar (★/🏷/⚖/✕). |
| **대화** | 좌: 세션 목록 (정렬 + FTS 검색 + 매칭 하이라이트). 우: 대화 뷰어 — 헤더에 토큰 분리(read/creation), lineage 블록 (subagent: parent + tool_use_id + task_prompt), spawned subagents 슬롯, 디스패치 체인 보기. 메시지: 마크다운 + stop_reason 배지 + git_branch 변경 마크. **사용자/어시스턴트 필터, 모두 접기/펼치기, 메시지 카운트, ↑↓ jump** |
| **모델** | 모델별 토큰·비용·캐시·사용 비중 카드 (sortable) |
| **프로젝트** | 프로젝트 사용량 — 클릭 시 탭형 모달 (통계 / 세션 목록 / 전체 대화). 통계 탭에 일별 비용 Chart.js bar+line |
| **관리** | CSV/JSON 내보내기, DB 백업, 데이터 보존 (이름 매칭 안전장치) |

---

## REST API 전체 (42 routes + WS)

### 통계·시계열·예측

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 (인증 우회) |
| GET | `/metrics` | Prometheus 메트릭 (인증 우회) |
| GET | `/api/stats` | 전체/오늘 통계 (모델 집계는 messages 기반) |
| GET | `/api/usage/periods` | 일/주/월 사용량 + 이전 대비 증감 |
| GET | `/api/usage/hourly?hours=N` | 시간별 (KST) |
| GET | `/api/usage/daily?days=N` | 일별 (KST) |
| GET | `/api/forecast?days=N` | 월말 예측 + 일/주간 burn-out |

### 세션

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/sessions` | sort, search, project, model, **pinned_only**, **date_from/to**, **cost_min/max**, **tag**, include_subagents |
| GET | `/api/sessions/search?q=k` | FTS5 전문 검색 |
| GET | `/api/sessions/{id}` | 세션 상세 |
| GET | `/api/sessions/{id}/messages` | 대화 (subagent 세션은 sidechain 필터 우회) |
| GET | `/api/sessions/{id}/subagents` | spawn한 subagent 목록 + duration |
| GET | `/api/sessions/{id}/chain?depth=N` | 디스패치 체인 (재귀 walk) |
| DELETE | `/api/sessions/{id}` | preview → confirm |
| POST/DELETE | `/api/sessions/{id}/pin` | 핀 토글 |
| POST | `/api/sessions/{id}/tags` | 태그 저장 (콤마 구분) |

### Subagents

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/subagents` | agent_type/parent/search 필터 + sort/order |
| GET | `/api/subagents/stats` | by_type, by_stop_reason, top_by_cost/duration, by_type_and_stop_reason |
| GET | `/api/subagents/heatmap` | agent_type × project 2D 집계 |

### 프로젝트·태그

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/models` | 모델별 분석 |
| GET | `/api/projects` | path 기반 그룹 + session/subagent 카운트 분리 |
| GET | `/api/projects/top?limit=N` | 비용 상위 N개 |
| GET | `/api/projects/{name}/stats` | `?path=` 모호성 해소, sessions 배열 포함 |
| GET | `/api/projects/{name}/messages` | 프로젝트 전체 대화 취합 |
| DELETE | `/api/projects/{name}` | preview → confirm (`?path=` 필요 시) |
| GET | `/api/tags` | 전체 태그 + 사용 카운트 |

### 예산·관리

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/plan/detect` | rateLimitTier 자동 감지 |
| GET/POST | `/api/plan/config` | 예산 조회/저장 |
| GET | `/api/plan/usage` | 일/주간 사용량 vs 예산 + 잔여 시각 |
| GET | `/api/export/csv` | CSV (23 컬럼: tags, stop_reason, parent_tool_use_id, duration 포함) |
| POST | `/api/admin/backup` | DB 백업 (write_lock, 10개 유지) |
| DELETE | `/api/admin/retention` | preview → confirm |
| GET | `/api/admin/db-size` | DB 파일 크기 |
| WS | `/ws` | 실시간 (init/batch_update/scan_progress/scan_complete) |

---

## 데이터베이스 스키마

SQLite 파일: `~/.claude/dashboard.db` (WAL 모드, `PRAGMA busy_timeout=5000`, `PRAGMA user_version=8`)

### sessions

| 컬럼 | 타입 | 도입 | 설명 |
|---|---|---|---|
| `id` | TEXT PK | v1 | 세션 UUID (subagent는 filename basename) |
| `project_path` | TEXT | v1 | cwd 원본 (C2/C3 핵심 키) |
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
| `agent_description` | TEXT | v1 | task 설명 (`.meta.json` 또는 부모 tool_use에서) |
| `pinned` | INTEGER | v1 | 0/1 |
| `final_stop_reason` | TEXT | **v7** | 마지막 assistant `stop_reason` |
| `parent_tool_use_id` | TEXT | **v7** | 부모의 `toolu_*` id |
| `task_prompt` | TEXT | **v7** | 부모가 dispatch 시 보낸 prompt (≤2KB) |
| `tags` | TEXT | **v8** | 콤마 구분 사용자 태그 |

### messages

| 컬럼 | 타입 | 도입 | 설명 |
|---|---|---|---|
| `id` | INTEGER PK | v1 | autoincrement |
| `session_id` | TEXT FK | v1 | |
| `message_uuid` | TEXT UNIQUE | v1 | 중복 방지 |
| `role` | TEXT | v1 | user/assistant |
| `content`, `content_preview` | TEXT | v1 | 100KB 초과 시 fallback |
| `input_tokens`, `output_tokens`, `cache_creation_tokens`, `cache_read_tokens` | INTEGER | v1 | |
| `cost_micro`, `model`, `request_id`, `timestamp`, `cwd`, `git_branch`, `is_sidechain` | — | v1 | |
| `stop_reason` | TEXT | **v7** | end_turn/tool_use/max_tokens/stop_sequence/refusal |

### messages_fts (v3)

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content_preview, content='messages', content_rowid='id',
    tokenize='unicode61 remove_diacritics 0'
);
-- ai/ad/au 트리거가 INSERT/UPDATE/DELETE 동기화
```

### plan_config

| 컬럼 | 설명 |
|---|---|
| `daily_cost_limit`, `weekly_cost_limit` | 사용자 예산 |
| `reset_hour`, `reset_weekday` | 재설정 시각 |
| `timezone_offset`, `timezone_name` | UTC 오프셋 + IANA 이름 |

### 인덱스 (v2)

```
idx_messages_session_id, idx_messages_timestamp, idx_messages_role_ts, idx_messages_session_sc,
idx_messages_session_time, idx_messages_preview,
idx_sessions_updated_at, idx_sessions_project, idx_sessions_model, idx_sessions_pinned,
idx_sessions_pinned_updated, idx_sessions_path, idx_sessions_path_updated,
idx_sessions_parent_tool_use
```

---

## 마이그레이션 히스토리

`PRAGMA user_version` 기반 자동 진화. `init_db()`가 시작 시 차분 적용.

| 버전 | 추가 |
|---|---|
| v1 | 베이스 스키마 (sessions, messages, file_watch_state, plan_config) |
| v2 | 복합 인덱스 (`idx_sessions_pinned_updated`, `idx_sessions_path_updated`, `idx_messages_session_time`) |
| v3 | FTS5 virtual table + INSERT/UPDATE/DELETE 트리거 + initial rebuild |
| v4 | cwd 기반 project_path/project_name 치유 + synthetic session.model 치유 |
| v5 | **subagent 재분류** — 878 파일 walk, 91,465 메시지 reassign, sessions 통계 재계산 |
| v6 | `agent-acompact-*` filename prefix → `agent_type='compact'` 자동 태깅 |
| v7 | `stop_reason` (messages) + `final_stop_reason`/`parent_tool_use_id`/`task_prompt` (sessions). 58,040 메시지 백필 + 875 subagent 부모 링크 |
| v8 | `sessions.tags TEXT` |

### DB 재구축 (드물게)

```bash
rm ~/.claude/dashboard.db
sudo systemctl restart claude-dashboard
# 시작 시 950+ JSONL 재스캔 + v0→v8 마이그레이션 + integrity check
```

---

## 보안

| 기능 | 구현 |
|---|---|
| HTTP Basic Auth | `DASHBOARD_PASSWORD` 환경변수 → constant-time `hmac.compare_digest` |
| WebSocket 인증 | Authorization 헤더 또는 `?token=` 쿼리 |
| SQL 인젝션 차단 | 전 엔드포인트 파라미터화 + LIKE ESCAPE + sort 화이트리스트 |
| 입력 검증 | Pydantic + `model_validator` (daily ≤ weekly) |
| **이름 매칭 삭제** | 모든 destructive action (`/api/sessions/{id}`, `/api/projects/{name}`, `/api/admin/retention`)이 프론트 모달에서 target 정확 입력 후에만 활성화 |
| XSS | `esc()`가 `&<>"'` 모두 escape, 위험 버튼은 DOM API (`addEventListener`) 사용 |
| 백업 | `_write_lock` 획득 후 `sqlite3.backup()` |
| systemd 하드닝 | `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `MemoryMax=512M`, `CPUQuota=150%`, `LockPersonality` |

### CORS × CSRF 주의

현재 `allow_origins=["*"]` + Basic Auth 조합은 **브라우저가 credentialed cross-origin 요청을 거부**하는 덕분에 CSRF 공격으로부터 사실상 안전하다 (wildcard + credentials 불일치).

`allow_origins`를 특정 도메인으로 좁히기 전에 반드시:
- DELETE/POST 엔드포인트에 CSRF 토큰 헤더 검증, 또는
- 상태 변경 요청에 `Origin`/`Referer` 헤더 검사, 또는
- 대시보드를 `localhost` 전용(unix socket, reverse proxy bind)으로 운영

---

## 환경 요건

- Python 3.12+ (pyenv 3.12.9 또는 시스템 Python)
- uvicorn `--loop asyncio --http h11` (다른 조합은 미지원)
- 디스크: `~/.claude/projects/` 읽기, `~/.claude/dashboard.db` 쓰기
- 선택: `prometheus_client`, `watchdog` (둘 다 자동 fallback 있음)

---

## 백업·복구

```bash
./backup.sh                                            # CLI (sqlite3 .backup)
curl -X POST http://localhost:8765/api/admin/backup    # API
```

백업 위치: `~/.claude/dashboard-backups/`, 최근 10개 자동 유지.
API 백업은 `_write_lock`을 획득해서 트랜잭션 도중 복사를 방지한다.

---

## 데이터 활용

### SQLite 직접 쿼리

```bash
sqlite3 ~/.claude/dashboard.db
```

```sql
-- 최근 7일간 일별 비용
SELECT strftime('%Y-%m-%d', timestamp, '+9 hours') AS d,
       ROUND(SUM(cost_micro)*1.0/1000000, 4) AS cost
FROM messages WHERE role = 'assistant'
  AND timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days')
GROUP BY d ORDER BY d;

-- 모델별 캐시 효율
SELECT model,
       ROUND(SUM(cache_read_tokens) * 100.0 /
             NULLIF(SUM(input_tokens + cache_read_tokens), 0), 1) AS cache_hit_pct
FROM messages WHERE role = 'assistant'
GROUP BY model;

-- subagent agent_type별 성공률
SELECT agent_type,
       SUM(CASE WHEN final_stop_reason='end_turn' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS success_pct,
       COUNT(*) AS total
FROM sessions WHERE is_subagent=1
GROUP BY agent_type ORDER BY total DESC;

-- FTS5 전문 검색
SELECT m.timestamp, m.role, m.content_preview
FROM messages_fts fts
JOIN messages m ON m.id = fts.rowid
WHERE messages_fts MATCH '"오류" OR "exception"'
ORDER BY m.timestamp DESC LIMIT 20;
```

### API 활용

```bash
curl -s http://localhost:8765/api/stats | jq .
curl -s 'http://localhost:8765/api/sessions?per_page=10&pinned_only=true' | jq '.sessions[]|{project_name,model,total_cost_usd,tags}'
curl -s 'http://localhost:8765/api/forecast?days=14' | jq .
curl -s 'http://localhost:8765/api/subagents/stats' | jq '.by_type_and_stop_reason'
curl -s 'http://localhost:8765/api/sessions/<sid>/chain?depth=4' | jq .
curl -o claude-usage.csv http://localhost:8765/api/export/csv
curl -s http://localhost:8765/metrics | grep dashboard_
```

---

## 추가 문서

- [`CLAUDE.md`](./CLAUDE.md) — 상세 가이드, 마이그레이션 히스토리, 인터랙션 기능 전수 목록, 디자인 시스템

## 라이선스 / 이슈

자체 사용 도구. 이슈/PR 전 `pytest tests/`로 검증.
