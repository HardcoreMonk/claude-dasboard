# CLAUDE.md — 코드 수정 시 지켜야 할 불변식

이 문서는 **에이전트가 이 코드베이스를 수정할 때 지켜야 할 규칙**만 담는다.
사용자용 설명·API 레퍼런스·DB 스키마는 `README.md`, `docs/API.md`, `docs/SCHEMA.md` 를 본다.

## 파일 라인맵

```
main.py             1876줄  FastAPI 47 routes + /metrics + WS + 미들웨어 (claude.ai 5 routes 포함)
database.py          726줄  WAL + thread-local + v1→v9 마이그레이션 + FTS5 × 2
parser.py            459줄  JSONL 파싱, cwd 식별, subagent split, stop_reason
watcher.py           341줄  watchdog + safety poll + WatcherMetrics 의존성 주입
import_claude_ai.py  256줄  일회성 CLI — claude.ai 데이터 export 인포터
tests/              1163줄  81 pytest (parser 29 · database 10 · watcher 9 · api 33)
static/index.html    742줄  Tailwind 쉘 + 대화 소스 토글
static/app.js       3127줄  SPA (claude.ai 뷰어 포함)
static/app.css       253줄  스타일 + 라이트모드 오버라이드
```

## 실행·테스트 (수정 검증)

```bash
./start.sh                                                           # 부트스트랩 + uvicorn
./.venv/bin/python -m pytest tests/ -v                               # 81 tests in ~2.5s
./.venv/bin/python import_claude_ai.py --zip <path>                  # claude.ai export 인포터
./.venv/bin/python import_claude_ai.py --zip <path> --dry-run        # 파싱만 (DB 변경 없음)
```

## 절대 깨면 안 되는 불변식

### uvicorn
- **반드시** `--loop asyncio --http h11`. 다른 조합은 미지원이다.

### DB 쓰기·읽기 분리
- 쓰기: `database.write_db()` — `threading.Lock` + `BEGIN IMMEDIATE` + auto-commit/rollback. 전 쓰기는 이 컨텍스트를 통과해야 한다.
- 읽기: `database.read_db()` — **thread-local 커넥션 캐시**. WAL 덕분에 다중 리더가 동시 실행된다.
- 백업은 반드시 `_write_lock` 획득 후 `sqlite3.backup()` (트랜잭션 중 복사 방지).

### 비용은 INTEGER micro-dollars
- 저장 컬럼 `cost_micro` (1 USD = 1,000,000). float 누적 오차 차단.
- SQL 읽기 시 `cost_micro * 1.0 / 1000000 AS cost_usd` 로 변환.
- **float 로 누적하는 새 코드를 추가하지 말 것.**

### 프로젝트 식별은 cwd 가 정답
- JSONL 레코드의 `cwd` 필드가 1차 소스. `Path(cwd).name` 이 display name (`project_name`), 원본이 `project_path`.
- parser 는 cwd 우선, fallback 으로만 디렉터리 dash 인코딩 추정.
- 디렉터리명에서 프로젝트를 역산하면 `claude-dashboard` ↔ `dashboard` 같은 손실이 생긴다 — **하지 말 것.**

### session.model 은 real model 일 때만 갱신
- `parser.is_real_model(model)` 이 True 일 때만 `sessions.model` 을 업데이트한다.
- `<synthetic>` 같은 메타 모델이 세션 주모델을 하이재킹하면 안 된다.
- 가격표는 `parser.py:MODEL_PRICING`. 미지 모델은 family fallback (`opus`/`sonnet`/`haiku` substring) + 1 회성 WARNING.

### Subagent 식별
- `~/.claude/projects/*/subagents/agent-<hash>.jsonl` 파일은 **filename basename** 을 세션 키로 사용한다. 레코드 안의 `sessionId` (부모를 가리킴) 는 무시.
- `.meta.json` sidecar 에서 `agentType` / `description` 로드.
- `agent-acompact-*` prefix 는 sidecar 없이도 `agent_type='compact'` 자동 태깅 (v6).
- 부모 링크 (v7): subagent 의 `meta.json.description` 을 부모 JSONL 의 `Agent` tool_use 블록과 매칭해 `parent_tool_use_id` 연결.

### stop_reason (v7) 은 sticky
- parser 가 매 assistant 메시지의 `message.stop_reason` 을 `messages.stop_reason` 에 저장.
- 세션의 `final_stop_reason` 은 **sticky update** — 빈 값은 기존 값을 덮어쓰지 않는다.

### 타임존
- DB 의 모든 timestamp 는 **UTC**. 시계열 쿼리는 `plan_config.timezone_name` (IANA) 으로 변환한다.
- `reset_hour` / `reset_weekday` 도 이 타임존 기준.

### 플랜 감지
- `~/.claude/.credentials.json` → `rateLimitTier` **로컬 읽기 전용**. API 호출 금지.
- Anthropic rate limit 조회 API 는 비공개이다. 예산 추적은 전적으로 로컬 JSONL 기반 추정.

## 마이그레이션 (`PRAGMA user_version` 기반)

`SCHEMA_VERSION=9`. `init_db()` 가 시작 시 차분 적용 (v0→v9). 새 마이그레이션 추가 시:

