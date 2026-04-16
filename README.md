# Codex Dashboard

Codex CLI 세션을 우선으로 수집·검색·복기하는 자체 호스팅 웹 대시보드.
기존 Claude Code 사용량 집계와 claude.ai 웹 대화 export 도 함께 유지하지만, 현재 UX 기준축은 Codex 세션 검색·리플레이·타임라인이다.

```
~/.claude/projects/**/*.jsonl  →  watchdog 감지  →  SQLite WAL  →  FastAPI 62 routes  →  SPA 브라우저
                                                                  ↑
                                [원격 서버] collector.py  →  POST /api/ingest
```

| 스택 | 상세 |
|------|------|
| 백엔드 | Python 3.12, FastAPI, uvicorn, watchdog |
| 저장소 | SQLite WAL + FTS5, micro-dollar 정수 비용, v15 스키마 |
| 프런트 | esbuild 번들 (198KB) + Tailwind v3 빌드 (51KB) + Pretendard + Chart.js |
| 테스트 | 174 pytest (10초), CI: ruff + bandit + pip-audit + esbuild |

## 빠른 시작

```bash
git clone <repo> && cd claude-dashboard
cp .env.example .env          # DASHBOARD_PASSWORD 설정
./start.sh                    # .env 로드 → npm build → uvicorn
```

기본 접속 주소는 `http://localhost:8617` 이며, 로그인 후 대시보드에 접근한다.

### 사용자 접근 검증 절차

Codex 런타임을 배포하거나 재시작한 뒤에는 아래 순서로 `8617` 접근 상태와 로그인 강제를 확인한다.

1. 바인딩 확인: `ss -ltnp | grep 8617` 결과에 `0.0.0.0:8617` 또는 의도한 바인딩 주소가 보여야 한다.
2. 인증 필요 여부 확인: `curl http://127.0.0.1:8617/api/auth/me` 응답에서 `DASHBOARD_PASSWORD` 를 설정한 경우 `{"authenticated":false,"auth_required":true}` 가 반환되어야 한다.
3. 동일 네트워크의 다른 기기에서 원격 접속 확인: 브라우저로 `http://<서버IP>:8617` 에 접속해 로그인 화면이 열리는지 확인한다.
4. 보호 API 차단 확인: 로그인하지 않은 상태에서 `curl -i http://127.0.0.1:8617/api/stats` 를 호출해 `HTTP/1.1 401 Unauthorized` 또는 JSON `{"error":"unauthorized"}` 가 반환되는지 확인한다.

인증이 꺼진 개발 환경이라면 2번의 `auth_required` 가 `false` 로 내려오며, 4번의 보호 API 차단도 발생하지 않는다. 운영 환경에서는 반드시 `DASHBOARD_PASSWORD` 를 설정한 뒤 위 절차를 다시 확인한다.

### 환경변수 (.env)

```bash
DASHBOARD_PASSWORD=           # 설정 시 로그인 필수. 미설정 시 인증 비활성화
DASHBOARD_SECRET=             # 세션 서명 키. 미설정 시 재시작마다 세션 무효화
DASHBOARD_SECURE=true         # HTTPS 배포 시 쿠키 Secure 플래그
DASHBOARD_CORS_ORIGINS=       # 허용 오리진 (쉼표 구분)
PORT=8617                     # 서버 포트 기본값 (override 가능)
```

### systemd 서비스

운영 기준은 Codex 인스턴스다. Claude와 Codex는 별도 systemd 서비스로 운영하며, 서로 다른 포트·별도 DB 루트·별도 백업 루트를 사용한다.

```bash
# Codex Web Dashboard
sudo cp codex-web-dashboard.service /etc/systemd/system/
sudo systemctl enable --now codex-web-dashboard

# Claude Usage Dashboard
sudo cp claude-dashboard.service /etc/systemd/system/
sudo systemctl enable --now claude-dashboard
```

- `codex-web-dashboard.service` → `PORT=8617`, `DASHBOARD_DB_PATH=~/.codex/dashboard.db`, `DASHBOARD_BACKUP_DIR=~/.codex/dashboard-backups`
- `claude-dashboard.service` → `PORT=8765`, `DASHBOARD_DB_PATH=~/.claude/dashboard.db`, `DASHBOARD_BACKUP_DIR=~/.claude/dashboard-backups`

### 테스트 & 빌드

```bash
./.venv/bin/python -m pytest tests/ -v        # 174 tests
npm run build                                 # bundle.js + tailwind.css
npm run dev                                   # watch 모드 (개발)
```

## 주요 기능

