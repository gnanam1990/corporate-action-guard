import { describe, expect, it } from 'vitest';
import {
  CORPORATE_ACTION_TOKEN_ABI,
  UNVERIFIED_MAINNET_CAPABILITIES,
  UnsupportedCapabilityError,
  WRAPPER_ABI,
  XLAYER_LIMITS,
  XLayerError,
  XLayerReader,
} from '../src/index.js';

/**
 * Deterministic JSON-RPC transport. Every test states exactly what the node answers, so a
 * failure mode is reproduced rather than waited for.
 */
function rpcServer(handlers: Record<string, (params: unknown[], callNo: number) => unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const counts = new Map<string, number>();

  const server = {
    calls: () => calls,
    countOf: (method: string) => counts.get(method) ?? 0,
    url: 'http://127.0.0.1:1/deterministic',
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as
      | { method: string; params: unknown[]; id: number }
      | { method: string; params: unknown[]; id: number }[];
    const batch = Array.isArray(body) ? body : [body];

    const results = batch.map((req) => {
      calls.push({ method: req.method, params: req.params });
      counts.set(req.method, (counts.get(req.method) ?? 0) + 1);
      const handler = handlers[req.method];
      if (handler === undefined) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `no handler for ${req.method}` },
        };
      }
      try {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: handler(req.params, counts.get(req.method) ?? 1),
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32000, message: err instanceof Error ? err.message : 'error' },
        };
      }
    });

    return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    ...server,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const addressWord = (a: string) => `0x${a.replace(/^0x/, '').toLowerCase().padStart(64, '0')}`;

const TOKEN = '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a';
const WRAPPER = '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;

/** Selectors, so a stub can answer the right call without decoding calldata properly. */
const SELECTOR = {
  asset: '0x38d52e0f',
  getCurrentMultiplier: '0x2b63c300',
  newMultiplier: '0x60638067',
  newMultiplierNonce: '0xf7a08958',
  newMultiplierActivationTime: '0x5416d876',
  decimals: '0x313ce567',
} as const;

function defaultHandlers(over: Record<string, (params: unknown[], n: number) => unknown> = {}) {
  return {
    eth_chainId: () => hex(196),
    eth_getBlockByNumber: () => ({
      number: hex(69_686_711),
      hash: BLOCK_HASH,
      timestamp: hex(1_788_000_000),
      parentHash: `0x${'00'.repeat(32)}`,
    }),
    eth_getCode: () => '0x6080604052',
    eth_call: (params: unknown[]) => {
      const call = params[0] as { data?: string; to?: string };
      const data = call.data ?? '';
      if (data.startsWith(SELECTOR.asset)) return addressWord(TOKEN);
      if (data.startsWith(SELECTOR.getCurrentMultiplier)) return word(1_003_269_012_539_818_700n);
      if (data.startsWith(SELECTOR.newMultiplier)) return word(1_003_269_012_539_818_700n);
      if (data.startsWith(SELECTOR.newMultiplierNonce)) return word(5n);
      if (data.startsWith(SELECTOR.newMultiplierActivationTime)) return word(0n);
      if (data.startsWith(SELECTOR.decimals)) return word(18n);
      throw new Error(`execution reverted for ${data.slice(0, 10)}`);
    },
    eth_getLogs: () => [],
    ...over,
  };
}

const reader = (url: string, over: Partial<ConstructorParameters<typeof XLayerReader>[0]> = {}) =>
  new XLayerReader({ rpcUrl: url, expectedChainId: 196, providerName: 'test-provider', ...over });

describe('chain identity', () => {
  it('accepts an RPC serving the expected chain', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      await expect(reader(s.url).assertChainId()).resolves.toBe(196);
    } finally {
      s.restore();
    }
  });

  it('refuses an RPC serving a different chain', async () => {
    // A misconfigured URL would otherwise return well-formed answers about the wrong world.
    const s = rpcServer(defaultHandlers({ eth_chainId: () => hex(1) }));
    try {
      await expect(reader(s.url).assertChainId()).rejects.toMatchObject({ kind: 'WRONG_CHAIN' });
    } finally {
      s.restore();
    }
  });

  it('reports an unreachable RPC as RPC_UNAVAILABLE, not as a wrong chain', async () => {
    const s = rpcServer(
      defaultHandlers({
        eth_chainId: () => {
          throw new Error('connection refused');
        },
      }),
    );
    try {
      await expect(reader(s.url).assertChainId()).rejects.toMatchObject({
        kind: 'RPC_UNAVAILABLE',
      });
    } finally {
      s.restore();
    }
  });

  it('caches the verified chain id rather than re-asking on every read', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      const r = reader(s.url);
      await r.assertChainId();
      await r.assertChainId();
      await r.assertChainId();
      expect(s.countOf('eth_chainId')).toBe(1);
    } finally {
      s.restore();
    }
  });
});

