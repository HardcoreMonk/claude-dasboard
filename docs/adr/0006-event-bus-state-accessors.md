# ADR-0006: 프론트엔드 이벤트 버스 + 상태 접근자

**상태**: 확정  
**일자**: 2026-04  
**결정자**: hardcoremonk  
**대체**: 30+ 글로벌 변수 직접 참조, 직접 함수 호출 체인

## 맥락

9개 JS 파일 간 30+ 전역 변수 직접 변경, 크로스 파일 함수 호출이 암묵적 의존을 만들어 유지보수 어려움.

## 결정

3가지 패턴 도입:

### 1. 이벤트 버스 (`bus`)
```javascript
bus.emit('refresh');          // WS batch_update 후 발행
bus.on('refresh', () => { ... }); // 각 모듈이 자체 갱신
```

### 2. 상태 접근자
```javascript
setChart('timeline', instance);  // state.charts.timeline = ... 대신
destroyChart('timeline');        // destroy + null 원자적
setPage(1); setAdvFilters({});   // state 직접 변경 대신
```

### 3. `data-action` 이벤트 위임
```html
<button data-action="toggleTheme">  <!-- onclick="toggleTheme()" 대신 -->
```

## 근거

- 모듈 간 결합도 감소 — 새 모듈은 `bus.on` 등록만으로 통합
- Chart.js 인스턴스 destroy 누락 방지 — `setChart`가 자동 처리
- inline onclick 51개 중 43개 전환 → CSP 준수 기반 마련

## 트레이드오프

- 런타임 오버헤드 (CustomEvent 디스패치) — 무시 가능 수준
- 기존 코드와 혼재 (글로벌 직접 참조 일부 잔존)
- 완전한 모듈 전환은 Phase 4 (ES module import/export)에서