### Codex 우선 탐색
- Codex 메시지 검색, 세션 리플레이, 타임라인/사용량/agent 요약을 별도 API 로 제공
- 프로젝트 단위로 Codex 세션을 빠르게 탐색하고 메시지 문맥을 재구성
- 기존 Claude Code 세션 집계와 분리된 인덱스로 저장해 회귀 없이 병행 운영

### 실시간 모니터링
- WebSocket 실시간 갱신 (800ms 디바운스)
- 4단계 프로젝트 상태 감지 (입력 대기 / 권한 대기 / 도구 실행 / 에이전트 작업)
- Web Audio 알림 chime (설정 가능)

### 비용 분석 (11개 시각화)
- 전체/오늘 비용 실시간 표시, 일/주/월 기간 비교
- 시간별/일별/모델별 차트, 캐시 효율, 종료 사유 분포
- $/hr 효율성, 월말 예측 (주중/주말 가중), 예산 소진 시각

### 세션 관리
- 8컬럼 정렬, 고급 필터 (날짜/비용/모델/태그/노드), FTS5 전문 검색
- 핀 고정, 태그, 벌크 작업 (병렬 Promise.all), 필터 프리셋
- CSV/JSON 내보내기 (스트리밍), 안전 삭제 (이름 매칭 확인)

### 대화 뷰어
- tool_use/tool_result 접기, 인라인 검색 + 하이라이트
- 통계 바, 시간 갭, 키보드 내비게이션 (j/k), 마크다운 내보내기
- WS 실시간 tail, subagent 디스패치 체인 시각화 (depth 5)

### 타임라인 (Gantt) — 18개 기능
- 프로젝트별 Gantt, 누적 비용 오버레이, 동시 작업 감지
- 줌/팬, 요일x시간 히트맵 + 드릴다운, 시간별 스택드 바 차트
- 시간별 아코디언, 효율 분석, 일간 리포트, 주간 트렌드
- 부모→자식(subagent) 연결 화살표, $/hr 이상치 자동 강조
- 어제→오늘 델타 카드 (신규/중단 프로젝트), 이름 해시 기반 프로젝트별 고유 색상

### 다중 서버 수집
- 원격 서버의 `~/.claude/projects/` 를 중앙 대시보드로 push
- 관리 UI 에서 노드 등록 → ingest key 발급 → collector 다운로드

```bash
# 원격 서버에서
curl -o collector.py http://dashboard:8617/api/collector.py
INGEST_KEY=<key> python3 collector.py --url http://dashboard:8617 --node-id server-1
```

- 세션/타임라인에서 노드별 필터링, Windows 경로 자동 파싱

### 관리자 (Admin)
- **대시보드 상태**: 가동시간, 스키마 버전, DB/WAL 크기, 세션·메시지·subagent·원격노드 카운트, Codex ingest 상태 (`source_kind=codex`, `indexed_sessions`, `indexed_messages`), Watcher 상태·큐
- **보존 스케줄**: 내장 asyncio 스케줄러 (enable/interval/days), 마지막·다음 실행 시각 표시
- **감사 로그**: 모든 관리자 액션(backup/retention/node_*)을 IP·상태·상세 JSON과 함께 기록·필터 조회
- **백업·복원·보존**: `sqlite3.backup()` 기반 일관 백업 (10개 로테이션), 보존 preview → confirm

### 그 외
- **Subagent 분석**: 유형별/종료사유/비용TOP10/소요TOP10/히트맵/매트릭스 (7개 섹션)
- **예산 관리**: 플랜 자동 감지, 일/주간 예산, 프로그레스 바, 카운트다운
- **claude.ai import**: 웹 export zip 인포트, 격리 테이블, 소스 토글
- **다크/라이트 테마**: WCAG AA 4.5:1, 반응형 (640/480/360px)
- **커맨드 팔레트**: Cmd+K, 키보드 단축키 (g+o/b/s/c)

## 인증 & 보안

| 항목 | 방식 |
|------|------|
| 로그인 | 쿠키 세션 (`dash_session`, HMAC 서명, 7일 만료) |
| rate limit | 로그인 5회/분/IP |
| API 클라이언트 | Basic Auth 헤더 호환 |
| SQL | 100% 파라미터화, ORDER BY 화이트리스트 |
| XSS | `h()` 헬퍼 + `esc()`, innerHTML 금지 |
| 삭제 | 이름 정확 입력 확인 모달 |
| CDN | SRI integrity 해시 |
| CORS | 환경변수 기반 허용 오리진 |

### HTTPS 배포

```bash
# 옵션 1: localhost + SSH 터널
HOST=127.0.0.1 ./start.sh
# 원격: ssh -L 8617:localhost:8617 user@host

# 옵션 2: Caddy 리버스 프록시 (자동 TLS)
# /etc/caddy/Caddyfile
dashboard.example.com {
    reverse_proxy 127.0.0.1:8617
}
```

