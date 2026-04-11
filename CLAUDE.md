# Claude Dashboard

Claude Code 토큰 사용량 실시간 추적 웹 대시보드. Supanova 디자인 시스템.

## 실행

```bash
./start.sh                            # 기본 (port 8765)
PORT=9000 ./start.sh                   # 포트 변경
DASHBOARD_PASSWORD=secret ./start.sh   # HTTP Basic Auth 활성화
```

systemd:
```bash
sudo cp claude-dashboard.service /etc/systemd/system/
sudo systemctl enable --now claude-dashboard
```

테스트:
```bash
./.venv/bin/python -m pip install pytest httpx
./.venv/bin/python -m pytest tests/ -v
```

## 구조

```
database.py        652줄  WAL + thread-local reads + v1→v8 migrations + FTS5 + 데이터 치유
parser.py          459줄  cwd 기반 프로젝트, subagent 파일명 식별, stop_reason 캡처, 미지 모델 경고
watcher.py         341줄  watchdog inotify + 30s safety poll + WatcherMetrics 의존성 주입
main.py           1714줄  FastAPI 42 routes + /metrics + WS + subagent 6종 + forecast + chain
tests/            1163줄  81 pytest (parser 29, database 10, watcher 9, api 33 integration)
static/index.html  736줄  Supanova HTML 쉘 (Tailwind + Pretendard + Solar + Chart.js)
static/app.js     2780줄  SPA — 정렬/URL/키보드/WS/subagent/bulk/forecast/chain/diff/preset
static/app.css     227줄  스타일 (폰트 +25%, 라이트모드, 토스트, sticky 헤더, 반응형)
```

총 8,072줄 (코드 + 테스트 + 정적 자산).

## 핵심 규칙

- uvicorn: **반드시** `--loop asyncio --http h11`
- DB 쓰기: `write_db()` — `threading.Lock` + `BEGIN IMMEDIATE` + auto-commit/rollback
- DB 읽기: `read_db()` — **스레드 로컬 커넥션 캐시** + WAL 다중 리더
- **마이그레이션**: `PRAGMA user_version` 기반. `SCHEMA_VERSION=8`.
  - v2: 복합 인덱스 (idx_sessions_pinned_updated, idx_sessions_path_updated)
  - v3: FTS5 virtual table + INSERT/UPDATE/DELETE 트리거 + rebuild
  - v4: cwd 기반 project identity 치유 + synthetic session.model 치유
  - v5: **subagent 재분류** — 878개 subagent 파일을 부모에서 분리, 91k 메시지 reassign, 세션 통계 재계산
  - v6: `agent-acompact-*` 자동 compact 태깅 (meta.json 없는 경우)
  - v7: stop_reason / final_stop_reason / parent_tool_use_id / task_prompt 컬럼 + JSONL 백필 (58k 메시지) + parent tool_use 매칭 (875 subagent 링크)
  - v8: `sessions.tags` TEXT 컬럼
- **비용 저장**: `cost_micro` INTEGER (1 USD = 1,000,000). SQL 읽기 시 `cost_micro*1.0/1000000 AS cost_usd`
- **프로젝트 식별**: JSONL 레코드의 `cwd` 필드가 정답. `Path(cwd).name`이 display name. parser는 cwd 우선, fallback으로 디렉토리 인코딩 추정.
- **세션 모델**: `is_real_model(model)`일 때만 `session.model` 갱신 — synthetic이 세션을 하이재킹하지 않음.
- **Subagent 식별**: `subagents/agent-<hash>.jsonl` 파일은 **filename basename**을 세션 키로 사용. 레코드의 `sessionId`(parent를 가리킴)는 무시. `.meta.json` sidecar에서 `agentType`/`description` 로드. `agent-acompact-*` prefix는 sidecar 없이도 `agent_type='compact'` 자동 태깅.
- **stop_reason**: parser가 매 assistant 메시지의 `message.stop_reason`을 messages 행에 저장. 세션의 `final_stop_reason`은 sticky update (빈 값은 기존 유지).
- **parent_tool_use_id**: subagent의 `meta.json.description`을 parent JSONL의 `Agent` tool_use 블록과 매칭해서 링크.
- 타임스탬프: DB는 UTC, 시계열 쿼리는 `plan_config.timezone_name` (IANA) 변환
- 플랜 감지: `~/.claude/.credentials.json` → `rateLimitTier` (로컬 읽기, API 호출 없음)
- Anthropic rate limit API는 비공개 — 예산 추적은 로컬 JSONL 기반 추정치

