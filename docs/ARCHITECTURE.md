# 아키텍처 가이드

Codex-first Dashboard 의 시스템 구조, 데이터 흐름, 컴포넌트 설계를 기술한다.
API 상세는 `API.md`, DB 스키마는 `SCHEMA.md` 를 참고.

프로젝트 운영 기준과 문서 우선순위는 `AGENTS.md`를 따른다.

---

## 시스템 개요

```
~/.codex/sessions/**/rollout-*.jsonl   (Codex 가 실시간 기록)
           |
     [watchdog + 30s poll]      codex_watcher.py
           |
     [JSONL 파싱 + 비용 계산]    codex_parser.py
           |
     [SQLite WAL 쓰기]          database.py
           |
Codex JSONL/이벤트 적재           store_codex_message()
           |
     [FastAPI routes]           main.py
       /    |     \
   REST API WS   Admin status
       \    |     /
      [SPA 프론트엔드]           static/*.js
```

단일 프로세스 (uvicorn) 가 파일 감시, DB 관리, Codex 인덱스 조회, API 서빙, WebSocket 브로드캐스트를 모두 처리한다.
외부 의존 서비스 없음 — SQLite 파일 하나로 완결된다.

운영 배포는 `codex-web-dashboard.service` 단일 인스턴스를 기준으로 한다. 기본 경로는 `~/.codex/dashboard.db`, `~/.codex/dashboard-backups`, `PORT=8617` 이다.

### 서비스 원칙

- `codex-web-dashboard.service` 는 Codex Web Dashboard 식별자와 전용 포트 `8617` 을 사용한다.
- 운영 데이터는 `~/.codex` 루트에만 쓴다.
- 백업과 보존 정책도 Codex 단일 인스턴스 기준으로 관리한다.

### 접근 검증 체크포인트

- 소켓 바인딩: 운영 점검 시 `ss -ltnp | grep 8617` 로 `0.0.0.0:8617` 리슨 여부를 먼저 확인한다.
- 인증 필요 상태: `GET /api/auth/me` 는 로그인 여부와 별개로 `auth_required` 를 반환한다. `DASHBOARD_PASSWORD` 가 설정된 Codex 런타임에서는 `auth_required=true` 가 정상 상태다.
- 원격 브라우저 접근: 동일 네트워크의 다른 기기에서 `http://<서버IP>:8617` 로 접속했을 때 로그인 화면이 보이면 바인딩과 HTTP 라우팅이 모두 정상이다.
- 보호 API 차단: 비로그인 상태에서 `GET /api/stats` 같은 보호 API 는 `401` 로 거부되어야 한다. 이 값이 200이면 인증 미들웨어 또는 환경설정이 잘못된 것이다.

---

## 백엔드

### uvicorn (ASGI 서버)

```bash
uvicorn main:app --host 0.0.0.0 --port 8617 --loop asyncio --http h11
```

- **asyncio loop + h11** 조합만 허용 (CLAUDE.md 불변식)
- 리버스 프록시 없이 단독 서빙 (정적 파일 + API + WebSocket)

### main.py — FastAPI 애플리케이션

HTTP routes + 1 WebSocket 을 호스팅.

| 그룹 | 라우트 | 역할 |
|---|---|---|
| 인증 | `/login`, `/api/auth/login`, `/logout`, `/me` | 쿠키 세션 인증 (HMAC 서명, rate limit 5/min/IP) |
| 페이지 | `/features` | Feature Reference HTML 페이지 (인증 우회) |
| 헬스 | `/api/health` | 서버 상태 + DB 메시지/세션 카운트 |
| 메트릭 | `/metrics` | Prometheus text format (인증 우회) |
| 세션 | `/api/sessions`, `/{id}`, `/{id}/messages`, `/{id}/message-position`, `/{id}/subagents`, `/{id}/chain`, `/{id}/pin`, `/{id}/tags` | Codex 기본 세션 조회/관리 경로 |
| Codex | `/api/search/messages`, `/api/search/messages/{message_id}/context`, `/api/sessions/{id}/replay`, `/api/codex/sessions`, `/api/codex/sessions/{id}/messages`, `/api/codex/projects/{name}/stats`, `/api/codex/projects/{name}/messages`, `/api/timeline/summary`, `/api/usage/summary`, `/api/agents/summary` | Codex 메시지 검색, 문맥 복기, 세션 리플레이, 프로젝트 상세, 타임라인/사용량/agent 요약 |
| 프로젝트 | `/api/projects`, `/top`, `/{name}/stats`, `/{name}/messages` | 프로젝트 집계, TOP 5, 상세 |
| 사용량 | `/api/usage/hourly`, `/daily`, `/periods` | 시계열 토큰/비용 집계 |
| 타임라인 | `/api/timeline`, `/timeline/heatmap`, `/timeline/hourly` | Gantt 데이터, 요일x시간 히트맵, 시간별 프로젝트×세션 집계 |
| 모델 | `/api/models` | 모델별 비용/토큰 집계 |
| Subagent | `/api/subagents`, `/stats`, `/heatmap` | subagent 분석 |
| 예측 | `/api/forecast` | MTD 비용 예측, 예산 소진 시간 |
| 플랜 | `/api/plan/detect`, `/plan/config`, `/plan/usage` | 요금제 감지, 예산 설정 |
| 원격 수집 | `/api/ingest`, `/api/nodes` | 다중 서버 JSONL 수집 (`codex_collector.py` → POST `/api/ingest`) |
| 관리 | `/api/admin/backup`, `/retention`, `/retention/schedule`, `/db-size`, `/status`, `/audit` | 백업, 보존 + 자동 스케줄러, Codex ingest 상태를 포함한 대시보드 상태, 감사 로그 |
| 내보내기 | `/api/export/csv` | 세션 CSV 다운로드 |
| WebSocket | `/ws` | 실시간 메시지 브로드캐스트 |