describe('observeAsset', () => {
  it('produces a complete, block-stamped snapshot', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      const snapshot = await reader(s.url).observeAsset({
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        nowMs: 1_788_000_000_000,
      });
      expect(snapshot.complete).toBe(true);
      expect(snapshot.failedReads).toEqual([]);
      expect(snapshot.blockNumber).toBe(69_686_711n);
      expect(snapshot.blockHash).toBe(BLOCK_HASH);
      expect(snapshot.chainId).toBe(196);
      expect(snapshot.providerName).toBe('test-provider');
    } finally {
      s.restore();
    }
  });

  it('reads the multiplier from the token and the asset relation from the wrapper', async () => {
    // Verified live on 2026-09-03: the multiplier surface is on the TOKEN. Calling
    // getCurrentMultiplier() on the wrapper reverts.
    const s = rpcServer(defaultHandlers());
    try {
      const snapshot = await reader(s.url).observeAsset({
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        nowMs: 0,
      });
      expect(snapshot.currentMultiplier).toBe(1_003_269_012_539_818_700n);
      expect(snapshot.multiplierNonce).toBe(5n);
      expect(snapshot.wrapperAsset).toBe(TOKEN);
    } finally {
      s.restore();
    }
  });

  it('treats an activation time of 0 as "no schedule", not as 1970', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      const snapshot = await reader(s.url).observeAsset({
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        nowMs: 0,
      });
      expect(snapshot.scheduledActivationMs).toBeUndefined();
    } finally {
      s.restore();
    }
  });

  it('converts a real activation time to epoch milliseconds', async () => {
    const s = rpcServer(
      defaultHandlers({
        eth_call: (params: unknown[]) => {
          const data = (params[0] as { data?: string }).data ?? '';
          if (data.startsWith(SELECTOR.newMultiplierActivationTime)) return word(1_789_000_000n);
          if (data.startsWith(SELECTOR.asset)) return addressWord(TOKEN);
          if (data.startsWith(SELECTOR.decimals)) return word(18n);
          return word(1n);
        },
      }),
    );
    try {
      const snapshot = await reader(s.url).observeAsset({
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        nowMs: 0,
      });
      expect(snapshot.scheduledActivationMs).toBe(1_789_000_000_000);
    } finally {
      s.restore();
    }
  });

  it('marks a snapshot incomplete and names the failed read', async () => {
    // A partial observation is still evidence, but must never be mistaken for a complete
    // one — only a complete snapshot may support an ALLOW.
    const s = rpcServer(
      defaultHandlers({
        eth_call: (params: unknown[]) => {
          const data = (params[0] as { data?: string }).data ?? '';
          if (data.startsWith(SELECTOR.asset)) throw new Error('execution reverted');
          if (data.startsWith(SELECTOR.decimals)) return word(18n);
          return word(5n);
        },
      }),
    );
    try {
      const snapshot = await reader(s.url).observeAsset({
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        nowMs: 0,
      });
      expect(snapshot.complete).toBe(false);
      expect(snapshot.failedReads).toContain('wrapper.asset()');
      expect(snapshot.wrapperAsset).toBeUndefined();
    } finally {
      s.restore();
    }
  });

  it('reports absent bytecode — an EOA or a self-destructed contract is not canonical', async () => {
    const s = rpcServer(defaultHandlers({ eth_getCode: () => '0x' }));
    try {
      const snapshot = await reader(s.url).observeAsset({
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        nowMs: 0,
      });
      expect(snapshot.tokenHasBytecode).toBe(false);
      expect(snapshot.wrapperHasBytecode).toBe(false);
    } finally {
      s.restore();
    }
  });

  it('pins every read to one block so a snapshot cannot mix heights', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      await reader(s.url).observeAsset({ tokenAddress: TOKEN, wrapperAddress: WRAPPER, nowMs: 0 });
      const blockTags = s
        .calls()
        .filter((c) => c.method === 'eth_call' || c.method === 'eth_getCode')
        .map((c) => (c.params as unknown[])[1]);
      expect(new Set(blockTags).size).toBe(1);
      expect(blockTags[0]).toBe(hex(69_686_711));
    } finally {
      s.restore();
    }
  });
});

