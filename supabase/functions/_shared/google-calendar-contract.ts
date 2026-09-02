import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
// Two-way sync (push) needs write access -- .readonly can never create/
// update/delete a Google event. Every existing connection was authorized
// under the old readonly-only scope, so this is a breaking change: an
// existing connection's stored refresh token does NOT retroactively gain
// write access just because this constant changed -- the user must
// reconnect (disconnect + connect again) to get a token actually carrying
// this broader scope. google-calendar-push checks for this explicitly
// (see insufficientScope handling) rather than assuming every connection
// row already has write access.
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar'

// Private extended-property keys Memdo stamps on every event it pushes to
// Google, so the pull side can (a) recognize "this is an event I pushed
// myself" and skip re-mirroring it (preventing a push->pull duplicate every
// cycle) and (b) reconstruct entryKind (task vs event) on any future
// re-read without guessing from the all-day/timed shape alone -- a genuine
// external all-day Google event would otherwise be indistinguishable from a
// Memdo task pushed as an all-day event. Private properties are scoped to
// the specific calendarId/eventId and invisible to other apps/attendees:
// https://developers.google.com/workspace/calendar/api/guides/extended-properties
export const MEMDO_TODO_ID_PROPERTY = 'memdoTodoId'
export const MEMDO_KIND_PROPERTY = 'memdoKind'

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
export const MIRROR_SYNC_WINDOW_PAST_DAYS = 60
export const MIRROR_SYNC_WINDOW_FUTURE_DAYS = 366

// be12: google-calendar-status previously returned `last_error` verbatim --
// raw upstream Google API/OAuth response text (see the `throw new Error`
// call sites below and in google-calendar-sync/index.ts) leaked straight to
// the client with no contract on its shape. Classified into a closed enum
// instead; `status` (connections table) already distinguishes 'revoked'
// from 'error' at a coarser level, this narrows the 'error' case only.
export type GoogleCalendarErrorReason =
  | 'auth_expired'
  | 'rate_limited'
  | 'calendar_not_found'
  | 'unknown'

const GOOGLE_ERROR_STATUS_PATTERN = /failed: (\d{3})/

