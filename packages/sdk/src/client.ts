import { randomUUID } from 'node:crypto';
import { GuardError, type PreflightDecision, type PreflightOperation } from './types.js';

/**
 * The integrator client.
 *
 * Thin by design. It constructs the canonical request, submits it with an idempotency key,
 * and hands back a typed decision. It does not decide anything itself.
 */

export interface GuardClientOptions {
  readonly baseUrl: string;
  /**
   * Read from the environment, stdin, or a keychain by the caller. Never accepted from a
   * command-line argument, which would put it in shell history and in `ps` output.
   */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Bounded retries, for idempotent reads only. */
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PreflightOptions {
  /**
   * Supply your own to make a retry safe across process restarts. The generated default is
   * unique per call, which makes a retry a NEW request — correct for a fresh intent, wrong
   * for a resubmission.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

export class GuardClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GuardClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.apiKey === undefined ? {} : { 'x-api-key': this.apiKey }),
      ...extra,
    };
  }

  private async call<T>(
    path: string,
    init: RequestInit & { readonly retryable: boolean },
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: GuardError | undefined;

    for (let attempt = 0; attempt <= (init.retryable ? this.maxRetries : 0); attempt++) {
      if (attempt > 0) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4_000));

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: combined });
      } catch (err) {
        const aborted =
          err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        lastError = new GuardError(
          aborted ? 'TIMEOUT' : 'UNAVAILABLE',
          aborted
            ? `request timed out after ${this.timeoutMs}ms`
            : 'the guard API could not be reached',
        );
        if (attempt === (init.retryable ? this.maxRetries : 0)) throw lastError;
        continue;
      }

      if (response.status === 401)
        throw new GuardError('UNAUTHORIZED', 'API key missing, invalid, or revoked');
      if (response.status === 403)
        throw new GuardError('FORBIDDEN', 'this API key lacks the required scope');

      if (response.status === 400) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new GuardError(
          'INVALID_REQUEST',
          body.detail ?? 'the request was rejected as invalid',
        );
      }

      if (!response.ok) {
        const kind = response.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE';
        lastError = new GuardError(kind, `the guard API returned ${response.status}`);
        if (
          !isRetryableStatus(response.status) ||
          attempt === (init.retryable ? this.maxRetries : 0)
        ) {
          throw lastError;
        }
        continue;
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new GuardError('INVALID_RESPONSE', 'the guard API returned a body that was not JSON');
      }
    }

    throw lastError ?? new GuardError('UNAVAILABLE', 'exhausted retries');
  }

  /**
   * Preflight one exact operation.
   *
   * **Never retried automatically.** A preflight is a state-changing request that can mint
   * a receipt, and retrying it without the caller's own idempotency key risks minting a
   * second one. Retries are the caller's decision, made with a stable key.
   */
  async preflight(
    operation: PreflightOperation,
    options: PreflightOptions = {},
  ): Promise<PreflightDecision> {
    const body = {
      chainId: operation.chainId,
      assetId: operation.assetId,
      target: operation.target,
      asset: operation.asset,
      wrapper: operation.wrapper,
      actionType: operation.actionType,
      caller: operation.caller,
      recipient: operation.recipient,
      // Base units as a decimal string: a JSON number cannot hold a uint256.
      amount: operation.amount.toString(),
      expectedMultiplierNonce: operation.expectedMultiplierNonce.toString(),
    };

    return this.call<PreflightDecision>(
      '/v1/preflight',
      {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/json',
          'idempotency-key': options.idempotencyKey ?? randomUUID(),
        }),
        body: JSON.stringify(body),
        retryable: false,
      },
      options.signal,
    );
  }

  /** Read the asset catalog. Idempotent, so bounded retries are safe. */
  async listAssets(query: Record<string, string> = {}, signal?: AbortSignal): Promise<unknown> {
    const params = new URLSearchParams(query).toString();
    return this.call(
      `/v1/assets${params === '' ? '' : `?${params}`}`,
      { method: 'GET', headers: this.headers(), retryable: true },
      signal,
    );
  }

  async getAsset(assetId: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(
      `/v1/assets/${encodeURIComponent(assetId)}`,
      { method: 'GET', headers: this.headers(), retryable: true },
      signal,
    );
  }

  async health(signal?: AbortSignal): Promise<unknown> {
    return this.call(
      '/v1/health/ready',
      { method: 'GET', headers: this.headers(), retryable: true },
      signal,
    );
  }

  /**
   * Readiness, for diagnostics.
   *
   * A 503 from the readiness endpoint is a MEANINGFUL ANSWER, not a transport failure: the
   * API is reachable and is telling you a dependency is unhealthy. Treating it as an error
   * would report "unreachable" for a service that is answering perfectly well, which sends
   * an operator to look at the wrong thing.
   */
  async readiness(signal?: AbortSignal): Promise<
    | {
        readonly reachable: true;
        readonly ready: boolean;
        readonly components: readonly { name: string; ok: boolean; detail: string }[];
      }
    | { readonly reachable: false; readonly detail: string }
  > {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/health/ready`, {
        method: 'GET',
        headers: this.headers(),
        signal: combined,
      });
    } catch (err) {
      const aborted =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      return { reachable: false, detail: aborted ? 'timed out' : 'connection failed' };
    }

    // 200 and 503 are both real answers here; anything else is not a readiness response.
    if (response.status !== 200 && response.status !== 503) {
      return { reachable: false, detail: `unexpected status ${response.status}` };
    }

    const body = (await response.json().catch(() => ({}))) as {
      status?: string;
      components?: { name: string; ok: boolean; detail: string }[];
    };

    return {
      reachable: true,
      ready: response.status === 200,
      components: body.components ?? [],
    };
  }

  async sourceHealth(signal?: AbortSignal): Promise<unknown> {
    return this.call(
      '/v1/system/source-health',
      { method: 'GET', headers: this.headers(), retryable: true },
      signal,
    );
  }
}
