# Claude Usage Dashboard

Claude Code 의 토큰 사용량·비용·대화·subagent 를 실시간 추적하는 자체 호스팅 웹 대시보드. claude.ai 웹 대화 export 도 같은 뷰어에서 검색·탐색할 수 있다.

`~/.claude/projects/` 하위의 세션 JSONL 을 자동 수집해 SQLite (WAL + FTS5) 에 저장하고, 브라우저에서 분석·검색·관리한다.

- 백엔드: Python 3.12 + FastAPI + uvicorn + watchdog
- 저장소: SQLite WAL, micro-dollar 정수 비용, 88 k+ 메시지 규모 테스트
- 프런트: 단일 파일 SPA — Tailwind + Pretendard + Chart.js + Cmd+K
- 테스트: 81 pytest (~2.5 초)

## 빠른 시작

```bash
cd claude-dashboard
./start.sh                            # 기본 http://localhost:8765
PORT=9000 ./start.sh                  # 포트 변경
DASHBOARD_PASSWORD=secret ./start.sh  # HTTP Basic Auth + WS 인증
```

`start.sh` 가 venv 를 부트스트랩하고 `uvicorn --loop asyncio --http h11` 로 띄운다.

### systemd 서비스

```bash
sudo cp claude-dashboard.service /etc/systemd/system/
sudo systemctl enable --now claude-dashboard
journalctl -u claude-dashboard -f
```