export function classifyGoogleCalendarErrorReason(
  message: string | null,
): GoogleCalendarErrorReason {
  if (!message) return 'unknown'
  if (message.includes('invalid_grant') || message.includes('missing refresh token secret')) {
    return 'auth_expired'
  }
  const status = Number(message.match(GOOGLE_ERROR_STATUS_PATTERN)?.[1])
  if (status === 401) return 'auth_expired'
  if (status === 429) return 'rate_limited'
  if (status === 404) return 'calendar_not_found'
  return 'unknown'
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

export function redirectUri(): string {
  const explicit = Deno.env.get('GOOGLE_CALENDAR_REDIRECT_URI')
  if (explicit) return explicit
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar-callback`
}

export function googleClientId(): string {
  return Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') ?? ''
}

export function googleClientSecret(): string {
  return Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') ?? ''
}

export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
  token_type: string
}

/** Both token-endpoint callers below differed only in the request body and
 * the label in their error message -- same URL, header, and
 * ok-check-then-throw shape otherwise. */
async function requestGoogleToken(
  body: URLSearchParams,
  errorLabel: string,
): Promise<TokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) {
    throw new Error(
      `google token ${errorLabel} failed: ${response.status} ${await response.text()}`,
    )
  }
  return await response.json()
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  return await requestGoogleToken(
    new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
    'exchange',
  )
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return await requestGoogleToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      grant_type: 'refresh_token',
    }),
    'refresh',
  )
}

export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(GOOGLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined)
}

export async function storeRefreshTokenSecret(
  supabase: SupabaseClient,
  userId: string,
  refreshToken: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('vault_create_secret', {
    p_secret: refreshToken,
    p_name: `google_calendar_refresh_token:${userId}:${crypto.randomUUID()}`,
  })
  if (error) throw error
  return data as string
}

export async function readRefreshTokenSecret(
  supabase: SupabaseClient,
  secretId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('vault_read_secret', { p_id: secretId })
  if (error) throw error
  return (data as string | null) ?? null
}

export async function deleteRefreshTokenSecret(
  supabase: SupabaseClient,
  secretId: string,
): Promise<void> {
  const { error } = await supabase.rpc('vault_delete_secret', { p_id: secretId })
  if (error) throw error
}

type GoogleEvent = {
  id: string
  status: string
  summary?: string
  description?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  location?: string
  updated?: string
  extendedProperties?: { private?: Record<string, string> }
}

// True when this event carries Memdo's own extended-property tag -- i.e. an
// event Memdo itself pushed via createGoogleEvent/updateGoogleEvent, not a
// genuine external Google event. The pull side (google-calendar-sync) must
// skip these entirely rather than re-mirroring them: without this check,
// push-then-pull would create a duplicate representation of the same item
// every single sync cycle.
export function isMemdoAuthoredEvent(event: GoogleEvent): boolean {
  return Boolean(event.extendedProperties?.private?.[MEMDO_TODO_ID_PROPERTY])
}

export function memdoTodoIdFromEvent(event: GoogleEvent): string | null {
  return event.extendedProperties?.private?.[MEMDO_TODO_ID_PROPERTY] ?? null
}

// Minimal todos-row shape needed to build a Google event body. Deliberately
// narrower than the full todoSelect row -- only what the mapping actually
// uses.
export type PushableTodo = {
  id: string
  title: string
  entry_kind: string
  is_all_day: boolean
  scheduled_date: string
  start_at: string | null
  end_at: string | null
  note: string | null
  location_name: string | null
}

/** Google's own convention: an all-day event's end.date is EXCLUSIVE -- a
 * single-day all-day event needs end.date set to the day *after*
 * start.date, or the event renders as zero-length.
 * https://developers.google.com/workspace/calendar/api/v3/reference/events */
function exclusiveEndDate(dateISO: string): string {
  const date = new Date(`${dateISO}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

type GoogleEventBody = {
  summary: string
  description?: string
  location?: string
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
  extendedProperties: { private: Record<string, string> }
}

/** Maps a todos row to a Google event body. Tasks (no fixed time) push as
 * an all-day event on their scheduled_date; events push with their real
 * start/end (all-day or timed, matching is_all_day). Every event Memdo
 * pushes is tagged with memdoTodoId/memdoKind so the pull side can
 * recognize it later -- see isMemdoAuthoredEvent above. */
export function toGoogleEventBody(todo: PushableTodo): GoogleEventBody {
  const isTask = todo.entry_kind === 'task'
  const start = isTask || todo.is_all_day || !todo.start_at
    ? { date: todo.scheduled_date }
    : { dateTime: todo.start_at }
  const end = isTask || todo.is_all_day || !todo.end_at
    ? { date: exclusiveEndDate(todo.scheduled_date) }
    : { dateTime: todo.end_at }
  return {
    summary: todo.title,
    description: todo.note ?? undefined,
    location: todo.location_name ?? undefined,
    start,
    end,
    extendedProperties: {
      private: {
        [MEMDO_TODO_ID_PROPERTY]: todo.id,
        [MEMDO_KIND_PROPERTY]: todo.entry_kind,
      },
    },
  }
}

async function googleEventsRequest(
  method: 'POST' | 'PATCH' | 'DELETE',
  accessToken: string,
  calendarId: string,
  path: string,
  body?: GoogleEventBody,
): Promise<{ id: string; updated?: string } | null> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${
    encodeURIComponent(calendarId)
  }/events${path}`
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401 || response.status === 403) {
    const insufficientScope = new Error(
      `google events ${method} failed: ${response.status} ${await response.text()}`,
    )
    ;(insufficientScope as Error & { code: string }).code = 'INSUFFICIENT_SCOPE_OR_AUTH'
    throw insufficientScope
  }
  if (method === 'DELETE') {
    // Google returns 410 for an already-deleted event -- treat as success,
    // the desired end state (no event) already holds.
    if (!response.ok && response.status !== 410 && response.status !== 404) {
      throw new Error(`google events.delete failed: ${response.status} ${await response.text()}`)
    }
    return null
  }
  if (!response.ok) {
    throw new Error(`google events ${method} failed: ${response.status} ${await response.text()}`)
  }
  return await response.json()
}

export async function createGoogleEvent(
  accessToken: string,
  calendarId: string,
  todo: PushableTodo,
): Promise<{ id: string; updated?: string }> {
  const result = await googleEventsRequest(
    'POST',
    accessToken,
    calendarId,
    '',
    toGoogleEventBody(todo),
  )
  if (!result) throw new Error('google events.insert returned no body')
  return result
}

export async function updateGoogleEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
  todo: PushableTodo,
): Promise<{ id: string; updated?: string }> {
  const result = await googleEventsRequest(
    'PATCH',
    accessToken,
    calendarId,
    `/${encodeURIComponent(googleEventId)}`,
    toGoogleEventBody(todo),
  )
  if (!result) throw new Error('google events.patch returned no body')
  return result
}

export async function deleteGoogleEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  await googleEventsRequest(
    'DELETE',
    accessToken,
    calendarId,
    `/${encodeURIComponent(googleEventId)}`,
  )
}

export type MirrorEventRow = {
  connection_id: string
  user_id: string
  google_event_id: string
  title: string
  is_all_day: boolean
  start_at: string
  end_at: string
  location_name: string | null
  note: string | null
  google_updated_at: string
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/** Google Calendar event descriptions are HTML when authored in Calendar's
 * own rich-text editor (bold/links/lists), plain text otherwise -- there's
 * no field telling us which. Converts either into plain text for Memdo's
 * memo field, which doesn't render HTML: block-level tags become newlines,
 * every other tag is dropped (keeping its text content), and the handful of
 * entities Calendar actually emits are decoded. Not a general HTML sanitizer
 * -- scoped to what this one source produces. */
export function plainTextFromGoogleDescription(html: string): string {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  const decoded = withBreaks.replace(
    /&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  )
  return decoded
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function mapGoogleEventToMirrorRow(
  event: GoogleEvent,
  connectionId: string,
  userId: string,
): MirrorEventRow | null {
  if (!event.start || !event.end || !event.updated) return null
  const isAllDay = Boolean(event.start.date)
  const startAt = event.start.dateTime ?? `${event.start.date}T00:00:00Z`
  const endAt = event.end.dateTime ?? `${event.end.date}T00:00:00Z`
  const note = event.description ? plainTextFromGoogleDescription(event.description) : null
  return {
    connection_id: connectionId,
    user_id: userId,
    google_event_id: event.id,
    title: event.summary?.trim() || '(제목 없음)',
    is_all_day: isAllDay,
    start_at: startAt,
    end_at: endAt,
    location_name: event.location ?? null,
    note: note || null,
    google_updated_at: event.updated,
  }
}

export type EventsPage = {
  events: GoogleEvent[]
  nextPageToken?: string
  nextSyncToken?: string
}

export async function fetchEventsPage(
  accessToken: string,
  calendarId: string,
  options: { syncToken?: string; pageToken?: string; timeMin?: string; timeMax?: string },
): Promise<EventsPage> {
  const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' })
  if (options.syncToken) {
    params.set('syncToken', options.syncToken)
  } else {
    if (options.timeMin) params.set('timeMin', options.timeMin)
    if (options.timeMax) params.set('timeMax', options.timeMax)
  }
  if (options.pageToken) params.set('pageToken', options.pageToken)

  const url = `https://www.googleapis.com/calendar/v3/calendars/${
    encodeURIComponent(calendarId)
  }/events?${params.toString()}`
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (response.status === 410) {
    const gone = new Error('sync token expired')
    ;(gone as Error & { code: string }).code = 'SYNC_TOKEN_GONE'
    throw gone
  }
  if (!response.ok) {
    throw new Error(`google events.list failed: ${response.status} ${await response.text()}`)
  }
  const body = await response.json()
  return {
    events: body.items ?? [],
    nextPageToken: body.nextPageToken,
    nextSyncToken: body.nextSyncToken,
  }
}

/** Called from every todos write-commit point (create/update/delete). Always
 * enqueues first (cheap, and the fallback path if the inline attempt below
 * fails), then makes one best-effort, fail-open, synchronous attempt to push
 * immediately -- same "never let a side effect block the primary write"
 * pattern this codebase already uses for Apple token revocation on account
 * deletion. Never throws; the caller's own write already succeeded and must
 * not be undone by a Google-side hiccup. The google-calendar-push cron is
 * the fallback for anything this inline attempt doesn't manage to deliver. */
export type GoogleCalendarSyncConnection = {
  id: string
  user_id: string
  google_calendar_id: string
  refresh_token_secret_id: string
  sync_token: string | null
}

const MAX_PAGES_PER_CONNECTION = 20

/** Pulls one connection's events from Google into the mirror table (and
 * applies last-write-wins updates to any already-materialized todos rows).
 * Shared by google-calendar-sync (the 15-min batch cron, scans every stale
 * connection) and google-calendar-webhook (a real-time push notification
 * for exactly one connection) -- both need the identical sync logic, only
 * how they discover *which* connection to sync differs. */
export async function syncConnection(
  supabase: SupabaseClient,
  connection: GoogleCalendarSyncConnection,
): Promise<void> {
  const refreshToken = await readRefreshTokenSecret(supabase, connection.refresh_token_secret_id)
  if (!refreshToken) throw new Error('missing refresh token secret')

  let tokens
  try {
    tokens = await refreshAccessToken(refreshToken)
  } catch (error) {
    const message = String(error)
    const revoked = message.includes('invalid_grant')
    await supabase.from('google_calendar_connections').update({
      status: revoked ? 'revoked' : 'error',
      last_error: message.slice(0, 500),
    }).eq('id', connection.id)
    return
  }

  let syncToken = connection.sync_token
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  let pages = 0

  const runPage = async () => {
    try {
      return await fetchEventsPage(tokens.access_token, connection.google_calendar_id, {
        syncToken: syncToken ?? undefined,
        pageToken,
        timeMin: syncToken
          ? undefined
          : new Date(Date.now() - MIRROR_SYNC_WINDOW_PAST_DAYS * 86400000).toISOString(),
        timeMax: syncToken
          ? undefined
          : new Date(Date.now() + MIRROR_SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString(),
      })
    } catch (error) {
      if ((error as Error & { code?: string }).code === 'SYNC_TOKEN_GONE') {
        syncToken = null
        pageToken = undefined
        return await fetchEventsPage(tokens.access_token, connection.google_calendar_id, {
          timeMin: new Date(Date.now() - MIRROR_SYNC_WINDOW_PAST_DAYS * 86400000).toISOString(),
          timeMax: new Date(Date.now() + MIRROR_SYNC_WINDOW_FUTURE_DAYS * 86400000).toISOString(),
        })
      }
      throw error
    }
  }

  while (pages < MAX_PAGES_PER_CONNECTION) {
    pages += 1
    const page = await runPage()

    const cancelledIds: string[] = []
    // Events not authored by Memdo itself (a genuine external Google event,
    // or one nobody has ever edited in Memdo) -- candidates for the mirror
    // table, unless already materialized (see below).
    const externalEvents: typeof page.events = []
    for (const event of page.events) {
      if (event.status === 'cancelled') {
        cancelledIds.push(event.id)
        continue
      }
      // Skip events Memdo pushed itself -- re-mirroring these would create a
      // duplicate representation of the same item every sync cycle. This
      // app's own todos row is already the source of truth for them.
      if (isMemdoAuthoredEvent(event)) continue
      externalEvents.push(event)
    }

    // Split externalEvents into "already materialized into a real todos
    // row" (a previously-mirrored event the user has since edited/deleted
    // in Memdo) vs "still only ever a mirror row" -- the two need different
    // targets and a different conflict rule.
    const materializedByEventId = new Map<
      string,
      { id: string; version: number; google_synced_at: string | null }
    >()
    if (externalEvents.length > 0) {
      const { data: materialized, error: materializedError } = await supabase
        .from('todos')
        .select('id,google_event_id,version,google_synced_at')
        .eq('user_id', connection.user_id)
        .in('google_event_id', externalEvents.map((event) => event.id))
        .is('deleted_at', null)
      if (materializedError) throw materializedError
      for (const row of materialized ?? []) {
        materializedByEventId.set(row.google_event_id as string, {
          id: row.id as string,
          version: row.version as number,
          google_synced_at: row.google_synced_at as string | null,
        })
      }
    }

    const toUpsertMirror = []
    for (const event of externalEvents) {
      const materialized = materializedByEventId.get(event.id)
      if (!materialized) {
        const row = mapGoogleEventToMirrorRow(event, connection.id, connection.user_id)
        if (row) toUpsertMirror.push(row)
        continue
      }
      // Last-write-wins, compared at apply time: only overwrite the
      // materialized todos row if Google's own change is newer than the
      // last time this row was synced. A genuinely simultaneous edit on
      // both sides within one sync interval can still silently lose one
      // side's change -- an accepted tradeoff, not a full merge.
      const googleUpdatedAt = event.updated ? new Date(event.updated).getTime() : 0
      const lastSyncedAt = materialized.google_synced_at
        ? new Date(materialized.google_synced_at).getTime()
        : 0
      if (googleUpdatedAt <= lastSyncedAt) continue
      const mirrorRow = mapGoogleEventToMirrorRow(event, connection.id, connection.user_id)
      if (!mirrorRow) continue
      // Bump version too, not just the content -- this is a real change to
      // the row (Google's edit overwriting Memdo's copy), and a client
      // still holding the pre-overwrite version must see a VERSION_CONFLICT
      // on its next PATCH rather than silently clobbering this update, the
      // same guarantee every other write path on this table provides.
      const { error: overwriteError } = await supabase
        .from('todos')
        .update({
          title: mirrorRow.title,
          is_all_day: mirrorRow.is_all_day,
          start_at: mirrorRow.start_at,
          end_at: mirrorRow.end_at,
          scheduled_date: mirrorRow.start_at.slice(0, 10),
          location_name: mirrorRow.location_name,
          note: mirrorRow.note,
          google_synced_at: new Date().toISOString(),
          version: materialized.version + 1,
        })
        .eq('id', materialized.id)
        .eq('version', materialized.version)
      if (overwriteError) throw overwriteError
    }

    if (toUpsertMirror.length > 0) {
      const upserted = await supabase
        .from('google_calendar_mirror_events')
        .upsert(toUpsertMirror, { onConflict: 'connection_id,google_event_id' })
      if (upserted.error) throw upserted.error
    }
    if (cancelledIds.length > 0) {
      const deleted = await supabase
        .from('google_calendar_mirror_events')
        .delete()
        .eq('connection_id', connection.id)
        .in('google_event_id', cancelledIds)
      if (deleted.error) throw deleted.error

      // A cancelled event that had been materialized into a real todos row
      // (the user edited it in Memdo at some point) must be soft-deleted
      // there too, not just pruned from the mirror table.
      const { error: cancelMaterializedError } = await supabase
        .from('todos')
        .update({ deleted_at: new Date().toISOString() })
        .eq('user_id', connection.user_id)
        .in('google_event_id', cancelledIds)
        .is('deleted_at', null)
      if (cancelMaterializedError) throw cancelMaterializedError
    }

    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken
    if (!page.nextPageToken) break
    pageToken = page.nextPageToken
  }

  await supabase.from('google_calendar_connections').update({
    sync_token: nextSyncToken ?? syncToken,
    status: 'active',
    last_error: null,
    last_synced_at: new Date().toISOString(),
  }).eq('id', connection.id)
}

const GOOGLE_CHANNELS_STOP_URL = 'https://www.googleapis.com/calendar/v3/channels/stop'
export const WATCH_CHANNEL_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days, renewed daily well before expiry

export type WatchChannel = {
  channelId: string
  resourceId: string
  expiration: string
  token: string
}

/** Registers a Google Calendar push-notification channel for one calendar.
 * Google POSTs to `address` on every change (no event data in the body --
 * the handler always re-runs syncConnection using the stored sync token,
 * same as the pull cron does). https://developers.google.com/workspace/calendar/api/guides/push */
export async function watchCalendar(
  accessToken: string,
  calendarId: string,
  address: string,
): Promise<WatchChannel> {
  const channelId = crypto.randomUUID()
  const token = crypto.randomUUID()
  const expiration = Date.now() + WATCH_CHANNEL_TTL_MS
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(calendarId)
    }/events/watch`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address,
        token,
        expiration: String(expiration),
      }),
    },
  )
  if (!response.ok) {
    throw new Error(`google events.watch failed: ${response.status} ${await response.text()}`)
  }
  const body = await response.json()
  return {
    channelId,
    resourceId: body.resourceId as string,
    expiration: new Date(Number(body.expiration ?? expiration)).toISOString(),
    token,
  }
}

