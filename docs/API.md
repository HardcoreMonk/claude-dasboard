# REST API

69 HTTP routes + 1 WebSocket. 인증은 `DASHBOARD_PASSWORD` 설정 시 쿠키 기반 세션 (`dash_session`). `/api/health`, `/metrics`, `/api/ingest`, `/api/collector.py`, `/login`, `/features`, `/landing/*` 는 인증 우회.

## 자동 생성 스펙 (FastAPI)

이 문서와 별개로 FastAPI 가 자동 생성하는 라이브 스펙이 있습니다:

| URL | 용도 |
|---|---|
| `http://localhost:8765/docs` | **Swagger UI** — 브라우저 인터랙티브 탐색, 요청 시도 |
| `http://localhost:8765/redoc` | **ReDoc** — 더 읽기 좋은 문서 뷰 |
| `http://localhost:8765/openapi.json` | **OpenAPI 3.1 스펙 JSON** — 외부 통합 / 클라이언트 코드 생성 |

외부 툴에서 이 대시보드 API 를 호출하려면 `openapi.json` 을 가져와
원하는 언어의 client generator 에 넣으면 됩니다. 예:

```bash
curl -s http://localhost:8765/openapi.json | jq '.paths | keys' | head
```


## 인증

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/login` | 로그인 페이지 HTML (인증 우회) |
| POST | `/api/auth/login` | 로그인. Body: `{password}`. 성공 시 `dash_session` 쿠키 발급 (HMAC 서명, 만료 내장). Rate limit: 5회/분/IP |
| POST | `/api/auth/logout` | 로그아웃 (`dash_session` 쿠키 삭제) |
| GET | `/api/auth/me` | 현재 인증 상태 확인. 응답: `{authenticated, auth_required}` |
| GET | `/features` | Feature Reference HTML 페이지 (인증 우회) |
| GET | `/landing`, `/landing/`, `/landing/{path}` | 공개 소개 페이지 (`landing-pages/` 서빙, 인증 우회, `Cache-Control: public, max-age=300`, path traversal guard) |

## 통계·시계열·예측

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 (인증 우회) |
| GET | `/metrics` | Prometheus 메트릭 (인증 우회) |
| GET | `/api/stats` | 전체/오늘 통계 (모델 집계는 messages 기반 → synthetic $0) |
| GET | `/api/usage/periods` | 일/주/월 사용량 + 이전 기간 대비 증감 |
| GET | `/api/usage/hourly?hours=N` | 시간별 (KST) |
| GET | `/api/usage/daily?days=N` | 일별 (KST) |
| GET | `/api/forecast?days=N` | 월말 비용 예측 + 일/주간 burn-out 시각 |

## 세션

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/sessions` | sort/order, search, project, model, pinned_only, date_from/to, cost_min/max, tag, include_subagents, node |
| GET | `/api/sessions/search?q=k` | FTS5 전문 검색 (선두 와일드카드 차단, 매칭 토큰 하이라이트) |
| GET | `/api/sessions/{id}` | 상세 — subagent_count/cost, duration, stop_reason, parent_tool_use_id, task_prompt, tags |
| GET | `/api/sessions/{id}/messages` | 대화 (limit/offset, subagent는 sidechain 필터 우회) |
| GET | `/api/sessions/{id}/message-position?message_id=N` | 특정 메시지의 0-based offset 반환 (검색 결과 → 해당 페이지 점프용). 응답: `{position, total, message_id}` |
| GET | `/api/sessions/{id}/subagents` | spawn한 subagent 목록 + duration |
| GET | `/api/sessions/{id}/chain?depth=N` | 디스패치 체인 재귀 walk |
| DELETE | `/api/sessions/{id}` | preview → confirm |
| POST / DELETE | `/api/sessions/{id}/pin` | 핀 토글 |
| POST | `/api/sessions/{id}/tags` | 태그 저장 (콤마 구분) |

