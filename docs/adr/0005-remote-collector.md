# ADR-0005: 다중 서버 수집 — Push 방식 (collector agent)

**상태**: 확정  
**일자**: 2026-04  
**결정자**: hardcoremonk

## 맥락

다른 서버의 `~/.codex/projects/` JSONL 데이터를 중앙 대시보드에 수집해야 함. 3가지 방식 검토:
- A) rsync로 원격 파일 동기화
- B) 원격 경량 에이전트가 HTTP push
- C) 각 서버에서 대시보드 운영 후 DB 머지

## 결정

**방식 B** — `codex_collector.py` 경량 에이전트.

## 설계

```
[원격] codex_collector.py → JSONL 감시 → POST /api/ingest (X-Ingest-Key) → [대시보드] process_record(source_node=node_id)
```

## 근거

- stdlib만 사용 — 원격 서버에 pip install 불필요
- 실시간 push (5초 폴링) — rsync보다 빠른 반영
- 방화벽 친화 (outbound HTTP만)
- `sessions.source_node` 컬럼으로 노드별 격리/필터

## 트레이드오프

- 원격 서버마다 collector 프로세스 필요
- ingest key 유출 시 DB 오염 가능 (rate limit 미구현)
- Windows 경로 파싱 이슈 → `PureWindowsPath` 로 해결

## 보안

- 노드 등록: `POST /api/nodes` → 일회성 ingest key (SHA-256 해시 저장)
- 키 로테이션: `POST /api/nodes/{id}/rotate-key`
- 키 전달: `INGEST_KEY` 환경변수 권장 (CLI 인자 → `ps aux` 노출 위험)
