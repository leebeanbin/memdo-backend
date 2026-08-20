import { z } from 'zod'
import { dayViewDto } from '../_shared/day-contract.ts'
import { apiError, successResponder, withApi, withCrudErrors } from '../_shared/http.ts'
import { todoDto, todoSelect } from '../_shared/todo-contract.ts'

const dateSchema = z.iso.date()

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/days/{date}',
      startedAt,
    })

    return await withCrudErrors('days.get', currentRequestId, async () => {
      if (request.method !== 'GET') {
        return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
      }

      const date = new URL(request.url).pathname.split('/').filter(Boolean).at(-1)
      const parsedDate = dateSchema.safeParse(date)
      if (!parsedDate.success) {
        return apiError(
          'INVALID_REQUEST',
          '날짜를 YYYY-MM-DD 형식으로 입력해 주세요.',
          400,
          currentRequestId,
        )
      }

      const { data, error } = await context.supabase
        .from('todos')
        .select(todoSelect)
        .eq('scheduled_date', parsedDate.data)
        .is('deleted_at', null)
        .order('start_at', { ascending: true, nullsFirst: false })
        .order('sort_order')
        .order('id')
      if (error) throw error

      const body = dayViewDto(parsedDate.data, data.map(todoDto))
      return success(body, 200, 'days.get', data.length)
    })
  }),
}
