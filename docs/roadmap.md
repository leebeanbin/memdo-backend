# Backend 전체 작업 계획

상태는 `대기`, `진행 중`, `외부 작업 필요`, `완료`만 사용한다. 이 문서는 원래 2026-08-17 개발 종료
시점 기준으로 작성됐고, 이후 재개된 작업이 있는 단계(B8)는 표에서 직접 갱신한다 — 재개 이력 전체는
아래 "2026-08-17 이후 재개된 작업"을 따른다.

| 단계             | 상태                           | 작업                                                                                                                                                                       | 완료 조건                                                                |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| B0 기반          | 완료                           | 저장소, schema, index, RLS, 일정 조회·생성                                                                                                                                 | type check와 계약 test 통과                                              |
| B1 인증 구성     | 완료 (재확인 필요)             | 익명 session 검증 완료, Apple·Google·GitHub provider 자격 증명·로그인 UI·callback 구현 완료                                                                                | 익명 경로는 확인됨. 세 provider 실기기 로그인 왕복은 출시 전 재확인 필요 |
| B2 일정 조회     | 완료                           | UI DTO 수정, day read, 실제 iOS 조회·생성                                                                                                                                  | create→relaunch→read와 값 무손실 왕복                                    |
| B3 일정 명령     | 완료                           | 상세·수정·삭제·원자적 재예약                                                                                                                                               | 실제 DB rollback·iOS 연결 검증                                           |
| B4 동기화/Widget | 완료                           | delta cursor·tombstone, iOS outbox·offline replay                                                                                                                          | offline 재연결 수렴과 위젯 일치                                          |
| B5 반복 일정     | 완료                           | schedule rules, on-demand virtual occurrence                                                                                                                               | DST·월말·단일 예외 검증                                                  |
| B6 알림·리뷰     | 완료                           | preferences, review 응답, 기간 요약                                                                                                                                        | 거부·시간대 변경·중복 응답 검증                                          |
| B7 검색          | 완료                           | pg_trgm 제목·메모·장소, 공용 search                                                                                                                                        | p95·최소 DTO·권한 격리 확인                                              |
| B8 Google        | 완료 (양방향 확장, 2026-09-02) | 별도 동의, refresh token vault, 증분 sync, 읽기 mirror + push queue + 실시간 webhook, 추가 캘린더 구독, 소유권 검증된 `enqueue_google_push` RPC, 멱등 push, 연결 상태 분류 | 연결·철회·재인증·출처 표시 검증, push 재시도가 중복 이벤트를 만들지 않음 |
| B9 브리핑        | 완료 (서버 미경유)             | iOS가 RSS를 직접 수집, 온디바이스 요약                                                                                                                                     | 하루 한 번·3~5개·출처 표시 (서버 pgmq 파이프라인은 만들지 않음)          |
| B10 Agent        | 완료                           | 온디바이스 FoundationModels(Reflection) + 사용자 BYOK OpenRouter 클라우드(streaming·rate limit·reflection·model 선택)                                                      | 승인 전 무변경, 서버 측 충돌 검사                                        |
| B11 Slack        | 완료 (축소 범위)               | 사용자 발급 Incoming Webhook을 iOS Keychain에 저장 후 전송                                                                                                                 | 저장 확인 후에만 전송, 중복 전송 방지                                    |
| B12 MCP          | 대기                           | 외부 tool adapter, OAuth, rate limit                                                                                                                                       | DB 직접 접근 없이 승인 링크 생성                                         |
| B13 운영·출시    | 대기                           | dashboard, backup, 글로벌화, 개인정보·심사                                                                                                                                 | 복구 훈련·ko/en·삭제·alert 증거                                          |

이 시점에서 개발을 종료했으나 이후 세 차례 재개됐다 (아래). B12(MCP)·B13(운영 자동화)은 여전히
착수하지 않았고, 그쪽을 재개할 때는 아래 "다음에 재개할 때"를 먼저 읽는다.

## 2026-08-17 이후 재개된 작업