1. `SCHEMA_VERSION` 을 bump.
2. `v(N-1)_to_v(N)()` 함수를 `database.py` 에 추가.
3. 기존 버전에서 한 번 통과하면 다시 실행되지 않도록 idempotent 하게 작성.
4. 무거운 재계산/백필 (v5, v7 같은) 은 write_lock 안에서 단일 트랜잭션으로 수행.

단계 요약:

- v2 복합 인덱스 · v3 FTS5 + 트리거 + rebuild · v4 cwd/model 치유 · **v5 subagent 재분류 (878 파일, 91k 메시지 reassign)** · v6 acompact 자동 태깅 · **v7 stop_reason + parent_tool_use_id 컬럼 + 58k 메시지 백필 + 875 부모 링크** · v8 `sessions.tags` · **v9 claude_ai_conversations + claude_ai_messages + claude_ai_messages_fts (독립 테이블)**

전체 표는 `docs/SCHEMA.md` 참고.

## claude.ai export 통합 (v9)

별도 경로. `~/.claude/projects/` JSONL 과 완전히 분리되어 있다.

- **원본**: claude.ai → Settings → Privacy → *Export data* 로 받는 `conversations.json` (토큰/모델/비용 **없음**)
- **수집 경로**: `import_claude_ai.py` CLI → `claude_ai_*` 테이블 upsert (conversation uuid / message uuid 가 idempotent key)
- **격리 원칙**: 기존 `sessions` / `messages` 집계 쿼리는 **절대로 claude_ai_* 를 JOIN/UNION 해서는 안 된다**. cost_micro·forecast·budget·burn-out 위젯이 오염된다. 읽기 라우트는 `/api/claude-ai/*` 전용.
- **프런트 진입점**: 대화 뷰 좌측 상단 source 토글 (`claude-code` ↔ `claude-ai`). `state.convSource` + `localStorage` 로 지속.
- **content block 렌더링**: 웹 UI 블록 (`text` / `thinking` / `tool_use` / `tool_result`) 은 Claude Code 의 블록과 shape 이 다르다. `renderClaudeAiContent(container, msg)` 가 DOM API 로 렌더 (`innerHTML` 금지 — 보안 훅이 막는다).

## 관측성·미들웨어 순서

- `/api/health`, `/metrics` 는 **인증 우회**.
- 미들웨어 스택: **metrics (외부) → auth (내부) → route**. 순서를 뒤집으면 401 이 메트릭에서 누락된다.
- `http_requests_total{method,path,status}` 은 **라우트 템플릿** 기반 (path param 을 그대로 쓰면 cardinality 폭발).
- 새 WebSocket 연결이 추가되면 `dashboard_ws_connections` 게이지를 increment/decrement 할 것.

## 보안 체크리스트

- **SQL**: 전 엔드포인트 파라미터화. `ORDER BY` 는 화이트리스트 (`_SESSIONS_SORT_MAP` 등). LIKE 는 ESCAPE 필수.
- **입력 검증**: Pydantic + `model_validator`. 예산 저장 시 `daily ≤ weekly` 강제.
- **이름 매칭 삭제**: 모든 destructive 프런트 액션 (`/api/sessions/{id}`, `/api/projects/{name}`, `/api/admin/retention`) 은 `openDeleteConfirm({target, message, onConfirm})` 을 거쳐 target 이름 정확 입력 후에만 confirm 버튼이 활성화된다. 새 destructive 라우트는 반드시 동일 패턴을 따라야 한다.
- **XSS**: `app.js` 의 `esc()` 가 `&<>"'` 모두 escape. 사용자 조작 가능 데이터는 전부 `esc()` 통과. 델리트/핀/태그 버튼은 `innerHTML` 이 아니라 `addEventListener` + DOM API 로 만든다.
- **CSRF**: `allow_origins=["*"]` + Basic Auth 조합이 브라우저 credentialed cross-origin 차단 덕분에 현재 안전하다. `allow_origins` 를 좁힐 경우 **반드시** CSRF 토큰 또는 `Origin`/`Referer` 검사를 같이 추가할 것.

## 프런트 수정 시

- 캐시버스팅: `static/index.html` 안의 `?v=N` 을 bump (현재 v=16).
- 정렬/필터 파라미터는 URL hash 에 반영되어야 한다 (`#/sessions?sort=cost&order=desc`).
- WebSocket 이벤트는 `debouncedRefresh` 로 batch. 개별 refresh 로 돌리지 말 것.
- 토스트는 `reportError(ctx, e)` / `toast.success(...)` 로 5 초 dedupe.
- 모든 모달은 focus trap 필수.

## 디자인 시스템 (Supanova)

- 배경 `#0a0a0a` (never pure black), 액센트 Emerald `#34d399` (단일)
- 카드: 더블베젤 (`bg-white/5` + `ring-white/[0.07]` + inset shadow)
- 네비: 플로팅 글래스 필 (`backdrop-blur-xl` + `rounded-full`)
- 폰트: Pretendard + `break-keep-all` + `tabular-nums` + +25% 스케일
- 아이콘: Iconify Solar (`solar:*-linear`)
- 전환: `cubic-bezier(.16,1,.3,1)` (spring), 진입 `fadeInUp` + `blur(3px)` + 시차
- 라이트모드: `body.theme-light` 토글, accent oklch 매핑
