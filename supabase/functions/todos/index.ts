import { withSupabase } from '@supabase/server'
import { z } from 'zod'
import {
  apiError,
  json,
  logRequest,
  requestId,
  responseByteLength,
  sha256,
} from '../_shared/http.ts'
import {
  decodeTodoCursor,
  encodeTodoCursor,
  todoDeleteSchema,
  todoDto,
  todoInputSchema,
  todoInsert,
  todoListQuerySchema,
  todoSelect,
  todoUpdate,
  todoUpdateSchema,
} from '../_shared/todo-contract.ts'

export default {
  fetch: withSupabase<any>({ auth: 'user' }, async (request, context) => {
    const startedAt = performance.now()
    const currentRequestId = requestId(request)

    const success = (body: unknown, status: number, eventName: string, returnedRows: number) => {
      logRequest({
        eventName,
        requestId: currentRequestId,
        routeTemplate: '/todos',
        method: request.method,
        status,
        durationMs: performance.now() - startedAt,
        responseBytes: responseByteLength(body),
        returnedRows,
      })
      return json(body, status, currentRequestId)
    }

    try {
      const itemId = new URL(request.url).pathname.split('/').filter(Boolean).at(-1)
      const hasItemPath = itemId !== 'todos' && z.uuid().safeParse(itemId).success

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
          .select(todoSelect)
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
        const body = {
          items: items.map(todoDto),
          nextCursor: hasMore ? encodeTodoCursor(items.at(-1)!) : null,
          hasMore,
          appliedFilters: parsed.data,
        }
        return success(body, 200, 'todos.list', items.length)
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
          .select(todoSelect)
          .single()

        if (!error) return success(todoDto(data), 201, 'todos.create', 1)
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
        return success(todoDto(existing.data), 201, 'todos.create', 1)
      }

      if (request.method === 'PATCH' && hasItemPath) {
        const parsed = todoUpdateSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '수정할 일정을 확인해 주세요.',
            400,
            currentRequestId,
            {
              issues: parsed.error.issues,
            },
          )
        }
        const { data, error } = await context.supabase
          .from('todos')
          .update(todoUpdate(parsed.data))
          .eq('id', itemId)
          .eq('version', parsed.data.version)
          .is('deleted_at', null)
          .select(todoSelect)
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return apiError(
            'VERSION_CONFLICT',
            '일정이 다른 곳에서 변경되었습니다.',
            409,
            currentRequestId,
          )
        }
        return success(todoDto(data), 200, 'todos.update', 1)
      }

      if (request.method === 'DELETE' && hasItemPath) {
        const parsed = todoDeleteSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '삭제할 일정을 확인해 주세요.',
            400,
            currentRequestId,
            {
              issues: parsed.error.issues,
            },
          )
        }
        const { data, error } = await context.supabase
          .from('todos')
          .update({ deleted_at: new Date().toISOString(), version: parsed.data.version + 1 })
          .eq('id', itemId)
          .eq('version', parsed.data.version)
          .is('deleted_at', null)
          .select('id')
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return apiError(
            'VERSION_CONFLICT',
            '일정이 다른 곳에서 변경되었습니다.',
            409,
            currentRequestId,
          )
        }
        return success({ id: data.id }, 200, 'todos.delete', 1)
      }

      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    } catch (error) {
      console.error(JSON.stringify({ requestId: currentRequestId, operation: 'todos', error }))
      return apiError('INTERNAL_ERROR', '잠시 후 다시 시도해 주세요.', 500, currentRequestId)
    }
  }),
}
