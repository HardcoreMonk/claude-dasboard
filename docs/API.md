# REST API

42 HTTP routes + 1 WebSocket. 인증은 `DASHBOARD_PASSWORD` 설정 시 HTTP Basic (`/api/health`, `/metrics` 제외).

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
| GET | `/api/sessions` | sort/order, search, project, model, pinned_only, date_from/to, cost_min/max, tag, include_subagents |
| GET | `/api/sessions/search?q=k` | FTS5 전문 검색 (선두 와일드카드 차단, 매칭 토큰 하이라이트) |
| GET | `/api/sessions/{id}` | 상세 — subagent_count/cost, duration, stop_reason, parent_tool_use_id, task_prompt, tags |
| GET | `/api/sessions/{id}/messages` | 대화 (limit/offset, subagent는 sidechain 필터 우회) |
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

## 프로젝트·태그

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/models` | 모델별 분석 (sort/order) |
| GET | `/api/projects` | path 기반 그룹 + session/subagent 카운트 분리 |
| GET | `/api/projects/top?limit=N` | 비용 상위 N개 |
| GET | `/api/projects/{name}/stats` | `?path=` 모호성 해소, sessions 배열 포함 |
| GET | `/api/projects/{name}/messages` | 프로젝트 전체 대화 취합 (limit/offset/order, `?path=`) |
| DELETE | `/api/projects/{name}` | preview → confirm (`?path=` 필요 시) |
| GET | `/api/tags` | 전체 태그 + 사용 카운트 |

## 예산·관리

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/plan/detect` | `rateLimitTier` 자동 감지 |
| GET / POST | `/api/plan/config` | 예산 조회/저장 (daily ≤ weekly 검증) |
| GET | `/api/plan/usage` | 일/주간 사용량 vs 예산 + 잔여 시각 |
| GET | `/api/export/csv` | CSV 23 컬럼 (tags, stop_reason, parent_tool_use_id, duration, agent_type/description 포함) |
| POST | `/api/admin/backup` | DB 백업 (write_lock, 10개 유지) |
| DELETE | `/api/admin/retention` | preview → confirm |
| GET | `/api/admin/db-size` | DB 파일 크기 |
| WS | `/ws` | 실시간 (init / batch_update / scan_progress / scan_complete, ping 30s) |

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
curl -s http://localhost:8765/api/stats | jq .
curl -s 'http://localhost:8765/api/sessions?per_page=10&pinned_only=true' \
  | jq '.sessions[]|{project_name,model,total_cost_usd,tags}'
curl -s 'http://localhost:8765/api/forecast?days=14' | jq .
curl -s 'http://localhost:8765/api/subagents/stats' | jq '.by_type_and_stop_reason'
curl -s 'http://localhost:8765/api/sessions/<sid>/chain?depth=4' | jq .
curl -o claude-usage.csv http://localhost:8765/api/export/csv
curl -s http://localhost:8765/metrics | grep dashboard_
```
