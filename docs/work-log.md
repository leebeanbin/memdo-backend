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
- 커밋: `5558355`. Supabase project가 없어 migration·EXPLAIN 실적용과 인증된 iOS
  create→relaunch→read는 대기한다.

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
- 커밋: backend `5558355`. Docker daemon과 Supabase publishable key가 없어 실제 anonymous
  sign-in→seed→조회→재실행 왕복은 대기한다. 브리핑은 fake를 제거하고 B9 연결 대기 상태를 표시한다.

## 2026-08-03 — 환경 설정 소유권 정리

- 목표: 같은 기능 flag가 백엔드와 iOS에 중복되어 불일치하는 상태를 제거한다.
- 변경 파일: iOS `ScheduleAPI`·Info.plist·Xcode build settings, backend README.
- 결정과 이유: OAuth·LLM secret과 개발 seed flag는 backend 환경만 소유한다. iOS에는 접속에 필요한
  공개 URL과 publishable key만 둔다.
- 실행한 검증과 결과: iOS source parse, plist·pbxproj lint와 backend format/typecheck를 실행한다.
- 커밋: backend `5558355`; iOS 변경은 제품 저장소 작업에 포함된다.
- 남은 blocker: local/preview/staging/production 값 주입 자동화는 배포 CI 구성 때 연결한다.

## 2026-08-03 — B3 원자적 재예약

- 목표: 날짜 이동 중 원본만 사라지는 부분 성공을 막고 상세 조회 계약을 완성한다.
- 변경 파일: Todo Edge Function·계약 검사, `reschedule_todo` migration, backend 문서.
- 결정과 이유: 원본 상태 변경과 replacement 생성을 하나의 PostgreSQL 함수에서 처리하고 새 UUID를
  idempotency key로 사용한다. stale version은 변경 없이 409를 반환한다.
- 실행한 검증과 결과: Deno format/typecheck와 계약 테스트 11개 통과.
- 커밋: `288ae96`, 계약 정렬 `1bcb9cb`.
- 남은 blocker: 실제 PostgreSQL rollback·RLS 검증과 iOS 재예약 호출 연결은 남아 있다.

## 2026-08-03 — B4 증분 pull

- 목표: 초기 조회 뒤 변경된 일정과 삭제 tombstone만 내려받는다.
- 변경 파일: `sync` Edge Function·계약 검사, Supabase config, backend 문서.
- 결정과 이유: 조회 테이블을 추가하지 않고 기존 `(user_id, updated_at, id)` 인덱스와 opaque cursor를
  사용한다. tombstone은 id·version·updatedAt만 보내 전송량을 줄인다.
- 실행한 검증과 결과: Deno format/typecheck와 계약 테스트 13개 통과.
- 커밋: `23a8c39`. iOS SwiftData outbox와 sync pull 적용은 남아 있다.

## 2026-08-03 — B6 사용자 설정 저장

- 목표: 설정 화면의 값을 계정에 저장하고 다른 기기와 재실행에서 복원할 기반을 만든다.
- 변경 파일: `user_preferences` migration, `preferences` Edge Function·계약 검사, backend 문서.
- 결정과 이유: 사용자당 한 행을 full replacement upsert하고 외부 연결 token과 브리핑 키워드는 별도
  경계로 유지한다. 기본값은 제품 정책대로 DB에서 한 번 정의한다.
- 실행한 검증과 결과: Deno format/typecheck와 계약 테스트 15개 통과.
- 커밋: `92cbefd`. iOS 설정 store 연결과 실제 DB constraint/RLS 검증은 남아 있다.

## 2026-08-03 — 원격 Supabase 첫 배포

- 목표: 준비된 일정 vertical slice를 `snfvykovzybfpwomnxhj` 프로젝트에 실제 배포하고 보안·성능
  경고를 제거한다.