- **2026-08-21~09-01 — Agent 견고성·평가 체계**: PR 기반 워크플로 도입 후 47개 PR 병합. Epic
  F-2(다중 모델 비교 runner), Epic G(모델 capability registry), Epic H(Agent 감사 로그), 그리고 반복
  일정·동기화 cursor·검색·권한 정합성 버그 다수 수정(코드에 `bd`/`be`/`fd` 접두 주석으로 남아있음).
  개별 변경 사항은 각 PR 설명 자체가 기록이므로 여기 다시 옮기지 않는다 —
  [병합된 PR 전체 목록](https://github.com/leebeanbin/memdo-backend/pulls?q=is%3Apr+is%3Amerged).
- **2026-09-02 — Google Calendar 양방향 동기화**: B8을 read-only mirror에서 push queue +
  materialize-on-edit + 실시간 webhook pull로 확장. 위 B8 행 참고.
- **2026-09-07~09 — 보안/신뢰성 리뷰 + 배포 인프라 복구**: `enqueue_google_push` RPC 소유권 검증,
  Google 이벤트 생성 멱등화, 연결 상태를 `active/error/rate_limited/revoked`로 분류(일시적 오류로
  재연결을 요구하지 않음), 실패한 push 큐 노출·재시도, OpenRouter rate-limit을 구조화된 에러로 구분,
  `deploy-supabase.yml` 자동 배포 파이프라인 복구(이 저장소와 무관한 `CLAUDE.md`의 `deno fmt` 위반이
  며칠간 자동 배포를 막고 있었음), 마이그레이션 히스토리 정합성 복구(로컬 파일 7개 재명명 + 커밋된
  적 없던 마이그레이션 1개를 라이브 스키마에서 재구성), DB 인덱스 정리(중복 인덱스 제거, 누락된 FK
  인덱스 5개 추가), revoked 연결의 미러 이벤트가 `/todos` 전체 로딩을 막던 버그 발견 및 수정. 자세한
  내용은 `work-log.md`의 해당 날짜 항목.

## 원래 설계와 실제 구현이 달라진 부분

- **B9 브리핑**: 서버 pgmq 기반 기사 dedupe·생성 파이프라인 대신, iOS 앱이 RSS 피드를 직접 파싱하고
  Apple FoundationModels로 온디바이스 요약한다. 별도 Edge Function이 없다.
- **B10 Agent**: iOS 저장소의 `docs/20-ai-agent-architecture.md`가 설계한 OpenAI Responses API +
  Agents SDK 상시 서버 오케스트레이션 대신, (1) 기기 내 Apple FoundationModels를 기본 경로로 쓰고
  (2) 사용자가 원할 때만 자신의 OpenRouter API 키(BYOK)로 클라우드 모델을 쓰는 2트랙 구조로
  구현했다. 이유는 iOS 저장소 ADR-073을 참고한다.
- **B11 Slack**: OAuth 앱 설치·`chat:write` scope 승인 흐름 대신, 사용자가 Slack에서 직접 발급한
  Incoming Webhook URL을 붙여넣어 Keychain에 저장하는 방식으로 시작했다. 채널 여러 개, 슬래시
  커맨드가 필요해지면 OAuth로 확장할 수 있지만 지금은 만들지 않았다.

## 의도적으로 만들지 않은 것

- 로그인할 때 Google Calendar scope 요청: 로그인과 캘린더 연결 동의를 분리해 B8에서 별도로 받는다.
- 커스텀 인증 API: Supabase Auth가 OAuth, session, refresh를 제공하므로 만들지 않는다.
- 익명 CAPTCHA: 내부 개발에서는 생략했다. 외부 파일럿을 열기 전에 Turnstile 또는 hCaptcha를 켠다.
- Memdo Remote MCP(B12): Google read-only 통합과 출처 인덱싱이 먼저 안정돼야 외부 AI도 같은 데이터를
  신뢰할 수 있다는 원래 설계 판단을 유지한 채 착수하지 않았다.
- 운영 dashboard·자동 백업·글로벌화(B13): 파일럿 규모(50명 내외)에서는 수동 운영으로 충분해 자동화
  투자를 미뤘다.
- 온디바이스 fallback 모델(비 Apple-Intelligence 기기용 MLX 등): 스코프만 잡고 구현은 보류했다.

## 다음에 재개할 때

1. `../memdo` 저장소의 `docs/26-document-consistency-audit.md`와 이 roadmap의 "원래 설계와 실제
   구현이 달라진 부분"부터 읽어 문서와 코드가 어디서 갈라졌는지 먼저 파악한다.
2. B12를 시작하려면 Google read-only mirror(B8)와 검색(B7)이 실사용자 데이터로 안정적인지 먼저
   확인한다.
3. B13은 실사용자가 늘어나 수동 운영 비용이 실제로 문제가 될 때 착수한다.

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
