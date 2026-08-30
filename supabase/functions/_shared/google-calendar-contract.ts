import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

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
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
  location?: string
  updated?: string
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
  google_updated_at: string
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
  return {
    connection_id: connectionId,
    user_id: userId,
    google_event_id: event.id,
    title: event.summary?.trim() || '(제목 없음)',
    is_all_day: isAllDay,
    start_at: startAt,
    end_at: endAt,
    location_name: event.location ?? null,
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
