# Codex 제로베이스 재기반화 설계

## 문서 기준

이 설계는 저장소를 Claude 호환 레이어 위에 얹힌 Codex 파생 제품으로 보지 않고, Codex 전용 제품으로 재정의한다. 구현, 스키마, 문서, 서비스 식별자는 모두 Codex 기준으로 맞춘다.

## 목표

현재 제공 중인 기능은 유지하되, 코드베이스와 런타임에서 Claude 연관 계층을 제거한다.

이 작업 이후 시스템은 다음을 만족해야 한다.

- 검색, 세션 뷰, 타임라인, 관리자 기능, 원격 수집 기능이 그대로 동작한다.
- `claude_ai_*`, `sessions/messages`, `parser.py`, `watcher.py`, `collector.py`, `claude-dashboard.service` 같은 Claude 유산에 기능적으로 의존하지 않는다.
- 데이터 소스와 집계 경로는 `codex_*` 테이블과 Codex 이벤트 파이프라인만 사용한다.
- 관리 메뉴의 DB 크기 표시는 실제 파일 크기와 활성 데이터 규모를 구분해 보여준다.

## 범위

이번 설계에 포함되는 항목은 다음과 같다.

- Codex 전용 수집/색인 파이프라인으로의 재기반화
- 원격 수집 기능 유지, 단 collector 계약을 Codex 기준으로 재정의
- Claude 전용 스키마, API, 서비스, 문서, 테스트 제거 또는 치환
- SQLite 파일 비대화 원인 제거와 DB 크기 표시 개선

이번 단계에서 제외하는 항목은 다음과 같다.

- 다중 프로바이더 지원
- Claude 데이터 import/export 호환성 유지
- 기존 Claude 런타임 DB를 자동으로 장기 보존하는 마이그레이션 도구

## 제품 원칙

### 1. Codex 단일 진실원

런타임에서 의미 있는 엔티티는 `codex_projects`, `codex_sessions`, `codex_messages`, `codex_messages_fts`, `remote_nodes`, `admin_audit`, `app_config`, `plan_config`만 남긴다.

기존 `sessions`, `messages`, `claude_ai_*`는 제품 내부 호환 계층이 아니라 제거 대상이다.

### 2. 기능 유지 우선

사용자에게 노출된 기능은 유지해야 한다. 기능을 줄이지 않고 구현 계층만 바꾼다.

- 검색 기능은 `codex_messages_fts` 기반으로 유지
- 세션 뷰는 `codex_sessions` / `codex_messages` 기반으로 유지
- 타임라인 6개 보조 패널도 `codex_*`만으로 집계
- 원격 수집도 Codex 이벤트를 서버로 전송하는 방식으로 유지

### 3. 호환 레이어 제거

Claude 관련 코드는 "남겨 두되 안 쓰는" 상태도 허용하지 않는다. 남아 있는 코드가 다시 활성화될 수 있기 때문이다. 저장소 수준에서 제거하거나 Codex 명명으로 재작성한다.

## 아키텍처

시스템은 세 계층으로 단순화한다.

### 1. Codex 수집 계층

로컬 Codex 로그와 원격 Codex 노드에서 들어오는 이벤트만 처리한다.

- 로컬: `~/.codex/...` 아래의 세션/이벤트 파일 감시
- 원격: `/api/ingest`가 Codex 이벤트 레코드 수신
- 체크포인트: 파일 경로, 오프셋, 수정 시각 추적

이 계층은 더 이상 Claude JSONL 의미를 알면 안 된다. 수집기 이름, 클래스 이름, 설정 상수도 Codex 기준으로 바뀐다.

### 2. Codex 정규화/저장 계층

원시 이벤트를 다음 엔티티로 정규화한다.

- `codex_projects`
- `codex_sessions`
- `codex_messages`
- `codex_messages_fts`

서브에이전트, 툴 호출, stop reason, usage, 원격 노드, timeline 파생 정보는 위 테이블의 컬럼과 파생 집계로 표현한다. Claude 전용 별도 저장 모델은 두지 않는다.

### 3. API 및 표현 계층

모든 UI/API는 Codex 정규화 계층만 읽는다.

