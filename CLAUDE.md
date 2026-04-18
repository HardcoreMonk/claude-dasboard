# CLAUDE.md — 코드 수정 불변식

에이전트가 이 코드베이스를 수정할 때 지켜야 할 규칙.

- 사용자 문서: `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/SCHEMA.md`
- 아키텍처 결정: `docs/adr/` (6건)
- **품질 게이트**: `docs/QUALITY-GATES.md` — 머지 전 필수 통과 기준

## 파일 구조

| 파일 | 역할 |
|------|------|
| `main.py` | FastAPI 70 routes + WS. `/` 공개 랜딩, `/app` SPA (인증), `/api/ingest`, 쿠키 세션 인증, 보존 스케줄러 |
| `database.py` | SQLite WAL, write/read 분리, v0→v15 마이그레이션 |
| `parser.py` | JSONL 파싱 (assistant/user/system), 비용 계산, source_node |
| `watcher.py` | watchdog + safety poll, WatcherMetrics DI |
| `collector.py` | 원격 수집 에이전트 (stdlib only) |
| `build.js` | esbuild concat+minify + tailwindcss CLI |
| `static/app.js` | core: state, bus, accessors, WS, routing, 대화뷰어 |
| `static/sessions.js` | 세션 목록, 필터, 벌크, 노드 필터 |
| `static/timeline.js` | Gantt, 히트맵, 시간별 분석, 트렌드 |
| `static/charts.js` | Chart.js 6개 차트 + 테마 |
| `static/overview.js` | 히어로 카드, 활성+TOP 5 (2그룹), 예측 |
| `static/search.js` | 전문 검색 — 3섹션 컨텍스트 뷰어, 역할 필터, 세션 점프 |
| `static/app.css` | 스타일 + 라이트모드 (WCAG AA 4.5:1) + color-scheme |
| `landing-pages/` | 공개 소개 페이지. `index.html` = `combined.html` (md5 동일, 주 랜딩) + variant-a/b/c 보조 시안 3종. `/landing/` 로 서빙, 인증 우회 |
| `tests/` | 174 pytest (11개 파일) |

## 실행·빌드·테스트

```bash
./start.sh                                    # .env 로드 + npm build + uvicorn
npm run build                                 # bundle.js + tailwind.css
./.venv/bin/python -m pytest tests/ -v        # 174 tests

# 원격 수집
curl -o collector.py http://dashboard:8765/api/collector.py
INGEST_KEY=<key> python3 collector.py --url http://dashboard:8765 --node-id <id>
```

## 환경변수 (.env)

```bash
DASHBOARD_PASSWORD=           # 설정 시 로그인 필수. 미설정 시 인증 비활성화
DASHBOARD_SECRET=             # 세션 서명 키. 미설정 시 재시작마다 세션 무효화
DASHBOARD_SECURE=true         # HTTPS 배포 시 쿠키 Secure 플래그
DASHBOARD_CORS_ORIGINS=       # 허용 오리진 (쉼표 구분). 미설정 시 same-origin만
PORT=8765                     # 서버 포트
ANTHROPIC_API_KEY=            # AI 세션 태깅. 미설정 시 태깅 비활성화 (graceful skip)
```

## 절대 깨면 안 되는 불변식

### uvicorn
`--loop asyncio --http h11` 필수. 다른 조합 미지원.

### DB 쓰기·읽기 분리
- 쓰기: `write_db()` — `threading.Lock` + `BEGIN IMMEDIATE`
- 읽기: `read_db()` — thread-local 캐시 (TTL 300s), WAL 다중 리더
- 백업: `_write_lock` 획득 후 `sqlite3.backup()`

### 비용은 INTEGER micro-dollars
`cost_micro` (1 USD = 1,000,000). SQL 읽기 시 `cost_micro * 1.0 / 1000000 AS cost_usd`. **float 누적 금지.**

### 프로젝트 식별 — cwd 최초 고정
- `record.cwd` → `PureWindowsPath(cwd).name` (크로스 플랫폼)
- **최초 INSERT 시 결정, 이후 변경 불가.** 빈 값 back-fill만 허용.

### session.model — real model만 갱신
`parser.is_real_model()` True일 때만. `<synthetic>` 등 메타 모델 하이재킹 금지.

### Subagent 식별
- `subagents/agent-<hash>.jsonl` — filename이 세션 키 (레코드 `sessionId` 무시)
- `agent-acompact-*` → `agent_type='compact'` 자동 태깅
- 부모 링크: `meta.json.description` ↔ 부모 `Agent` tool_use 매칭

