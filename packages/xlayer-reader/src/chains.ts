import { defineChain } from 'viem';

/**
 * X Layer mainnet. **Read-only for the entire lifetime of this product.**
 *
 * There is no signing code path for chain 196 anywhere in this repository, no mainnet
 * entry in `contracts/foundry.toml`'s `[rpc_endpoints]`, and deployment scripts refuse it.
 */
export const xLayerMainnet = defineChain({
  id: 196,
  name: 'X Layer',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.xlayer.tech'] } },
  blockExplorers: { default: { name: 'OKLink', url: 'https://www.oklink.com/x-layer' } },
});

/** X Layer testnet. The only chain this product ever writes to. */
export const xLayerTestnet = defineChain({
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: ['https://testrpc.xlayer.tech'] } },
  blockExplorers: { default: { name: 'OKLink', url: 'https://www.oklink.com/x-layer-test' } },
  testnet: true,
});

export const XLAYER_MAINNET_CHAIN_ID = 196 as const;
export const XLAYER_TESTNET_CHAIN_ID = 1952 as const;

/**
 * Verified operational limits, measured against `https://rpc.xlayer.tech` on 2026-09-03.
 * See docs/integrations/xlayer.md for the measurements.
 */
export const XLAYER_LIMITS = {
  /**
   * The public RPC rejects any `eth_getLogs` span wider than 100 blocks with
   * `-32602 block range greater than 100 max`. This is not a tunable preference; it is a
   * hard server-side cap that dictates the indexer's design.
   */
  maxLogRangeBlocks: 100,
  /** Measured 1.00 s/block, so a full 100-block window covers only ~1.7 minutes. */
  approxBlockTimeMs: 1_000,
} as const;
