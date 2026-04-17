# AGENTS.md

Codex Dashboard 프로젝트의 최상위 기준 문서.

이 저장소의 제품 정체성, 운영 기본값, 문서 우선순위, 실행 표준은 이 문서를 기준으로 한다. 세부 구현 불변식은 `CLAUDE.md`, 인터페이스 계약은 `docs/API.md`, 구조 설명은 `docs/ARCHITECTURE.md`, 데이터 계약은 `docs/SCHEMA.md`를 따른다.

## 제품 기준

- 제품명: `Codex Dashboard`
- 기본 대상: Codex CLI 세션 수집, 탐색, 복기
- 기본 포트: `8617`
- 기본 DB 경로: `~/.codex/dashboard.db`
- 기본 백업 경로: `~/.codex/dashboard-backups`
- 기본 인증 방식: `DASHBOARD_PASSWORD` 기반 쿠키 세션

새 문서와 운영 예시는 모두 Codex 기준으로 작성한다. Claude 관련 경로와 서비스는 호환 운영용 레거시로만 유지한다.

## 문서 우선순위

문서 간 설명이 충돌하면 아래 순서를 따른다.

1. `AGENTS.md`
2. `CLAUDE.md`
3. `README.md`
4. `docs/API.md`
5. `docs/ARCHITECTURE.md`
6. `docs/SCHEMA.md`
7. `docs/QUALITY-GATES.md`
8. `docs/adr/*`

## 문서 책임

- `README.md`: 설치, 실행, 로그인, 운영 진입점
- `CLAUDE.md`: 코드 수정 시 지켜야 할 구현 불변식
- `docs/API.md`: HTTP/WebSocket 계약
- `docs/ARCHITECTURE.md`: 시스템 구조와 데이터 흐름
- `docs/SCHEMA.md`: SQLite 스키마와 마이그레이션
- `docs/QUALITY-GATES.md`: 머지 전 검증 기준
- `docs/adr/*`: 확정된 설계 결정 기록

공통 정책은 이 문서에 두고, 나머지 문서는 각자 자기 책임 범위만 유지한다.

## 운영 원칙

- 운영 기본값은 Codex 인스턴스다.
- `codex-web-dashboard.service`를 우선 설명한다.
- Codex와 Claude는 포트, DB, 백업 루트를 분리한다.
- 운영 환경에서는 반드시 `DASHBOARD_PASSWORD`를 설정한다.
- 기본 검증 절차는 `8617` 바인딩, `/api/auth/me`, `/api/stats` 확인으로 통일한다.

## 실행 표준

```bash
cp .env.example .env
./start.sh
```

기본 접속 주소:

```text
http://localhost:8617
```

기본 검증:

```bash
ss -ltnp | grep 8617
curl http://127.0.0.1:8617/api/auth/me
curl -i http://127.0.0.1:8617/api/stats
```

## 빌드와 테스트

```bash
npm run build
./.venv/bin/python -m pytest tests/ -v
ruff check .
```

버그 수정은 재현 테스트를 먼저 추가하고, 수정 후 관련 테스트와 회귀 범위를 확인한다.
