import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import {
  appleTokenExchangeRequestSchema,
  decodeAppleIdTokenSub,
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
    let appleSub: string | null = null
    try {
      const tokenResponse = await exchangeAppleAuthCode(parsed.data.authorizationCode)
      if (!tokenResponse.refresh_token) {
        // Apple always returns a refresh_token for a first-time authorization-code
        // exchange -- a response without one means something is misconfigured
        // (wrong client_id/aud), not a case worth silently accepting.
        throw new Error('apple token response had no refresh_token')
      }
      refreshToken = tokenResponse.refresh_token
      appleSub = tokenResponse.id_token ? decodeAppleIdTokenSub(tokenResponse.id_token) : null
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

    // The endpoint accepted any authorizationCode from any authenticated
    // caller and stored the resulting refresh token under *their* userId --
    // nothing checked that the Apple identity in the token response
    // actually matches the caller's own. An authorization code minted for
    // the same client_id but a different Apple account would bind that
    // account's refresh token (and later, revoke privileges via account
    // deletion) to the caller. Found via founder-dogfooding code review
    // (be5). Compares against auth.identities' own record of which Apple
    // account this Supabase user actually signed in with -- not something
    // this request's payload can influence.
    if (!appleSub) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'apple_auth.id_token_missing',
        }),
      )
      return apiError('INTERNAL_ERROR', 'Apple 인증 처리에 실패했습니다.', 500, currentRequestId)
    }
    const { data: userData, error: userLookupError } = await supabase.auth.admin.getUserById(userId)
    const expectedSub = userData?.user?.identities?.find((i) => i.provider === 'apple')
      ?.identity_data?.sub as string | undefined
    if (userLookupError || !expectedSub || expectedSub !== appleSub) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'apple_auth.identity_mismatch',
          error: userLookupError,
        }),
      )
      return apiError(
        'INVALID_REQUEST',
        'Apple 계정 정보가 일치하지 않아요.',
        400,
        currentRequestId,
      )
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