- 변경 파일: Deno 배포 설정, 로컬 검사 script, 함수 권한·복합 FK index migration, 배포 상태 문서.
- 결정과 이유: 원격 번들러는 npm 의존성을 설치하도록 `nodeModulesDir=auto`, 로컬 검사는 lockfile의
  설치본을 쓰도록 `--node-modules-dir=manual`을 사용한다. 가입 trigger의 직접 실행 권한을 회수하고
  `(calendar_id, user_id)` 복합 index가 기존 단일 index를 대체한다.
- 실행한 검증과 결과: migration 6개 적용, public 테이블 4개 RLS 강제, 보안 advisor 0건, Edge
  Function 6개 `ACTIVE`·JWT 검증 활성, Deno 검사와 계약 테스트 15개 통과, iPhone 15 build/run 성공.
- 커밋 / 남은 blocker: Supabase Dashboard의 익명 로그인과 Google·GitHub provider가 아직 비활성화되어
  실제 인증·CRUD 왕복은 대기한다. 성능 advisor의 미사용 index 정보는 데이터가 없는 신규 DB이므로
  유지한다.

## 2026-08-03 — 원격 인증·일정 왕복 검증

- 목표: 배포 상태를 넘어 iPhone 15에서 사용자 인증과 일정 영속화를 실제로 확인한다.
- 변경 파일: Supabase Auth 설정, backend 상태 문서, iOS shared session/repository 연결.
- 결정과 이유: 계정 없이 시작은 별도 임시 저장소를 만들지 않고 Supabase anonymous session과 같은
  owner RLS 경로를 사용한다. 공개 파일럿 전에는 CAPTCHA를 추가한다.
- 실행한 검증과 결과: anonymous signup 200, 사용자/profile/기본 캘린더 2개/preferences trigger 생성,
  Todo POST 201·GET 200·PATCH 200, 앱 재실행 후 일정 복원, 수정 후 version 2를 확인했다. Edge
  Function 로그와 Auth 로그에도 같은 성공 상태가 남았다.
- 커밋 / 남은 blocker: Google·GitHub client ID/secret이 비어 있어 두 provider의 실제 로그인은
  대기한다. Security Advisor의 anonymous-access 경고는 owner RLS를 유지한 의도된 개발 경로이며
  CAPTCHA 없이 외부 파일럿을 열지 않는다. 비밀번호 로그인 출시 전 leaked-password protection을 켠다.

## 2026-08-16 — B8 Google Calendar 읽기 전용 미러

- 목표: 로그인 scope와 분리된 별도 동의로 Google Calendar를 연결하고, Memdo Todo와 섞지 않는 읽기
  전용 미러를 구축한다.
- 변경 파일: `google_calendar_connections`·`google_calendar_oauth_states`·`google_calendar_mirror_events`
  migration, `google-calendar-{start,callback,status,disconnect,sync}` Edge Function, vault
  RPC 재사용.
- 결정과 이유: refresh token은 Supabase Vault에 저장하고 service-role만 읽는다. 증분 동기화는
  Google의 `nextSyncToken`을 그대로 저장하고, `410 Gone` 응답을 받으면 해당 캘린더만 전체
  재동기화한다. Todo 테이블에 직접 쓰지 않고 별도 mirror 테이블·owner RLS로 격리한다.
- 실행한 검증과 결과: 실제 Google 계정으로 연결→동기화→해제→재인증 왕복, 보안 advisor 0건, Deno
  계약 test, CI green.
- 커밋: `4c0f40c`. 남은 blocker 없음(Phase A 범위 완료, write scope와 MCP는 B12 이후).

## 2026-08-16 — B10 클라우드 Agent(OpenRouter BYOK)

- 목표: 온디바이스 Apple FoundationModels만으로 부족한 사용자를 위해, 사용자가 직접 발급한
  OpenRouter API 키로 더 강한 클라우드 모델을 쓸 수 있게 한다.
- 변경 파일: `user_api_keys`·`agent_chat_requests` migration, `agent-key`·`agent-cloud-chat` Edge
  Function, `_shared/agent-key-contract.ts`·`_shared/agent-cloud-contract.ts`(+ 단위 테스트 14개).
