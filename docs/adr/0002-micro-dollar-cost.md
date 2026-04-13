# ADR-0002: 비용 저장 — INTEGER micro-dollars

**상태**: 확정  
**일자**: 2026-03  
**결정자**: hardcoremonk

## 맥락

Claude API 비용을 DB에 저장해야 함. 선택지: float, DECIMAL, integer micro-dollars.

## 결정

`cost_micro INTEGER` (1 USD = 1,000,000 micro-dollars).

## 근거

- float 누적 오차가 $0.01 단위에서 실제 발생 (수천 메시지 합산 시)
- SQLite에 DECIMAL 타입 없음
- INTEGER 연산은 정확하고 빠름
- `cost_micro * 1.0 / 1000000 AS cost_usd` 로 표시 시 변환

## 영향

- 모든 SQL 쓰기: `cost_micro` 컬럼에 정수 저장
- 모든 SQL 읽기: `* 1.0 / 1000000` 변환 필수
- Python 코드에서 float 비용 누적 금지 — 반드시 정수 단계에서 합산
