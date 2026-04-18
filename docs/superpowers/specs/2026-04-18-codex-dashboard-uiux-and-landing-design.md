# Codex Dashboard UI/UX Optimization and Landing Variants Design

## Goal

Codex Dashboard를 `운영 / 생산성 / 보고` 세 축을 균형 있게 담는 제품으로 재정의한다.  
제품 대시보드는 `균형 포털형` 홈을 중심으로 최적화하고, 같은 제품을 서로 다른 구매 동기로 설명하는 랜딩페이지 3종을 만든다.

이 작업은 `supanova-design-skill`의 원칙을 적용한다.

- 대시보드도 랜딩처럼 시각 위계와 포지셔닝을 명확히 만든다
- 한국어 콘텐츠는 자연스럽고 구체적으로 쓴다
- 다크/라이트는 같은 정보 구조를 공유하되, 표현 문법은 분리한다
- CTA는 모두 `로컬 실행형`으로 통일한다

## Product Positioning

Codex Dashboard는 하나의 제품이지만 사용자는 세 가지 동기로 접근한다.

1. 운영 통제
- 비용, 상태, ingest, retention, node, DB 건강도를 한 화면에서 통제하고 싶다

2. 팀 생산성
- 세션 검색, 복기, 프로젝트 흐름, Subagent 활동을 통해 팀 작업 맥락을 빠르게 되찾고 싶다

3. 리더십 보고
- 비용 추세, 예산, forecast, 모델 사용량, 주간 변화로 의사결정에 필요한 요약을 보고 싶다

제품 홈은 이 세 가지를 모두 수용해야 한다.  
특정 한 역할만의 홈이 아니라, 세 역할 모두가 “자기 일로 바로 내려갈 수 있는 포털”이어야 한다.

## Dashboard UX Strategy

### Primary IA

상위 내비게이션은 유지한다.

- `개요`
- `탐색`
- `분석`
- `관리`

이 중 `개요`가 제품 홈이며, 역할은 `균형 포털형`이다.

### Overview Home Structure

`개요`는 다음 4단 구조를 가진다.

1. 상단: 3축 요약 카드
- `운영`
- `생산성`
- `보고`

각 카드는 해당 축의 현재 상태를 2~4개의 강한 신호로 요약한다.

예시:
- 운영: 경고 수, ingest 상태, DB compact 필요 여부
- 생산성: 최근 활성 세션, 검색 진입, 프로젝트 activity
- 보고: 오늘 비용, 주간 변화, forecast

2. 중단 1: 공통 KPI 스트립
- 오늘 비용
- 일일 예산
- 주간 예산
- 활성 세션
- 최근 활동
- 월말 forecast

3. 중단 2: 3축 상세 프리뷰
- 운영 프리뷰: alerts, ingest/node, DB 상태
- 생산성 프리뷰: 최근 세션, 검색 진입, 활성 프로젝트, agent-run
- 보고 프리뷰: 비용 추세, 모델 분포, 주간 변화

4. 하단: 행동 진입 블록
- 검색 시작
- 프로젝트 분석
- 타임라인
- 관리 작업

핵심 원칙은 다음과 같다.

- 홈은 분석 결과를 다 펼치는 화면이 아니다
- 홈은 판단과 진입을 동시에 지원하는 포털이다
- 사용자는 홈에서 “지금 무엇을 봐야 하는가”와 “다음 어디로 가야 하는가”를 바로 이해해야 한다

### Explore Strategy

`탐색`은 검색 중심 작업면이다.

- 기본 서브뷰는 `검색`
- 같은 군집 안에서 `세션`, `대화`를 전환한다
- 전역 명령 팔레트는 어느 상위 뷰에서도 열 수 있다
- 즉, 검색은 `전역 도구`이면서 동시에 `탐색`의 기본 작업면이다

### Analysis Strategy

`분석`은 전문가용 dense cockpit으로 유지한다.

- 비용
- 모델
- 프로젝트
- 타임라인
- Subagent

이 영역은 시각적으로 더 밀도 있고 도구적인 성격을 가진다.

### Admin Strategy

`관리`는 운영 작업과 유지보수 행위를 모은다.

- export
- backup / restore
- retention
- node 상태
- DB 진단
- 감사/운영 로그

이 영역은 설명보다 조작과 상태 확인이 우선이다.

## Theme System

다크와 라이트는 완전히 다른 제품처럼 갈라지지 않는다.  
같은 정보 구조를 공유하고, 표현 문법만 달라진다.

### Dark Theme: Console Luxury

의도:
- 고급 운영 콘솔
- dense 정보
- 계기판 같은 긴장감

규칙:
- 순수 검정 대신 tint가 있는 dark base 사용
- 얇은 edge, 유광감 있는 card surface, 미세한 ambient gradient 사용
- KPI 숫자는 tabular numerals로 강하게
- 상태색은 액센트가 아니라 의미 체계로 사용
- hover와 pressed state는 얕지만 분명하게

느낌:
- “운영자가 지금 상태를 통제하는 화면”

### Light Theme: Editorial Tech

의도:
- 전략 브리프
- 설명력이 강한 product narrative
- 읽히는 데이터

규칙:
- 큰 헤드라인, 넓은 여백, 섹션 중심 구조
- 카드보다 콘텐츠 블록과 타이포 중심
- 동일 데이터를 더 읽기 쉬운 hierarchy로 재해석
- 색은 구조와 구분을 돕는 용도에 집중

