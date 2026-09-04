/**
 * Typed client for the Corporate Action Guard API.
 *
 * Shapes mirror `apps/api/openapi/openapi.json`. The console holds no server package
 * dependency — it speaks HTTP only, which is what keeps a server secret structurally
 * unable to reach the browser.
 *
 * Every call returns a discriminated result rather than throwing. A page that cannot reach
 * the API must render a truthful unavailable state, and an exception thrown into a server
 * component produces a generic error page that says nothing useful to an operator.
 */

export interface Asset {
  readonly assetId: string;
  readonly symbol: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly wrapperAddress: string | null;
  readonly wrapperIsCurrent: boolean | null;
  readonly multiplier: { readonly value: string; readonly decimals: number } | null;
  readonly multiplierNonce: string | null;
  readonly scheduledActivation: string | null;
  readonly lifecycleState: LifecycleState;
  readonly canonicality: 'PASS' | 'FAIL' | 'UNKNOWN';
  readonly apiObservedAt: string | null;
  readonly chainObservedAt: string | null;
  readonly chainBlockNumber: string | null;
  readonly chainBlockHash: string | null;
}

export type LifecycleState =
  | 'NORMAL'
  | 'PENDING'
  | 'GUARD_WINDOW'
  | 'APPLIED'
  | 'RECONCILED'
  | 'MISMATCH'
  | 'MANUAL_REVIEW'
  | 'RECOVERED';

export interface AssetPage {
  readonly items: readonly Asset[];
  readonly nextCursor: string | null;
  readonly servedAt: string;
}

export interface Coverage {
  readonly discovered: number;
  readonly canonicallyVerified: number;
  readonly pendingOrGuardWindow: number;
  readonly mismatchedOrReview: number;
  readonly servedAt: string;
}

export interface SourceHealthEntry {
  readonly sourceKind: string;
  readonly healthy: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly detail: string;
}

export interface SourceHealthResponse {
  readonly sources: readonly SourceHealthEntry[];
  readonly servedAt: string;
}

export interface Incident {
  readonly incidentId: string;
  readonly assetId: string;
  readonly severity: 'SAFETY_CRITICAL' | 'EVIDENCE_DEGRADED' | 'INPUT_REJECTED';
  readonly status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'RECOVERED';
  readonly reasonCodes: readonly string[];
  readonly firstDetectedAt: string;
  readonly lastObservedAt: string;
  readonly resolvedAt: string | null;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly reason: 'UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_RESPONSE';
      readonly detail: string;
    };

/** Only NEXT_PUBLIC_API_BASE_URL is readable here. No server secret is reachable. */
const BASE = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:4000';

async function request<T>(
  path: string,
  validate: (raw: unknown) => raw is T,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { accept: 'application/json' },
      // Evidence freshness is the product. A cached page would show an operator a state
      // that was true some minutes ago while presenting it as current.
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'UNAVAILABLE',
      detail: err instanceof Error ? err.message : 'the API could not be reached',
    };
  }

  if (response.status === 404) return { ok: false, reason: 'NOT_FOUND', detail: 'Not found.' };
  if (!response.ok) {
    return { ok: false, reason: 'UNAVAILABLE', detail: `The API returned ${response.status}.` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      reason: 'INVALID_RESPONSE',
      detail: 'The API returned a body that was not JSON.',
    };
  }

  // A generated client that has drifted from the server must produce a safe page error,
  // never a page rendering undefined as though it were data.
  if (!validate(body)) {
    return {
      ok: false,
      reason: 'INVALID_RESPONSE',
      detail:
        'The API response did not match the expected contract. The client may be out of date.',
    };
  }

  return { ok: true, data: body };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isAssetPage = (raw: unknown): raw is AssetPage =>
  isRecord(raw) && Array.isArray(raw['items']) && typeof raw['servedAt'] === 'string';

const isAsset = (raw: unknown): raw is Asset =>
  isRecord(raw) && typeof raw['assetId'] === 'string' && typeof raw['lifecycleState'] === 'string';

const isCoverage = (raw: unknown): raw is Coverage =>
  isRecord(raw) && typeof raw['discovered'] === 'number' && typeof raw['servedAt'] === 'string';

const isSourceHealth = (raw: unknown): raw is SourceHealthResponse =>
  isRecord(raw) && Array.isArray(raw['sources']) && typeof raw['servedAt'] === 'string';

const isIncidentPage = (raw: unknown): raw is { items: Incident[]; servedAt: string } =>
  isRecord(raw) && Array.isArray(raw['items']) && typeof raw['servedAt'] === 'string';

export const api = {
  assets: (query: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, v);
    const qs = params.toString();
    return request<AssetPage>(`/v1/assets${qs === '' ? '' : `?${qs}`}`, isAssetPage);
  },
  asset: (assetId: string) => request<Asset>(`/v1/assets/${encodeURIComponent(assetId)}`, isAsset),
  coverage: () => request<Coverage>('/v1/system/coverage', isCoverage),
  sourceHealth: () => request<SourceHealthResponse>('/v1/system/source-health', isSourceHealth),
  incidents: (query: Record<string, string | undefined> = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') params.set(k, v);
    const qs = params.toString();
    return request<{ items: Incident[]; servedAt: string }>(
      `/v1/incidents${qs === '' ? '' : `?${qs}`}`,
      isIncidentPage,
    );
  },
};

/** Lifecycle state to a status tone. Every mapping is explicit; there is no default arm. */
export function lifecycleTone(
  state: LifecycleState,
): 'verified' | 'pending' | 'blocked' | 'chain' | 'unknown' {
  switch (state) {
    case 'NORMAL':
    case 'RECONCILED':
    case 'RECOVERED':
      return 'verified';
    case 'PENDING':
    case 'GUARD_WINDOW':
    case 'APPLIED':
      return 'pending';
    case 'MISMATCH':
    case 'MANUAL_REVIEW':
      return 'blocked';
  }
}

/** Format a fixed-point multiplier for display, without ever going through a float. */
export function formatMultiplier(m: { value: string; decimals: number } | null): string {
  if (m === null) return '—';
  const negative = m.value.startsWith('-');
  const digits = (negative ? m.value.slice(1) : m.value).padStart(m.decimals + 1, '0');
  const whole = digits.slice(0, digits.length - m.decimals) || '0';
  const frac = m.decimals > 0 ? `.${digits.slice(digits.length - m.decimals)}` : '';
  return `${negative ? '-' : ''}${whole}${frac}`;
}
