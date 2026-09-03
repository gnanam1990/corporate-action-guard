/**
 * Central redaction.
 *
 * Applied to every structured log and every error body. Secrets leak through logs far more
 * often than through code, and the leak is usually a field nobody thought about — so this
 * matches on key NAME patterns rather than on an allowlist of known-bad values.
 */

// `[-_]?` on every compound word, not just some: a header arrives as `api-key` far more
// often than `api_key`, and a pattern that catches only the snake_case form is a hole
// exactly where headers are logged.
const SECRET_KEY_PATTERN =
  /(?:^|[._-])(?:private[-_]?key|secret|password|passwd|token|api[-_]?key|auth(?:orization)?|cookie|session|mnemonic|seed[-_]?phrase|signature|credential)s?(?:$|[._-])/i;

export const REDACTED = '[redacted]';

/** Value shapes that are secret regardless of the key they arrived under. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^0x[0-9a-fA-F]{64}$/, // a 32-byte hex value — a private key or a raw signature component
  /^Bearer\s+\S{16,}$/i,
  /^(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{8,}$/,
];

/** Strip credentials from a URL. RPC URLs frequently embed an API key in userinfo or path. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = REDACTED;
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY_PATTERN.test(key) || /key|token/i.test(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    // Many RPC providers put the key in the path: https://host/v2/<key>
    const segments = url.pathname.split('/');
    url.pathname = segments
      .map((seg) => (/^[A-Za-z0-9_-]{24,}$/.test(seg) ? REDACTED : seg))
      .join('/');
    return url.toString();
  } catch {
    return '[unparseable-url]';
  }
}

/** Recursively redact a value for logging. Never mutates the input. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (SECRET_VALUE_PATTERNS.some((re) => re.test(value))) return REDACTED;
    if (/^https?:\/\//.test(value)) return redactUrl(value);
    // Bound unbounded payloads; a 2 MB response body in a log line helps nobody.
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const capped = value.slice(0, 100).map((v) => redact(v, depth + 1));
    return value.length > 100 ? [...capped, `…${value.length - 100} more`] : capped;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
