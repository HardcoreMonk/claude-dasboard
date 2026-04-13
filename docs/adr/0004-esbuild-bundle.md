# ADR-0004: Tailwind CDN → esbuild 번들 + Tailwind CLI

**상태**: 확정  
**일자**: 2026-04  
**결정자**: hardcoremonk  
**대체**: Tailwind CDN play 모드 + 7개 개별 `<script>` 태그

## 맥락

- Tailwind CDN (~80KB JS)이 런타임에 CSS 생성 — 프로덕션 부적합
- 7개 JS 파일 개별 로드 — HTTP 요청 7회
- JS에서 동적 추가한 Tailwind 클래스가 JIT 스캔에 누락

## 결정

`build.js` (Node 스크립트)가 두 가지를 생성:
1. **bundle.js**: 소스 JS를 의존 순서대로 concat → esbuild minify
2. **tailwind.css**: `tailwindcss -i app.css -o tailwind.css --minify`

## 근거

- 7 HTTP 요청 → 1 (186KB gzip ~50KB)
- Tailwind CSS 빌드: 사용된 유틸리티만 포함 (28KB)
- 소스맵 포함 → 디버깅 가능
- 빌드 65ms (CSS 43ms + JS 22ms) — 개발 루프에 영향 없음

## 트레이드오프

- Node.js 빌드 의존성 추가 (esbuild, tailwindcss)
- 빌드 산출물 git tracked (서버 배포 시 Node 불필요하도록)
- concat 방식이라 진정한 ES module이 아님 — 51개 inline onclick과 글로벌 스코프 호환 유지

## 불채택 대안

| 대안 | 불채택 이유 |
|------|-----------|
| Vite | 과도한 설정, HMR 불필요 (단일 페이지 대시보드) |
| Webpack | 설정 복잡도, 빌드 속도 느림 |
| ES module `type="module"` | 51개 inline onclick이 글로벌 함수 필요 → 전면 리팩터링 |