## Subagents

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/subagents` | agent_type/parent/search 필터 + sort/order |
| GET | `/api/subagents/stats` | by_type, by_stop_reason, top_by_cost/duration, parents_with_most_subs, by_type_and_stop_reason |
| GET | `/api/subagents/heatmap` | agent_type × project 2D 집계 |

## 타임라인

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/timeline?date_from=D&date_to=D` | Gantt 용 세션 목록 (start/end, cost, model, project). `include_subagents`, `limit`, `node` |
| GET | `/api/timeline/heatmap?days=N` | 요일×시간 7×24 행렬 (메시지 수, 비용). 기본 90일 |
| GET | `/api/timeline/hourly?date=YYYY-MM-DD` | 특정 일자 시간별 (0~23) 프로젝트×세션 집계. `include_subagents`. 슬롯별 projects/sessions/message_count/cost_usd/tokens 반환 |

## 프로젝트·태그

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/models` | 모델별 분석 (sort/order, page/per_page) |
| GET | `/api/projects` | path 기반 그룹 + session/subagent 카운트 분리 (sort/order, page/per_page) |
| GET | `/api/projects/top?limit=N` | 비용 상위 N개. `include_active=true` → `{projects, active}` 형태로 활성(최근 30분) 프로젝트 별도 반환. `active_window_minutes`, `active_limit`(1–200, 기본 10) |
| GET | `/api/projects/{name}/stats` | `?path=` 모호성 해소, sessions 배열 포함 |
| GET | `/api/projects/{name}/messages` | 프로젝트 전체 대화 취합 (limit/offset/order, `?path=`) |
| DELETE | `/api/projects/{name}` | preview → confirm (`?path=` 필요 시) |
| GET | `/api/tags` | 전체 태그 + 사용 카운트 (page/per_page) |

## 예산·관리

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/plan/detect` | `rateLimitTier` 자동 감지 |
| GET / POST | `/api/plan/config` | 예산 조회/저장 (daily ≤ weekly 검증) |
| GET | `/api/plan/usage` | 일/주간 사용량 vs 예산 + 잔여 시각 |
| GET | `/api/export/csv` | CSV 23 컬럼 (tags, stop_reason, parent_tool_use_id, duration, agent_type/description 포함) |
| WS | `/ws` | 실시간 (init / batch_update / scan_progress / scan_complete, ping 30s). 쿠키 세션 인증 (`dash_session`) |

## 관리자 (admin)

관리자 UI의 "내보내기/Admin" 뷰에서 사용되는 라우트. 모든 admin 액션은 `admin_audit` 테이블에 `{action, actor_ip, status, detail}` 로 기록된다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/admin/backup` | DB 백업 (`_write_lock` + `sqlite3.backup()`, 10개 유지). 감사 `action=backup` |
| DELETE | `/api/admin/retention` | 오래된 세션 삭제. `?older_than_days=N&confirm=true`. preview → confirm 2단계. 감사 `action=retention` |
| GET | `/api/admin/db-size` | DB 파일 크기 (bytes / MB) |
| GET | `/api/admin/status` | 가동시간, 스키마 버전, DB·WAL 크기, 세션·메시지·subagent·원격노드·audit 카운트, watcher 상태·큐·추적 파일 수 |
| GET | `/api/admin/audit?limit=100&action=` | 감사 로그 조회 (최근순, action 필터) |
| GET | `/api/admin/retention/schedule` | 보존 스케줄 설정 조회 — `{enabled, interval_hours, older_than_days, last_run_at, last_result, next_run_at}` |
| PUT | `/api/admin/retention/schedule` | 스케줄 갱신 (enabled/interval_hours/older_than_days). 감사 `action=retention_schedule_update`. 내장 asyncio 루프가 60초마다 확인하여 due 시 자동 실행 (`action=retention_scheduled`) |

## 원격 노드 수집

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/ingest` | 원격 collector 에이전트가 JSONL 레코드 전송. `X-Ingest-Key` 헤더 인증. Body: `{node_id, file_path, records[]}` (인증 우회) |
| GET | `/api/collector.py` | collector.py 스크립트 다운로드 (원격 서버 설치용, 인증 우회) |
| GET | `/api/nodes` | 등록된 노드 목록 (local 포함) + 세션/메시지 카운트 |
| POST | `/api/nodes` | 노드 등록. Body: `{node_id, label?}`. 응답에 일회성 `ingest_key` 포함 |
| DELETE | `/api/nodes/{node_id}` | 노드 등록 해제 (수집된 데이터는 유지) |
| POST | `/api/nodes/{node_id}/rotate-key` | ingest key 재발급 |