- 검색/세션/개요/관리자/타임라인은 `codex_*` 기반
- 관리자 진단은 DB 파일, WAL, freelist, 인덱스 카운트까지 노출
- 더 이상 `/api/claude-ai/*`, `/api/collector.py` 같은 Claude 잔존 표면은 두지 않는다

## 제거 대상과 대체 경로

### 제거 대상

- `parser.py`
- `watcher.py`
- `collector.py`
- `import_claude_ai.py`
- `claude-dashboard.service`
- `claude-dashboard-retention.service`
- `claude-dashboard-retention.timer`
- `sessions`, `messages`, `messages_fts` 계열 테이블
- `claude_ai_conversations`, `claude_ai_messages`, `claude_ai_messages_fts` 계열 테이블
- `/api/claude-ai/*`
- `/api/collector.py`
- 모든 Claude 전용 문서/테스트/설명

### 대체 대상

- `parser.py` → `codex_parser.py` 또는 기존 Codex 파서 모듈로 통합
- `watcher.py` → `codex_watcher.py` 또는 Codex 전용 감시 클래스
- `collector.py` → `codex_collector.py`
- `claude-dashboard.service` → 제거. 단일 `codex-web-dashboard.service`만 유지
- `/api/collector.py` → `/api/codex-collector.py` 또는 collector 다운로드 자체 제거 후 문서로 대체
- `sessions/messages` 기반 집계 → `codex_sessions/codex_messages` 기반 집계로 일원화

## 데이터 모델

### 유지 테이블

- `codex_projects`
- `codex_sessions`
- `codex_messages`
- `codex_messages_fts`
- `remote_nodes`
- `admin_audit`
- `app_config`
- `plan_config`
- `file_watch_state` 또는 이에 준하는 Codex 체크포인트 테이블

### 제거 테이블

- `sessions`
- `messages`
- `messages_fts` 및 하위 FTS 보조 테이블
- `claude_ai_conversations`
- `claude_ai_messages`
- `claude_ai_messages_fts` 및 하위 FTS 보조 테이블

### 스키마 원칙

- 테이블명과 API 명세에서 `claude` 문자열을 제거한다.
- 기존 기능에 필요한 메타데이터는 `codex_messages`와 `codex_sessions` 컬럼 확장으로 수용한다.
- 검색은 `codex_messages_fts` 하나로 끝나야 한다.

## 기능별 유지 전략

### 검색 및 세션 뷰

현재 검색 경험은 이미 `codex_messages_fts` 중심이므로 유지 비용이 낮다. `claude-ai` 소스 토글, 웹 export 뷰, 관련 API 호출 코드는 삭제한다.

### 타임라인

타임라인은 이미 Codex fallback이 붙어 있으므로, 다음 상태를 목표로 한다.

- fallback이 아니라 기본 구현이 `codex_*`
- `legacy` 모드 제거
- 시간별 작업량, heatmap, 주간 비교, 델타, 일간 리포트를 모두 `codex_messages` / `codex_sessions`에서 직접 계산

### 관리자

관리 기능은 유지하되 Codex 전용으로 단순화한다.

- 노드 등록, ingest key 발급 유지
- backup/restore 유지
- retention 유지
- DB 크기 표시 개선

### 원격 수집

원격 수집 기능은 유지한다. 다만 구현과 명칭은 Codex 기준으로 바뀐다.

- 다운로드 스크립트명: `codex_collector.py`
- `/api/ingest` 계약은 유지 가능
- 수집 대상 경로와 레코드 의미는 Codex 로그 포맷 기준으로 재정의
- 문서와 UI에서 더 이상 `.claude/projects`를 언급하지 않는다

## DB 크기 및 저장공간 설계

현재 관리 메뉴의 533 MB 표시는 실제 파일 크기이지만, 대부분은 free page다. 실제 사용 데이터는 약 3.4 MB 수준이다.

### 문제 정의

- `DB_PATH.stat().st_size`는 파일 크기만 보여준다
- retention/삭제 후 free page가 남아도 UI는 이를 설명하지 않는다
- 사용자는 활성 데이터가 큰 것으로 오해한다

### 목표 상태

관리 메뉴는 최소 세 값을 구분해 보여준다.

- 실제 파일 크기
- WAL 크기
- 활성 사용 크기 추정치 (`(page_count - freelist_count) * page_size`)

추가로 다음 값을 제공한다.

- free page 크기
- reclaim 가능 여부
- 마지막 vacuum 시각 또는 shrink action 결과

