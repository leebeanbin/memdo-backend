# 작업 기록

## 2026-08-02 — 백엔드 기반

- 저장소 생성: `/Users/leebeanbin/Documents/Codex/2026-07-30/wlrma/memdo-backend`
- 구현: Supabase config, DB migration, RLS, calendars GET, todos GET·POST, cursor, idempotency.
- 검증: `npm run check`, `npm test` 통과.
- 커밋: `9e29e11 feat: add Supabase schedule backend foundation`
- 제한: Docker 호환 runtime과 원격 Supabase 프로젝트가 없어 migration 실적용은 대기.

## 2026-08-02 — Google·GitHub 로그인 구성

- 변경: Google·GitHub provider를 env 기반으로 구성하고 `memdo://auth/callback`을 허용.
- 문서: 저장소 지도, provider 설정, 전체 roadmap, 작업 기록을 추가.
- 보안 결정: 로그인 scope와 Calendar·repository 접근 scope를 분리하고 secret은 커밋하지 않음.
- 외부 작업 필요: Google OAuth client, GitHub OAuth App, Supabase 프로젝트 생성.
- 검증: OAuth 임시 값을 주입해 config 해석 통과. `npm run check`, `npm test` 통과. 전체 실행은
  Docker 미설치 지점에서 중단됨.
- 커밋: `253a411 feat: configure Google and GitHub OAuth`

## 2026-08-02 — UI·백엔드 계약 재감사

- 목표: 실제 SwiftUI 화면과 OpenAPI·물리 schema·단계별 개발 범위를 다시 일치시킨다.
- 변경 파일: 제품 문서 `03`·`04`·`05`·`10`·`14`~`23`·`30`·`31`, backend README·roadmap, iOS Daily
  Summary·Widget.
- 결정과 이유: pgmq/pgvector는 같은 PostgreSQL, Redis는 ephemeral, MCP는 API adapter, SQL
  migration은 schema 원본으로 제한한다.
- 확인 결과: 알림 String↔Int, 장소 String↔구조체, 완료 Bool↔status, fixture 날짜, 미연결 UI action을
  B2~B13에 배치했다.
- 검증: OpenAPI YAML parse, 상대 문서 링크, `npm run check`, Deno test 3개, iOS simulator generic
  build 통과.
- 남은 blocker: 실제 migration 적용과 EXPLAIN은 Docker 또는 원격 Supabase project 연결 뒤 진행한다.

## 2026-08-02 — B2 날짜별 일정 조회

- 목표: Today 화면이 사용하는 날짜별 최소 조회 경로와 iOS 입력 모델의 손실 필드를 먼저 고정한다.
- 변경 파일: `days` Edge Function·계약 테스트, day 조회 partial index, Todo projection·route log,
  iOS `ScheduleModel`·`ScheduleSheets`·`ScheduleAPI`.
- 결정과 이유: 별도 조회 테이블은 만들지 않고 실제
  `user_id + scheduled_date + start_at + sort_order` query에 맞춘 partial index를 사용한다. 알림은
  분 단위 정수, 장소는 MapKit 좌표를 포함한 구조체, 상태와 enum raw value는 API 값으로 정규화했다.
- 실행한 검증과 결과: `npm run check`, Deno 계약 테스트 6개, iOS generic Simulator build 통과.
- 커밋 / 남은 blocker: 미커밋. Supabase project가 없어 migration·EXPLAIN 실적용과 인증된 iOS
  create→relaunch→read는 대기한다. fixture 날짜 제거와 인증 session 주입도 B2에 남아 있다.

## 2026-08-03 — UI fixture 제거와 백엔드 vertical slice

- 목표: iOS의 고정 2026-07 일정과 Widget 정적 문구를 제거하고 개발 데이터도 인증된 백엔드에서
  읽는다.
- 변경 파일: 익명 Auth config, `demo-bootstrap`, Todo PATCH·DELETE, hard delete 차단 migration, iOS
  Supabase session/repository/store, 실제 날짜 UI, App Group Widget snapshot.
- 결정과 이유: 개발 seed는 SQL 공용 fixture가 아니라 익명 사용자별 1회 batch insert로 만든다. 수정과
  삭제는 `version` 조건이 포함된 단일 SQL statement로 처리하고 클라이언트는 실패 시 낙관적 변경을
  되돌린다.
- 실행한 검증과 결과: Deno 계약 테스트 9개와 format/typecheck 통과, OpenAPI·plist·pbxproj lint,
  Widget Swift typecheck 통과. Xcode에서 Memdo를 iPhone 15에 build/run하고 설정 누락 오류 상태까지
  확인했다. CLI SwiftPM build만 Codex 중첩 sandbox 제약을 받는다.
- 커밋 / 남은 blocker: 미커밋. Docker daemon과 Supabase publishable key가 없어 실제 anonymous
  sign-in→seed→조회→재실행 왕복은 대기한다. 브리핑은 fake를 제거하고 B9 연결 대기 상태를 표시한다.

## 2026-08-03 — 환경 설정 소유권 정리

- 목표: 같은 기능 flag가 백엔드와 iOS에 중복되어 불일치하는 상태를 제거한다.
- 변경 파일: iOS `ScheduleAPI`·Info.plist·Xcode build settings, backend README.
- 결정과 이유: OAuth·LLM secret과 개발 seed flag는 backend 환경만 소유한다. iOS에는 접속에 필요한
  공개 URL과 publishable key만 둔다.
- 실행한 검증과 결과: iOS source parse, plist·pbxproj lint와 backend format/typecheck를 실행한다.
- 커밋 / 남은 blocker: 미커밋. local/preview/staging/production 값 주입 자동화는 배포 CI 구성 때
  연결한다.

## 2026-08-03 — B3 원자적 재예약

- 목표: 날짜 이동 중 원본만 사라지는 부분 성공을 막고 상세 조회 계약을 완성한다.
- 변경 파일: Todo Edge Function·계약 검사, `reschedule_todo` migration, backend 문서.
- 결정과 이유: 원본 상태 변경과 replacement 생성을 하나의 PostgreSQL 함수에서 처리하고 새 UUID를
  idempotency key로 사용한다. stale version은 변경 없이 409를 반환한다.
- 실행한 검증과 결과: Deno format/typecheck와 계약 테스트 11개 통과.
- 커밋 / 남은 blocker: 실제 PostgreSQL rollback·RLS 검증과 iOS 재예약 호출 연결은 남아 있다.

## 이후 기록 형식

각 작업은 아래 다섯 항목을 빠짐없이 기록한다.

```text
날짜와 작업명
- 목표:
- 변경 파일:
- 결정과 이유:
- 실행한 검증과 결과:
- 커밋 / 남은 blocker:
```