## claude.ai export

`import_claude_ai.py` 로 적재된 웹 대화 아카이브 전용 라우트. 토큰/비용 없음 — content 검색 전용. 기존 `/api/sessions`, `/api/stats` 등 집계 엔드포인트는 이 데이터를 포함하지 않는다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/claude-ai/stats` | 전체 카운트 (conversations, messages, attachments, files, total_text_bytes, first/last timestamp) |
| GET | `/api/claude-ai/conversations` | sort (`updated_at`/`created_at`/`message_count`/`name`/`text_bytes`), order, search, per_page, page |
| GET | `/api/claude-ai/conversations/{uuid}` | 대화 메타 상세 (404 on unknown uuid) |
| GET | `/api/claude-ai/conversations/{uuid}/messages` | 메시지 목록 (limit/offset, content_json 포함) |
| GET | `/api/claude-ai/search?q=k` | FTS5 전문 검색 (LIKE fallback) |

## 관측성 메트릭

`/metrics` 응답에 포함되는 주요 시리즈:

- `http_requests_total{method,path,status}` — 라우트 템플릿 기반 (cardinality bounded)
- `http_request_duration_seconds` — 히스토그램 10 buckets (0.005s~5s)
- `dashboard_ws_connections` — 활성 WebSocket 게이지
- `dashboard_scan_files_total{phase}` — initial / event / poll
- `dashboard_new_messages_total` — watcher 가 ingest 한 새 메시지 카운터
- `dashboard_file_retries_total{outcome}` — retry / gave_up
- `dashboard_{sessions,messages}_total` 게이지 + `dashboard_db_size_bytes`

미들웨어 순서: **metrics(외부) → auth(내부) → route**. 401 도 카운트된다.

## 사용 예시

```bash
# 인증이 설정된 경우 먼저 로그인 (쿠키 저장)
curl -c cookies.txt -X POST http://localhost:8765/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"your-password"}'

# 이후 요청에 쿠키 첨부 (-b cookies.txt)
curl -b cookies.txt -s http://localhost:8765/api/stats | jq .
curl -b cookies.txt -s 'http://localhost:8765/api/sessions?per_page=10&pinned_only=true' \
  | jq '.sessions[]|{project_name,model,total_cost_usd,tags}'
curl -s 'http://localhost:8765/api/forecast?days=14' | jq .
curl -s 'http://localhost:8765/api/subagents/stats' | jq '.by_type_and_stop_reason'
curl -s 'http://localhost:8765/api/sessions/<sid>/chain?depth=4' | jq .
curl -o claude-usage.csv http://localhost:8765/api/export/csv
curl -s http://localhost:8765/metrics | grep dashboard_

# claude.ai export 엔드포인트
curl -s http://localhost:8765/api/claude-ai/stats | jq .
curl -s 'http://localhost:8765/api/claude-ai/conversations?sort=message_count&per_page=5' | jq '.conversations[]|{uuid,name,message_count}'
curl -s --get --data-urlencode 'q=하이퍼바이저' --data 'limit=5' http://localhost:8765/api/claude-ai/search | jq '.results'
```
