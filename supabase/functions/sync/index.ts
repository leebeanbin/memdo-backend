import {
  apiError,
  json,
  logRequest,
  normalizeZodIssues,
  responseByteLength,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'
import {
  decodeSyncCursor,
  encodeSyncCursor,
  syncItem,
  syncQuerySchema,
} from '../_shared/sync-contract.ts'
import { fetchCategoriesByIds, todoSelect } from '../_shared/todo-contract.ts'

type SyncRow = Record<string, unknown>

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    const userId = context.userClaims!.id

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

      // sync_seq (20260829083831_todos_sync_seq.sql, generalized to a
      // shared sequence in 20260831070000) is one monotonic counter across
      // every synced entity type, assigned by nextval() in true commit
      // order -- no (updated_at, id) tie-breaker needed, and no window for
      // a concurrently-committing row to end up permanently behind a
      // cursor already handed out (founder-dogfooding fix). One sequence,
      // but not one table: each entity's own table is queried
      // independently (its own top limit+1 by sync_seq) and the results
      // are merge-sorted -- fetching limit+1 from every table is always
      // sufficient to compute the correct combined top-limit page,
      // because any row within the true combined top-(limit+1) must also
      // be within its own table's top-(limit+1) (otherwise limit+1
      // same-table rows already precede it, which alone would push it
      // past the combined top-(limit+1) too).
      let todoQuery = context.supabase
        .from('todos')
        .select(todoSelect)
        .order('sync_seq')
        .limit(parsed.data.limit + 1)
      if (cursor) todoQuery = todoQuery.gt('sync_seq', cursor.syncSeq)

      // workout_log_full has anon/authenticated revoked entirely
      // (20260829080903_workout_log_full_security_invoker.sql) --
      // context.supabase (the authenticated-role, RLS-bound client) cannot
      // read it at all. Goes through the service-role client with an
      // explicit .eq('user_id', ...) filter instead, matching
      // workout-logs/index.ts's own established pattern for this table.
      let workoutQuery = serviceClient()
        .from('workout_log_full')
        .select('*')
        .eq('user_id', userId)
        .order('sync_seq')
        .limit(parsed.data.limit + 1)
      if (cursor) workoutQuery = workoutQuery.gt('sync_seq', cursor.syncSeq)

      // user_categories keeps its normal grants (unlike workout_log_full),
      // so context.supabase + RLS is enough here -- RLS doesn't filter
      // deleted_at, only ownership, so a soft-deleted row (needed for the
      // tombstone) is still readable through it.
      let categoryQuery = context.supabase
        .from('user_categories')
        .select('*')
        .order('sync_seq')
        .limit(parsed.data.limit + 1)
      if (cursor) categoryQuery = categoryQuery.gt('sync_seq', cursor.syncSeq)

      const [todoResult, workoutResult, categoryResult] = await Promise.all([
        todoQuery,
        workoutQuery,
        categoryQuery,
      ])
      if (todoResult.error) throw todoResult.error
      if (workoutResult.error) throw workoutResult.error
      if (categoryResult.error) throw categoryResult.error

      const todoRows = todoResult.data as SyncRow[]
      const categories = await fetchCategoriesByIds(
        context.supabase,
        todoRows.map((row) => row.category_id as string | null),
      )

      const merged = [
        ...todoRows.map((row) => ({ row, entity: 'todo' as const })),
        ...(workoutResult.data as SyncRow[]).map((row) => ({ row, entity: 'workout' as const })),
        ...(categoryResult.data as SyncRow[]).map((row) => ({ row, entity: 'category' as const })),
      ].sort((a, b) => Number(a.row.sync_seq) - Number(b.row.sync_seq))

      const hasMore = merged.length > parsed.data.limit
      const page = merged.slice(0, parsed.data.limit)
      const body = {
        items: page.map(({ row, entity }) =>
          syncItem(
            row,
            entity,
            entity === 'todo' ? categories.get(row.category_id as string) ?? null : null,
          )
        ),
        nextCursor: page.length ? encodeSyncCursor(page.at(-1)!.row) : parsed.data.cursor ?? null,
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
        returnedRows: page.length,
      })
      return json(body, 200, currentRequestId)
    })
  }),
}
