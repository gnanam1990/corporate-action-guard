/** Typed failures. Every one is a distinct operator response, so none collapses into "error". */
export type XStocksErrorKind =
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_PAYLOAD'
  | 'PAGINATION_LOOP'
  | 'INCOMPLETE_CATALOG'
  | 'RESPONSE_TOO_LARGE'
  | 'NOT_FOUND';

export class XStocksError extends Error {
  override readonly name = 'XStocksError';
  constructor(
    readonly kind: XStocksErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
    /**
     * Whether retrying could plausibly succeed. Decided where the error is CREATED, by the
     * code that knows what went wrong — never inferred later from the error kind, because
     * the same kind can be retryable or not depending on cause. A schema violation and a
     * truncated body are both INVALID_PAYLOAD, but only one is worth retrying.
     */
    readonly retryable: boolean = false,
  ) {
    super(message);
  }
}

/**
 * Redact anything credential-shaped before a URL reaches a log or an evidence payload.
 * The xStocks public API needs no key, but a self-hosted or proxied base URL might carry
 * one, and a source locator is written to the journal.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '[redacted]';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|auth|signature/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString();
  } catch {
    return '[unparseable-url]';
  }
}
