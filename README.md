# Claude Usage Dashboard

Claude Code 세션의 토큰 사용량, 비용, 대화, subagent 를 **실시간 추적**하는 자체 호스팅 웹 대시보드.
다중 서버의 Claude Code 데이터를 중앙 수집하고, claude.ai 웹 대화 export 도 통합 뷰어에서 검색할 수 있다.

```
~/.claude/projects/**/*.jsonl  →  watchdog 감지  →  SQLite WAL  →  FastAPI 69 routes  →  SPA 브라우저 · 공개 /landing/
                                                                  ↑
                                [원격 서버] collector.py  →  POST /api/ingest
```

| 스택 | 상세 |
|------|------|
| 백엔드 | Python 3.12, FastAPI, uvicorn, watchdog |
| 저장소 | SQLite WAL + FTS5, micro-dollar 정수 비용, v14 스키마 |
| 프런트 | esbuild 번들 (198KB) + Tailwind v3 빌드 (51KB) + Pretendard + Chart.js |
| 테스트 | 174 pytest (10초), CI: ruff + bandit + pip-audit + esbuild |

## 빠른 시작

```bash
git clone <repo> && cd claude-dashboard
cp .env.example .env          # DASHBOARD_PASSWORD 설정
./start.sh                    # .env 로드 → npm build → uvicorn
```

`http://localhost:8765` 에서 로그인 후 대시보드 접근.

### 환경변수 (.env)

```bash
DASHBOARD_PASSWORD=           # 설정 시 로그인 필수. 미설정 시 인증 비활성화
DASHBOARD_SECRET=             # 세션 서명 키. 미설정 시 재시작마다 세션 무효화
DASHBOARD_SECURE=true         # HTTPS 배포 시 쿠키 Secure 플래그
DASHBOARD_CORS_ORIGINS=       # 허용 오리진 (쉼표 구분)
PORT=8765                     # 서버 포트
```

### systemd 서비스

```bash
sudo cp claude-dashboard.service /etc/systemd/system/
sudo systemctl enable --now claude-dashboard
```

### 테스트 & 빌드

```bash
./.venv/bin/python -m pytest tests/ -v        # 174 tests
npm run build                                 # bundle.js + tailwind.css
npm run dev                                   # watch 모드 (개발)
```

## 주요 기능

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
curl -o collector.py http://dashboard:8765/api/collector.py
INGEST_KEY=<key> python3 collector.py --url http://dashboard:8765 --node-id server-1
```

- 세션/타임라인에서 노드별 필터링, Windows 경로 자동 파싱

### 관리자 (Admin)
- **대시보드 상태**: 가동시간, 스키마 버전, DB/WAL 크기, 세션·메시지·subagent·원격노드 카운트, Watcher 상태·큐
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
# 원격: ssh -L 8765:localhost:8765 user@host

# 옵션 2: Caddy 리버스 프록시 (자동 TLS)
# /etc/caddy/Caddyfile
dashboard.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

`DASHBOARD_SECURE=true` 설정 시 쿠키에 Secure 플래그 적용.

## 프로젝트 구조

```
main.py              FastAPI 69 routes + WS + 쿠키 세션 인증 + /landing/ 공개 라우트 + in-app 스케줄러
database.py          SQLite WAL, v0→v14 마이그레이션, write/read 분리
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
  overview.js        히어로 카드, 활성+TOP 5 (2그룹), 예측
  plan.js            예산 설정
  subagents.js       7개 섹션 시각화
  app.css            스타일 + 라이트모드 (WCAG AA)
  bundle.js          빌드 산출물 (esbuild)
  tailwind.css       빌드 산출물 (tailwindcss)
landing-pages/       공개 소개 페이지 (인증 우회, /landing/ 로 서빙)
  index.html         시안 navigator
  combined.html      통합판 (A+B+C, 01 Local → 02 Team → 03 Proof)
  variant-a-editorial.html   미니멀 에디토리얼
  variant-b-dataviz.html     데이터 중심 (대시보드 mockup + 히트맵)
  variant-c-multinode.html   팀/멀티노드 (아키텍처 다이어그램)
tests/               174 pytest (11개 파일)
docs/
  API.md             REST API 69 routes
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

## 문서

| 문서 | 내용 |
|------|------|
| [`docs/API.md`](docs/API.md) | REST API 69 routes + WebSocket |
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
