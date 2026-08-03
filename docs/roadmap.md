# Backend 전체 작업 계획

상태는 `대기`, `진행 중`, `외부 작업 필요`, `완료`만 사용한다. 아래 순서가 구현 순서이며, 앞 단계의
완료 조건을 통과하지 않으면 다음 단계의 배포를 진행하지 않는다.

| 단계             | 상태    | 작업                                                | 완료 조건                              |
| ---------------- | ------- | --------------------------------------------------- | -------------------------------------- |
| B0 기반          | 완료    | 저장소, schema, index, RLS, 일정 조회·생성          | type check와 계약 test 통과            |
| B1 인증 구성     | 진행 중 | 익명 session 완료, Google·GitHub OAuth 값 대기      | 소셜 로그인·재실행·만료 token·RLS 확인 |
| B2 일정 조회     | 완료    | UI DTO 수정, day read, 실제 iOS 조회·생성           | create→relaunch→read와 값 무손실 왕복  |
| B3 일정 명령     | 진행 중 | 상세·수정 완료, 삭제·원자적 재예약 검증 대기        | 실제 DB rollback·iOS 연결 검증         |
| B4 동기화/Widget | 진행 중 | delta cursor·tombstone 완료, outbox·snapshot 대기   | offline 재연결 수렴과 위젯 일치        |
| B5 반복 일정     | 대기    | schedule rules, pgmq occurrence 작업                | DST·월말·단일 예외 검증                |
| B6 알림·리뷰     | 진행 중 | preferences 완료, review 응답·기간 요약 대기        | 거부·시간대 변경·중복 응답 검증        |
| B7 검색          | 대기    | pg_trgm 제목·메모·장소, 공용 SearchTodos            | p95·최소 DTO·권한 격리 확인            |
| B8 Google        | 대기    | 별도 동의, token vault, 증분 sync, external mirror  | 연결·철회·재인증·출처 표시 검증        |
| B9 브리핑        | 대기    | 관심 키워드, 기사 dedupe, pgmq 생성                 | 하루 한 번·3~5개·출처·실패 보존        |
| B10 Agent        | 대기    | consent/proposal, OpenAI+llama.cpp, pgvector, Redis | 승인 전 무변경과 provider eval         |
| B11 Slack        | 대기    | 승인 후 전송·예약, 허용 channel                     | 최소 scope와 중복 전송 방지            |
| B12 MCP          | 대기    | 외부 tool adapter, OAuth, rate limit                | DB 직접 접근 없이 승인 링크 생성       |
| B13 운영·출시    | 대기    | dashboard, backup, 글로벌화, 개인정보·심사          | 복구 훈련·ko/en·삭제·alert 증거        |

## 바로 다음 작업

1. Google·GitHub OAuth App을 만들고 Supabase provider 값을 입력한다.
2. iPhone 15에서 Google/GitHub 로그인과 session 복원을 각각 검증한다.
3. 원격 환경에서 delete/reschedule과 별도 사용자 간 RLS 격리를 검증한다.
4. 원격 Supabase에서 오늘 조회 EXPLAIN과 route duration/response bytes 로그를 저장한다.
5. B4의 iOS delta sync/outbox를 구현한 뒤 반복·검색 순서로 진행한다.

## 의도적으로 미룬 것

- 로그인할 때 Google Calendar scope 요청: 로그인과 캘린더 연결 동의를 분리하기 위해 B8에서 한다.
- provider token 저장: 실제 외부 API 연동 전에는 필요 없다.
- 커스텀 인증 API: Supabase Auth가 OAuth, session, refresh를 제공하므로 만들지 않는다.
- Apple 로그인: 개발 초기 provider 요청에는 없지만 App Store 출시 조건 때문에 B13 전에 반드시 한다.
- 익명 CAPTCHA: 내부 개발에서는 생략하지만 외부 파일럿을 열기 전에 Turnstile 또는 hCaptcha를 켠다.

## 모든 단계 공통 완료 게이트

```text
UI 성공·빈·로딩·오류 상태
+ Domain/DTO/DB row 경계
+ OpenAPI와 migration/RLS/index
+ transaction/idempotency
+ 최소 payload/cursor
+ metric/log/trace
+ ko-KR/en-US와 timezone
+ 실행 가능한 test와 작업 기록
```

인덱스는 query EXPLAIN과 함께 추가한다. 전송 최적화는 projection DTO, delta cursor, ETag, 압축,
batch로 별도 검증한다.
