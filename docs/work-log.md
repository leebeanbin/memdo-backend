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
