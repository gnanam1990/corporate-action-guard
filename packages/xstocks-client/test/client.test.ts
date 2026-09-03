import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractExactDecimal,
  extractNumericLiteral,
  redactUrl,
  toExactDecimal,
  XStocksClient,
  XStocksError,
  xLayerDeployment,
  type XStocksAsset,
} from '../src/index.js';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
const assetFixture = readFileSync(path.join(FIXTURES, 'aaplx-asset.json'), 'utf8');
const multiplierFixture = readFileSync(path.join(FIXTURES, 'aaplx-multiplier.json'), 'utf8');

/** Deterministic transport. Every test states exactly what the server does. */
function stubFetch(
  handler: (
    url: URL,
    attempt: number,
  ) => { status: number; body: string; headers?: Record<string, string> },
) {
  let attempt = 0;
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    attempt++;
    const url = input instanceof URL ? input : new URL(String(input));
    calls.push(url);
    const { status, body, headers = {} } = handler(url, attempt);
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls, attempts: () => attempt };
}

const client = (over: Partial<ConstructorParameters<typeof XStocksClient>[0]> = {}) =>
  new XStocksClient({
    // No real sleeping in tests; backoff is exercised by counting attempts.
    sleep: async () => undefined,
    random: () => 0,
    ...over,
  });

const CID = '11111111-1111-4111-8111-111111111111';

describe('exact numeric literals', () => {
  it('recovers the multiplier digits the server actually sent', () => {
    // JSON.parse has already lost these digits by the time the object exists.
    const exact = extractExactDecimal(multiplierFixture, 'currentMultiplier');
    expect(exact?.literal).toBe('1.0032690125398187');
    expect(exact?.value).toBe(10_032_690_125_398_187n);
    expect(exact?.decimals).toBe(16);
  });

  it('preserves precision a double would destroy', () => {
    const a = toExactDecimal('1.00000000000000001');
    const b = toExactDecimal('1.00000000000000002');
    expect(a?.value).not.toBe(b?.value);
    // The same two values are indistinguishable as doubles.
    expect(Number('1.00000000000000001')).toBe(Number('1.00000000000000002'));
  });

  it('declines rather than guesses when a field appears with conflicting values', () => {
    expect(extractNumericLiteral('{"a":1,"b":{"a":2}}', 'a')).toBeUndefined();
  });

  it('declines when the field is absent or not a number', () => {
    expect(extractNumericLiteral('{"a":"1.5"}', 'a')).toBeUndefined();
    expect(extractNumericLiteral('{"b":1}', 'a')).toBeUndefined();
  });

  it('declines exponent notation rather than expanding it by guess', () => {
    expect(toExactDecimal('1e5')).toBeUndefined();
  });
});

describe('getAsset', () => {
  it('parses the bare asset object the production route returns', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: assetFixture }));
    const result = await client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID);
    expect(result.value.symbol).toBe('AAPLx');
  });

  it('finds the X Layer deployment with its token and current wrapper', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: assetFixture }));
    const { value } = await client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID);
    const deployment = xLayerDeployment(value);
    // Point-in-time smoke assertion against the values observed on 2026-09-03. This is
    // evidence of a verified call, not a permanent registry — canonical addresses always
    // come from the live API at runtime, never from a constant.
    expect(deployment?.address).toBe('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a');
    expect(deployment?.wrapperAddressV2).toBe('0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f');
  });

  it('rejects a malformed EVM address rather than normalizing it', async () => {
    const broken = JSON.parse(assetFixture) as XStocksAsset;
    (broken.deployments[0] as { address: string }).address = '0xnot-an-address';
    const fetchImpl = stubFetch(() => ({ status: 200, body: JSON.stringify(broken) }));
    await expect(client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID)).rejects.toThrow(
      XStocksError,
    );
  });
});

