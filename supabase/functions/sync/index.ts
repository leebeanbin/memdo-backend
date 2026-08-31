import {
  apiError,
  json,
  logRequest,
  normalizeZodIssues,
  responseByteLength,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import {
  decodeSyncCursor,
  encodeSyncCursor,
  syncItem,
  syncQuerySchema,
} from '../_shared/sync-contract.ts'
import { todoSelect } from '../_shared/todo-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    return await withCrudErrors('sync.pull', currentRequestId, async () => {
      if (request.method !== 'GET') {
        return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
      }

      const url = new URL(request.url)
      const parsed = syncQuerySchema.safeParse({
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 200),
      })
      if (!parsed.success) {
        return apiError('INVALID_REQUEST', '동기화 조건을 확인해 주세요.', 400, currentRequestId, {
          issues: normalizeZodIssues(parsed.error.issues),
        })
      }

      const cursor = parsed.data.cursor ? decodeSyncCursor(parsed.data.cursor) : null
      if (parsed.data.cursor && !cursor) {
        return apiError('INVALID_REQUEST', '동기화 커서를 확인해 주세요.', 400, currentRequestId)
      }

      // sync_seq (20260829083831_todos_sync_seq.sql) is a single monotonic
      // column assigned by nextval() in true commit order -- no
      // (updated_at, id) tie-breaker needed, and no window for a
      // concurrently-committing row to end up permanently behind a cursor
      // already handed out (founder-dogfooding fix).
      let query = context.supabase
        .from('todos')
        .select(todoSelect)
        .order('sync_seq')
        .limit(parsed.data.limit + 1)
      if (cursor) {
        query = query.gt('sync_seq', cursor.syncSeq)
      }

      const { data, error } = await query
      if (error) throw error

      const hasMore = data.length > parsed.data.limit
      const rows = data.slice(0, parsed.data.limit)
      const body = {
        items: rows.map(syncItem),
        nextCursor: rows.length ? encodeSyncCursor(rows.at(-1)!) : parsed.data.cursor ?? null,
        hasMore,
      }
      logRequest({
        eventName: 'sync.pull',
        requestId: currentRequestId,
        routeTemplate: '/sync',
        method: request.method,
        status: 200,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows: rows.length,
      })
      return json(body, 200, currentRequestId)
    })
  }),
}
