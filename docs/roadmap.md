# Backend 전체 작업 계획

상태는 `대기`, `진행 중`, `외부 작업 필요`, `완료`만 사용한다. 이 문서는 개발 종료 시점(2026-08-17)
기준의 최종 상태를 기록한다.

| 단계             | 상태               | 작업                                                                                                                    | 완료 조건                                                       |
| ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| B0 기반          | 완료               | 저장소, schema, index, RLS, 일정 조회·생성                                                                                | type check와 계약 test 통과                                     |
| B1 인증 구성     | 완료 (재확인 필요) | 익명 session 검증 완료, Apple·Google·GitHub provider 자격 증명·로그인 UI·callback 구현 완료                               | 익명 경로는 확인됨. 세 provider 실기기 로그인 왕복은 출시 전 재확인 필요 |
| B2 일정 조회     | 완료               | UI DTO 수정, day read, 실제 iOS 조회·생성                                                                                  | create→relaunch→read와 값 무손실 왕복                            |
| B3 일정 명령     | 완료               | 상세·수정·삭제·원자적 재예약                                                                                              | 실제 DB rollback·iOS 연결 검증                                   |
| B4 동기화/Widget | 완료               | delta cursor·tombstone, iOS outbox·offline replay                                                                        | offline 재연결 수렴과 위젯 일치                                  |
| B5 반복 일정     | 완료               | schedule rules, on-demand virtual occurrence                                                                              | DST·월말·단일 예외 검증                                          |
| B6 알림·리뷰     | 완료               | preferences, review 응답, 기간 요약                                                                                       | 거부·시간대 변경·중복 응답 검증                                  |
| B7 검색          | 완료               | pg_trgm 제목·메모·장소, 공용 search                                                                                       | p95·최소 DTO·권한 격리 확인                                      |
| B8 Google        | 완료               | 별도 동의, refresh token vault, 증분 sync, 읽기 전용 mirror                                                                | 연결·철회·재인증·출처 표시 검증                                  |
| B9 브리핑        | 완료 (서버 미경유) | iOS가 RSS를 직접 수집, 온디바이스 요약                                                                                    | 하루 한 번·3~5개·출처 표시 (서버 pgmq 파이프라인은 만들지 않음)  |
| B10 Agent        | 완료               | 온디바이스 FoundationModels(Reflection) + 사용자 BYOK OpenRouter 클라우드(streaming·rate limit·reflection·model 선택)     | 승인 전 무변경, 서버 측 충돌 검사                                |
| B11 Slack        | 완료 (축소 범위)   | 사용자 발급 Incoming Webhook을 iOS Keychain에 저장 후 전송                                                                | 저장 확인 후에만 전송, 중복 전송 방지                            |
| B12 MCP          | 대기               | 외부 tool adapter, OAuth, rate limit                                                                                      | DB 직접 접근 없이 승인 링크 생성                                 |
| B13 운영·출시    | 대기               | dashboard, backup, 글로벌화, 개인정보·심사                                                                                | 복구 훈련·ko/en·삭제·alert 증거                                  |

이 시점에서 개발을 종료한다. B12(MCP)·B13(운영 자동화)은 착수하지 않았고, 재개할 때는 아래 "다음에
재개할 때"를 먼저 읽는다.

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
