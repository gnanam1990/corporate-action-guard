import { describe, expect, it } from 'vitest';
import { XStocksClient, xLayerDeployment } from '../src/index.js';

/**
 * Contract test against the LIVE xStocks production API.
 *
 * Opt-in only. Ordinary CI must stay deterministic, and a third-party endpoint is not a
 * dependency a required check should have. Enable with:
 *
 *   XSTOCKS_LIVE_CONTRACT_TEST=1 pnpm test:integration
 *
 * What this proves: the schemas in this package still match what production actually
 * sends. What it does not prove: that any particular address is permanently correct.
 * Canonical addresses always come from the live API at runtime.
 */
const ENABLED = process.env['XSTOCKS_LIVE_CONTRACT_TEST'] === '1';
const CID = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!ENABLED)('live xStocks contract', () => {
  const client = new XStocksClient({ timeoutMs: 20_000, totalTimeoutMs: 120_000 });

  it('discovers X Layer assets and validates every one against the schema', async () => {
    const { assets, pagesWalked } = await client.listAssets({
      network: 'XLayer',
      correlationId: CID,
    });
    expect(assets.length).toBeGreaterThan(0);
    expect(pagesWalked).toBeGreaterThanOrEqual(1);
    for (const asset of assets) {
      expect(asset.symbol).toBeTruthy();
    }
  }, 120_000);

  it('resolves AAPLx dynamically and exposes an X Layer token and current wrapper', async () => {
    const { value } = await client.getAsset('AAPLx', CID);
    const deployment = xLayerDeployment(value);
    expect(deployment).toBeDefined();
    expect(deployment?.address).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(deployment?.wrapperAddressV2).toMatch(/^0x[0-9a-f]{40}$/i);
  }, 60_000);

  it('returns a multiplier whose exact digits are recoverable from the raw body', async () => {
    const result = await client.getMultiplier('AAPLx', 'XLayer', CID);
    expect(result.exactCurrentMultiplier).toBeDefined();
    // The literal must reproduce exactly what the server wrote.
    expect(result.rawBody).toContain(
      `"currentMultiplier":${result.exactCurrentMultiplier?.literal}`,
    );
  }, 60_000);

  it('still exposes no multiplier nonce — the premise of ADR 0004', async () => {
    // If this ever fails, xStocks has started publishing a nonce and the nonce should be
    // moved into the required agreement field set.
    const result = await client.getMultiplier('AAPLx', 'XLayer', CID);
    const body = JSON.parse(result.rawBody) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('nonce');
    expect(Object.keys(body)).not.toContain('multiplierNonce');
  }, 60_000);
});
