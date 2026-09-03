import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * API-key authentication.
 *
 * Keys are stored only as `sha256` hashes, looked up by a short public prefix, and compared
 * in constant time. A raw key is never stored and never logged — the only place it exists
 * in plaintext is the integrator's own configuration.
 */

export const SCOPES = [
  'public:read',
  'integrator:preflight',
  'operator:review',
  'admin:reconcile',
] as const;
export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRecord {
  /** Public, non-secret lookup id. Safe to log. */
  readonly keyId: string;
  readonly principal: string;
  readonly hash: string;
  readonly scopes: readonly Scope[];
  readonly revoked: boolean;
}

/** Format: `cag_<keyId>_<secret>`. The id is public; only the secret half is sensitive. */
const KEY_FORMAT = /^cag_([A-Za-z0-9]{8})_([A-Za-z0-9]{32,})$/;

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Compare in constant time.
 *
 * A plain `===` on a secret leaks its prefix through timing. Lengths are compared first
 * because `timingSafeEqual` throws on a length mismatch — but both sides here are
 * fixed-length hex digests, so that branch carries no secret information.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type AuthResult =
  | {
      readonly ok: true;
      readonly principal: string;
      readonly keyId: string;
      readonly scopes: readonly Scope[];
    }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'UNKNOWN_KEY' | 'REVOKED' | 'MISSING' };

export function authenticate(
  rawKey: string | undefined,
  lookup: (keyId: string) => ApiKeyRecord | undefined,
): AuthResult {
  if (rawKey === undefined || rawKey === '') return { ok: false, reason: 'MISSING' };

  const match = KEY_FORMAT.exec(rawKey);
  if (match === null) return { ok: false, reason: 'MALFORMED' };

  const keyId = match[1]!;
  const record = lookup(keyId);

  if (record === undefined) {
    // Still do the hash work, so a missing key and a wrong key take comparable time.
    constantTimeEquals(hashApiKey(rawKey), '0'.repeat(64));
    return { ok: false, reason: 'UNKNOWN_KEY' };
  }

  if (!constantTimeEquals(hashApiKey(rawKey), record.hash)) {
    return { ok: false, reason: 'UNKNOWN_KEY' };
  }

  // Revocation is checked AFTER the hash comparison, so a revoked key and an unknown key
  // are indistinguishable in timing to someone probing for valid key ids.
  if (record.revoked) return { ok: false, reason: 'REVOKED' };

  return { ok: true, principal: record.principal, keyId: record.keyId, scopes: record.scopes };
}

export function hasScope(scopes: readonly Scope[], required: Scope): boolean {
  return scopes.includes(required);
}