**미들웨어 스택** (등록 역순으로 실행):

```
요청 → metrics middleware → auth middleware → route handler
```

- `metrics`: 모든 요청을 `http_requests_total{method,path,status}` 로 카운트 (라우트 템플릿 기반, cardinality 제어)
- `auth`: `DASHBOARD_PASSWORD` 설정 시 쿠키 세션 검증 (`dash_session`). `/`, `/static/*`, `/api/health`, `/metrics`, `/api/ingest`, `/api/codex-collector.py`, `/login` 은 우회

### database.py — SQLite 데이터 계층

```
SCHEMA_VERSION = 18
모드: WAL, busy_timeout=5000, auto_vacuum=INCREMENTAL
```

**쓰기/읽기 분리:**

| 함수 | 역할 | 동시성 |
|---|---|---|
| `write_db()` | context manager, `threading.Lock` + `BEGIN IMMEDIATE` | 직렬 (단일 writer) |
| `read_db()` | thread-local 커넥션 캐시 | 병렬 (WAL 다중 reader) |

**테이블 구조:**

| 테이블 | 역할 |
|---|---|
| `file_watch_state` | 파일별 마지막 파싱 위치 (offset + mtime) |
| `plan_config` | 요금제, 예산, 타임존 설정 |
| `codex_projects` | Codex 프로젝트 메타 |
| `codex_sessions` | Codex 세션 메타 |
| `codex_messages` | Codex 메시지 + 리플레이/검색 원본 |
| `remote_nodes` | 원격 수집 노드 등록 (node_id, label, ingest_key) |
| `admin_audit` | 관리자 액션 감사 로그 (ts/action/actor_ip/status/detail) |
| `app_config` | in-app 설정 키-값 스토어 (현재 `retention_schedule`) |

**마이그레이션:** `PRAGMA user_version` 기반 차분 적용 (v0→v18). 각 단계는 idempotent.

### Codex 수집 상태

`/api/admin/status` 는 기존 DB 상태 외에 Codex 전용 ingest 상태도 함께 반환한다.

| 필드 | 의미 |
|---|---|
| `source_kind` | 현재 관리자 수집 상태가 어떤 소스를 설명하는지 나타냄. 현재 값은 `codex` |
| `indexed_sessions` | `codex_sessions` 기준 적재된 세션 수 |
| `indexed_messages` | `codex_messages` 기준 적재된 메시지 수 |

이 필드는 관리자 화면에서 "Codex 인덱스가 실제로 채워졌는지"를 즉시 확인하는 용도다.

### Codex runtime 기본값

대시보드는 Codex runtime 만을 기본 경로로 사용한다. 세션 상세, 메시지, 검색, 사용량, 메트릭, chain 은 모두 `codex_projects`, `codex_sessions`, `codex_messages` 기준으로 응답한다.

startup bootstrap 역시 Codex 전용이다. primary UI/API 에 필요한 스키마와 보조 설정 테이블만 생성하며, legacy runtime table bootstrap 은 더 이상 수행하지 않는다.

### codex_parser.py — JSONL 파싱 엔진

```
JSONL 레코드 → type 분기 (user/assistant/system)
           → 세션 upsert + 메시지 insert
           → 비용 계산 (micro-dollars)
```

**핵심 로직:**

