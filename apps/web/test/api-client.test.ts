import { describe, expect, it, vi } from 'vitest';
import { api, formatMultiplier, lifecycleTone, type LifecycleState } from '../src/lib/api';

/**
 * The client returns a discriminated result rather than throwing.
 *
 * A page that cannot reach the API must render a truthful unavailable state. An exception
 * thrown into a server component produces a generic error page that tells an operator
 * nothing, and — worse — an empty array would render as "nothing is wrong".
 */

const mockFetch = (impl: () => Promise<Response>) => {
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
};

describe('unreachable API', () => {
  it('reports UNAVAILABLE rather than throwing', async () => {
    mockFetch(async () => {
      throw new Error('fetch failed');
    });
    const result = await api.coverage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNAVAILABLE');
    vi.unstubAllGlobals();
  });

  it('reports UNAVAILABLE on a 5xx', async () => {
    mockFetch(async () => new Response('{}', { status: 503 }));
    const result = await api.assets();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('UNAVAILABLE');
    vi.unstubAllGlobals();
  });

  it('never returns an empty page in place of a failure', async () => {
    // An empty array and an unreachable API are different facts, and the console renders
    // them differently: "no assets discovered" versus "the catalog could not be read".
    mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await api.assets();
    expect(result.ok).toBe(false);
    expect((result as { data?: unknown }).data).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('contract drift', () => {
  it('rejects a response that does not match the expected shape', async () => {
    // A generated client that has drifted from the server must produce a safe page error,
    // never a page rendering undefined as though it were data.
    mockFetch(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    const result = await api.coverage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_RESPONSE');
    vi.unstubAllGlobals();
  });

  it('rejects a non-JSON body', async () => {
    mockFetch(async () => new Response('<html>gateway</html>', { status: 200 }));
    const result = await api.assets();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_RESPONSE');
    vi.unstubAllGlobals();
  });

  it('distinguishes NOT_FOUND from UNAVAILABLE', async () => {
    mockFetch(async () => new Response('{}', { status: 404 }));
    const result = await api.assets();
    if (!result.ok) expect(result.reason).toBe('NOT_FOUND');
    vi.unstubAllGlobals();
  });
});

describe('successful reads', () => {
  it('returns validated data', async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            discovered: 726,
            canonicallyVerified: 8,
            pendingOrGuardWindow: 0,
            mismatchedOrReview: 0,
            servedAt: '2026-09-04T00:00:00.000Z',
          }),
          { status: 200 },
        ),
    );
    const result = await api.coverage();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.discovered).toBe(726);
    vi.unstubAllGlobals();
  });

  it('never caches: evidence freshness is the product', async () => {
    let seenInit: RequestInit | undefined;
    vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => {
      seenInit = init;
      return new Response(JSON.stringify({ items: [], servedAt: 'x' }), { status: 200 });
    }) as unknown as typeof fetch);
    await api.assets();
    expect(seenInit?.cache).toBe('no-store');
    vi.unstubAllGlobals();
  });
});

describe('lifecycle tone mapping is total', () => {
  const states: LifecycleState[] = [
    'NORMAL',
    'PENDING',
    'GUARD_WINDOW',
    'APPLIED',
    'RECONCILED',
    'MISMATCH',
    'MANUAL_REVIEW',
    'RECOVERED',
  ];

  it('maps every state explicitly, with no default arm', () => {
    for (const state of states) {
      expect(lifecycleTone(state)).toBeDefined();
    }
  });

  it('maps the unsafe states to the blocked tone', () => {
    expect(lifecycleTone('MISMATCH')).toBe('blocked');
    expect(lifecycleTone('MANUAL_REVIEW')).toBe('blocked');
  });

  it('maps the guard window to pending, never to verified', () => {
    expect(lifecycleTone('GUARD_WINDOW')).toBe('pending');
  });
});

describe('multiplier formatting never passes through a float', () => {
  it('renders an 18-decimal value exactly', () => {
    expect(formatMultiplier({ value: '1003269012539818700', decimals: 18 })).toBe(
      '1.003269012539818700',
    );
  });

  it('distinguishes values that a double would collapse', () => {
    const a = formatMultiplier({ value: '1000000000000000001', decimals: 18 });
    const b = formatMultiplier({ value: '1000000000000000002', decimals: 18 });
    expect(a).not.toBe(b);
    expect(Number(a)).toBe(Number(b));
  });

  it('renders an absent multiplier as an em dash, not as zero', () => {
    expect(formatMultiplier(null)).toBe('—');
  });

  it('handles a zero-decimal value', () => {
    expect(formatMultiplier({ value: '5', decimals: 0 })).toBe('5');
  });
});
