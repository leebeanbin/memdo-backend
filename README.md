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
5. [`../memdo/docs/31-ui-backend-contract-audit.md`](../memdo/docs/31-ui-backend-contract-audit.md):
   실제 UI·DTO·OpenAPI·schema 차이

## 현재 범위

- Supabase Auth 사용자 생성 시 `개인`, `업무` 캘린더 생성
- PostgreSQL 일정 schema, 제약조건, 조회 인덱스
- 모든 사용자 테이블의 RLS와 `(select auth.uid())` 소유권 정책
- `GET /functions/v1/calendars`
- `GET /functions/v1/todos?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=20`
- `POST /functions/v1/todos`와 UUID `Idempotency-Key`
- `PATCH/DELETE /functions/v1/todos/{id}`와 optimistic `version`
- `GET /functions/v1/todos/{id}`와 원자적 `POST /functions/v1/todos/{id}/reschedule`
- `GET /functions/v1/sync`의 `(updatedAt,id)` 증분 cursor와 삭제 tombstone
- `GET/PUT /functions/v1/preferences` 사용자 설정 영속화
- 개발 익명 사용자 전용 `POST /functions/v1/demo-bootstrap`
- Google·GitHub OAuth 로컬 구성과 `memdo://auth/callback` 허용

오프라인 push outbox, 반복 일정과 Agent는 아직 연결하지 않는다.

## 확정된 확장 경계

- 비동기 전달: Supabase Queues(`pgmq`), Kafka/RabbitMQ 제외
- 의미 검색: 같은 PostgreSQL의 pgvector, 외부 vector DB 제외
- Redis: AI·MCP rate limit과 짧은 lock에만 Upstash REST 사용
- ORM: SQL migration이 원본이며 Drizzle은 trusted worker의 실제 복잡 쿼리에만 제한
- MCP: Memdo API를 호출하는 외부 adapter, DB 직접 접근 금지
- LLM: OpenAI production adapter + llama.cpp local/self-host adapter

## 로컬 실행

Docker가 실행 중이어야 한다.

```bash
npm install
npm run start
npm run db:reset
npm run functions:serve
```

개발 seed를 사용할 때는 `.env.example`을 `.env.local`로 복사해 `MEMDO_DEMO_SEED_ENABLED=true`로
바꾸고 `npx supabase functions serve --env-file .env.local`을 실행한다. 운영 환경에서는 이 값을 켜지
않는다.

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

iOS Debug 실행 Scheme에 `SUPABASE_PUBLISHABLE_KEY`를 환경 변수로 추가한다. 로컬 URL 기본값은
`http://127.0.0.1:54321`이며 key는 `npx supabase status -o env`에서 확인한다. 개발 seed 허용 여부는
백엔드의 `MEMDO_DEMO_SEED_ENABLED`만이 결정하며 iOS에는 같은 flag를 두지 않는다.

## 요청 헤더

```text
apikey: <SUPABASE_PUBLISHABLE_KEY>
Authorization: Bearer <USER_ACCESS_TOKEN>
Content-Type: application/json
Idempotency-Key: <UUID> # POST command
```

## 다음 연결 순서

1. Supabase Dashboard에서 익명 로그인과 Google·GitHub provider, `memdo://auth/callback`을 활성화
2. iOS에서 로그인→일정 CRUD→재실행→조회 실제 왕복 검증
3. 재예약 명령과 증분 동기화의 iOS 호출 연결
4. Sign in with Apple과 Supabase Auth 연결
5. 배포 로그·EXPLAIN·복구 절차를 운영 문서에 저장