| 함수 | 역할 |
|---|---|
| `parse_jsonl_file()` | 파일을 줄 단위로 파싱, 깨진 줄 스킵+카운트 |
| `process_record()` | 타입별 디스패치 (user/assistant/system) |
| `calculate_cost_micro()` | usage 딕트 + 모델 → 정수 micro-dollars |
| `effective_session_id()` | subagent 파일이면 filename basename 사용 |
| `project_info_from_cwd()` | cwd → (project_path, project_name) |

**비용 계산:**

```python
cost = input_tokens * rate.input
     + output_tokens * rate.output
     + cache_creation_tokens * rate.cache_creation
     + cache_read_tokens * rate.cache_read
→ USD → × 1,000,000 → INTEGER (micro-dollars)
```

6개 모델 가격표 (`MODEL_PRICING`) + family fallback (opus/sonnet/haiku substring 매칭).

### codex_watcher.py — 파일 감시

**이중 감시 체계:**

1. **watchdog Observer** — OS-level 파일 이벤트 (Linux: inotify)
2. **Safety poll** — 30초 간격 전체 스캔 (inotify 누락 대비)

**수명 주기:**

```
start_watching()
  → 초기 전체 스캔 (PROJECTS_ROOT 하위 모든 JSONL)
  → watchdog Observer 시작
  → safety poll 루프 (30s)
  → 변경 파일 → parse → DB 쓰기 → WS broadcast
```

**건강 검사:** Observer 스레드가 죽으면 자동 재시작.

**메트릭 주입:** `WatcherMetrics` 인터페이스 (Prometheus counters: scan_files, new_messages, retries). 테스트에서는 noop 구현 주입.

---

## 프론트엔드

### 모듈 구조

```
index.html          Tailwind 쉘 + 9개 뷰 섹션 + nav + 모달 + data-action 이벤트 위임
login.html          독립 로그인 페이지
  ├─ main.js        ES module entry point (import 순서 정의)
  ├─ app.js         코어: state, bus, accessors, WS, routing, utils, h(), 4단계 상태 감지
  ├─ charts.js      Chart.js 6개 차트 (usage, models, dailyCost, cache, stopReason, modelCache)
  ├─ sessions.js    세션 목록, 필터, 프리셋, 벌크 작업, 페이지네이션
  ├─ overview.js    overview 콘솔, KPI 요약, 기간별 비용, TOP 5, 예측, 미리보기 drawer
  ├─ plan.js        플랜 사용량, 설정 모달
  ├─ subagents.js   7개 섹션 시각화 (유형별·종료사유·히트맵·매트릭스)
  ├─ timeline.js    Gantt 차트, 히트맵(드릴다운), 효율분석, 일간리포트(시간별 아코디언), 스택드 바 차트, 트렌드비교
  ├─ app.css        스타일 + 라이트모드 매핑 + 반응형 + reduced-motion
  └─ [빌드 산출물]
     ├─ bundle.js     esbuild concat+minify (sourcemap 포함)
     └─ tailwind.css  tailwindcss CLI 프로덕션 빌드
```

**빌드:** `node build.js` (= `npm run build`) — 소스 JS 를 의존 순서대로 concat 후 esbuild minify → `bundle.js`. 동시에 tailwindcss CLI → `tailwind.css`. `index.html` 은 `bundle.vN.js` + `tailwind.vN.css` 단 2개만 로드.

### 이벤트 버스 & 상태 접근자

```javascript
// 경량 pub/sub — 모듈 간 느슨한 결합
const bus = { on(e, fn) { ... }, emit(e, ...args) { ... } };

// Chart.js 인스턴스 캡슐화
getChart(id), setChart(id, inst), destroyChart(id)

// 상태 접근자
setPage(n), setAdvFilters(obj), ...
```

- `data-action` 이벤트 위임: 인라인 `onclick` 대신 `data-action="actionName"` 속성 + delegated click handler 로 이벤트 처리.

### 상태 관리

```javascript
const state = {
  ws, stats, charts: {},           // WebSocket, 캐시, Chart.js 인스턴스
  currentPage, totalPages,         // 페이지네이션
  searchQuery, currentSession,     // 검색, 현재 열린 세션
  usageRange, theme,               // UI 프리퍼런스
  advFilters, bulkSelected,        // 고급 필터, 벌크 선택
  idleProjects: {},                // 프로젝트 4단계 상태
  convSource: 'codex',             // Codex 전용
};

const sortState = {                // 뷰별 정렬 (localStorage 영속)
  sessions:      { key, order, pinned_only },
  projects:      { key, order },
  models:        { key, order },
  conversations: { key, order },
};
```

`localStorage` (`codex-dashboard-prefs-v1`) 에 테마, 정렬, 필터, 타임라인 범위 등 영속.

