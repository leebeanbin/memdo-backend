import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  appleTokenExchangeRequestSchema,
  exchangeAppleAuthCode,
  storeAppleRefreshTokenSecret,
  updateAppleRefreshTokenSecret,
} from '../_shared/apple-auth-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'

// Called by the iOS client immediately after a successful Sign in with
// Apple, with the authorizationCode captured alongside the identityToken
// already used for Supabase's own signInWithIdToken. The code is single-use
// and ~5 minutes lived, so this must run near sign-in time -- there's no
// later opportunity to exchange it. The resulting refresh_token is what
// account deletion (the `account` function) later revokes via
// /auth/revoke. Google/GitHub sign-ins never call this endpoint.
export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'POST') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const parsed = appleTokenExchangeRequestSchema.safeParse(
      await request.json().catch(() => undefined),
    )
    if (!parsed.success) {
      return apiError('INVALID_REQUEST', '요청을 확인해 주세요.', 400, currentRequestId, {
        issues: parsed.error.issues,
      })
    }

    const userId = context.userClaims!.id
    const supabase = serviceClient()

    let refreshToken: string
    try {
      const tokenResponse = await exchangeAppleAuthCode(parsed.data.authorizationCode)
      if (!tokenResponse.refresh_token) {
        // Apple always returns a refresh_token for a first-time authorization-code
        // exchange -- a response without one means something is misconfigured
        // (wrong client_id/aud), not a case worth silently accepting.
        throw new Error('apple token response had no refresh_token')
      }
      refreshToken = tokenResponse.refresh_token
    } catch (error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'apple_auth.token_exchange',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return apiError('INTERNAL_ERROR', 'Apple 인증 처리에 실패했습니다.', 500, currentRequestId)
    }

    try {
      const { data: existing, error: findError } = await supabase
        .from('apple_oauth_tokens')
        .select('id,refresh_token_secret_id')
        .eq('user_id', userId)
        .maybeSingle()
      if (findError) throw findError

      if (existing) {
        // Idempotent across repeat Apple sign-ins: update in place rather
        // than accumulating stale rows/secrets.
        await updateAppleRefreshTokenSecret(
          supabase,
          existing.refresh_token_secret_id as string,
          refreshToken,
        )
      } else {
        const secretId = await storeAppleRefreshTokenSecret(supabase, userId, refreshToken)
        const inserted = await supabase
          .from('apple_oauth_tokens')
          .insert({ user_id: userId, refresh_token_secret_id: secretId })
        if (inserted.error) throw inserted.error
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'apple_auth.store_token',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return apiError('INTERNAL_ERROR', 'Apple 인증 저장에 실패했습니다.', 500, currentRequestId)
    }

    const body = { linked: true }
    logRequest({
      eventName: 'apple_auth.token_exchange',
      requestId: currentRequestId,
      routeTemplate: '/apple-auth-token-exchange',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: 0,
    })
    return json(body, 200, currentRequestId)
  }),
}
