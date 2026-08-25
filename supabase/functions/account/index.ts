import { apiError, json, logRequest, responseByteLength, withApi } from '../_shared/http.ts'
import { accountDeletionRequestSchema } from '../_shared/account-contract.ts'
import {
  deleteAppleRefreshTokenSecret,
  readAppleRefreshTokenSecret,
  revokeAppleRefreshToken,
} from '../_shared/apple-auth-contract.ts'
import { serviceClient } from '../_shared/google-calendar-contract.ts'

// DELETE /account (Epic L). Implemented synchronously within the request --
// deliberately NOT the 202+AsyncOperation shape docs/05-api-spec.yaml
// originally designed, since that assumes a pgmq-backed async operation
// queue that doesn't exist anywhere in this backend and is out of scope to
// build for this one endpoint. Runtime invariant: an Apple revoke failure
// NEVER blocks the user's own account/data deletion (fail-open, matching
// google-calendar-disconnect's precedent) -- this is proven once via a
// real-Apple-account integration check, not re-asserted per deletion.
export default {
  fetch: withApi<any>(async (request, context, currentRequestId) => {
    const startedAt = performance.now()

    if (request.method !== 'DELETE') {
      return apiError('METHOD_NOT_ALLOWED', '지원하지 않는 요청입니다.', 405, currentRequestId)
    }

    const parsed = accountDeletionRequestSchema.safeParse(
      await request.json().catch(() => undefined),
    )
    if (!parsed.success) {
      return apiError('INVALID_REQUEST', '삭제 확인 문구를 확인해 주세요.', 400, currentRequestId, {
        issues: parsed.error.issues,
      })
    }

    const userId = context.userClaims!.id
    const supabase = serviceClient()

    // Apple revocation, fail-open: never let this block the deletion below.
    // Google/GitHub-only users simply have no row here and skip this
    // entirely -- Supabase's own OAuth token handling for those providers
    // is a separate question, not covered by this Epic.
    const { data: appleTokenRow } = await supabase
      .from('apple_oauth_tokens')
      .select('id,refresh_token_secret_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (appleTokenRow) {
      const secretId = appleTokenRow.refresh_token_secret_id as string
      const refreshToken = await readAppleRefreshTokenSecret(supabase, secretId).catch(
        (error) => {
          console.error(
            JSON.stringify({
              requestId: currentRequestId,
              operation: 'account.delete.apple_revoke_read',
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          return null
        },
      )
      if (refreshToken) await revokeAppleRefreshToken(refreshToken)
      // Row/secret cleanup is best-effort too -- the user row cascades away
      // via auth.admin.deleteUser below regardless of whether this succeeds.
      await deleteAppleRefreshTokenSecret(supabase, secretId).catch(() => undefined)
    }

    // Cascades every application table (todos, preferences, reviews,
    // categories, workout logs, google_calendar_connections, agent_*_log,
    // apple_oauth_tokens, ...) via their `references public.users(id) on
    // delete cascade` FKs, which themselves cascade from `public.users.id
    // references auth.users(id) on delete cascade` -- confirmed against the
    // actual schema, not assumed. No separate per-table deletion code
    // needed.
    const { error: deleteUserError } = await supabase.auth.admin.deleteUser(userId)
    if (deleteUserError) {
      console.error(
        JSON.stringify({
          requestId: currentRequestId,
          operation: 'account.delete',
          error: deleteUserError.message,
        }),
      )
      return apiError('INTERNAL_ERROR', '계정 삭제에 실패했습니다.', 500, currentRequestId)
    }

    const body = { deleted: true }
    logRequest({
      eventName: 'account.delete',
      requestId: currentRequestId,
      routeTemplate: '/account',
      method: request.method,
      status: 200,
      durationMs: performance.now() - startedAt,
      responseBytes: responseByteLength(body),
      returnedRows: 0,
    })
    return json(body, 200, currentRequestId)
  }),
}
