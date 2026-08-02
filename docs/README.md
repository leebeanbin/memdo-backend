# Memdo Backend 문서 시작점

## 저장소 위치

- 절대 경로: `/Users/leebeanbin/Documents/Codex/2026-07-30/wlrma/memdo-backend`
- Git 저장소: 위 폴더 자체가 독립 저장소다.
- 현재 브랜치: `main`
- iOS UI와 제품 기획 문서 저장소: `../memdo`
- 주의: 현재 `../memdo`에는 Swift 소스가 없으므로 로그인 화면과 딥 링크 처리는 아직 iOS 앱에 연결할
  수 없다.

## 읽는 순서

1. 이 문서에서 현재 상태와 경계를 확인한다.
2. [`auth-social-login.md`](auth-social-login.md)에서 로그인 흐름과 필요한 외부 설정을 확인한다.
3. [`roadmap.md`](roadmap.md)에서 다음 작업, 의존성, 완료 조건을 확인한다.
4. [`work-log.md`](work-log.md)에서 실제 변경과 검증 결과를 확인한다.

## 코드 지도

| 위치                            | 책임                                         |
| ------------------------------- | -------------------------------------------- |
| `supabase/config.toml`          | 로컬 Supabase, OAuth provider, redirect 설정 |
| `supabase/migrations/`          | 사용자·캘린더·일정 schema, index, RLS        |
| `supabase/functions/calendars/` | 인증 사용자의 캘린더 조회                    |
| `supabase/functions/todos/`     | 인증 사용자의 일정 조회·생성                 |
| `supabase/functions/_shared/`   | HTTP 응답과 일정 입력 계약                   |
| `.env.example`                  | 커밋 가능한 환경변수 이름 목록               |
| `docs/`                         | 결정, 작업 순서, 작업 기록                   |

## 현재 상태

- 완료: DB migration, RLS, 캘린더 조회, 일정 조회·생성, cursor pagination, 입력 검증.
- 구성 완료: Google·GitHub OAuth의 로컬 설정과 iOS callback allow-list.
- 외부 작업 필요: Supabase 프로젝트, Google OAuth client, GitHub OAuth App 생성 및 secret 입력.
- 검증 제한: 이 Mac에는 Docker 호환 runtime이 없어 로컬 Supabase 전체 실행은 아직 못 했다.

## 문서 운영 규칙

앞으로 기능을 구현할 때마다 다음을 함께 갱신한다.

1. 작업 전 `roadmap.md`에서 대상 항목을 `진행 중`으로 바꾼다.
2. 코드와 가장 작은 실행 가능한 검사를 같이 작성한다.
3. 작업 후 `work-log.md`에 변경 파일, 결정, 검증, 남은 blocker를 기록한다.
4. 완료 조건을 충족한 항목만 `완료`로 바꾼다.
5. 기능 단위로 커밋하고 커밋 ID를 작업 기록에 남긴다.
