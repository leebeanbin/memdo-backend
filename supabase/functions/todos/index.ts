import { withSupabase } from '@supabase/server'
import { z } from 'zod'
import { apiError, json, requestId, sha256 } from '../_shared/http.ts'
import {
  decodeTodoCursor,
  encodeTodoCursor,
  todoDto,
  todoInputSchema,
  todoInsert,
  todoListQuerySchema,
} from '../_shared/todo-contract.ts'

export default {
  fetch: withSupabase<any>({ auth: 'user' }, async (request, context) => {
    const currentRequestId = requestId(request)

    try {
      if (request.method === 'GET') {
        const url = new URL(request.url)
        const parsed = todoListQuerySchema.safeParse({
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          status: url.searchParams.getAll('status'),
          limit: Number(url.searchParams.get('limit') ?? 20),
          cursor: url.searchParams.get('cursor') ?? undefined,
        })
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '조회 조건을 확인해 주세요.', 400, currentRequestId, {
            issues: parsed.error.issues,
          })
        }

        const cursor = parsed.data.cursor ? decodeTodoCursor(parsed.data.cursor) : null
        if (parsed.data.cursor && !cursor) {
          return apiError('INVALID_REQUEST', '조회 커서를 확인해 주세요.', 400, currentRequestId)
        }

        let query = context.supabase
          .from('todos')
          .select('*')
          .is('deleted_at', null)
          .order('scheduled_date')
          .order('sort_order')
          .order('id')
          .limit(parsed.data.limit + 1)

        if (parsed.data.from) query = query.gte('scheduled_date', parsed.data.from)
        if (parsed.data.to) query = query.lte('scheduled_date', parsed.data.to)
        if (parsed.data.status?.length) query = query.in('status', parsed.data.status)
        if (cursor) {
          query = query.or(
            `scheduled_date.gt.${cursor.scheduledDate},and(scheduled_date.eq.${cursor.scheduledDate},sort_order.gt.${cursor.sortOrder}),and(scheduled_date.eq.${cursor.scheduledDate},sort_order.eq.${cursor.sortOrder},id.gt.${cursor.id})`,
          )
        }

        const { data, error } = await query
        if (error) throw error

        const hasMore = data.length > parsed.data.limit
        const items = data.slice(0, parsed.data.limit)
        return json(
          {
            items: items.map(todoDto),
            nextCursor: hasMore ? encodeTodoCursor(items.at(-1)!) : null,
            hasMore,
            appliedFilters: parsed.data,
          },
          200,
          currentRequestId,
        )
      }

      if (request.method === 'POST') {
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey || !z.uuid().safeParse(idempotencyKey).success) {
          return apiError(
            'INVALID_REQUEST',
            'Idempotency-Key UUID가 필요합니다.',
            400,
            currentRequestId,
          )
        }

        const body = await request.json().catch(() => undefined)
        const parsed = todoInputSchema.safeParse(body)
        if (!parsed.success) {
          return apiError('INVALID_REQUEST', '일정 입력을 확인해 주세요.', 400, currentRequestId, {
            issues: parsed.error.issues,
          })
        }

        const hash = await sha256(parsed.data)
        const { data, error } = await context.supabase
          .from('todos')
          .insert(todoInsert(parsed.data, context.userClaims!.id, idempotencyKey, hash))
          .select('*')
          .single()

        if (!error) return json(todoDto(data), 201, currentRequestId)
        if (error.code !== '23505') throw error

        const existing = await context.supabase
          .from('todos')
          .select('*')
          .eq('id', idempotencyKey)
          .maybeSingle()
        if (existing.error) throw existing.error
        if (!existing.data || existing.data.creation_request_hash !== hash) {
          return apiError(
            'IDEMPOTENCY_CONFLICT',
            '같은 요청 키가 다른 일정에 사용되었습니다.',
            409,
            currentRequestId,
          )
        }
        return json(todoDto(existing.data), 201, currentRequestId)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    } catch (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'todos', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
  }),
}