느낌:
- “리더가 상황을 읽고 방향을 판단하는 화면”

### Shared Rules

- 정보 구조는 동일해야 한다
- 다크/라이트 모두 같은 액션과 같은 진입 구조를 유지한다
- 테마 차이는 기능 차이가 아니라 인식 문법 차이여야 한다

## Dashboard Visual Direction

`supanova-design-skill` 적용 기준은 다음과 같다.

### Typography

- 한국어 기본은 `Pretendard`
- 영문 디스플레이는 `Geist` 또는 동급의 현대적인 grotesk 계열
- 헤드라인은 더 크고, 더 촘촘하게
- 메트릭과 비용 숫자는 `tabular-nums`
- 한국어 긴 텍스트는 `word-break: keep-all`, `text-wrap: balance`

### Surfaces

- 퍼플 기반 AI 그라디언트 금지
- 액센트는 한 테마 안에서 1개 주축 + 상태색 체계로 제한
- 플랫한 영역은 ambient gradient 또는 subtle texture로 보강
- 다크에서는 tinted shadow 사용

### Layout

- 모든 섹션이 같은 카드 열 구조를 반복하지 않게 한다
- `개요`는 포털형
- `탐색`은 작업면형
- `분석`은 dense cockpit형
- `관리`는 utilitarian panel형

### Motion

- 의미 있는 entry/stagger만 허용
- hover, press, focus 상태는 모두 살아 있어야 한다
- 전역 검색과 포털 카드 전환은 spring 계열 easing 사용

## Landing Page Program

랜딩은 같은 제품을 서로 다른 동기로 설명하는 3안이다.  
세 페이지 모두 CTA는 `로컬 실행`으로 통일한다.

### Variant A: Ops Control

핵심 메시지:
- 비용과 상태를 동시에 통제하는 Codex 운영 콘솔

주요 독자:
- 운영자
- 인프라/플랫폼 담당자
- 비용 통제가 중요한 팀

구성:
- Hero: 비용, 경고, node, retention, DB signal을 한 프레임에서 제시
- Proof block: 예산, 상태, 경고, DB compact 등 운영 시그널
- Feature narrative: 운영 통제, 이상징후, 유지보수 흐름
- CTA: 로컬 실행 후 바로 운영 지표 확인

느낌:
- 다크에서 특히 강함

### Variant B: Team Recall

핵심 메시지:
- 세션과 프로젝트 흐름을 다시 찾는 팀용 탐색 대시보드

주요 독자:
- 개발자
- 팀 리드
- 세션 복기와 협업 맥락이 중요한 사용자

구성:
- Hero: 검색, 세션, 프로젝트, Subagent 흐름 중심
- Proof block: 검색 속도, 최근 세션, 프로젝트 context, agent-run 시야
- Feature narrative: 복기, 재탐색, 팀 협업 가시성
- CTA: 로컬 실행 후 바로 검색 시작

느낌:
- 가장 제품 체험형에 가깝다

### Variant C: Executive Signal

핵심 메시지:
- 비용, forecast, 사용량을 바로 읽는 리더십 브리프

주요 독자:
- 팀 리더
- 엔지니어링 매니저
- 비용과 usage를 보고 판단하는 의사결정자

구성:
- Hero: 비용, 월말 forecast, 모델 분포, 주간 변화
- Proof block: 리포트형 KPI와 추세 설명
- Feature narrative: 보고, 설명, 예산 판단, usage narrative
- CTA: 로컬 실행 후 팀 usage 읽기

느낌:
- 라이트에서 특히 강함

## Landing Shared Rules

세 랜딩 모두 다음을 공유한다.

- 한국어 중심 자연스러운 카피
- 로컬 실행 CTA
- 제품 스크린샷은 실제 대시보드 구조와 연결되어야 함
- 각 페이지는 hero, proof, feature narrative, CTA의 구조는 유지하되 강조 신호가 달라야 함
- 같은 제품인데 다른 제품처럼 보이면 안 된다

## Deliverables

이번 설계의 최종 산출은 다음이다.

1. 제품 대시보드 UI/UX 최적화
- `개요 / 탐색 / 분석 / 관리` 체계를 유지
- `개요`를 균형 포털형 홈으로 최적화
- 다크/라이트 표현 문법 분리

2. 랜딩페이지 3종
- Ops Control
- Team Recall
- Executive Signal

3. 단일 제품 디자인 시스템
- 같은 정보 구조
- 다른 표현 문법
- CTA와 제품 identity는 일관되게 유지

## Out of Scope

- 새로운 데이터 소스 추가
- 대시보드 기능 자체 확장
- 로그인/인증 플로우 개편
- 배포 구조 변경

이번 작업은 `정보 구조`, `표현 문법`, `카피 포지셔닝`, `랜딩 산출물`에 집중한다.

## Acceptance Criteria

- 홈 `개요`가 세 역할을 모두 수용하는 포털로 재설계된다
- 검색은 전역 도구이면서 `탐색`의 기본 작업면으로 유지된다
- 다크/라이트가 같은 구조를 공유하면서도 서로 다른 성격을 분명히 가진다
- 랜딩 3안이 서로 다른 포지셔닝을 명확히 보여준다
- 랜딩 3안 모두 `로컬 실행` CTA로 자연스럽게 수렴한다
- 시각 방향이 `supanova-design-skill` 원칙과 충돌하지 않는다
