import { z } from 'zod'
import {
  apiError,
  normalizeZodIssues,
  POSTGRES_FOREIGN_KEY_VIOLATION,
  POSTGRES_UNIQUE_VIOLATION,
  sha256,
  successResponder,
  withApi,
  withCrudErrors,
} from '../_shared/http.ts'
import { materializeRow, nextOccurrenceAfter, ruleSelect } from '../_shared/rule-contract.ts'
import {
  DEAD_STATUSES,
  decodeTodoCursor,
  encodeTodoCursor,
  fetchCategoriesByIds,
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
import {
  googleMirrorEventsInRange,
  MAX_PAGE_EXTENSION,
  pageSplitsADate,
  virtualOccurrencesInRange,
  virtualRangeForPage,
} from '../_shared/todo-list-contract.ts'

export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const success = successResponder({
      request,
      currentRequestId,
      routeTemplate: '/todos',
      startedAt: performance.now(),
    })

    return await withCrudErrors('todos', currentRequestId, async () => {
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
        const categories = await fetchCategoriesByIds(context.supabase, [
          data.category_id as string | null,
        ])
        return success(
          todoDto(data, categories.get(data.category_id as string) ?? null),
          200,
          'todos.get',
          1,
        )
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
            issues: normalizeZodIssues(parsed.error.issues),
          })
        }

        const cursor = parsed.data.cursor ? decodeTodoCursor(parsed.data.cursor) : null
        if (parsed.data.cursor && !cursor) {
          return apiError('INVALID_REQUEST', '조회 커서를 확인해 주세요.', 400, currentRequestId)
        }

        // bd12: over-fetch by one to detect hasMore (as before), but also
        // extend the effective page size -- re-fetching with a larger
        // limit -- whenever the peeked (limit+1-th) row shares its date
        // with the last row that would otherwise be returned. This
        // guarantees a single calendar date's real todos are never split
        // across two pages, which is what makes the per-page virtual/
        // Google merge below sort-equivalent to a single unbounded fetch:
        // every date's real+virtual+Google items always end up merge-
        // sorted together within the same page's response, using the
        // same (scheduledDate, sortOrder, id) comparator a single big
        // fetch would use. A date with more real todos than
        // MAX_PAGE_EXTENSION (a pathological volume) is the one
        // documented exception -- extension stops and that one page may
        // split that one date.
        let effectiveLimit = parsed.data.limit
        let data: Record<string, unknown>[] = []
        while (true) {
          let query = context.supabase
            .from('todos')
            .select(todoSelect)
            .is('deleted_at', null)
            .order('scheduled_date')
            .order('sort_order')
            .order('id')
            .limit(effectiveLimit + 1)

          if (parsed.data.from) query = query.gte('scheduled_date', parsed.data.from)
          if (parsed.data.to) query = query.lte('scheduled_date', parsed.data.to)
          // Default view excludes dead statuses (matching ScheduleDetail.isActive
          // and the Agent's own DB reads -- founder-dogfooding fix, this used to
          // be the one reader of `todos` that left the filtering to the client,
          // so it disagreed with GET /days and search_schedules for the same
          // day). An explicit ?status= filter is a deliberate ask for exactly
          // those statuses (e.g. a future "rescheduled/cancelled history" view)
          // and overrides the default rather than being ANDed with it.
          if (parsed.data.status?.length) {
            query = query.in('status', parsed.data.status)
          } else {
            query = query.not('status', 'in', `(${DEAD_STATUSES.join(',')})`)
          }
          if (cursor) {
            query = query.or(
              `scheduled_date.gt.${cursor.scheduledDate},and(scheduled_date.eq.${cursor.scheduledDate},sort_order.gt.${cursor.sortOrder}),and(scheduled_date.eq.${cursor.scheduledDate},sort_order.eq.${cursor.sortOrder},id.gt.${cursor.id})`,
            )
          }

          const result = await query
          if (result.error) throw result.error
          data = result.data

          if (!pageSplitsADate(data, effectiveLimit)) break
          const nextLimit = Math.min(effectiveLimit * 2, MAX_PAGE_EXTENSION)
          if (nextLimit === effectiveLimit) break // safety valve -- accept the split
          effectiveLimit = nextLimit
        }

        const hasMore = data.length > effectiveLimit
        const items = data.slice(0, effectiveLimit)

        // event-mode recurring rules materialize nothing up front (see rules POST) --
        // occurrences are computed on demand for whatever range is queried, like
        // Google Calendar/Outlook treat recurring events. Scoped to the date range
        // this specific page covers (not the whole request), and computed on every
        // page now, not just the first -- see clampedTo/virtualFrom/virtualTo below.
        let virtualItems: Record<string, unknown>[] = []
        let googleItems: Record<string, unknown>[] = []
        // Surfaced in appliedFilters below so a truncated response is
        // distinguishable from "the rule genuinely has no more occurrences."
        let clampedTo: string | null = null
        // Carried into nextCursor -- the date through which virtual/Google
        // items have been returned, inclusive. Stays null when virtual
        // computation never applies to this query at all (no date range, or
        // the status filter excludes 'planned').
        let virtualThroughDateForCursor: string | null = null
        // Virtual occurrences are always synthesized as status 'planned' -- if the
        // caller filtered to statuses that exclude it, none of them can match, so
        // don't bother generating (and don't leak unfiltered ones into a filtered
        // response either).
        const statusAllowsVirtual = !parsed.data.status?.length ||
          parsed.data.status.includes('planned')
        if (parsed.data.from && parsed.data.to && statusAllowsVirtual) {
          // Bounding virtualTo by the last real todo's date is only correct
          // when a LATER page is coming to pick up whatever comes after it --
          // on the final page (hasMore false) there is no later page, so
          // trailing dates past the last real todo (with no real todos of
          // their own) must be covered here or they're dropped entirely.
          // Passing null on the last page makes virtualRangeForPage fall
          // through to the full clampedTo, regardless of where the last real
          // todo landed. items.at(-1) is guaranteed fully covered by real
          // todos for its date on a non-last page (the page-extension loop
          // above never splits a date across pages), so it's always safe to
          // treat as the boundary there -- no deferral needed.
          const pageBoundaryDate = hasMore ? (items.at(-1)!.scheduled_date as string) : null
          const range = virtualRangeForPage({
            requestFrom: parsed.data.from,
            requestTo: parsed.data.to,
            cursorVirtualThroughDate: cursor?.virtualThroughDate,
            pageBoundaryDate,
          })
          clampedTo = range.clampedTo
          if (range.shouldFetch) {
            ;[virtualItems, googleItems] = await Promise.all([
              virtualOccurrencesInRange(context.supabase, range.virtualFrom, range.virtualTo),
              googleMirrorEventsInRange(context.supabase, range.virtualFrom, range.virtualTo),
            ])
          }
          // Written even when skipped -- stabilizes at clampedTo, so every later
          // page's virtualFrom also exceeds virtualTo and this skip keeps
          // firing, with no separate "we're done" flag needed.
          virtualThroughDateForCursor = range.virtualTo
        }

        const categories = await fetchCategoriesByIds(
          context.supabase,
          items.map((row: Record<string, unknown>) => row.category_id as string | null),
        )
        const body = {
          items: [
            ...items.map((row: Record<string, unknown>) =>
              todoDto(row, categories.get(row.category_id as string) ?? null)
            ),
            ...virtualItems,
            ...googleItems,
          ].sort((a, b) =>
            String(a.scheduledDate).localeCompare(String(b.scheduledDate)) ||
            Number(a.sortOrder) - Number(b.sortOrder) || String(a.id).localeCompare(String(b.id))
          ),
          nextCursor: hasMore ? encodeTodoCursor(items.at(-1)!, virtualThroughDateForCursor) : null,
          hasMore,
          appliedFilters: clampedTo && clampedTo < parsed.data.to!
            ? { ...parsed.data, recurringOccurrencesThrough: clampedTo }
            : parsed.data,
        }
        return success(
          body,
          200,
          'todos.list',
          items.length + virtualItems.length + googleItems.length,
        )
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
              issues: normalizeZodIssues(parsed.error.issues),
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
          const categories = await fetchCategoriesByIds(context.supabase, [
            original.data.category_id as string | null,
            data.category_id as string | null,
          ])
          return success(
            {
              original: todoDto(
                original.data,
                categories.get(original.data.category_id as string) ?? null,
              ),
              replacement: todoDto(data, categories.get(data.category_id as string) ?? null),
            },
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

        const currentCategories = await fetchCategoriesByIds(context.supabase, [
          current.data.category_id as string | null,
        ])
        return apiError(
          'VERSION_CONFLICT',
          '일정이 다른 곳에서 변경되었거나 재예약할 수 없는 상태입니다.',
          409,
          currentRequestId,
          {
            currentResource: todoDto(
              current.data,
              currentCategories.get(current.data.category_id as string) ?? null,
            ),
          },
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
            issues: normalizeZodIssues(parsed.error.issues),
          })
        }

        const hash = await sha256(parsed.data)
        const { data, error } = await context.supabase
          .from('todos')
          .insert(todoInsert(parsed.data, context.userClaims!.id, idempotencyKey, hash))
          .select(todoSelect)
          .single()

        if (!error) {
          const categories = await fetchCategoriesByIds(context.supabase, [
            data.category_id as string | null,
          ])
          return success(
            todoDto(data, categories.get(data.category_id as string) ?? null),
            201,
            'todos.create',
            1,
          )
        }
        // Three different FKs can fire here (calendarId, scheduleRuleId, or
        // categoryId, bd18) -- this used to always blame the recurrence rule
        // for anything that wasn't calendarId, which was already wrong for
        // calendarId's own synthetic-Google-Calendar-entry path (bd10) and
        // would now misreport a bad categoryId as a bad recurrence rule too.
        // Postgres includes the constraint name in the error message itself,
        // no extra query needed to tell them apart.
        if (error.code === POSTGRES_FOREIGN_KEY_VIOLATION) {
          if (error.message?.includes('todos_calendar_user_fkey')) {
            return apiError(
              'INVALID_REQUEST',
              '연결할 캘린더를 찾을 수 없습니다.',
              400,
              currentRequestId,
            )
          }
          if (error.message?.includes('todos_category_user_fkey')) {
            return apiError(
              'INVALID_REQUEST',
              '연결할 카테고리를 찾을 수 없습니다.',
              400,
              currentRequestId,
            )
          }
          return apiError(
            'INVALID_REQUEST',
            '연결할 반복 규칙을 찾을 수 없습니다.',
            400,
            currentRequestId,
          )
        }
        if (error.code !== POSTGRES_UNIQUE_VIOLATION) throw error

        // todos_pkey (the idempotency-key replay this branch exists for)
        // isn't the only unique constraint on this table --
        // todos_rule_occurrence_uidx (schedule_rule_id, scheduled_date)
        // fires when materializing a virtual occurrence for a date that
        // already has a real row for that rule, which is a genuinely
        // different situation this used to misreport as "same request key
        // used for a different item" (it looks up idempotencyKey as an id,
        // finds nothing, and returns that message regardless) (be8).
        if (error.message?.includes('todos_rule_occurrence_uidx')) {
          return apiError(
            'VERSION_CONFLICT',
            '이미 해당 날짜에 반복 일정이 있어요.',
            409,
            currentRequestId,
          )
        }

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
        const existingCategories = await fetchCategoriesByIds(context.supabase, [
          existing.data.category_id as string | null,
        ])
        return success(
          todoDto(
            existing.data,
            existingCategories.get(existing.data.category_id as string) ?? null,
          ),
          201,
          'todos.create',
          1,
        )
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
              issues: normalizeZodIssues(parsed.error.issues),
            },
          )
        }
        // bd14: todoUpdate needs the row's status as it stood *before* this
        // PATCH to tell a genuine not-completed -> completed transition
        // apart from a PATCH that merely keeps an already-completed item
        // completed (e.g. fixing a typo) -- see todoUpdate's comment. A
        // race between this read and the update below is already handled
        // by the existing optimistic-lock .eq('version', ...) check: if
        // another write lands in between, that check simply fails to match
        // and the request 409s, so a stale `previousStatus` here can never
        // actually get applied.
        const current = await context.supabase
          .from('todos')
          .select('status')
          .eq('id', itemId)
          .maybeSingle()
        if (current.error) throw current.error

        const { data, error } = await context.supabase
          .from('todos')
          .update(todoUpdate(parsed.data, (current.data?.status as string | undefined) ?? null))
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

        // task-mode recurring rules keep exactly one materialized occurrence at a
        // time; completing it advances the series by materializing the next one.
        // Best-effort: the completion itself already succeeded, so a failure here
        // shouldn't turn into an error response for an action the user already got.
        if (data.schedule_rule_id && data.status === 'completed') {
          try {
            // bd21: don't materialize a fresh occurrence for a rule that's
            // been (soft-)deleted since this todo was fetched -- a deleted
            // series shouldn't keep spawning new future rows.
            const rule = await context.supabase
              .from('schedule_rules')
              .select(ruleSelect)
              .eq('id', data.schedule_rule_id as string)
              .is('deleted_at', null)
              .maybeSingle()
            if (rule.error) throw rule.error
            if (rule.data && rule.data.entry_kind === 'task') {
              const next = nextOccurrenceAfter(
                {
                  frequency: rule.data.frequency as string,
                  interval: rule.data.step_interval as number,
                  anchorDate: rule.data.anchor_date as string,
                  untilDate: rule.data.until_date as string | null,
                  count: rule.data.occurrence_count as number | null,
                },
                data.scheduled_date as string,
              )
              if (next) {
                const row = await materializeRow(rule.data, next, context.userClaims!.id)
                // ignoreDuplicates: a plain upsert would overwrite an
                // already-materialized later occurrence's status/completed_at/
                // version with this fresh row's defaults on ON CONFLICT, which
                // can violate todos_completion_check and regress its version.
                // This call should only ever insert a genuinely new row.
                const upserted = await context.supabase
                  .from('todos')
                  .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
                if (upserted.error) throw upserted.error
              }
            }
          } catch (materialiseError) {
            console.error(JSON.stringify({
              requestId: currentRequestId,
              operation: 'todos.materialiseNext',
              error: String(materialiseError),
            }))
          }
        }

        const updateCategories = await fetchCategoriesByIds(context.supabase, [
          data.category_id as string | null,
        ])
        return success(
          todoDto(data, updateCategories.get(data.category_id as string) ?? null),
          200,
          'todos.update',
          1,
        )
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
              issues: normalizeZodIssues(parsed.error.issues),
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
    })
  }),
}