### 저장공간 회수 방식

Codex 전용 DB로 재기반화한 뒤, 일회성 `VACUUM`으로 파일을 축소한다.

운영 원칙은 다음과 같다.

- 구조 제거 완료 후에만 `VACUUM` 수행
- 수행 전 백업 생성
- 완료 후 관리 메뉴 수치로 축소 결과 검증

장기적으로는 `auto_vacuum=INCREMENTAL` 유지 + retention 후 `incremental_vacuum` 또는 명시적 shrink action을 둔다.

## API 설계

### 제거

- `/api/claude-ai/*`
- `/api/collector.py`

### 유지

- `/api/ingest`
- `/api/admin/*`
- `/api/timeline*`
- `/api/search`, `/api/sessions`, Codex 대화 탐색 관련 라우트

### 변경

- `/api/admin/db-size` 응답 확장
  - `size_bytes`
  - `wal_size_bytes`
  - `used_bytes`
  - `free_bytes`
  - `page_size`
  - `page_count`
  - `freelist_count`

- `/api/admin/status`도 동일한 저장공간 필드 포함

## 테스트 전략

테스트는 "기능 유지 + Claude 제거"를 동시에 검증해야 한다.

### 삭제/정리

- Claude 전용 contract/e2e/parser/watcher/collector 테스트 제거 또는 Codex 기준으로 치환
- `claude_ai_*` API contract 제거
- `claude-dashboard.service` identity 테스트 제거

### 신규/대체

- Codex 전용 ingest contract
- Codex watcher/parser/collector 단위 테스트
- 타임라인 6개 패널의 `codex_*` 직접 집계 회귀 테스트
- `/api/admin/db-size`가 used/free/file 크기를 구분해 반환하는 테스트
- 구조 제거 후 DB shrink 시나리오 테스트

## 문서 전략

다음 문서를 Codex 단일 제품 기준으로 다시 쓴다.

- `README.md`
- `AGENTS.md`
- `CLAUDE.md` 또는 Codex 기준 불변식 문서로 재정의
- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/SCHEMA.md`
- `docs/QUALITY-GATES.md`
- `docs/features.html`
- ADR/스펙/플랜 중 Claude 전제를 담은 문서

문서에는 다음이 남으면 안 된다.

- `~/.claude/...`
- Claude Dashboard / Claude Usage Dashboard
- claude.ai export 기능 설명
- Claude 전용 서비스 병행 운영 설명

## 마이그레이션 순서

1. Codex 전용 수집/감시/원격 수집 모듈 확정
2. `main.py`의 Claude import와 라우트 제거
3. `database.py`에서 Claude 스키마와 legacy 집계 제거
4. 프런트에서 `legacy` 모드와 `claude-ai` 소스 제거
5. 테스트를 Codex 기준으로 교체
6. 문서와 서비스 정의 정리
7. DB 백업
8. Claude 유산 테이블 제거 후 `VACUUM`
9. 관리 메뉴에서 축소 결과 확인

## 리스크와 대응

### 1. 기능 유지 실패

위험: Claude 계층이 암묵적으로 쓰이던 기능이 깨질 수 있다.

대응:

- 기능 단위 회귀 테스트 먼저 확보
- 제거 순서를 "테스트 작성 → 참조 제거 → 동작 확인"으로 강제

### 2. 원격 수집 중단

위험: `collector.py` 제거 과정에서 원격 ingest가 깨질 수 있다.

대응:

- Codex collector 계약을 먼저 정의
- `/api/ingest`를 유지하면서 클라이언트만 교체

### 3. DB 손상 또는 크기 축소 실패

위험: `VACUUM` 중단 또는 테이블 제거 실수

대응:

- 사전 백업
- 백업 성공 후 schema surgery
- vacuum 후 integrity check

## 성공 기준

다음 조건을 모두 만족하면 완료로 본다.

- 저장소에서 Claude 관련 런타임 코드와 서비스가 제거된다
- 현재 제공 기능은 모두 동일하게 동작한다
- 관리 메뉴 DB 크기에서 file/used/free가 분리 표시된다
- 실제 DB 파일 크기가 활성 데이터 수준에 가깝게 축소된다
- 문서와 테스트가 Codex 단일 제품 기준으로 일관된다
