import { z } from 'zod';

/**
 * Schemas for the xStocks public API v2.
 *
 * Written against the OpenAPI document downloaded from
 * https://docs.xstocks.fi/_bundle/apis/@v2/openapi.json and cross-checked against live
 * production responses. See docs/integrations/xstocks-api.md for the exact verification
 * date and the responses that were observed.
 *
 * Two rules at this boundary:
 *  - Unknown fields are preserved for diagnostics but never trusted. `.passthrough()`
 *    keeps them; nothing downstream reads them.
 *  - Nothing is coerced into a shape it did not arrive in. A malformed address is an
 *    error, not something to normalize into looking valid.
 */

/** Networks the API enumerates. Only XLayer matters to this product. */
export const NETWORKS = [
  'Ethereum',
  'Polygon',
  'Gnosis',
  'BinanceSmartChain',
  'Arbitrum',
  'Avalanche',
  'Fantom',
  'Base',
  'Lisk',
  'Etherlink',
  'Sonic',
  'Solana',
  'Tron',
  'Ton',
  'Mantle',
  'HyperEVM',
  'Ink',
  'XLayer',
  'Optimism',
] as const;

export const networkSchema = z.enum(NETWORKS);
export type Network = z.infer<typeof networkSchema>;

/** The network name this product observes. X Layer mainnet is chain 196. */
export const XLAYER_NETWORK: Network = 'XLayer';

/**
 * Networks whose addresses are 20-byte EVM addresses.
 *
 * The catalog is multi-chain: the same asset is deployed on Solana, Tron, and Ton, whose
 * addresses are base58/base64 strings. Requiring EVM format on every deployment would
 * reject the whole asset over chains this product never reads — a strict check on an
 * irrelevant field turning into a total discovery failure. Format is therefore validated
 * per network family, strictly for the chains that matter and structurally for the rest.
 */
export const EVM_NETWORKS = new Set<Network>([
  'Ethereum',
  'Polygon',
  'Gnosis',
  'BinanceSmartChain',
  'Arbitrum',
  'Avalanche',
  'Fantom',
  'Base',
  'Lisk',
  'Etherlink',
  'Sonic',
  'Mantle',
  'HyperEVM',
  'Ink',
  'XLayer',
  'Optimism',
]);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const isEvmNetwork = (network: Network): boolean => EVM_NETWORKS.has(network);

export const stablecoinSchema = z
  .object({
    symbol: z.string(),
    currency: z.string().optional(),
    network: networkSchema.optional(),
    address: z.string().optional(),
    decimals: z.number().int().optional(),
    issuance: z.boolean().optional(),
    redemption: z.boolean().optional(),
    supportsAtomicSwaps: z.boolean().optional(),
  })
  .passthrough();

export const deploymentSchema = z
  .object({
    /** Format depends on the network; validated in the refinement below. */
    address: z.string().min(1),
    network: networkSchema,
    /**
     * Version 1 wrapper. Frequently absent on live responses — absence means "no v1
     * wrapper recorded", which is UNKNOWN, not "no wrapper exists".
     */
    wrapperAddress: z.string().min(1).optional(),
    /** Current wrapper. This is the only wrapper accepted for protected actions. */
    wrapperAddressV2: z.string().min(1).optional(),
    supportsAtomicSwaps: z.boolean().optional(),
    stablecoins: z.array(stablecoinSchema).optional(),
  })
  .passthrough()
  .superRefine((deployment, ctx) => {
    if (!isEvmNetwork(deployment.network)) return;
    for (const field of ['address', 'wrapperAddress', 'wrapperAddressV2'] as const) {
      const value = deployment[field];
      if (value !== undefined && !EVM_ADDRESS_RE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${deployment.network} is an EVM network; ${field} must be a 20-byte 0x address`,
        });
      }
    }
  });

export const assetSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    symbol: z.string(),
    isin: z.string().optional(),
    description: z.string().optional(),
    logo: z.string().optional(),
    isTradingHalted: z.boolean().optional(),
    deployments: z.array(deploymentSchema).default([]),
  })
  .passthrough();

export type XStocksAsset = z.infer<typeof assetSchema>;
export type XStocksDeployment = z.infer<typeof deploymentSchema>;

/**
 * The list envelope. Note it carries only `currentPage` and `hasNextPage` — there is no
 * total count, so the catalog size cannot be known before walking every page.
 */
export const assetPageSchema = z
  .object({
    nodes: z.array(assetSchema),
    page: z
      .object({
        currentPage: z.number(),
        hasNextPage: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export type AssetPage = z.infer<typeof assetPageSchema>;

/**
 * The multiplier endpoint.
 *
 * Verified live shape:
 *   {"currentMultiplier":1.0032690125398187,"newMultiplier":0,"activationDateTime":0,"reason":null}
 *
 * Two things this schema deliberately does NOT do:
 *  - It does not treat `newMultiplier: 0` / `activationDateTime: 0` as a real pending
 *    action. Zero is the API's "none" sentinel. Reading `activationDateTime: 0` as an
 *    instant would place every asset permanently inside a guard window around 1970.
 *  - It does not expose a multiplier NONCE, because the API has none. See ADR 0004.
 */
export const multiplierResponseSchema = z
  .object({
    currentMultiplier: z.number(),
    newMultiplier: z.number(),
    /** Epoch seconds. 0 is the "no scheduled activation" sentinel, not 1970-01-01. */
    activationDateTime: z.number(),
    reason: z
      .enum(['FeeAccrual', 'Dividend', 'Split', 'ReverseSplit', 'Administrative'])
      .nullable()
      .optional(),
  })
  .passthrough();

export type MultiplierResponse = z.infer<typeof multiplierResponseSchema>;

/** Upcoming corporate actions. Multiplier values here are strings — exact by construction. */
export const corporateActionSchema = z
  .object({
    eventId: z.string(),
    version: z.number().optional(),
    xstockSymbol: z.string().nullable().optional(),
    spvSymbol: z.string().optional(),
    caType: z.string(),
    effectiveTimeUtc: z.string().nullable().optional(),
    multiplierOld: z.string().nullable().optional(),
    multiplierNew: z.string().nullable().optional(),
    status: z.string().optional(),
    createdTimeUtc: z.string().optional(),
  })
  .passthrough();

export const corporateActionPageSchema = z
  .object({
    nodes: z.array(corporateActionSchema),
    page: z
      .object({
        currentPage: z.number(),
        hasNextPage: z.boolean(),
        totalNodes: z.number().optional(),
        totalPages: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CorporateAction = z.infer<typeof corporateActionSchema>;
export type CorporateActionPage = z.infer<typeof corporateActionPageSchema>;
