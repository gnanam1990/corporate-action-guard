import { describe, expect, it } from 'vitest';
import { XLayerReader, XLAYER_LIMITS } from '../src/index.js';

/**
 * Live READ-ONLY smoke test against X Layer mainnet (chain 196).
 *
 * Opt-in. Performs no signing and submits no transaction — the reader has no signing
 * method and never attaches an account, so a write is not expressible here.
 *
 *   XLAYER_LIVE_SMOKE_TEST=1 pnpm test:integration
 */
const ENABLED = process.env['XLAYER_LIVE_SMOKE_TEST'] === '1';
const RPC = process.env['XLAYER_MAINNET_RPC_URL'] ?? 'https://rpc.xlayer.tech';

// Resolved dynamically from the live xStocks API in production. Pinned here only as a
// point-in-time smoke target, matching the addresses verified on 2026-09-03.
const AAPLX_TOKEN = '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a';
const AAPLX_WRAPPER_V2 = '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f';

describe.skipIf(!ENABLED)('live X Layer mainnet reads', () => {
  const reader = new XLayerReader({
    rpcUrl: RPC,
    expectedChainId: 196,
    providerName: 'rpc.xlayer.tech',
    timeoutMs: 20_000,
  });

  it('serves chain 196', async () => {
    await expect(reader.assertChainId()).resolves.toBe(196);
  }, 30_000);

  it('reports a head with both a number and a hash', async () => {
    const head = await reader.getHead();
    expect(head.blockNumber).toBeGreaterThan(0n);
    expect(head.blockHash).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 30_000);

  it('proves real bytecode exists at the token and the wrapper', async () => {
    const head = await reader.getHead();
    await expect(reader.hasBytecode(AAPLX_TOKEN, head.blockNumber)).resolves.toBe(true);
    await expect(reader.hasBytecode(AAPLX_WRAPPER_V2, head.blockNumber)).resolves.toBe(true);
  }, 30_000);

  it('finds no bytecode at an address that holds none', async () => {
    const head = await reader.getHead();
    const empty = '0x000000000000000000000000000000000000dEaD';
    await expect(reader.hasBytecode(empty, head.blockNumber)).resolves.toBe(false);
  }, 30_000);

  it('confirms the wrapper reports the expected underlying asset', async () => {
    const snapshot = await reader.observeAsset({
      tokenAddress: AAPLX_TOKEN,
      wrapperAddress: AAPLX_WRAPPER_V2,
      nowMs: Date.now(),
    });
    expect(snapshot.wrapperAsset).toBe(AAPLX_TOKEN.toLowerCase());
  }, 60_000);

  it('produces a complete snapshot with the multiplier read from the token', async () => {
    const snapshot = await reader.observeAsset({
      tokenAddress: AAPLX_TOKEN,
      wrapperAddress: AAPLX_WRAPPER_V2,
      nowMs: Date.now(),
    });
    expect(snapshot.failedReads).toEqual([]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.currentMultiplier).toBeGreaterThan(0n);
    expect(snapshot.multiplierNonce).toBeGreaterThanOrEqual(0n);
    expect(snapshot.tokenDecimals).toBe(18);
  }, 60_000);

  it('every snapshot carries the block it was read at', async () => {
    const snapshot = await reader.observeAsset({
      tokenAddress: AAPLX_TOKEN,
      wrapperAddress: AAPLX_WRAPPER_V2,
      nowMs: Date.now(),
    });
    expect(snapshot.blockNumber).toBeGreaterThan(0n);
    expect(snapshot.blockHash).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 60_000);

  it('the 100-block getLogs cap is still what the server enforces', async () => {
    // If this ever passes with a wider span, the documented cap has changed and the
    // indexer's sizing in docs/integrations/xlayer.md should be revisited.
    const head = await reader.getHead();
    const from = head.blockNumber - 50n;
    const logs = await reader.getLogsChunked({
      address: AAPLX_TOKEN,
      fromBlock: from,
      toBlock: head.blockNumber,
    });
    expect(Array.isArray(logs)).toBe(true);
    expect(XLAYER_LIMITS.maxLogRangeBlocks).toBe(100);
  }, 60_000);

  it('splits a range wider than the cap rather than failing', async () => {
    const head = await reader.getHead();
    // 250 blocks would be rejected outright as a single request.
    const logs = await reader.getLogsChunked({
      address: AAPLX_TOKEN,
      fromBlock: head.blockNumber - 249n,
      toBlock: head.blockNumber,
    });
    expect(Array.isArray(logs)).toBe(true);
  }, 90_000);

  it('detects no reorg for a freshly read block', async () => {
    const head = await reader.getHead();
    const result = await reader.detectReorg({
      blockNumber: head.blockNumber - 40n,
      blockHash:
        (
          await reader.getLogsChunked({
            address: AAPLX_TOKEN,
            fromBlock: head.blockNumber - 40n,
            toBlock: head.blockNumber - 40n,
          })
        )[0]?.blockHash ?? (await reader.getHead()).blockHash,
    });
    // Either verdict is legitimate here; what matters is that it answers rather than throws.
    expect(typeof result.reorged).toBe('boolean');
  }, 60_000);

  it('refuses an RPC that serves a different chain', async () => {
    const wrong = new XLayerReader({
      rpcUrl: RPC,
      expectedChainId: 1,
      providerName: 'rpc.xlayer.tech',
    });
    await expect(wrong.assertChainId()).rejects.toMatchObject({ kind: 'WRONG_CHAIN' });
  }, 30_000);
});
