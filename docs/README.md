# Memdo Backend 문서 시작점

## 저장소 위치

- 절대 경로: `/Users/leebeanbin/Documents/Codex/2026-07-30/wlrma/memdo-backend`
- Git 저장소: 위 폴더 자체가 독립 저장소다.
- 현재 브랜치: `main`
- iOS UI와 제품 기획 문서 저장소: `../memdo`
- 실제 Swift 소스: `../memdo/apps/ios/Memdo/Memdo`
- UI·API·schema 감사: `../memdo/docs/31-ui-backend-contract-audit.md`

## 읽는 순서

1. 이 문서에서 현재 상태와 경계를 확인한다.
2. 제품 저장소의
   [`31-ui-backend-contract-audit.md`](../../memdo/docs/31-ui-backend-contract-audit.md)에서 화면과
   계약 차이를 확인한다.
3. [`auth-social-login.md`](auth-social-login.md)에서 로그인 흐름과 필요한 외부 설정을 확인한다.
4. [`roadmap.md`](roadmap.md)에서 다음 작업, 의존성, 완료 조건을 확인한다.
5. [`work-log.md`](work-log.md)에서 실제 변경과 검증 결과를 확인한다.

## 코드 지도

| 위치                                             | 책임                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `supabase/config.toml`                           | 로컬 Supabase, OAuth provider, redirect 설정                                 |
| `supabase/migrations/`                           | schema, index, RLS, cron job 전체 이력                                       |
| `supabase/functions/calendars/`                  | 인증 사용자의 캘린더 조회                                                    |
| `supabase/functions/todos/`                      | 인증 사용자의 일정 CRUD, 원자적 재예약                                       |
| `supabase/functions/days/`                       | 날짜별 일정과 리뷰 상태 조회                                                 |
| `supabase/functions/demo-bootstrap/`             | Debug 개발 데이터 생성                                                       |
| `supabase/functions/sync/`                       | 일정 증분 pull과 삭제 tombstone                                              |
| `supabase/functions/preferences/`                | 사용자 설정 조회·전체 저장                                                   |
| `supabase/functions/rules/`                      | 반복 일정 규칙, on-demand virtual occurrence (B5)                            |
| `supabase/functions/reviews/`                    | 하루 리뷰 기록 (B6)                                                          |
| `supabase/functions/summaries/`                  | 기간 요약 (B6)                                                               |
| `supabase/functions/search/`                     | pg_trgm 일정 검색 (B7)                                                       |
| `supabase/functions/google-calendar-start/`      | Google OAuth 인가 시작 (B8)                                                  |
| `supabase/functions/google-calendar-callback/`   | Google OAuth callback, refresh token vault 저장 (B8)                         |
| `supabase/functions/google-calendar-status/`     | 연결 상태 조회 (B8)                                                          |
| `supabase/functions/google-calendar-disconnect/` | 연결 해제, vault secret 삭제 (B8)                                            |
| `supabase/functions/google-calendar-sync/`       | incremental sync token, `410 Gone` 전체 재동기화 (B8)                        |
| `supabase/functions/categories/`                 | 사용자 정의 카테고리 조회·저장                                               |
| `supabase/functions/workout-logs/`               | 운동 기록 CRUD                                                               |
| `supabase/functions/agent-key/`                  | OpenRouter BYOK 키 저장·삭제 (vault) (B10)                                   |
| `supabase/functions/agent-cloud-chat/`           | OpenRouter streaming chat, tool calling, server reflection, rate limit (B10) |
| `supabase/functions/_shared/`                    | HTTP 응답, 일정·Agent 입력 계약, vault 헬퍼                                  |
| `.env.example`                                   | 커밋 가능한 환경변수 이름 목록                                               |
| `docs/`                                          | 결정, 작업 순서, 작업 기록                                                   |

## 현재 상태

- 완료: 원격 DB migration 전체, RLS, 캘린더 조회, 일정 CRUD·원자적 재예약, 날짜별 조회, 증분 sync
  cursor, 반복 일정(B5), 하루 리뷰·기간 요약(B6), pg_trgm 검색(B7), Google Calendar 읽기 전용
  미러(B8), 사용자 정의 카테고리, 운동 기록, BYOK 클라우드 Agent(B10) — Edge Function 20개 배포.
- 구성 완료: Apple·Google·GitHub OAuth 자격 증명, `memdo://auth/callback`. 검증 완료: 익명 세션의
  iPhone 15 session 복원과 일정 create→relaunch→read→update round-trip. 세 provider 각각의 실기기
  로그인 왕복은 미재확인 — [`auth-social-login.md`](auth-social-login.md) 참고.
- iOS 온디바이스 Agent(Apple FoundationModels)는 이 백엔드에 새 엔드포인트가 필요 없다 — 기기에서
  직접 실행하고 기존 일정 API만 호출한다.
- 서버로 옮기지 않기로 한 것: B9 뉴스 브리핑(iOS가 RSS 직접 수집), B11 Slack 알림(사용자 발급
  Incoming Webhook을 iOS Keychain에 저장) — 둘 다 별도 서버 함수가 없다.
- 구현하지 않은 것: B12 Memdo Remote MCP, B13 운영 dashboard·자동 백업·글로벌화. 온디바이스 fallback
  모델(비 Apple-Intelligence 기기)은 스코프만 잡고 보류했다.
- 주의: 익명 사용자는 RLS가 적용된 `authenticated` role을 사용한다. 현재 owner policy로 사용자별
  격리하며 공개 파일럿 전 CAPTCHA를 켠다.

## 문서 운영 규칙

앞으로 기능을 구현할 때마다 다음을 함께 갱신한다.

1. 작업 전 `roadmap.md`에서 대상 항목을 `진행 중`으로 바꾼다.
2. 코드와 가장 작은 실행 가능한 검사를 같이 작성한다.
3. 작업 후 `work-log.md`에 변경 파일, 결정, 검증, 남은 blocker를 기록한다.
4. 완료 조건을 충족한 항목만 `완료`로 바꾼다.
5. 기능 단위로 커밋하고 커밋 ID를 작업 기록에 남긴다.