describe('getMultiplier', () => {
  it('treats activationDateTime 0 as "no schedule", not as 1970', async () => {
    // If 0 were read as an instant, every asset would sit permanently inside a guard
    // window around 1970-01-01 and the product would block everything.
    const fetchImpl = stubFetch(() => ({ status: 200, body: multiplierFixture }));
    const result = await client({ fetchImpl: fetchImpl.impl }).getMultiplier(
      'AAPLx',
      'XLayer',
      CID,
    );
    expect(result.value.activationDateTime).toBe(0);
    expect(result.scheduledActivationMs).toBeUndefined();
  });

  it('converts a real activation to milliseconds', async () => {
    const body =
      '{"currentMultiplier":1.5,"newMultiplier":2.0,"activationDateTime":1789000000,"reason":"Split"}';
    const fetchImpl = stubFetch(() => ({ status: 200, body }));
    const result = await client({ fetchImpl: fetchImpl.impl }).getMultiplier(
      'AAPLx',
      'XLayer',
      CID,
    );
    expect(result.scheduledActivationMs).toBe(1_789_000_000_000);
    expect(result.exactNewMultiplier?.literal).toBe('2.0');
  });
});

describe('pagination', () => {
  const page = (current: number, hasNext: boolean, symbol: string) =>
    JSON.stringify({
      nodes: [{ id: `id-${symbol}`, name: symbol, symbol, deployments: [] }],
      page: { currentPage: current, hasNextPage: hasNext },
    });

  it('walks every page — a full first page is not proof the catalog ends there', async () => {
    const fetchImpl = stubFetch((url) => {
      const p = Number(url.searchParams.get('page'));
      return { status: 200, body: page(p, p < 2, `SYM${p}`) };
    });
    const result = await client({ fetchImpl: fetchImpl.impl }).listAssets({ correlationId: CID });
    expect(result.pagesWalked).toBe(3);
    expect(result.assets.map((a) => a.symbol)).toEqual(['SYM0', 'SYM1', 'SYM2']);
  });

  it('detects a repeated page index instead of looping forever', async () => {
    // A server that always reports currentPage 0 with hasNextPage true would otherwise
    // spin until the process died.
    const fetchImpl = stubFetch(() => ({ status: 200, body: page(0, true, 'STUCK') }));
    await expect(
      client({ fetchImpl: fetchImpl.impl }).listAssets({ correlationId: CID }),
    ).rejects.toMatchObject({ kind: 'PAGINATION_LOOP' });
  });

  it('raises INCOMPLETE_CATALOG at the page cap rather than returning a partial list', async () => {
    const fetchImpl = stubFetch((url) => {
      const p = Number(url.searchParams.get('page'));
      return { status: 200, body: page(p, true, `SYM${p}`) };
    });
    await expect(
      client({ fetchImpl: fetchImpl.impl, maxPages: 3 }).listAssets({ correlationId: CID }),
    ).rejects.toMatchObject({ kind: 'INCOMPLETE_CATALOG' });
  });

  it('passes the network filter through', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: page(0, false, 'ONE') }));
    await client({ fetchImpl: fetchImpl.impl }).listAssets({
      correlationId: CID,
      network: 'XLayer',
    });
    expect(fetchImpl.calls()[0]?.searchParams.get('network')).toBe('XLayer');
  });
});

describe('failure model', () => {
  it('retries a 500 and succeeds', async () => {
    const fetchImpl = stubFetch((_url, attempt) =>
      attempt < 3 ? { status: 500, body: '{}' } : { status: 200, body: assetFixture },
    );
    const result = await client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID);
    expect(result.value.symbol).toBe('AAPLx');
    expect(fetchImpl.attempts()).toBe(3);
  });

  it('honours Retry-After on a 429', async () => {
    const waits: number[] = [];
    const fetchImpl = stubFetch((_url, attempt) =>
      attempt === 1
        ? { status: 429, body: '{}', headers: { 'retry-after': '2' } }
        : { status: 200, body: assetFixture },
    );
    await client({
      fetchImpl: fetchImpl.impl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).getAsset('AAPLx', CID);
    expect(waits).toContain(2_000);
  });

  it('gives up on a 429 that never clears', async () => {
    const fetchImpl = stubFetch(() => ({ status: 429, body: '{}' }));
    await expect(
      client({ fetchImpl: fetchImpl.impl, maxRetries: 1 }).getAsset('AAPLx', CID),
    ).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
  });

  it('does not retry a 400 — a bad request will not become good', async () => {
    const fetchImpl = stubFetch(() => ({ status: 400, body: '{}' }));
    await expect(client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID)).rejects.toThrow(
      XStocksError,
    );
    expect(fetchImpl.attempts()).toBe(1);
  });

  it('does not retry a 404', async () => {
    const fetchImpl = stubFetch(() => ({ status: 404, body: '{}' }));
    await expect(client({ fetchImpl: fetchImpl.impl }).getAsset('NOPE', CID)).rejects.toMatchObject(
      {
        kind: 'NOT_FOUND',
      },
    );
    expect(fetchImpl.attempts()).toBe(1);
  });

  it('reports a truncated body as INVALID_PAYLOAD', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: '{"id":"x","sym' }));
    await expect(
      client({ fetchImpl: fetchImpl.impl, maxRetries: 0 }).getAsset('AAPLx', CID),
    ).rejects.toMatchObject({ kind: 'INVALID_PAYLOAD' });
  });

  it('rejects an oversized body', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: 'x'.repeat(5_000) }));
    await expect(
      client({ fetchImpl: fetchImpl.impl, maxResponseBytes: 1_000 }).getAsset('AAPLx', CID),
    ).rejects.toMatchObject({ kind: 'RESPONSE_TOO_LARGE' });
  });

  it('reports a timeout as TIMEOUT, not as a generic failure', async () => {
    const impl = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;
    await expect(
      client({ fetchImpl: impl, maxRetries: 0 }).getAsset('AAPLx', CID),
    ).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('never substitutes bundled sample data when the API fails', async () => {
    const fetchImpl = stubFetch(() => ({ status: 503, body: '{}' }));
    // The only acceptable outcome is a typed failure. There is no fallback path.
    await expect(
      client({ fetchImpl: fetchImpl.impl, maxRetries: 0 }).listAssets({ correlationId: CID }),
    ).rejects.toThrow(XStocksError);
  });
});

