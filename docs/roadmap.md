# Backend 전체 작업 계획

상태는 `대기`, `진행 중`, `외부 작업 필요`, `완료`만 사용한다. 아래 순서가 구현 순서이며, 앞 단계의
완료 조건을 통과하지 않으면 다음 단계의 배포를 진행하지 않는다.

| 단계           | 상태           | 작업                                                | 완료 조건                               |
| -------------- | -------------- | --------------------------------------------------- | --------------------------------------- |
| B0 기반        | 완료           | 저장소, schema, index, RLS, 일정 조회·생성          | type check와 계약 test 통과             |
| B1 인증 구성   | 외부 작업 필요 | Google·GitHub OAuth client와 Supabase 프로젝트 생성 | 두 provider의 실제 로그인과 RLS 확인    |
| B2 iOS 인증    | 대기           | 로그인 화면, deep link, session 복원, 로그아웃      | 앱 재실행·취소·만료 token 시나리오 통과 |
| B3 일정 명령   | 대기           | 상세 조회, 수정, 완료, 삭제, 다른 날짜 이동         | version 충돌과 idempotency 검증         |
| B4 동기화      | 대기           | 변경 cursor, tombstone, offline outbox              | offline 생성·수정 후 재연결 수렴        |
| B5 반복 일정   | 대기           | 반복 규칙과 예외 일정                               | DST·월말·단일 예외 검증                 |
| B6 알림·리뷰   | 대기           | reminder, 일일 요약 시간, 미완료 일정 질문          | 알림 허용·거부·시간대 변경 검증         |
| B7 검색        | 대기           | 사용자 일정 키워드·필터 검색                        | 50명 규모 p95와 권한 격리 확인          |
| B8 외부 캘린더 | 대기           | Google Calendar 동의, token vault, 증분 sync        | 연결·철회·충돌·재동기화 검증            |
| B9 업무 연동   | 대기           | Slack의 실제 지원 action만 연결                     | workspace 동의와 최소 scope 검증        |
| B10 Agent      | 대기           | 일정 조회·제안·확인 후 실행 tool                    | 쓰기 전 확인, audit, consent 검증       |
| B11 Widget API | 대기           | 잠금·홈 위젯용 최소 snapshot                        | 앱·위젯 데이터 일관성 확인              |
| B12 운영       | 대기           | 배포, backup, Sentry, Supabase 로그·지표            | staging 복구 훈련과 alert 확인          |
| B13 출시       | 대기           | Apple 로그인, 계정 삭제, 개인정보 문서              | App Review와 실제 계정 삭제 검증        |

## 바로 다음 작업

1. 사용자가 Supabase 무료 프로젝트를 만들고 project ref를 확정한다.
2. Google OAuth client와 GitHub OAuth App을 만들고 secret을 각 Dashboard에 입력한다.
3. 실제 Swift 소스가 있는 iOS 저장소 위치를 백엔드 문서에 연결한다.
4. B1 로그인 통합 테스트를 통과시킨 뒤 B2 iOS 인증을 구현한다.

## 의도적으로 미룬 것

- 로그인할 때 Google Calendar scope 요청: 로그인과 캘린더 연결 동의를 분리하기 위해 B8에서 한다.
- provider token 저장: 실제 외부 API 연동 전에는 필요 없다.
- 커스텀 인증 API: Supabase Auth가 OAuth, session, refresh를 제공하므로 만들지 않는다.
- Apple 로그인: 개발 초기 provider 요청에는 없지만 App Store 출시 조건 때문에 B13 전에 반드시 한다.
