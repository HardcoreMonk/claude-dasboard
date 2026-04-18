# ADR-0001: SQLite 단일 파일 DB

**상태**: 확정  
**일자**: 2026-03  
**결정자**: hardcoremonk

## 맥락

Codex CLI 세션 데이터를 저장할 DB가 필요. 선택지: PostgreSQL, MySQL, SQLite, DuckDB.

## 결정

**SQLite (WAL 모드)** 단일 파일.

## 근거

- 외부 서비스 의존 없음 — 단일 바이너리 배포
- WAL 모드: 다중 리더 + 단일 라이터 동시성으로 대시보드 워크로드에 충분
- 백업이 파일 복사 한 번 (`sqlite3.backup()`)
- 200K+ 메시지, 1K+ 세션에서 쿼리 < 50ms

## 트레이드오프

- 수평 확장 불가 (단일 프로세스 write lock)
- 동시 쓰기 처리량 제한 (~100 writes/sec)
- FK CASCADE DELETE 미사용 (ALTER TABLE ADD CONSTRAINT 미지원)

## 완화

- `_write_lock` + `BEGIN IMMEDIATE` 로 직렬화
- `read_db()` thread-local + TTL 300s로 stale 방지
- `wal_checkpoint(TRUNCATE)` 셧다운 시 호출
