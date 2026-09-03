import { createHash } from 'node:crypto';

/**
 * Canonical JSON encoding for payload hashing.
 *
 * Two processes that observed the same fact must produce the same hash, or idempotency
 * silently stops working and the journal fills with duplicates of the same observation.
 * `JSON.stringify` preserves insertion order, so `{a,b}` and `{b,a}` would hash
 * differently despite being the same value. This sorts object keys at every depth.
 *
 * Array order is preserved — in an array, order is part of the value.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('cannot canonicalize a non-finite number');
      }
      return JSON.stringify(value);
    case 'bigint':
      // bigint has no JSON representation; encode as a decimal string so exact integer
      // values survive a round trip that a double would corrupt.
      return JSON.stringify(value.toString());
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError('cannot canonicalize undefined; omit the key instead');
    case 'function':
    case 'symbol':
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // An absent key and a key set to undefined are the same fact.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/** SHA-256 over the canonical encoding. Stable across JSON key order. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}
