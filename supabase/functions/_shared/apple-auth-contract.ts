import { z } from 'zod'
import { type SupabaseClient } from '@supabase/supabase-js'

export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token'
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke'

export const appleTokenExchangeRequestSchema = z.object({
  authorizationCode: z.string().trim().min(1).max(4000),
})

export function appleTeamId(): string {
  return Deno.env.get('APPLE_TEAM_ID') ?? ''
}
export function appleSignInKeyId(): string {
  return Deno.env.get('APPLE_SIGNIN_KEY_ID') ?? ''
}
export function appleSignInClientId(): string {
  return Deno.env.get('APPLE_SIGNIN_CLIENT_ID') ?? ''
}
function appleSignInPrivateKeyPem(): string {
  return Deno.env.get('APPLE_SIGNIN_PRIVATE_KEY') ?? ''
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

/** Parses a PEM-encoded PKCS8 private key (the .p8 file's contents, as
 * pasted into an env var -- either with literal newlines or escaped `\n`)
 * into the raw DER bytes crypto.subtle.importKey expects. */
function pemToPkcs8(pem: string): ArrayBuffer {
  const normalized = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export type AppleSignInConfig = {
  teamId: string
  keyId: string
  clientId: string
  privateKeyPem: string
}

function appleSignInConfigFromEnv(): AppleSignInConfig {
  return {
    teamId: appleTeamId(),
    keyId: appleSignInKeyId(),
    clientId: appleSignInClientId(),
    privateKeyPem: appleSignInPrivateKeyPem(),
  }
}

/** Builds Apple's client_secret: a short-lived ES256 JWT signed with the
 * Sign in with Apple private key. Generated fresh per call (5-minute
 * expiry) rather than cached/rotated -- this endpoint is called rarely
 * (once per Apple sign-in, once per account deletion for an Apple-signed-in
 * user), so there's no reuse benefit worth the complexity of caching a
 * short-lived secret. Uses Web Crypto directly (no jose/jsonwebtoken
 * dependency) -- ECDSA P-256 signatures from crypto.subtle.sign are already
 * in the raw r||s format JWS ES256 requires, no re-encoding needed.
 *
 * Takes `config` as a parameter rather than reading Deno.env internally --
 * mirrors resolveRateLimitPerHour's env-as-injected-parameter shape
 * (agent-cloud-contract.ts) so this stays unit-testable without granting
 * the test runner --allow-env. Real callers pass
 * appleSignInConfigFromEnv() (called at the actual I/O boundary, below). */
export async function buildAppleClientSecret(
  config: AppleSignInConfig,
  now: Date = new Date(),
): Promise<string> {
  const header = { alg: 'ES256', kid: config.keyId }
  const iat = Math.floor(now.getTime() / 1000)
  const payload = {
    iss: config.teamId,
    iat,
    exp: iat + 300,
    aud: 'https://appleid.apple.com',
    sub: config.clientId,
  }
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(config.privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

type AppleTokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

/** Exchanges a Sign in with Apple authorization code for tokens.
 * grant_type=authorization_code is /auth/token's parameter for this step --
 * distinct from /auth/revoke below, which takes token/token_type_hint and
 * no grant_type at all. */
export async function exchangeAppleAuthCode(
  authorizationCode: string,
): Promise<AppleTokenResponse> {
  const config = appleSignInConfigFromEnv()
  const clientSecret = await buildAppleClientSecret(config)
  const response = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: authorizationCode,
      client_id: config.clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
    }),
  })
  if (!response.ok) {
    throw new Error(`apple token exchange failed: ${response.status} ${await response.text()}`)
  }
  return await response.json()
}

/** Revokes a stored Apple refresh token. Fail-open by design (mirrors
 * revokeGoogleToken in google-calendar-contract.ts): never throws, so a
 * caller doing account deletion never has to choose between "block
 * deletion" and "ignore the failure" -- this function has already decided
 * for them. Apple's /auth/revoke takes token/token_type_hint, NOT
 * grant_type=refresh_token (that parameter belongs to /auth/token's
 * refresh-token grant, a different call this codebase doesn't need). */
export async function revokeAppleRefreshToken(refreshToken: string): Promise<void> {
  try {
    const config = appleSignInConfigFromEnv()
    const clientSecret = await buildAppleClientSecret(config)
    await fetch(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    })
  } catch {
    // Fail-open: logged by the caller if it wants to, never re-thrown here.
  }
}

export async function storeAppleRefreshTokenSecret(
  supabase: SupabaseClient,
  userId: string,
  refreshToken: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('vault_create_secret', {
    p_secret: refreshToken,
    p_name: `apple_refresh_token:${userId}:${crypto.randomUUID()}`,
  })
  if (error) throw error
  return data as string
}

export async function updateAppleRefreshTokenSecret(
  supabase: SupabaseClient,
  secretId: string,
  refreshToken: string,
): Promise<void> {
  const { error } = await supabase.rpc('vault_update_secret', {
    p_id: secretId,
    p_secret: refreshToken,
  })
  if (error) throw error
}

export async function readAppleRefreshTokenSecret(
  supabase: SupabaseClient,
  secretId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('vault_read_secret', { p_id: secretId })
  if (error) throw error
  return (data as string | null) ?? null
}

export async function deleteAppleRefreshTokenSecret(
  supabase: SupabaseClient,
  secretId: string,
): Promise<void> {
  const { error } = await supabase.rpc('vault_delete_secret', { p_id: secretId })
  if (error) throw error
}
