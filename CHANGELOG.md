# Changelog

본 문서는 사용자 가시 변경(UI/디자인/문서)을 빌드 버전 단위로 기록한다. 전체 커밋 이력은 `git log` 참조.

## [v89] — 2026-04 — Supanova Redesign + landing footer removal + FINDING-001~004 refinements

- FINDING-001: 랜딩 stale test count 수정 (174 → 177)
- FINDING-002: SPA 개요 행이 모바일에서 잘리던 문제 수정 + 모바일 stack 레이아웃
- FINDING-004: 랜딩 nav 터치 타깃 30px → 44px 확대 (접근성)
- Supanova Redesign Engine 전면 적용 (login / SPA / landing 통합 톤)
- 랜딩 푸터 전체 제거 — CTA 섹션 이후 바로 종료, variant A/B/C 네비게이션 제거 (직접 URL만)
- ADR-011 reverse-proxy 통합 컨텍스트 CLAUDE.md 명시

## [v88] — 2026-04 — SPA frontend-design 검수 10항목 + 2-cluster nav pill

- frontend-design 스킬 검수 결과 10항목 일괄 반영
- SPA nav를 2-cluster pill 레이아웃으로 재구성 (탭 pill + 유틸 pill)
- 한글 2자 탭 라벨 통일 ("개요/비용/세션/대화/모델/하위/검색/시간/관리"), "프로젝트"만 예외

## [v87] — 2026-04 — Overview 활성+TOP 5 2그룹 개편 + dead code 제거

- 개요 페이지 히어로 카드 하단을 "활성 / TOP 5" 2-그룹으로 재배치
- 사용되지 않는 dead code 일괄 제거

## [v86] — 2026-04 — Supanova 디자인 시스템 이식

- Supanova 디자인 시스템 이식: Double-Bezel 카드 / Pretendard / Iconify Solar / spring easing
- `.eyebrow`, `.reveal`, `.noise-overlay`, `.glass-section`, `.ambient-orb*` 컴포넌트 도입

## [v85] — 2026-04 — 다크/라이트 테마 고도화 + 라이트모드 검색 입력창 가시성

- 라이트 테마 컬러 매핑 정비 (WCAG AA 4.5:1)
- 라이트모드에서 검색 입력창 가시성 개선

## [v84] — 2026-04 — 검색 페이지 비주얼라이징

- 검색 페이지 비주얼 리뉴얼 — 결과 카드 / 하이라이트 톤 정비

## [v83~v82] — 2026-04 — 검색 메뉴 + 3섹션 컨텍스트 뷰어

- 전문 검색 메뉴 신설
- 3-섹션 컨텍스트 뷰어 (이전 / 매칭 / 이후) + 역할 필터 + 세션 점프

## [v81~v80] — 2026-04 — Reasoning Trace Explorer + AI 세션 자동 태깅

- Reasoning Trace Explorer — assistant thinking 블록 시각화
- AI 세션 자동 태깅 (`sessions.ai_tags` / `ai_tags_status`, schema v15)

---

이전 변경 이력은 `git log` 참조.
