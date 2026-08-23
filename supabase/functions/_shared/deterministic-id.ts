/** Deterministic UUID (v4-shaped, but derived from `value` rather than
 * random) for `value` -- SHA-256 hash, truncated to 16 bytes, with the
 * UUID v4 variant/version bits set so it's indistinguishable from a real
 * random UUID to anything reading it later. Was independently reimplemented
 * in rule-contract.ts (as occurrenceId, keyed on ruleId+date so
 * re-materializing the same occurrence is naturally idempotent) and
 * demo-contract.ts (keyed on userId+a fixed per-row key, so re-running the
 * demo seed for the same user is idempotent too) -- same algorithm, same
 * reason for wanting it, just different key shapes. */
export async function stableUuid(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  ).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x40
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`
}
