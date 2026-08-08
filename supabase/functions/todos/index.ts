import { z } from 'zod'
import { apiError, json, logRequest, responseByteLength, sha256, withApi } from '../_shared/http.ts'
import {
  decodeTodoCursor,
  encodeTodoCursor,
  todoDeleteSchema,
  todoDto,
  todoInputSchema,
  todoInsert,
  todoListQuerySchema,
  todoRescheduleSchema,
  todoSelect,
  todoUpdate,
  todoUpdateSchema,
} from '../_shared/todo-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

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
      const path = new URL(request.url).pathname.split('/').filter(Boolean)
      const todosIndex = path.lastIndexOf('todos')
      const itemId = path[todosIndex + 1]
      const action = path[todosIndex + 2]
      const hasItemPath = z.uuid().safeParse(itemId).success

      if (request.method === 'GET' && hasItemPath && !action) {
        const { data, error } = await context.supabase
          .from('todos')
          .select(todoSelect)
          .eq('id', itemId)
          .is('deleted_at', null)
          .maybeSingle()
        if (error) throw error
        if (!data) {
          return apiError('RESOURCE_NOT_FOUND', '일정을 찾을 수 없습니다.', 404, currentRequestId)
        }
        return success(todoDto(data), 200, 'todos.get', 1)
      }

      if (request.method === 'GET' && !hasItemPath) {
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

      if (request.method === 'POST' && hasItemPath && action === 'reschedule') {
        const idempotencyKey = request.headers.get('Idempotency-Key')
        if (!idempotencyKey || !z.uuid().safeParse(idempotencyKey).success) {
          return apiError(
            'INVALID_REQUEST',
            'Idempotency-Key UUID가 필요합니다.',
            400,
            currentRequestId,
          )
        }

        const parsed = todoRescheduleSchema.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) {
          return apiError(
            'INVALID_REQUEST',
            '재예약 시간을 확인해 주세요.',
            400,
            currentRequestId,
            {
              issues: parsed.error.issues,
            },
          )
        }

        const current = await context.supabase
          .from('todos')
          .select(todoSelect)
          .eq('id', itemId)
          .is('deleted_at', null)
          .maybeSingle()
        if (current.error) throw current.error
        if (!current.data) {
          return apiError('RESOURCE_NOT_FOUND', '일정을 찾을 수 없습니다.', 404, currentRequestId)
        }
        if (
          current.data.entry_kind === 'event' &&
          (!parsed.data.startAt || !parsed.data.endAt || parsed.data.dueAt)
        ) {
          return apiError(
            'INVALID_REQUEST',
            '시간 일정의 시작과 종료를 확인해 주세요.',
            400,
            currentRequestId,
          )
        }

        const hash = await sha256(parsed.data)
        const { data, error } = await context.supabase.rpc('reschedule_todo', {
          p_original_id: itemId,
          p_replacement_id: idempotencyKey,
          p_base_version: parsed.data.baseVersion,
          p_request_hash: hash,
          p_entry_kind: current.data.entry_kind,
          p_scheduled_date: parsed.data.targetDate,
          p_start_at: parsed.data.startAt,
          p_end_at: parsed.data.endAt,
          p_due_at: parsed.data.dueAt,
          p_time_bucket: parsed.data.timeBucket,
        }).select(todoSelect).maybeSingle()
        if (error) throw error
        if (data) {
          const original = await context.supabase
            .from('todos')
            .select(todoSelect)
            .eq('id', itemId)
            .single()
          if (original.error) throw original.error
          return success(
            { original: todoDto(original.data), replacement: todoDto(data) },
            201,
            'todos.reschedule',
            2,
          )
        }

        const replacement = await context.supabase
          .from('todos')
          .select('id')
          .eq('id', idempotencyKey)
          .maybeSingle()
        if (replacement.error) throw replacement.error
        if (replacement.data) {
          return apiError(
            'IDEMPOTENCY_CONFLICT',
            '같은 요청 키가 다른 재예약에 사용되었습니다.',
            409,
            currentRequestId,
          )
        }

        return apiError(
          'VERSION_CONFLICT',
          '일정이 다른 곳에서 변경되었거나 재예약할 수 없는 상태입니다.',
          409,
          currentRequestId,
          { currentResource: todoDto(current.data) },
        )
      }

      if (request.method === 'POST' && !hasItemPath) {
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

      if (request.method === 'PATCH' && hasItemPath && !action) {
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

      if (request.method === 'DELETE' && hasItemPath && !action) {
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
