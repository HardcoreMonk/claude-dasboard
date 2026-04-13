# 품질 게이트

코드가 main 브랜치에 머지되기 전 반드시 통과해야 하는 검증 기준.

---

## Gate 1: 테스트 (필수)

```bash
./.venv/bin/python -m pytest tests/ -v --tb=short
```

| 기준 | 조건 |
|------|------|
| 전체 통과 | 174+ tests, **0 failures** |
| 신규 기능 | 관련 테스트 최소 1개 추가 |
| 버그 수정 | 재현 테스트 추가 후 수정 |
| 인증 관련 | `test_auth.py` 패턴으로 양쪽 (인증O/인증X) 검증 |

## Gate 2: 빌드 (필수)

```bash
npm run build
```

| 기준 | 조건 |
|------|------|
| JS 번들 | `bundle.js` 생성, 에러 없음 |
| CSS 빌드 | `tailwind.css` 생성, 에러 없음 |
| JS syntax | 모든 소스 파일 `node --check` 통과 |

## Gate 3: 린트 (필수)

```bash
ruff check .
```

| 기준 | 조건 |
|------|------|
| ruff | 0 errors (CI에서 블록) |
| 신규 코드 | E501 (120자 초과) 허용하지 않음 |

## Gate 4: 보안 (필수)

```bash
bandit -r main.py database.py parser.py watcher.py collector.py -s B101 -q
```

| 기준 | 조건 |
|------|------|
| bandit | 0 findings (B101 assert 제외) |
| SQL | 모든 쿼리 파라미터화. f-string SQL은 화이트리스트 컬럼만 |
| XSS | `innerHTML`에 사용자 데이터 → `esc()` 필수. 새 코드는 `h()` 또는 DOM API |
| 인증 | destructive 엔드포인트는 인증 필수. `_AUTH_BYPASS`에 추가 금지 |

## Gate 5: 의존성 (경고)

```bash
pip-audit --strict
```

| 기준 | 조건 |
|------|------|
| pip-audit | 알려진 취약점 0 (CI에서 경고, 블록은 아님) |
| CDN 스크립트 | SRI integrity 해시 필수 |

## Gate 6: DB 마이그레이션 (해당 시)

| 기준 | 조건 |
|------|------|
| SCHEMA_VERSION | bump 필수 |
| idempotent | `IF NOT EXISTS`, `INSERT OR IGNORE` 등 재실행 안전 |
| `_commit_migration()` | 각 단계 원자적 커밋 |
| 테스트 | `test_database.py`에 마이그레이션 검증 추가 |

## Gate 7: 프론트엔드 (해당 시)

| 기준 | 조건 |
|------|------|
| 캐시 bump | `index.html`의 `.vN` 일괄 증가 |
| 빌드 반영 | `npm run build` 후 `bundle.js` 갱신 |
| `data-action` | 새 버튼은 inline onclick 대신 `data-action` 사용 |
| 접근자 | `state.*` 직접 변경 대신 `setChart`/`setPage` 등 사용 |
| 라이트 테마 | 새 색상은 `app.css` 라이트 매핑에 포함 확인 |
| 접근성 | 클릭 가능 요소: `tabindex="0"` + `role="button"` + keydown |

## Gate 8: API (해당 시)

| 기준 | 조건 |
|------|------|
| 응답 스키마 | `test_contract.py`에 shape 테스트 추가 |
| 페이지네이션 | 무제한 반환 엔드포인트 금지 (page/per_page 또는 limit) |
| 정렬 | `ORDER BY`는 `_SORT_MAP` 화이트리스트 경유 |
| 날짜 파라미터 | `YYYY-MM-DD` 형식 검증 |
| destructive | `openDeleteConfirm()` 패턴 필수 |

---

## CI 자동 검증

`.github/workflows/ci.yml`에서 Gate 1~5 자동 실행:

```yaml
jobs:
  test:     # Gate 1 + Gate 3 + Gate 4 + Gate 5
  js-build: # Gate 2
```

Gate 6~8은 리뷰어가 수동 확인.

## 빠른 체크 (로컬)

```bash
# 한 줄로 Gate 1~3 확인
./.venv/bin/python -m pytest tests/ --tb=short && npm run build && ruff check .
```