### SPA 라우팅

```
URL hash: #/overview, #/cost, #/sessions, #/conversations,
          #/models, #/projects, #/subagents, #/timeline, #/export
```

- `showView(name)` — 뷰 전환 (DOM show/hide + nav pill active + hash 업데이트)
- `onViewChange(name)` — 뷰별 데이터 로더 호출 + Chart.js 인스턴스 정리
- `applyHash()` — `window.load` 시점에 호출 (모든 모듈 파싱 후)
- 딥링크: `#/project/<name>?path=<path>` → 프로젝트 모달 직접 열기

### WebSocket 실시간 업데이트

```
[서버]                              [클라이언트]
watcher 변경 감지                    connectWS()
  → broadcast(batch_update)   →      onmessage
                                       → notifyIdleFromBatch()  (4단계 상태)
                                       → debouncedRefresh()     (800ms 코얼레스)
                                           → loadStats, loadPeriods, loadTopProjects...
```

**재연결:** exponential backoff (2s → 4s → 8s → ... → 30s cap), 무한 재시도.
**15초 무응답 시:** persistent error 배너 표시.
**concurrent write 방지:** per-connection `asyncio.Lock`.

### 디자인 시스템 (Supanova)

| 요소 | 사양 |
|---|---|
| 배경 | `#0a0a0a` (never pure black) |
| 액센트 | Emerald `#34d399` (단일), 라이트 `#065f46` |
| 카드 | 더블베젤 (`bg-white/5` + `ring-white/[0.07]` + inset shadow) |
| 네비 | 플로팅 글래스 필 (`backdrop-blur-xl` + `rounded-full`) |
| 폰트 | Pretendard + `break-keep-all` + `tabular-nums` + +25% 스케일 |
| 아이콘 | Iconify Solar (`solar:*-linear`) |
| 전환 | `cubic-bezier(.16,1,.3,1)` (spring), `fadeInUp` + `blur(3px)` |
| 라이트모드 | `body.theme-light` 토글, WCAG AA 4.5:1 전 텍스트 검증 |

**캐시버스팅:** 파일명 기반 `/static/bundle.vN.js`, `tailwind.vN.css`. 서버가 정규식으로 `.vN` strip.

---

## 데이터 파이프라인

### 세션 식별

```
~/.codex/sessions/YYYY/MM/DD/<session>/rollout-*.jsonl
~/.codex/history.jsonl
```

- **일반 세션:** 레코드의 `sessionId` 필드 사용
- **Subagent:** 파일명 basename (`agent-{hash}`) 이 세션 키
- **부모 링크:** 디렉터리 구조에서 `parent_session_id` 추출, `.meta.json` sidecar 에서 `agentType`/`description` 로드
- **프로젝트:** 최초 `cwd` 값 고정 (후속 레코드의 cwd 변경 무시)

### 비용 흐름

```
JSONL 레코드 usage 블록
  → parser.calculate_cost_micro(usage, model)
    → MODEL_PRICING[model] 또는 family fallback
    → SUM(tokens × rate) × 1,000,000 → INTEGER
  → messages.cost_micro 저장
  → sessions.cost_micro += delta (누적)
  → API: cost_micro * 1.0 / 1000000 AS cost_usd
  → 프론트: fmt$() 로 표시
```

float 누적 오차 완전 차단 — DB 에서 프론트까지 정수 연산.

### 프로젝트 상태 4단계

```
[WebSocket batch_update]
  → notifyIdleFromBatch(records)
    → end_turn (부모)       → "입력 대기" (amber, chime)
    → tool_use (부모, 15s)  → "권한 승인 대기" (amber, chime)
    → tool_use (부모, <15s) → "도구 실행 중" (cyan)
    → tool_use (subagent)   → "에이전트 작업 중" (blue)
  → loadTopProjects() 에서 뱃지 렌더링
```

---

## 인프라

### 부트스트랩

```bash
./start.sh    # venv 생성 → pip install → uvicorn 실행
```

### systemd 서비스

```ini
[Service]
Type=simple
Restart=always
RestartSec=5s
MemoryMax=512M
CPUQuota=150%
ProtectSystem=strict
```

### DR (재해 복구)

| 스크립트 | 역할 |
|---|---|
| `backup.sh` | `sqlite3.backup()` + 최근 10개 보관 |
| `restore.sh` | `integrity_check` 후 복원 |
| `rebuild.sh` | DB 삭제 → 전체 JSONL 재파싱 |

### 보존 정책 (두 가지 경로)

**A. 내장 asyncio 스케줄러 (v14~, 권장)**

