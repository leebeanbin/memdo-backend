# Memdo Backend

Supabase 기반 Memdo 백엔드의 독립 저장소다. 첫 수직 슬라이스는 인증된 사용자의 기본 캘린더와 일정
조회·생성이다.

## 정확한 위치와 문서 순서

저장소 절대 경로: `/Users/leebeanbin/Documents/Codex/2026-07-30/wlrma/memdo-backend`

작업을 따라갈 때는 아래 순서로 읽는다.

1. [`docs/README.md`](docs/README.md): 현재 상태와 파일 지도
2. [`docs/auth-social-login.md`](docs/auth-social-login.md): Google·GitHub 로그인 구성
3. [`docs/roadmap.md`](docs/roadmap.md): 앞으로 할 전체 작업과 완료 조건
4. [`docs/work-log.md`](docs/work-log.md): 실제로 수행한 작업과 검증 기록

## 현재 범위

- Supabase Auth 사용자 생성 시 `개인`, `업무` 캘린더 생성
- PostgreSQL 일정 schema, 제약조건, 조회 인덱스
- 모든 사용자 테이블의 RLS와 `(select auth.uid())` 소유권 정책
- `GET /functions/v1/calendars`
- `GET /functions/v1/todos?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=20`
- `POST /functions/v1/todos`와 UUID `Idempotency-Key`
- Google·GitHub OAuth 로컬 구성과 `memdo://auth/callback` 허용

수정·완료·삭제·원자적 재예약, sync cursor, 반복 일정과 Agent는 아직 연결하지 않는다.

## 로컬 실행

Docker가 실행 중이어야 한다.

```bash
npm install
npm run start
npm run db:reset
npm run functions:serve
```

Supabase Studio는 `http://127.0.0.1:54323`, Edge Functions는
`http://127.0.0.1:54321/functions/v1`에서 열린다.

## 원격 프로젝트 연결

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
npm run functions:deploy
```

클라이언트에는 project URL, publishable key와 로그인 후 발급된 사용자 access token만 전달한다.
secret/service-role key는 앱에 넣지 않는다.

## 요청 헤더

```text
apikey: <SUPABASE_PUBLISHABLE_KEY>
Authorization: Bearer <USER_ACCESS_TOKEN>
Content-Type: application/json
Idempotency-Key: <UUID> # POST command
```

## 다음 연결 순서

1. Supabase staging project 생성과 서울 리전 선택
2. migration·Functions 배포
3. Sign in with Apple과 Supabase Auth 연결
4. iOS `URLSession` client에서 calendars와 todos 조회·생성
5. 완료·수정·삭제·재예약과 오프라인 sync 확장