유닛은 `MemoryMax=512M`, `CPUQuota=150%`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` 하드닝이 적용되어 있다.

### 테스트

```bash
./.venv/bin/python -m pip install pytest httpx
./.venv/bin/python -m pytest tests/ -v
```

## 주요 기능

| 영역 | 내용 |
|---|---|
| **데이터 정확성** | `cost_micro` 정수 저장, cwd 기반 프로젝트 식별, synthetic 모델 하이재킹 차단, 878 개 subagent 파일 독립 세션 승격 |
| **실시간 수집** | watchdog inotify 우선 + 30 초 폴링 safety net, 3-phase 처리 (read → parse → serialized write) |
| **분석·시각화** | 14 일 평균 기반 월말 forecast, 일/주간 burn-out, subagent 히트맵 (agent_type × project), 종료 매트릭스, 디스패치 체인 트리, 모델 전환 타임라인 |
| **세션 관리** | FTS5 전문 검색, 고급 필터 (날짜/비용 range) + preset 저장, 핀, 태그, 세션 2 개 side-by-side diff, bulk 작업 |
| **UX** | Cmd+K 명령 팔레트, 다크/라이트 테마, 18 개 액션 토스트 피드백, 마크다운 렌더, 모바일 반응형, focus trap, 키보드 단축키 |
| **관측성** | `/api/health` + `/metrics` (Prometheus) 인증 우회, WebSocket 지수 백오프 무한 재연결 |
| **claude.ai import** | 웹 export zip (`conversations.json`) 을 분리 테이블로 인포트, 독립 FTS5 검색, 대화 뷰에서 source 토글 (토큰/비용 없음 — 격리 저장) |

## 화면

| 뷰 | 설명 |
|---|---|
| **개요** | 일/주/월 카드, 예산 추적 바, forecast 카드 3 개, TOP 10 프로젝트, subagent 히트맵·종료 매트릭스 |
| **세션** | sortable 테이블 + 고급 필터 드로어, bulk action bar, 이름 매칭 삭제 안전장치 |
| **대화** | 좌 세션 목록 (FTS 하이라이트), 우 뷰어 — lineage 블록, spawned subagents, stop_reason 배지, Agent 블록 inline 카드 |
| **모델** | 모델별 토큰·비용·캐시 카드 |
| **프로젝트** | 탭형 모달 (통계 / 세션 / 전체 대화), 일별 비용 차트 |
| **관리** | CSV 내보내기, DB 백업, 데이터 보존 (이름 매칭 확인) |

## 프로젝트 구조

```
main.py               1876줄  FastAPI 47 routes + /metrics + WS
database.py            726줄  WAL + thread-local + v1→v9 마이그레이션 + FTS5 × 2
parser.py              459줄  cwd 식별, subagent split, stop_reason 캡처
watcher.py             341줄  watchdog + safety poll + 메트릭 주입
import_claude_ai.py    256줄  claude.ai export → claude_ai_* 테이블 (일회성 CLI)
static/index.html      742줄  Tailwind + Pretendard HTML 쉘
static/app.js         3127줄  SPA — 라우팅·키보드·WS·bulk·forecast·claude.ai 뷰어
static/app.css         253줄  스타일 + 라이트모드 + 반응형
tests/                1163줄  81 pytest (parser/database/watcher/api)
```

총 ~8,943 줄.

## 예산 추적 vs 실제 플랜 한도

Anthropic 은 rate limit 조회 API 를 공개하지 않는다. 이 대시보드의 예산 추적은 **로컬 JSONL 기반 추정치**이며 claude.ai 웹의 플랜 잔여량과는 별개이다.

- `~/.claude/.credentials.json` → `rateLimitTier` 자동 감지
- 사용자가 일/주간 한도 직접 설정 (Pro / Max 5x / Max 20x 프리셋)
- 14 일 평균 기반 burn-out 시각 ("N 시간 후 한도 도달")

## 보안 요약

- `DASHBOARD_PASSWORD` → HTTP Basic Auth + WebSocket 인증 (`hmac.compare_digest`)
- 전 엔드포인트 SQL 파라미터화 + LIKE ESCAPE + 정렬 화이트리스트
- 모든 destructive action 은 프런트 모달에서 **target 이름 정확 입력** 후에만 활성화
- XSS: `esc()` 가 `&<>"'` escape, 위험 버튼은 DOM API
- systemd: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`, `MemoryMax=512M`

> ⚠️ **CORS × CSRF**: 현재 `allow_origins=["*"]` + Basic Auth 조합은 브라우저가 credentialed cross-origin 요청을 거부하기에 사실상 안전하다. `allow_origins` 를 좁히기 전에 반드시 CSRF 토큰 또는 `Origin`/`Referer` 검사를 추가하거나, localhost 전용으로 운영할 것.

## 환경 요건

- Python 3.12+
- uvicorn **반드시** `--loop asyncio --http h11`
- 디스크: `~/.claude/projects/` 읽기, `~/.claude/dashboard.db` 쓰기
- 선택: `prometheus_client`, `watchdog` (없으면 자동 fallback)

## 백업·복구

```bash
./backup.sh                                            # CLI (sqlite3 .backup)
curl -X POST http://localhost:8765/api/admin/backup    # API (write_lock 획득)
```

백업 위치: `~/.claude/dashboard-backups/`, 최근 10 개 자동 유지.

## claude.ai 웹 대화 import

claude.ai 웹에서 쌓인 대화는 Anthropic 공개 API 가 없어 실시간 수집이 불가능하지만, 공식 *Export data* 기능으로 받은 `conversations.json` 을 인포트할 수 있다.

```bash
# 1. claude.ai → Settings → Privacy → Export data (이메일로 zip 수령)
# 2. 인포트 (idempotent — 같은 export 재실행 시 중복 없음)
./.venv/bin/python import_claude_ai.py --zip /path/to/data-*.zip

# 파싱 검증만 하고 DB 변경은 안 할 경우
./.venv/bin/python import_claude_ai.py --zip /path/to/data-*.zip --dry-run
```

주의: claude.ai export 에는 **토큰·모델·비용 정보가 없다**. 이 데이터는 `claude_ai_*` 테이블에 분리 저장되며 forecast / budget / burn-out 집계에는 영향을 주지 않는다. 브라우저 대화 뷰 좌측 상단의 **Claude Code ↔ claude.ai** 토글로 전환한다.

## 문서

- [`docs/API.md`](./docs/API.md) — REST API 42 routes + WebSocket + 관측성 메트릭
- [`docs/SCHEMA.md`](./docs/SCHEMA.md) — DB 스키마, 마이그레이션 히스토리, SQL 예제, 모델 가격표
- [`CLAUDE.md`](./CLAUDE.md) — 코드 수정 시 지켜야 할 불변식 (에이전트용)

## 라이선스

자체 사용 도구. PR 전 `pytest tests/` 로 검증.