## 관측성

- `/api/health` 인증 우회 (모니터링용)
- `/metrics` Prometheus 텍스트 포맷 (인증 우회)
  - `http_requests_total{method,path,status}` — 라우트 템플릿 기반 (cardinality bounded)
  - `http_request_duration_seconds` 히스토그램 (10 buckets: 0.005s~5s)
  - `dashboard_ws_connections` — 활성 WebSocket 게이지
  - `dashboard_scan_files_total{phase}` — initial/event/poll
  - `dashboard_new_messages_total` — watcher가 ingest한 새 메시지 카운터
  - `dashboard_file_retries_total{outcome}` — retry/gave_up
  - `dashboard_{sessions,messages}_total` gauge + `dashboard_db_size_bytes`
- 미들웨어 순서: **metrics(외부) → auth(내부) → route**. 401도 카운트됨.

## 디자인 시스템

Supanova Design Skill 기반:
- 배경: `#0a0a0a` (never pure black)
- 액센트: Emerald `#34d399` (단일)
- 카드: 더블베젤 (`bg-white/5` + `ring-white/[0.07]` + `inset shadow`)
- 네비: 플로팅 글래스 필 (`backdrop-blur-xl` + `rounded-full`)
- 폰트: Pretendard CDN + `break-keep-all` + `tabular-nums` + +25% 스케일
- 아이콘: Iconify Solar (`solar:*-linear`)
- 전환: `cubic-bezier(.16,1,.3,1)` (spring)
- 진입: `fadeInUp` + `blur(3px)` + 시차 (`anim-d1`~`anim-d5`)
- 버튼: pill `hover:scale-[1.02]` `active:scale-[0.98]`
- **라이트모드**: `body.theme-light` 토글, accent 컬러 oklch 매핑, sticky 헤더 반전
- **반응형**: `@media (max-width: 640px)` — 모달 95vw, 대화 stack, 토스트 top-center

## API 전체 목록 (42 routes + WS)

### 통계·시계열·예측

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/health` | 헬스체크 (인증 우회) |
| GET | `/metrics` | Prometheus 메트릭 (인증 우회) |
| GET | `/api/stats` | 전체/오늘 통계 (모델 집계는 **messages 기반** → synthetic $0) |
| GET | `/api/usage/periods` | 일/주/월 사용량 + 이전 기간 대비 증감 |
| GET | `/api/usage/hourly` | 시간별 (KST) |
| GET | `/api/usage/daily` | 일별 (KST) |
| GET | `/api/forecast?days=N` | 월말 비용 예측 + 일/주간 burn-out 시각 |

### 세션 관리

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/sessions` | 세션 목록 (sort/order, search, project, model, **pinned_only**, **date_from/to**, **cost_min/max**, **tag**, include_subagents) |
| GET | `/api/sessions/search?q=kw` | **FTS5** 전문 검색 (선두 와일드카드 차단, 매칭 토큰 하이라이트) |
| GET | `/api/sessions/{id}` | 세션 상세 (subagent_count/cost, duration_seconds, stop_reason, parent_tool_use_id, task_prompt, tags 포함) |
| GET | `/api/sessions/{id}/messages` | 대화 내용 (limit/offset, subagent 세션은 is_sidechain 필터 우회) |
| GET | `/api/sessions/{id}/subagents` | 해당 parent가 spawn한 subagent 목록 + duration |
| GET | `/api/sessions/{id}/chain?depth=N` | **디스패치 체인** — 재귀 walk (description 매칭) |
| DELETE | `/api/sessions/{id}` | 세션 삭제 (preview → confirm) |
| POST | `/api/sessions/{id}/pin` | 세션 핀 고정 |
| DELETE | `/api/sessions/{id}/pin` | 세션 핀 해제 |
| POST | `/api/sessions/{id}/tags` | 세션 태그 저장 (콤마 구분) |