- 결정과 이유: 키는 Vault에 저장하고 서버는 절대 평문으로 보관하지 않는다. 응답은 SSE로 스트리밍하고,
  `propose_schedule` 도구 호출마다 서버가 기존 일정과의 시간 충돌을 직접 재검사(Reflection)해 모델
  주장을 신뢰하지 않는다. 시간당 요청 수를 제한한다. 모델 allowlist는 2026-08 기준 OpenRouter가 실제
  서빙하는 모델만 `curl`로 직접 확인해 채웠다(WebFetch 요약은 신뢰하지 않음). ChatGPT
  Plus/Claude Pro·Max/Google AI Pro 등 기존 구독 재사용은 API 미제공 또는 서드파티 도구에 대한
  Anthropic의 2026-04-04 Consumer ToS 집행 때문에 채택하지 않았다.
- 실행한 검증과 결과: 타임존 안전 날짜 계산(Deno test, `TZ=UTC`/`TZ=America/New_York` 교차 검증),
  streaming/tool-call 누적 로직 단위 테스트, CI green, 실제 OpenRouter 키로 왕복 확인.
- 커밋: `87885e9`, `61d9ad0`, `2a20108`, `b9df806`, `20fb92d`. 남은 blocker: 비
  Apple-Intelligence 기기용 온디바이스 fallback 모델은 스코프만 잡고 미구현(#67).

## 2026-08-16 — 카테고리 동기화, 운동 기록 rescue, meeting_url 이력화

- 목표: iOS에서만 로컬로 존재하던 사용자 정의 카테고리를 서버에 영속화하고, migration 이력 없이
  운영에 배포돼 있던 `workout_logs`와 `todos.meeting_url`을 버전 관리로 되돌린다.
- 변경 파일: `user_categories` migration + `categories` Edge Function, `workout_logs`/
  `workout_log_details`/`workout_log_full` rescue migration, `todos.meeting_url` rescue migration,
  `supabase/functions/package.json`의 `check` script를 하드코딩 파일 목록에서 glob으로 변경.
- 결정과 이유: 두 rescue 모두 "실제 운영 동작을 바꾸지 않고 이력만 되돌린다"는 원칙을 지켰다.
  `check` script를 glob으로 바꾼 이유는 하드코딩된 파일 목록이 신규 함수 6개를 CI type check에서
  누락시킨 근본 원인이었기 때문이다.
- 실행한 검증과 결과: `npm run check`(glob 적용 후 20개 함수 모두 검사됨 확인), `npm test`, 보안
  advisor 0건, CI green.
- 커밋: `026cedc`, `fdfb0e4`, `a3b09ba`.

## 2026-08-17 — 개발 종료, 문서 최신화

- 목표: 계획된 범위(B0~B11)를 모두 구현·배포·검증한 시점에 문서를 실제 코드와 다시 맞추고 개발을
  마무리한다.
- 변경 파일: 이 저장소의 `README.md`·`docs/README.md`·`docs/roadmap.md`·`docs/work-log.md`, iOS
  저장소의 `README.md`·`docs/09-roadmap-and-backlog.md`·`docs/10-decisions-and-open-questions.md`
  (ADR-073~075 추가)·`docs/20-ai-agent-architecture.md`·`docs/21-integration-hub-google-calendar-mcp.md`.
- 결정과 이유: 설계 문서(`20`, `21`)는 원래 구상한 상위 아키텍처(Agents SDK, MCP, Slack OAuth)를
  참고 자료로 남기되, 각 문서 상단에 실제 배포된 범위와의 차이를 명시해 향후 재개 시 문서와 코드를
  다시 맞추는 작업을 반복하지 않게 했다.
- 실행한 검증과 결과: 코드 지도·roadmap·ADR을 실제 migration/함수 목록·git log와 대조 확인.
- 남은 blocker: B12(MCP), B13(운영 자동화), #67(온디바이스 fallback 모델) 미착수. 재개 조건은 각
  문서의 "다음에 재개할 때" 절을 따른다.

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