export async function stopWatchChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  await fetch(GOOGLE_CHANNELS_STOP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: channelId, resourceId }),
    // Best-effort -- an already-expired/unknown channel 404s, which is fine
    // (the desired end state, "this channel is gone," already holds).
  }).catch(() => undefined)
}

export async function queueAndPushGoogleSync(
  supabase: SupabaseClient,
  params: {
    userId: string
    todoId: string
    operation: 'create' | 'update' | 'delete'
    todo?: PushableTodo
    googleEventId?: string | null
  },
): Promise<void> {
  try {
    const { data: connection } = await supabase
      .from('google_calendar_connections')
      .select('id,google_calendar_id,refresh_token_secret_id,status')
      .eq('user_id', params.userId)
      .eq('status', 'active')
      .maybeSingle()
    if (!connection) return

    await supabase.rpc('enqueue_google_push', {
      p_todo_id: params.todoId,
      p_user_id: params.userId,
      p_connection_id: connection.id,
      p_operation: params.operation,
      p_google_event_id: params.googleEventId ?? null,
    })

    const refreshToken = await readRefreshTokenSecret(supabase, connection.refresh_token_secret_id)
    if (!refreshToken) return
    const tokens = await refreshAccessToken(refreshToken)

    if (params.operation === 'create' && params.todo) {
      const result = await createGoogleEvent(
        tokens.access_token,
        connection.google_calendar_id,
        params.todo,
      )
      await supabase.from('todos').update({
        google_event_id: result.id,
        google_synced_at: new Date().toISOString(),
      }).eq('id', params.todoId)
    } else if (params.operation === 'update' && params.todo && params.googleEventId) {
      await updateGoogleEvent(
        tokens.access_token,
        connection.google_calendar_id,
        params.googleEventId,
        params.todo,
      )
      await supabase.from('todos').update({
        google_synced_at: new Date().toISOString(),
      }).eq('id', params.todoId)
    } else if (params.operation === 'delete' && params.googleEventId) {
      await deleteGoogleEvent(
        tokens.access_token,
        connection.google_calendar_id,
        params.googleEventId,
      )
    } else {
      return
    }

    await supabase.from('google_calendar_push_queue').delete().eq('todo_id', params.todoId)
  } catch (error) {
    // Leave it queued (enqueue_google_push already ran above) -- the
    // google-calendar-push cron retries on its own 1-minute tick.
    console.error(
      JSON.stringify({
        operation: 'google_calendar.push.inline',
        todoId: params.todoId,
        error: String(error),
      }),
    )
  }
}