describe('eth_getLogs range splitting', () => {
  it('never requests a span wider than the server cap', async () => {
    // X Layer's public RPC rejects >100 blocks with -32602. Without splitting, every
    // historical query fails outright.
    const s = rpcServer(defaultHandlers());
    try {
      await reader(s.url).getLogsChunked({ address: TOKEN, fromBlock: 1_000n, toBlock: 1_450n });
      const spans = s
        .calls()
        .filter((c) => c.method === 'eth_getLogs')
        .map((c) => {
          const f = c.params[0] as { fromBlock: string; toBlock: string };
          return Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) + 1;
        });
      expect(spans.length).toBe(5);
      expect(Math.max(...spans)).toBeLessThanOrEqual(XLAYER_LIMITS.maxLogRangeBlocks);
      expect(spans.reduce((a, b) => a + b, 0)).toBe(451);
    } finally {
      s.restore();
    }
  });

  it('covers the requested range exactly, with no gap and no overlap', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      await reader(s.url).getLogsChunked({ address: TOKEN, fromBlock: 500n, toBlock: 742n });
      const ranges = s
        .calls()
        .filter((c) => c.method === 'eth_getLogs')
        .map((c) => c.params[0] as { fromBlock: string; toBlock: string })
        .map((f) => [BigInt(f.fromBlock), BigInt(f.toBlock)] as const);

      expect(ranges[0]?.[0]).toBe(500n);
      expect(ranges.at(-1)?.[1]).toBe(742n);
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1n);
      }
    } finally {
      s.restore();
    }
  });

  it('handles a single-block range', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      await reader(s.url).getLogsChunked({ address: TOKEN, fromBlock: 10n, toBlock: 10n });
      expect(s.countOf('eth_getLogs')).toBe(1);
    } finally {
      s.restore();
    }
  });

  it('rejects an inverted range instead of looping', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      await expect(
        reader(s.url).getLogsChunked({ address: TOKEN, fromBlock: 100n, toBlock: 10n }),
      ).rejects.toMatchObject({ kind: 'LOG_RANGE_TOO_WIDE' });
    } finally {
      s.restore();
    }
  });
});

describe('reorg detection', () => {
  it('reports no reorg when the hash still matches', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      const result = await reader(s.url).detectReorg({
        blockNumber: 69_686_711n,
        blockHash: BLOCK_HASH,
      });
      expect(result.reorged).toBe(false);
    } finally {
      s.restore();
    }
  });

  it('detects a differing hash at the same height', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      const result = await reader(s.url).detectReorg({
        blockNumber: 69_686_711n,
        blockHash: `0x${'cd'.repeat(32)}`,
      });
      expect(result.reorged).toBe(true);
      if (result.reorged) expect(result.currentHash).toBe(BLOCK_HASH);
    } finally {
      s.restore();
    }
  });

  it('is insensitive to hash casing', async () => {
    const s = rpcServer(defaultHandlers());
    try {
      const result = await reader(s.url).detectReorg({
        blockNumber: 69_686_711n,
        blockHash: BLOCK_HASH.toUpperCase().replace('0X', '0x'),
      });
      expect(result.reorged).toBe(false);
    } finally {
      s.restore();
    }
  });
});

describe('unverified capabilities are refused, never guessed', () => {
  it('names the mainnet capabilities that could not be verified', () => {
    expect(UNVERIFIED_MAINNET_CAPABILITIES).toContain('MULTIPLIER_SCHEDULED_EVENT');
  });

  it('raises a typed error rather than decoding an invented signature', () => {
    const err = new UnsupportedCapabilityError(
      'MULTIPLIER_SCHEDULED_EVENT',
      'no schedule event was observable on mainnet and no verified ABI is published',
    );
    expect(err).toBeInstanceOf(XLayerError);
    expect(err.kind).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('the verified ABI keeps the multiplier surface on the token only', () => {
    const wrapperFns = WRAPPER_ABI.map((f) => f.name);
    const tokenFns = CORPORATE_ACTION_TOKEN_ABI.map((f) => f.name);
    expect(wrapperFns).toContain('asset');
    expect(wrapperFns).not.toContain('getCurrentMultiplier');
    expect(tokenFns).toContain('getCurrentMultiplier');
    expect(tokenFns).toContain('newMultiplierNonce');
  });
});

/**
 * The stub above answers by selector. If a selector here ever stops matching what viem
 * encodes from the verified ABI, the stub would silently answer the wrong call and every
 * other test in this file would be testing nothing. This pins them.
 */
describe('selector pinning', () => {
  it('the stub selectors match what viem encodes from the verified ABI', async () => {
    const { encodeFunctionData } = await import('viem');
    const expected: Record<string, string> = {
      asset: SELECTOR.asset,
      getCurrentMultiplier: SELECTOR.getCurrentMultiplier,
      newMultiplier: SELECTOR.newMultiplier,
      newMultiplierNonce: SELECTOR.newMultiplierNonce,
      newMultiplierActivationTime: SELECTOR.newMultiplierActivationTime,
      decimals: SELECTOR.decimals,
    };
    for (const [name, selector] of Object.entries(expected)) {
      const abi = name === 'asset' ? WRAPPER_ABI : CORPORATE_ACTION_TOKEN_ABI;
      const encoded = encodeFunctionData({ abi: abi as never, functionName: name });
      expect(encoded.slice(0, 10), `${name} selector drifted`).toBe(selector);
    }
  });
});
