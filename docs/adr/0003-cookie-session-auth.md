# ADR-0003: Basic Auth → 쿠키 세션 인증

**상태**: 확정  
**일자**: 2026-04  
**결정자**: hardcoremonk  
**대체**: 기존 HTTP Basic Auth

## 맥락

Basic Auth는 브라우저 팝업 UX가 열악하고, 로그아웃이 불가능하며, 세션 만료를 제어할 수 없음.

## 결정

HMAC 서명 쿠키 (`dash_session`) 기반 세션 인증.

## 설계

```
POST /api/auth/login {password} → _sign_session() → Set-Cookie: dash_session
토큰 = base64(dashboard:{expires_ts}.{hmac_sha256})
검증 = 서명 확인 + 만료 확인
```

## 근거

- 로그인 페이지 UX (비밀번호 입력 → 에러 표시 → 리다이렉트)
- 세션 만료 내장 (7일, 토큰에 timestamp 포함)
- 로그아웃 가능 (쿠키 삭제)
- rate limit (5회/분/IP)
- WebSocket도 쿠키 기반 — 별도 토큰 불필요

## 트레이드오프

- 서버 비밀키 (`DASHBOARD_SECRET`) 필요 — 미설정 시 재시작마다 세션 무효화
- Basic Auth 하위호환 유지 (curl, collector 등 프로그래밍 클라이언트)
- `SameSite=Lax` 의존 — 구형 브라우저에서 CSRF 보호 약화

## 보안 속성

| 속성 | 값 |
|------|---|
| `httpOnly` | true (JS 접근 차단) |
| `secure` | `DASHBOARD_SECURE=true` 시 활성화 |
| `sameSite` | lax (CSRF 기본 보호) |
| 만료 | 토큰 내 타임스탬프 (서버 검증) + 쿠키 max-age 7일 |