### Subagents

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/subagents` | 전체 subagent 목록 (agent_type/parent/search 필터, sort/order, duration 포함) |
| GET | `/api/subagents/stats` | by_type / by_stop_reason / top_by_cost / top_by_duration / parents_with_most_subs / by_type_and_stop_reason |
| GET | `/api/subagents/heatmap` | agent_type × project 2D 집계 |

### 프로젝트 관리

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/models` | 모델별 분석 (sort/order) |
| GET | `/api/projects` | 프로젝트별 (path로 그룹, **session_count + subagent_count 분리**) |
| GET | `/api/projects/top` | 상위 N개 프로젝트 |
| GET | `/api/projects/{name}/stats` | 프로젝트 상세 (`?path=` 모호성 해소, sessions 배열 포함) |
| GET | `/api/projects/{name}/messages` | **프로젝트 전체 대화 취합** (limit/offset/order, `?path=`) |
| DELETE | `/api/projects/{name}` | 프로젝트 삭제 (`?path=` 필요 시) |

### 태그·예산·플랜

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tags` | 전체 태그 + 사용 카운트 |
| GET | `/api/plan/detect` | 플랜 자동 감지 |
| GET | `/api/plan/config` | 예산 설정 + 감지 정보 |
| POST | `/api/plan/config` | 예산 설정 변경 (daily ≤ weekly 검증) |
| GET | `/api/plan/usage` | 일일/주간 예산 vs 사용량 |

### 내보내기·관리

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/export/csv` | CSV — 23개 컬럼 (tags, stop_reason, parent_tool_use_id, duration_seconds, agent_type/description 포함) |
| POST | `/api/admin/backup` | DB 백업 (write_lock, 10개 유지) |
| DELETE | `/api/admin/retention` | 데이터 삭제 (preview → confirm) |
| GET | `/api/admin/db-size` | DB 크기 |
| WS | `/ws` | 실시간 (ping/pong 30초, WS 인증, batch_update 브로드캐스트) |

## 보안

- `DASHBOARD_PASSWORD` → HTTP Basic Auth + WS 인증 (constant-time 비교 `hmac.compare_digest`)
- SQL: 전 엔드포인트 파라미터화 + LIKE ESCAPE + 정렬 화이트리스트 (`_SESSIONS_SORT_MAP` 등)
- 입력: Pydantic + model_validator
- **삭제 안전장치**: 모든 destructive action(`/api/sessions/{id}` `/api/projects/{name}` `/api/admin/retention`)이 프론트에서 **이름 정확 입력 매칭** 모달을 거쳐야 confirm. 입력값 ≠ target → 버튼 disabled.
- 백업: write_lock 획득 후 SQLite `.backup`
- XSS: `esc()`가 `&<>"'` 모두 이스케이프; 사용자 조작 가능 데이터는 모두 `esc()`, 위험한 delete/pin/tag 버튼은 `addEventListener`로 DOM API 사용
- systemd: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `MemoryMax=512M`, `CPUQuota=150%`, `LockPersonality=true`

### ⚠️ CORS × CSRF 주의

현재 `allow_origins=["*"]` + HTTP Basic Auth 조합은 **브라우저가 credentialed cross-origin 요청을 거부**하는 덕분에 CSRF 공격으로부터 사실상 안전합니다 (wildcard + credentials 불일치로 브라우저가 자체 차단).

**`allow_origins`를 특정 도메인으로 좁히기 전에 반드시 다음 중 하나를 추가하세요**:
- DELETE/POST 엔드포인트에 CSRF 토큰 헤더 검증
- 또는 상태 변경 요청에 `Origin`/`Referer` 헤더 검사
- 또는 대시보드를 `localhost` 전용(unix socket, reverse proxy bind)으로 운영

그렇지 않으면 동일 사용자가 다른 탭에서 악성 사이트를 방문할 때 `<form method="POST">` 자동 제출 공격이 가능해집니다.

## DB 스키마

비용은 **INTEGER micro-dollars**로 저장 (1 USD = 1,000,000). float 누적 오차 차단.

