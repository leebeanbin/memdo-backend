import {
  appleTokenExchangeRequestSchema,
  buildAppleClientSecret,
  decodeAppleIdTokenSub,
} from './apple-auth-contract.ts'

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error('assertion failed')
}

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    segment.length + (4 - (segment.length % 4)) % 4,
    '=',
  )
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)))
}

function pemFromPkcs8(der: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(der)) binary += String.fromCharCode(byte)
  const base64 = btoa(binary)
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

Deno.test('appleTokenExchangeRequestSchema accepts a real authorization code', () => {
  const result = appleTokenExchangeRequestSchema.safeParse({ authorizationCode: 'c1234.abcd' })
  assert(result.success)
})

Deno.test('appleTokenExchangeRequestSchema rejects an empty authorization code', () => {
  const result = appleTokenExchangeRequestSchema.safeParse({ authorizationCode: '' })
  assert(!result.success)
})

Deno.test('appleTokenExchangeRequestSchema rejects a missing authorization code', () => {
  const result = appleTokenExchangeRequestSchema.safeParse({})
  assert(!result.success)
})

Deno.test('buildAppleClientSecret produces a structurally valid, correctly signed ES256 JWT', async () => {
  // Generates a real P-256 key pair for this test only -- exercises the
  // exact same pemToPkcs8 -> importKey -> sign pipeline the real function
  // uses against real Apple credentials, without calling Apple's API (this
  // function does no network I/O itself, unlike exchangeAppleAuthCode/
  // revokeAppleRefreshToken, which are left untested per this repo's
  // established I/O-untested convention).
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)

  const config = {
    teamId: 'TEST_TEAM_ID',
    keyId: 'TEST_KEY_ID',
    clientId: 'com.memdo.ios.test',
    privateKeyPem: pemFromPkcs8(pkcs8),
  }

  const now = new Date('2026-08-25T00:00:00Z')
  const jwt = await buildAppleClientSecret(config, now)
  const segments = jwt.split('.')
  assert(segments.length === 3)

  const header = decodeJsonSegment(segments[0]) as { alg: string; kid: string }
  assert(header.alg === 'ES256')
  assert(header.kid === 'TEST_KEY_ID')

  const payload = decodeJsonSegment(segments[1]) as {
    iss: string
    aud: string
    sub: string
    iat: number
    exp: number
  }
  assert(payload.iss === 'TEST_TEAM_ID')
  assert(payload.aud === 'https://appleid.apple.com')
  assert(payload.sub === 'com.memdo.ios.test')
  assert(payload.iat === Math.floor(now.getTime() / 1000))
  assert(payload.exp === payload.iat + 300)

  const signingInput = `${segments[0]}.${segments[1]}`
  const signatureBytes = new Uint8Array(base64UrlDecode(segments[2]))
  const signatureValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.publicKey,
    signatureBytes,
    new TextEncoder().encode(signingInput),
  )
  assert(signatureValid)
})

function base64UrlEncodeJson(value: unknown): string {
  const binary = new TextEncoder().encode(JSON.stringify(value))
  let str = ''
  for (const byte of binary) str += String.fromCharCode(byte)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fakeIdToken(payload: Record<string, unknown>): string {
  const header = base64UrlEncodeJson({ alg: 'RS256', kid: 'test' })
  const body = base64UrlEncodeJson(payload)
  // decodeAppleIdTokenSub never checks the signature (see its own doc
  // comment on why) -- any third segment round-trips through split('.').
  return `${header}.${body}.fake-signature`
}

Deno.test('decodeAppleIdTokenSub reads the sub claim out of a real-shaped id_token', () => {
  const token = fakeIdToken({
    iss: 'https://appleid.apple.com',
    sub: '001234.abcd5678.5678',
    aud: 'com.memdo.ios',
  })
  assert(decodeAppleIdTokenSub(token) === '001234.abcd5678.5678')
})

Deno.test('decodeAppleIdTokenSub returns null for a malformed token', () => {
  assert(decodeAppleIdTokenSub('not-a-jwt') === null)
  assert(decodeAppleIdTokenSub('only.two') === null)
  assert(decodeAppleIdTokenSub('a.b.c') === null)
})

Deno.test('decodeAppleIdTokenSub returns null when sub is missing or not a string', () => {
  assert(decodeAppleIdTokenSub(fakeIdToken({ aud: 'com.memdo.ios' })) === null)
  assert(decodeAppleIdTokenSub(fakeIdToken({ sub: 12345 })) === null)
})