`DASHBOARD_SECURE=true` 설정 시 쿠키에 Secure 플래그 적용.

## 프로젝트 구조

```
main.py              FastAPI 62 routes + WS + 쿠키 세션 인증 + in-app 스케줄러
database.py          SQLite WAL, v0→v15 마이그레이션, write/read 분리
parser.py            JSONL 파싱, 비용 계산, cross-platform cwd
watcher.py           watchdog + safety poll
collector.py         원격 수집 에이전트 (stdlib only)
build.js             esbuild + tailwindcss CLI 빌드
static/
  index.html         Tailwind 쉘 + 9개 뷰 + data-action 이벤트 위임
  login.html         로그인 페이지
  app.js             core: state, bus, accessors, WS, 대화뷰어
  sessions.js        세션 목록, 필터, 벌크, 노드 필터
  timeline.js        Gantt, 히트맵, 시간별 분석, 트렌드
  charts.js          Chart.js 6개 차트
  overview.js        히어로 카드, TOP 5, 예측
  plan.js            예산 설정
  subagents.js       7개 섹션 시각화
  app.css            스타일 + 라이트모드 (WCAG AA)
  bundle.js          빌드 산출물 (esbuild)
  tailwind.css       빌드 산출물 (tailwindcss)
tests/               174 pytest (11개 파일)
docs/
  API.md             REST API 58 routes
  ARCHITECTURE.md    아키텍처 가이드
  SCHEMA.md          DB 스키마 + 마이그레이션
  QUALITY-GATES.md   8단계 품질 게이트
  adr/               6건 아키텍처 결정 기록
  features.html      기능 레퍼런스 (14개 카테고리)
```

## 관측성

- Prometheus: `/metrics` (7개 메트릭 — 요청, 지연, WS, 스캔, 메시지, 재시도, DB)
- Grafana: `docs/grafana-dashboard.json` import
- Alert: `docs/alert-rules.yml` (8개 경보)
- 헬스: `GET /api/health` (인증 우회)

## 백업 & DR

```bash
./backup.sh                    # sqlite3 .backup (트랜잭션 안전, 10개 로테이션)
./restore.sh --latest          # 최신 백업 복원 (integrity_check 포함)
./rebuild.sh                   # DB 전체 재빌드 (스냅샷 → rm → 자동 재스캔)
```

### 자동 보존 정책 — 두 가지 경로

**A. 내장 asyncio 스케줄러 (권장)** — Export/Admin UI에서 토글로 활성화. `interval_hours`와 `older_than_days`를 설정하면 백그라운드 루프가 주기 체크 후 자동 실행. 설정은 `app_config` 테이블에 영속화되어 재시작에도 유지. Docker/VPS 동일하게 동작.

**B. systemd timer (레거시)** — 기존 설치 유지용.

```bash
sudo cp claude-dashboard-retention.{service,timer} /etc/systemd/system/
sudo systemctl enable --now claude-dashboard-retention.timer
# 매주 일요일 03:30, 365일 이전 데이터 삭제
```

서비스를 분리 운영할 때도 백업/보존 루트는 섞지 않는다. Claude와 Codex는 별도 systemd 서비스로 운영하고, 별도 DB 루트와 별도 백업 루트를 유지해야 복원 절차와 보존 정책을 독립적으로 관리할 수 있다.

## 문서

| 문서 | 내용 |
|------|------|
| [`docs/API.md`](docs/API.md) | REST API 62 routes + WebSocket |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 아키텍처 가이드 |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | DB 스키마, 마이그레이션, SQL 예제 |
| [`docs/QUALITY-GATES.md`](docs/QUALITY-GATES.md) | 8단계 품질 게이트 |
| [`docs/adr/`](docs/adr/) | 6건 아키텍처 결정 기록 |
| [`docs/features.html`](docs/features.html) | 기능 레퍼런스 (80+ 항목) |
| [`CLAUDE.md`](CLAUDE.md) | 코드 수정 불변식 (에이전트용) |
| `/docs` (서버) | Swagger UI (라이브) |
| `/features` (서버) | 기능 레퍼런스 HTML (인증 없이 접근) |

## 환경 요건

- Python 3.12+
- Node.js 20+ (빌드용 — `npm run build`)
- uvicorn `--loop asyncio --http h11` (필수)
- 디스크: `~/.claude/projects/` 읽기, `~/.claude/dashboard.db` 쓰기
- 선택: `prometheus_client`, `watchdog` (없으면 자동 fallback)

## 라이선스

자체 사용 도구. PR 전 `pytest tests/ && npm run build && ruff check .` 로 검증.