```sql
-- sessions
cost_micro INTEGER DEFAULT 0    -- 세션 누적 비용 (micro USD)
pinned INTEGER DEFAULT 0        -- 핀 고정
project_path TEXT               -- cwd 원본 (C2/C3 fix의 핵심 키)
is_subagent INTEGER             -- subagent 여부
parent_session_id TEXT          -- 부모 session id (subagent only)
agent_type TEXT                 -- Explore/Plan/general-purpose/compact/...
agent_description TEXT          -- task 설명 (.meta.json에서 로드)
final_stop_reason TEXT          -- 마지막 assistant stop_reason (v7)
parent_tool_use_id TEXT         -- 부모의 toolu_* id (v7)
task_prompt TEXT                -- 부모가 dispatch 시 보낸 prompt (v7)
tags TEXT                       -- 콤마 구분 사용자 태그 (v8)

-- messages
cost_micro INTEGER DEFAULT 0    -- 메시지 비용 (micro USD)
stop_reason TEXT                -- end_turn/tool_use/max_tokens/... (v7)

-- messages_fts (v3 FTS5 virtual table)
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content_preview, content='messages', content_rowid='id'
)  -- triggers keep it in sync on INSERT/UPDATE/DELETE

-- SQL 읽기 시 변환
SELECT cost_micro * 1.0 / 1000000 AS cost_usd FROM ...
```

## 마이그레이션

```bash
# Schema는 PRAGMA user_version 기반. init_db()가 자동 진화 (v0~v8):
#   v0 → v1: base CREATE TABLE IF NOT EXISTS
#   v1 → v2: 복합 인덱스
#   v2 → v3: FTS5 virtual table + 트리거 + rebuild
#   v3 → v4: cwd 기반 project identity 치유 + session.model 치유
#   v4 → v5: subagent 재분류 (878 파일 walk, 91k 메시지 reassign)
#   v5 → v6: agent-acompact-* compact 태깅
#   v6 → v7: stop_reason + parent_tool_use_id 컬럼 + JSONL 백필
#   v7 → v8: sessions.tags TEXT

# 재구축이 필요할 때 (드물게):
rm ~/.claude/dashboard.db && sudo systemctl restart claude-dashboard
```

## 프론트 아키텍처

- `static/index.html` — HTML 쉘 (Tailwind CDN inline config + link 2개)
- `static/app.css?v=N` — 스타일 (폰트 +25% 오버라이드, 애니메이션, 라이트모드, 토스트, sticky 헤더, 반응형)
- `static/app.js?v=N` — 모든 JS (~2700 줄)
- FastAPI `StaticFiles` mount에서 `/static/*` 서빙
- 캐시버스팅: HTML 안의 `?v=N` 쿼리스트링을 코드 변경마다 bump (현재 v=16)

### 인터랙션 기능