```
lifespan 시작 → _retention_scheduler_loop() 태스크 생성
  → 60초 sleep
  → app_config['retention_schedule'] 읽기
  → enabled && (now - last_run_at) ≥ interval_hours 면 _run_retention() 호출
  → last_run_at / last_result 저장
  → admin_audit 기록 (action=retention_scheduled)
lifespan 종료 → 태스크 cancel
```

설정은 `PUT /api/admin/retention/schedule` 로 영속화. Docker/Fly/Railway 등 컨테이너 배포에서도 동일하게 동작. UI: Export/Admin 뷰.

**B. systemd timer**

```
codex-web-dashboard-retention.timer  → 일요일 03:30 (15분 랜덤)
codex-web-dashboard-retention.service → 오래된 데이터 정리
```

### 감사 로그 (v14~)

모든 관리자 액션(backup/retention/node_*)은 `_audit(action, request, detail)` 헬퍼를 통해 `admin_audit` 테이블에 기록. 스케줄러 자동 실행은 `actor_ip='local'`. 조회: `GET /api/admin/audit?limit=&action=`.

### CI/CD

```yaml
# .github/workflows/ci.yml
- ruff (lint)
- pytest 전체 스위트
- node --check (JS syntax)
```

---

## 보안 모델

| 계층 | 방어 |
|---|---|
| **인증** | `DASHBOARD_PASSWORD` → 쿠키 세션 (`dash_session`, HMAC 서명, 만료 내장). 로그인 rate limit 5회/분/IP |
| **SQL** | 전 쿼리 파라미터화. ORDER BY 화이트리스트. LIKE 는 ESCAPE 필수 |
| **XSS** | `h()` 헬퍼 (DOM API), `esc()` (entity encoding). innerHTML 금지 |
| **삭제 확인** | `openDeleteConfirm()` — 타겟 이름 정확 입력 후 confirm |
| **CSRF** | 쿠키 세션 + `SameSite=Lax` 로 기본 보호 |
| **WebSocket** | `_ws_auth_ok()` — `dash_session` 쿠키 검증 |
| **정적 파일** | `/` 는 `Cache-Control: no-store`. 정적 파일은 `.vN` 캐시버스팅 |

---

## 외부 통합

### 원격 노드 수집

```
[원격 서버]                        [대시보드 서버]
codex_collector.py                POST /api/ingest
  watchdog + poll                   → X-Ingest-Key 인증
  → JSONL 변경 감지                  → parser.process_record(source_node=node_id)
  → POST /api/ingest                → DB 저장 + WS broadcast
```

- `codex_collector.py`: stdlib-only 독립 스크립트. 원격 서버의 Codex 로그를 감시하며 변경된 JSONL 레코드를 대시보드 서버로 전송.
- `GET /api/codex-collector.py`: 대시보드 서버에서 Codex collector 스크립트 다운로드 (원격 서버 설치 편의).
- `POST /api/nodes`: 노드 등록 시 일회성 `ingest_key` 발급. `POST /api/nodes/{id}/rotate-key` 로 재발급.
- `codex_sessions.source_node` 컬럼으로 로컬/원격 세션 구분. `?node=` 필터로 노드별 조회.

### 플랜 감지

- `~/.codex/.credentials.json` 의 `rateLimitTier` 읽기 (로컬 전용, API 호출 없음)
- 티어별 기본 한도 매핑 (Pro, Max 5x, Max 20x)
- 예산 추적은 전적으로 로컬 JSONL 기반 추정

---

## 테스트 커버리지

174 pytest across 11 test files:

| 파일 | 테스트 수 | 영역 |
|---|---|---|
| `test_parser.py` | 37 | JSONL 파싱, 비용 계산, subagent 식별 |
| `test_api.py` | 34 | REST 엔드포인트, 정렬, 필터, 페이지네이션 |
| `test_contract.py` | 32 | API 응답 스키마 계약 |
| `test_auth.py` | 18 | 쿠키 세션 인증, rate limit, 로그인/로그아웃 |
| `test_ingest.py` | 12 | 원격 노드 수집, ingest key 검증 |
| `test_database.py` | 10 | 마이그레이션, 쓰기/읽기 분리 |
| `test_watcher.py` | 9 | 파일 감시, 건강 검사, 재시작 |
| `test_e2e_smoke.py` | 8 | 엔드투엔드 통합 (서버 기동 → API 호출) |
| `test_collector.py` | 6 | collector 에이전트 로직 |
| `test_websocket.py` | 5 | WS 인증, 메시지 수신, ping/pong |
| `test_backup_restore.py` | 3 | DR 스크립트 |