describe('source locator redaction', () => {
  it('strips credentials from a URL before it can reach a log or the journal', () => {
    expect(redactUrl('https://user:hunter2@api.example.com/v2/assets')).not.toContain('hunter2');
  });

  it('redacts credential-shaped query parameters', () => {
    const out = redactUrl('https://api.example.com/v2?apiKey=sk_live_abc&page=0');
    expect(out).toContain('page=0');
    expect(out).not.toContain('sk_live_abc');
  });

  it('never throws on an unparseable URL', () => {
    expect(redactUrl('not a url')).toBe('[unparseable-url]');
  });
});

/**
 * Regression: the catalog is multi-chain. Requiring EVM address format on every
 * deployment rejected the whole AAPLx asset because Solana, Tron, and Ton addresses are
 * not 0x-prefixed — a strict check on a field this product never reads turning into a
 * total discovery failure against live production.
 */
describe('multi-chain address formats', () => {
  const multiChain = JSON.stringify({
    id: 'x',
    name: 'Apple xStock',
    symbol: 'AAPLx',
    deployments: [
      {
        address: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
        network: 'XLayer',
        wrapperAddressV2: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
      },
      { address: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', network: 'Solana' },
      { address: 'TZ7nsyCuQq1cusCtex6V4qbzWcb3NbibAM', network: 'Tron' },
      { address: 'EQDsjAwfKo-6FVZv2EYt-1CaZTY_ZL-pfkSId6jeQchNwmdo', network: 'Ton' },
    ],
  });

  it('accepts non-EVM addresses on non-EVM networks', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: multiChain }));
    const { value } = await client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID);
    expect(value.deployments).toHaveLength(4);
  });

  it('still picks the X Layer deployment out of a multi-chain asset', async () => {
    const fetchImpl = stubFetch(() => ({ status: 200, body: multiChain }));
    const { value } = await client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID);
    expect(xLayerDeployment(value)?.network).toBe('XLayer');
  });

  it('still enforces EVM format strictly on an EVM network', async () => {
    const broken = JSON.parse(multiChain) as XStocksAsset;
    (broken.deployments[0] as { address: string }).address =
      'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
    const fetchImpl = stubFetch(() => ({ status: 200, body: JSON.stringify(broken) }));
    await expect(
      client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID),
    ).rejects.toMatchObject({
      kind: 'INVALID_PAYLOAD',
    });
  });

  it('rejects a malformed wrapper address on an EVM network', async () => {
    const broken = JSON.parse(multiChain) as XStocksAsset;
    (broken.deployments[0] as { wrapperAddressV2: string }).wrapperAddressV2 = '0xshort';
    const fetchImpl = stubFetch(() => ({ status: 200, body: JSON.stringify(broken) }));
    await expect(
      client({ fetchImpl: fetchImpl.impl }).getAsset('AAPLx', CID),
    ).rejects.toMatchObject({
      kind: 'INVALID_PAYLOAD',
    });
  });
});