- **URL 해시 라우팅**: `#/overview`, `#/sessions`, ..., `#/project/<name>?path=<path>`
- **키보드 단축키**: `g+o/s/c/m/p/e` 뷰, `/` 검색 포커스, `Esc` 모달 닫기, `?` 도움말, `Cmd/Ctrl+K` 명령 팔레트
- **WebSocket**: 무한 재연결 (지수 백오프 max 30s), wsDot 클릭 시 수동 재연결, debouncedRefresh로 batch_update 합치기
- **명령 팔레트** (Cmd+K): 뷰/프로젝트 fuzzy search, ↑↓/Enter/Esc
- **토스트**: 모든 destructive action + backup/export/plan 저장 success/error 피드백, 5초 dedupe (`reportError(ctx, e)`)
- **테마**: dark / light 토글, localStorage 지속
- **모달 focus trap**: deleteConfirm / projectModal / planModal / commandPalette / kbdHelp / tagEditModal
- **이름 매칭 삭제**: 모든 destructive action이 `openDeleteConfirm({target, message, onConfirm})` 거침
- **bulk operations**: 세션 multi-select → 핀/태그/비교/삭제 일괄
- **filter preset**: 정렬 + 고급 필터 조합을 이름 붙여 localStorage 저장
- **세션 비교 (diff)**: bulk 선택 2개 → 14개 메트릭 side-by-side
- **subagent chain**: parent → 자식 디스패치 트리 시각화
- **conversation tree 인디케이터**: parent_uuid가 직전 메시지가 아닐 때만 `↳ <8자> N단계 차이`
- **메시지 마크다운**: 코드블록(\`\`\`), 인라인 코드, 굵게, 링크, 불릿/번호 목록 (수작업 파서)
- **모델 전환 타임라인**: 세션 내 consecutive run 축약 (`Opus×12 → Haiku×8`)
- **subagent 카드**: 대화 뷰의 Agent tool_use 블록을 인라인 카드로 변환 (description 매칭)

### Overview 페이지 위젯

1. Day/Week/Month 카드 (cost + 이전 대비 증감)
2. 사용량 추적 바 (daily/weekly budget vs 사용)
3. 5개 stat (오늘/전체 cost/tokens, 캐시 효율)
4. 차트 행 1: 토큰 사용량 추이 (24h/7d/30d) + 모델 분포 도넛
5. 차트 행 2: 일별 비용 bar + 캐시 토큰 비율 도넛
6. **forecast 카드 3개**: 월말 예측 / 평균 / burn-out (B3+B4)
7. TOP 10 프로젝트
8. **subagent 히트맵** (agent_type × project)
9. **subagent 종료 매트릭스** (agent_type × stop_reason + 성공률)

### 세션 페이지

- 컬럼: ☐ / 프로젝트 (+ 핀, stop_reason, subagent 카운트, 태그) / 모델 / 입력 / 출력 / 캐시 / 비용 / 메시지 (+ 사용자 비율) / 활동 (+ duration) / 관리
- 액션 컬럼: ★ 핀 / 🏷 태그 / ✕ 삭제
- 상단: ★ 핀만 토글 / 필터 드로어 / 검색
- 필터 드로어: 시작일 / 종료일 / 비용 min / max + preset 저장/적용
- bulk action bar: ★핀 / ☆해제 / 🏷태그 / ⚖비교 / ✕삭제

### 대화 페이지

- 좌: 세션 목록 (정렬 핀, FTS 검색)
- 우: 대화 뷰어
  - 헤더: 프로젝트/cwd/모델, 토큰 분리(↓read + ↑creation), 비용, lineage 블록 (subagent: parent 링크 + tool_use_id + task_prompt), spawned subagents 슬롯, 디스패치 체인 보기 버튼
  - 네비 바: 사용자/어시스턴트 필터, 모두 접기/펼치기, 메시지 카운트, ↑↓ jump
  - 메시지: 마크다운 렌더, stop_reason 배지, git_branch 변경 인디케이터, parent_uuid 분기 마크
  - Agent tool_use 블록 → 인라인 subagent 카드 (클릭 drill-down)

### 프로젝트 모달

- 탭: 통계 / 세션 목록 / 전체 대화
- 통계: 4 카드 + 모델별 + 일별 비용 Chart.js bar
- 세션 목록: sortable 테이블, → 버튼으로 대화 drill
- 전체 대화: 시간순 timeline, 세션 boundary divider, 정렬 (오래된/최신)

### 설정 모달

- 탭: 플랜·예산 / 표시
- 플랜: 프리셋 (Pro/Max5x/Max20x), 일/주간 한도, 재설정, 시간대
- 표시: 테마 토글, 알림 권한, 환경설정 초기화, 키보드 단축키 도움말

## 테스트

```bash
./.venv/bin/python -m pytest tests/ -v
```

| 파일 | 케이스 | 영역 |
|---|---:|---|
| `tests/test_parser.py` | 29 | 가격, is_real_model, 코스트 계산, 프로젝트 식별, subagent ID, stop_reason 캡처/sticky |
| `tests/test_database.py` | 10 | 마이그레이션 idempotent, FTS5 트리거, 스레드 로컬 격리, write 직렬화, integrity |
| `tests/test_watcher.py` | 9 | WatcherMetrics 의존성 주입, _state_lock 동시성, 순환 임포트 회귀 방지 |
| `tests/test_api.py` | 33 | TestClient 통합 — health/stats/projects/sessions/subagents/forecast/chain/CSV/필터/태그 |
| **합계** | **81** | 평균 실행 ~2.5초 |

## 누적 변화 (요약)

| 단계 | 코드 | 테스트 | 핵심 |
|---|---:|---:|---|
| 시작 | 2,376줄 | 0 | 기본 대시보드 |
| 1차 감사 후 | 3,775줄 | 22 | C1~C4 데이터 정확성 fix |
| 2차 감사 후 | 4,400줄 | 41 | R1~R7 (circular import 등) |
| 3차 감사 후 | 5,500줄 | 68 | subagent 분리 + stop_reason |
| UX 1차 (18개) | ~6,200줄 | 78 | 토스트, 명령 팔레트, 다크/라이트 등 |
| 안전장치 + 토스트 전역 | ~6,400줄 | 78 | 이름 매칭 삭제, 토스트 통합 |
| Tier A+B (12개) | **8,072줄** | **81** | bulk/preset/forecast/burn/chain/diff |