### 프로젝트 상태 4단계
| 상태 | 조건 | 색상 | chime |
|------|------|------|-------|
| 입력 대기 | `end_turn` (부모) | amber | O |
| 권한 대기 | `tool_use` (부모, 15s 무응답) | amber | O |
| 도구 실행 | `tool_use` (부모, 15s 이내) | cyan | X |
| 에이전트 작업 | subagent `tool_use` | blue | X |

### stop_reason — sticky update
빈 값은 기존 `final_stop_reason` 덮어쓰지 않음.

### 타임존
DB는 **UTC**. 시계열 쿼리는 `plan_config.timezone_name` (IANA)으로 변환.

### claude.ai export 격리
`claude_ai_*` 테이블은 `sessions`/`messages` 와 **절대 JOIN/UNION 금지** — 비용 오염.

### 관리자 액션 감사
- `/api/admin/backup`, `/retention`, `/retention/schedule`, `/api/nodes/*` 를 변경하거나 추가할 때 **반드시** `_audit(action, request, detail=...)` 호출 (status='ok'/'error')
- `_audit()`는 실패해도 raise 하지 않음 — admin 액션 자체를 막으면 안 됨
- 스케줄러 자동 실행은 `request=None` 전달 → `actor_ip='local'`

### 보존 스케줄러
- `_retention_scheduler_loop()`는 lifespan 진입 시 `asyncio.create_task()`로 시작, 종료 시 cancel
- 설정은 `app_config['retention_schedule']` (JSON)에 영속화 — DB 기반 SSOT
- DB 쓰기는 `asyncio.to_thread(_run_retention, days)`로 이벤트 루프 비차단
- `/api/admin/retention` HTTP 라우트와 `_run_retention()` 공용 함수로 로직 공유

## 마이그레이션

`SCHEMA_VERSION=15`. `init_db()`가 차분 적용. 각 단계는 `_commit_migration()`으로 원자적 커밋.

| 버전 | 내용 |
|------|------|
| v2 | 복합 인덱스 |
| v3 | FTS5 + 트리거 |
| v4 | cwd/model 치유 |
| v5 | subagent 재분류 (878 파일, 91k 메시지) |
| v6 | acompact 자동 태깅 |
| v7 | stop_reason + parent_tool_use_id + 58k 백필 |
| v8 | sessions.tags |
| v9 | claude_ai 독립 테이블 + FTS5 |
| v10 | parent_session_id 인덱스 (N² → N log N) |
| v11 | claude_ai_messages.updated_at |
| v12 | sessions.turn_duration_ms |
| v13 | sessions.source_node + remote_nodes 테이블 |
| v14 | admin_audit + app_config — 관리자 감사 로그 + in-app 설정 스토어 |
| v15 | sessions.ai_tags + ai_tags_status — AI 세션 자동 태깅 |

새 마이그레이션: `SCHEMA_VERSION` bump → `_commit_migration()` 사용 → idempotent. 전체 표: `docs/SCHEMA.md`.

## 보안 체크리스트

- **SQL**: 전 파라미터화. `ORDER BY` 화이트리스트. LIKE에 ESCAPE.
- **XSS**: `h()` 헬퍼 또는 DOM API. `innerHTML` + 템플릿 리터럴 금지. `esc()`로 `&<>"'` escape.
- **인증**: 쿠키 세션 (`dash_session`, HMAC 서명, 만료 내장). rate limit 5회/분/IP.
- **CSRF**: `SameSite=Lax`. CORS 변경 시 CSRF 토큰 필수.
- **삭제**: `openDeleteConfirm()` — 이름 정확 입력 필수.

## 빌드 시스템

```bash
npm run build    # concat → esbuild minify → bundle.js + tailwindcss → tailwind.css
npm run dev      # watch 모드
```
- `index.html`은 `bundle.vN.js` + `tailwind.vN.css` 2개만 로드 (현재 v=89)
- 서버가 `.vN` strip하여 실제 파일 서빙
- 빌드 산출물은 git tracked — 배포 시 Node 불필요

### 공개 랜딩 페이지 (`landing-pages/` → `/` + `/landing/`)

