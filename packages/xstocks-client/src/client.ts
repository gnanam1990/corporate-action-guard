import { XStocksError, redactUrl } from './errors.js';
import { extractExactDecimal, type ExactDecimal } from './exact-number.js';
import {
  assetPageSchema,
  assetSchema,
  corporateActionPageSchema,
  multiplierResponseSchema,
  XLAYER_NETWORK,
  type CorporateAction,
  type MultiplierResponse,
  type Network,
  type XStocksAsset,
  type XStocksDeployment,
} from './schemas.js';

/** Verified production base URL. Note the `/api/v2` path — the host alone returns 404. */
export const XSTOCKS_PRODUCTION_BASE_URL = 'https://api.xstocks.fi/api/v2';

export interface XStocksClientOptions {
  readonly baseUrl?: string;
  /** Per-request timeout. */
  readonly timeoutMs?: number;
  /** Overall budget for a paginated walk. */
  readonly totalTimeoutMs?: number;
  readonly maxRetries?: number;
  /** Hard cap on pages walked, so a broken cursor cannot loop forever. */
  readonly maxPages?: number;
  /** Hard cap on a single response body. */
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injected so retry backoff is deterministic in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface Fetched<T> {
  readonly value: T;
  /** Redacted request path. Written to the journal as the source locator. */
  readonly sourceLocator: string;
  /** Raw body, retained so exact numeric literals can be recovered. */
  readonly rawBody: string;
  readonly httpStatus: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  maxRetries: 3,
  maxPages: 100,
  maxResponseBytes: 8 * 1024 * 1024,
} as const;

/** Retry only where a retry can help: transient transport and server faults. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 425 || (status >= 500 && status <= 599);
}

export class XStocksClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: XStocksClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? XSTOCKS_PRODUCTION_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULTS.totalTimeoutMs;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.maxPages = options.maxPages ?? DEFAULTS.maxPages;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /**
   * One attempt. Returns the parsed value, or an error that states for itself whether a
   * retry could plausibly help.
   */
  private async attemptOnce<T>(
    url: URL,
    locator: string,
    parse: (raw: unknown) => T,
    correlationId: string,
  ): Promise<{ ok: true; value: Fetched<T> } | { ok: false; error: XStocksError }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json', 'x-correlation-id': correlationId },
      });

      if (response.status === 404) {
        return {
          ok: false,
          error: new XStocksError('NOT_FOUND', `not found: ${locator}`, { locator }, false),
        };
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        return {
          ok: false,
          error: new XStocksError(
            'RATE_LIMITED',
            'rate limited by the xStocks API',
            { locator, retryAfter },
            true,
          ),
        };
      }

      if (!response.ok) {
        // A 4xx other than 408/425/429 will not become a 2xx on retry. Retrying it just
        // produces the same rejection more slowly and hides a contract problem.
        return {
          ok: false,
          error: new XStocksError(
            'UNAVAILABLE',
            `xStocks API returned ${response.status}`,
            { locator, status: response.status },
            isRetryableStatus(response.status),
          ),
        };
      }

      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > this.maxResponseBytes) {
        return {
          ok: false,
          error: new XStocksError(
            'RESPONSE_TOO_LARGE',
            'response exceeds the configured cap',
            { locator, declaredBytes: Number(declared) },
            false,
          ),
        };
      }

      const rawBody = await response.text();
      if (rawBody.length > this.maxResponseBytes) {
        return {
          ok: false,
          error: new XStocksError(
            'RESPONSE_TOO_LARGE',
            'response exceeds the configured cap',
            { locator, bytes: rawBody.length },
            false,
          ),
        };
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        // A truncated body is a transport symptom, so a retry can genuinely help.
        return {
          ok: false,
          error: new XStocksError(
            'INVALID_PAYLOAD',
            'response body was not valid JSON',
            { locator, bytes: rawBody.length },
            true,
          ),
        };
      }

      try {
        // A schema violation is NOT retried: the server is answering, just not the way the
        // contract says. Retrying hides a contract break behind a slow failure.
        return {
          ok: true,
          value: {
            value: parse(json),
            sourceLocator: locator,
            rawBody,
            httpStatus: response.status,
          },
        };
      } catch (err) {
        if (err instanceof XStocksError) return { ok: false, error: err };
        throw err;
      }
    } catch (err) {
      if (err instanceof XStocksError) return { ok: false, error: err };
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: new XStocksError(
          aborted ? 'TIMEOUT' : 'UNAVAILABLE',
          aborted ? `request timed out after ${this.timeoutMs}ms` : 'transport failure',
          { locator, cause: err instanceof Error ? err.message : String(err) },
          true,
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One validated GET with bounded retries.
   *
   * Retryability is a property each error carries, decided where it was created. Nothing
   * here re-derives it from the error kind.
   */
  private async getJson<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    parse: (raw: unknown) => T,
    correlationId: string,
  ): Promise<Fetched<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const locator = redactUrl(url.toString());

    let lastError: XStocksError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const previousWasRateLimit = lastError?.kind === 'RATE_LIMITED';
        const retryAfter = previousWasRateLimit ? lastError?.detail['retryAfter'] : undefined;

        if (typeof retryAfter === 'string' && Number.isFinite(Number(retryAfter))) {
          // Honour the server's own instruction in preference to our backoff curve.
          await this.sleep(Math.min(Number(retryAfter) * 1_000, 30_000));
        } else {
          // Exponential backoff with full jitter, so a fleet of workers does not retry in
          // lockstep and turn a blip into a thundering herd.
          const base = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
          await this.sleep(Math.floor(base * this.random()));
        }
      }

      const result = await this.attemptOnce(url, locator, parse, correlationId);
      if (result.ok) return result.value;

      if (!result.error.retryable || attempt === this.maxRetries) throw result.error;
      lastError = result.error;
    }

    throw lastError ?? new XStocksError('UNAVAILABLE', 'exhausted retries', { locator }, false);
  }

  /**
   * Walk the full asset catalog.
   *
   * The envelope carries only `currentPage` and `hasNextPage` — there is no total count —
   * so the catalog size cannot be known before walking every page. A first page returning
   * 100 assets is not evidence that the catalog holds 100 assets, and this method never
   * treats it as such: it follows `hasNextPage` to completion, and a walk stopped by the
   * page cap or the time budget raises INCOMPLETE_CATALOG rather than returning a partial
   * list that would look complete to the caller.
   */
  async listAssets(options: {
    readonly network?: Network;
    readonly correlationId: string;
    readonly pageSize?: number;
  }): Promise<{
    readonly assets: readonly XStocksAsset[];
    readonly sourceLocator: string;
    readonly pagesWalked: number;
  }> {
    const pageSize = Math.min(options.pageSize ?? 100, 100);
    const started = Date.now();
    const assets: XStocksAsset[] = [];
    const seenPages = new Set<number>();
    let page = 0;

    for (let walked = 0; walked < this.maxPages; walked++) {
      if (Date.now() - started > this.totalTimeoutMs) {
        throw new XStocksError('INCOMPLETE_CATALOG', 'catalog walk exceeded the time budget', {
          pagesWalked: walked,
          collected: assets.length,
        });
      }
      if (seenPages.has(page)) {
        throw new XStocksError('PAGINATION_LOOP', 'the API returned a page index already seen', {
          page,
          pagesWalked: walked,
        });
      }
      seenPages.add(page);

      const result = await this.getJson(
        '/public/assets',
        { network: options.network, page, pageSize },
        (raw) => {
          const parsed = assetPageSchema.safeParse(raw);
          if (!parsed.success) {
            throw new XStocksError('INVALID_PAYLOAD', 'asset page failed schema validation', {
              issues: parsed.error.issues
                .slice(0, 10)
                .map((i) => `${i.path.join('.')}: ${i.message}`),
            });
          }
          return parsed.data;
        },
        options.correlationId,
      );
      assets.push(...result.value.nodes);

      if (!result.value.page.hasNextPage) {
        return { assets, sourceLocator: result.sourceLocator, pagesWalked: walked + 1 };
      }
      page = result.value.page.currentPage + 1;
    }

    throw new XStocksError('INCOMPLETE_CATALOG', 'catalog walk hit the page cap', {
      maxPages: this.maxPages,
      collected: assets.length,
    });
  }

  /** One asset by symbol. */
  async getAsset(symbol: string, correlationId: string): Promise<Fetched<XStocksAsset>> {
    const result = await this.getJson(
      `/public/assets/${encodeURIComponent(symbol)}`,
      {},
      (raw) => {
        // Verified against production on 2026-09-03: this route returns a BARE asset
        // object, not the `{nodes, page}` envelope the list route uses. The envelope form
        // is still accepted so a future contract change does not break discovery outright.
        const bare = assetSchema.safeParse(raw);
        if (bare.success) return bare.data;

        const page = assetPageSchema.safeParse(raw);
        if (page.success) {
          const first = page.data.nodes[0];
          if (first === undefined) {
            throw new XStocksError('NOT_FOUND', `no asset returned for symbol ${symbol}`, {
              symbol,
            });
          }
          return first;
        }

        throw new XStocksError('INVALID_PAYLOAD', 'asset response failed schema validation', {
          symbol,
          issues: bare.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      },
      correlationId,
    );
    return result;
  }

  /**
   * Current multiplier for a symbol on a network.
   *
   * Returns the exact decimal literal alongside the parsed response, because the API sends
   * the multiplier as a JSON number and `JSON.parse` has already lost the exact digits by
   * the time the object exists. See `exact-number.ts`.
   */
  async getMultiplier(
    symbol: string,
    network: Network,
    correlationId: string,
  ): Promise<
    Fetched<MultiplierResponse> & {
      readonly exactCurrentMultiplier: ExactDecimal | undefined;
      readonly exactNewMultiplier: ExactDecimal | undefined;
      /** Undefined when the API reports the "none" sentinel rather than a real schedule. */
      readonly scheduledActivationMs: number | undefined;
    }
  > {
    const result = await this.getJson(
      `/public/assets/${encodeURIComponent(symbol)}/multiplier`,
      { network },
      (raw) => {
        const parsed = multiplierResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new XStocksError(
            'INVALID_PAYLOAD',
            'multiplier response failed schema validation',
            {
              symbol,
              issues: parsed.error.issues
                .slice(0, 10)
                .map((i) => `${i.path.join('.')}: ${i.message}`),
            },
          );
        }
        return parsed.data;
      },
      correlationId,
    );

    // 0 is the API's "no scheduled activation" sentinel. Reading it as an instant would
    // place every asset permanently inside a guard window around 1970-01-01.
    const activation = result.value.activationDateTime;
    const scheduledActivationMs = activation > 0 ? activation * 1_000 : undefined;

    return {
      ...result,
      exactCurrentMultiplier: extractExactDecimal(result.rawBody, 'currentMultiplier'),
      exactNewMultiplier: extractExactDecimal(result.rawBody, 'newMultiplier'),
      scheduledActivationMs,
    };
  }

  /** Upcoming corporate actions. Multiplier values here are strings, so they are exact already. */
  async listUpcomingCorporateActions(options: {
    readonly symbol?: string;
    readonly correlationId: string;
  }): Promise<{ readonly actions: readonly CorporateAction[]; readonly sourceLocator: string }> {
    const actions: CorporateAction[] = [];
    let page = 0;

    for (let walked = 0; walked < this.maxPages; walked++) {
      const result = await this.getJson(
        '/public/corporate-actions/upcoming',
        { symbol: options.symbol, page, pageSize: 100 },
        (raw) => {
          const parsed = corporateActionPageSchema.safeParse(raw);
          if (!parsed.success) {
            throw new XStocksError(
              'INVALID_PAYLOAD',
              'corporate action page failed schema validation',
              {
                issues: parsed.error.issues
                  .slice(0, 10)
                  .map((i) => `${i.path.join('.')}: ${i.message}`),
              },
            );
          }
          return parsed.data;
        },
        options.correlationId,
      );
      actions.push(...result.value.nodes);
      if (!result.value.page.hasNextPage) {
        return { actions, sourceLocator: result.sourceLocator };
      }
      page = result.value.page.currentPage + 1;
    }

    throw new XStocksError('INCOMPLETE_CATALOG', 'corporate action walk hit the page cap', {
      maxPages: this.maxPages,
    });
  }
}

/** Pick the X Layer deployment from an asset, if it has one. */
export function xLayerDeployment(asset: XStocksAsset): XStocksDeployment | undefined {
  return asset.deployments.find((d) => d.network === XLAYER_NETWORK);
}
