# Memdo Backend

Supabase 기반 Memdo 백엔드의 독립 저장소다. 일정 CRUD부터 반복 일정, Google Calendar 읽기 전용 미러,
사용자 BYOK 기반 클라우드 Agent까지 개발을 완료했다.

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
- Apple·Google·GitHub OAuth 자격 증명 구성과 `memdo://auth/callback` 허용. 익명 세션 경로는 실제
  계정으로 왕복 검증됨; 세 provider 각각의 실기기 로그인은 출시 전 재확인이 필요하다
  ([`docs/auth-social-login.md`](docs/auth-social-login.md) 참고)
- `schedule_rules` 반복 일정과 on-demand virtual occurrence 생성 (B5)
- `GET/PUT/DELETE /functions/v1/reviews`, `GET /functions/v1/summaries` 하루 리뷰·기간 요약 (B6)
- `GET /functions/v1/search`의 pg_trgm 일정 검색 (B7)
- Google Calendar 읽기 전용 미러: OAuth 연결·해제·상태 조회, incremental sync token, `410 Gone` 전체
  재동기화 (B8) — `google-calendar-{start,callback,status,disconnect,sync}`
- `GET/PUT /functions/v1/categories` 사용자 정의 카테고리 (iOS와 동기화)
- `workout-logs` 운동 기록 (원래 migration 없이 배포됐던 것을 버전 관리로 rescue)
- `agent-key`(OpenRouter BYOK 키 vault 저장)와 `agent-cloud-chat`(SSE streaming, tool calling, 서버
  측 conflict reflection, hourly rate limit)로 클라우드 Agent 경로 완료 (B10)
- iOS 온디바이스 Agent(Apple FoundationModels)는 이 백엔드를 거치지 않고 기기에서 직접 실행

B9(뉴스 브리핑)는 서버 pgmq 파이프라인 대신 iOS가 RSS를 직접 수집해 온디바이스로 요약하는 방식으로
구현했다. B11(Slack)은 OAuth 앱 설치 대신 사용자가 발급한 Incoming Webhook URL을 iOS Keychain에
저장하는 방식으로 구현했다 — 둘 다 이 저장소에 대응하는 Edge Function이 없다. B12(MCP)와 B13(운영
dashboard·백업 자동화)은 구현하지 않았다. 자세한 배경은 [`docs/roadmap.md`](docs/roadmap.md)를
참고한다.

## 확정된 확장 경계

- 비동기 전달: Supabase Queues(`pgmq`), Kafka/RabbitMQ 제외
- 의미 검색: 같은 PostgreSQL의 pgvector, 외부 vector DB 제외
- Redis: AI·MCP rate limit과 짧은 lock에만 Upstash REST 사용
- ORM: SQL migration이 원본이며 Drizzle은 trusted worker의 실제 복잡 쿼리에만 제한
- MCP: Memdo API를 호출하는 외부 adapter, DB 직접 접근 금지 (아직 구현 안 함)
- LLM: OpenAI Responses/Agents SDK 상시 서버 오케스트레이션 대신, 기기 내 Apple FoundationModels +
  사용자 BYOK OpenRouter(OpenAI 호환 Chat Completions) 조합으로 확정했다. ChatGPT Plus/Claude
  Pro·Max/Google AI Pro 같은 기존 구독 재사용은 채택하지 않는다 — ChatGPT/Gemini 구독은 애초에 API
  접근이 없고, Claude Pro/Max의 구독 OAuth를 서드파티 도구에 쓰는 경로는 Anthropic이 2026-04-04부터
  Consumer ToS 위반으로 집행 중이다.

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

## 개발 종료 상태 (2026-08-17)

Apple·Google·GitHub 로그인, 일정 CRUD·재예약·증분 동기화·오프라인 outbox, 반복 일정, 검색, 하루
리뷰·기간 요약, Google Calendar 읽기 전용 미러, 사용자 정의 카테고리, 운동 기록, BYOK 클라우드
Agent까지 계획한 범위를 모두 구현·배포·검증하고 이 시점에서 개발을 마쳤다. 남은 항목과 원래 설계
대비 실제 구현 차이는 [`docs/roadmap.md`](docs/roadmap.md)를 따른다.