- `/` 루트 — `landing-pages/index.html` 서빙 (2026-04-18부터 공개 front door). 기존 `/` SPA는 `/app`으로 이동
- `/landing`, `/landing/`, `/landing/{path}` — 동일 파일을 다른 경로로도 접근 가능 (레거시 호환 / 명시적 링크용)
- `/app`, `/app/` — SPA 대시보드 HTML shell (인증 필요)
- `_AUTH_BYPASS` 에 `/` 추가. `_AUTH_BYPASS_PREFIX('/landing/')` 유지
- Path traversal guard: `STATIC_DIR` 라우트와 동일 패턴 (resolved path가 `LANDING_DIR` 하위인지 검증)
- Standalone HTML — Tailwind/Pretendard/Iconify/Instrument Serif/Geist CDN만 의존, `bundle.js` 와 무관
- SPA(`/app`)와 생명주기 분리: 랜딩 변경 시 SPA 캐시버스팅(`.vN`) 불필요
- `index.html` 과 `combined.html` 은 동일 파일 (md5 매칭). 수정 시 두 파일 모두 반영 (대체로 `combined.html` 편집 후 `cp` 로 sync)
- nav 로고(`claude-dashboard`/`cd` 축약)는 `/login` 으로 이동 — 방문자 인증 진입점
- `/login` 성공 시 `/app` 로 리다이렉트 (기존 `/` 에서 변경)

## 프런트 수정 규칙

- **캐시버스팅**: `index.html`의 `.vN` 일괄 bump
- **이벤트**: `data-action="fnName"` + 중앙 위임. 새 버튼은 inline onclick 대신 `data-action` 사용
- **상태 접근자**: `getChart`/`setChart`/`destroyChart`, `setPage`/`setAdvFilters` 등. `state.*` 직접 변경 지양
- **Chart.js 렌더링**: `renderChart(stateKey, canvasId, config)` 사용. `setChart(name, new Chart(...))` 패턴은 `new Chart`가 setChart destroy보다 먼저 평가돼 "Canvas already in use" 에러 발생. `renderChart`는 destroy 보장 + `Chart.getChart(canvas)` 안전망 포함
- **이벤트 버스**: `bus.emit('refresh')` / `bus.on('refresh', fn)` — 모듈 간 직접 함수 호출 대신 사용
- **WS 이벤트**: `debouncedRefresh`로 batch
- **에러**: `reportError(ctx, e)` / `reportSuccess(ctx)`
- **라이트 테마**: `bg-[#0f0f0f]` 사용 (`bg-[#0a0a0a]` 금지). 새 색상은 `app.css` 라이트 매핑 확인
- **디자인**: Emerald `#34d399` 액센트, Double-Bezel 카드 (`.bezel`/`.bezel-inner`), Pretendard 폰트, Iconify Solar, `cubic-bezier(.16,1,.3,1)` spring
- **Supanova 컴포넌트**: `.eyebrow` (섹션 태그), `.reveal` (IntersectionObserver 스크롤 reveal), `.noise-overlay` (고정 노이즈), `.glass-section` (backdrop-blur 컨테이너), `.ambient-orb*` (메시 배경 애니메이션)
- **SPA nav 구조 (v88~)**: 2-cluster pill 레이아웃. (1) 상단 중앙 탭 전용 pill (10개 뷰 버튼, `whitespace-nowrap` 필수), (2) 상단 우측 유틸 pill (연결 상태/테마/⌘K/로그아웃). 탭 라벨은 모두 한글 2자 ("개요/비용/세션/대화/모델/하위/검색/시간/관리"), 예외는 "프로젝트" 하나
- **Table 행 관리 컬럼**: pin 상태(`★`)는 항상 visible, 나머지 action 버튼(🏷, ✕)은 `opacity-0 group-hover:opacity-100`. `<tr>` 에 `group` 클래스 필수

## 관측성

- 미들웨어: **metrics → auth → route** (순서 필수)
- `/api/health`, `/metrics` 인증 우회
- `http_requests_total{method,path,status}` — 라우트 템플릿 기반
- WS: `ConnectionManager` per-connection `asyncio.Lock`. broadcast + ping 모두 lock 경유

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke gstack-office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke gstack-investigate
- Ship, deploy, push, create PR → invoke gstack-ship
- QA, test the site, find bugs → invoke gstack-qa
- Code review, check my diff → invoke gstack-review
- Update docs after shipping → invoke gstack-document-release
- Weekly retro → invoke gstack-retro
- Design system, brand → invoke gstack-design-consultation
- Visual audit, design polish → invoke gstack-design-review
- Architecture review → invoke gstack-plan-eng-review
- Save progress, checkpoint, resume → invoke gstack-checkpoint
- Code quality, health check → invoke gstack-health
