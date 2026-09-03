/**
 * RFC 9457 problem details.
 *
 * One documented error shape for the whole API. A client should never have to parse two
 * formats, and an error body must never carry a stack trace, a dependency URL, or a
 * connection string.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  /** Stable machine-readable codes where the failure has them. */
  readonly reasonCodes?: readonly string[];
  readonly correlationId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

const BASE = 'https://corporate-action-guard.dev/problems';

export const problem = {
  badRequest: (detail: string, errors?: ProblemDetails['errors']): ProblemDetails => ({
    type: `${BASE}/bad-request`,
    title: 'Bad Request',
    status: 400,
    detail,
    ...(errors === undefined ? {} : { errors }),
  }),
  unauthorized: (detail = 'A valid API key is required.'): ProblemDetails => ({
    type: `${BASE}/unauthorized`,
    title: 'Unauthorized',
    status: 401,
    detail,
  }),
  forbidden: (detail: string): ProblemDetails => ({
    type: `${BASE}/forbidden`,
    title: 'Forbidden',
    status: 403,
    detail,
  }),
  notFound: (detail: string): ProblemDetails => ({
    type: `${BASE}/not-found`,
    title: 'Not Found',
    status: 404,
    detail,
  }),
  conflict: (detail: string): ProblemDetails => ({
    type: `${BASE}/conflict`,
    title: 'Conflict',
    status: 409,
    detail,
  }),
  tooManyRequests: (detail: string): ProblemDetails => ({
    type: `${BASE}/rate-limited`,
    title: 'Too Many Requests',
    status: 429,
    detail,
  }),
  internal: (correlationId: string): ProblemDetails => ({
    type: `${BASE}/internal`,
    title: 'Internal Server Error',
    status: 500,
    // Deliberately opaque. The correlation id is how an operator finds the real cause in
    // the logs; the client gets nothing it could use to probe internals.
    detail: 'The request could not be completed. Quote the correlation id when reporting this.',
    correlationId,
  }),
  serviceUnavailable: (detail: string): ProblemDetails => ({
    type: `${BASE}/unavailable`,
    title: 'Service Unavailable',
    status: 503,
    detail,
  }),
} as const;
