import { z } from 'zod';

/**
 * Environment contract for Corporate Action Guard.
 *
 * Two rules are enforced here rather than by convention:
 *  1. A server secret may never be published to the browser. Any variable whose name
 *     starts with `NEXT_PUBLIC_` is compiled into the web bundle, so the secret keys are
 *     checked against that prefix at load time (see `assertNoPublicSecrets`).
 *  2. X Layer mainnet is read-only. The mainnet chain id is pinned and a signer key may
 *     never be paired with it (see `assertNoMainnetSigner`).
 */

/** X Layer mainnet. Read-only for the entire lifetime of this product. */
export const XLAYER_MAINNET_CHAIN_ID = 196 as const;
/** X Layer testnet. The only chain this product ever writes to. */
export const XLAYER_TESTNET_CHAIN_ID = 1952 as const;

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address');

const hexPrivateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte private key');

const httpUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
    message: 'must be an http(s) URL',
  });

/** Optional values arrive from the environment as empty strings; treat those as absent. */
const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? undefined : v), inner.optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  XSTOCKS_API_BASE_URL: httpUrl.default('https://api.xstocks.fi/api/v2'),

  XLAYER_MAINNET_RPC_URL: optional(httpUrl),
  XLAYER_TESTNET_RPC_URL: optional(httpUrl),
  XLAYER_MAINNET_CHAIN_ID: z.coerce
    .number()
    .int()
    .refine((v) => v === XLAYER_MAINNET_CHAIN_ID, {
      message: `X Layer mainnet chain id is pinned to ${XLAYER_MAINNET_CHAIN_ID}`,
    })
    .default(XLAYER_MAINNET_CHAIN_ID),
  XLAYER_TESTNET_CHAIN_ID: z.coerce
    .number()
    .int()
    .refine((v) => v === XLAYER_TESTNET_CHAIN_ID, {
      message: `X Layer testnet chain id is pinned to ${XLAYER_TESTNET_CHAIN_ID}`,
    })
    .default(XLAYER_TESTNET_CHAIN_ID),

  API_PUBLIC_BASE_URL: httpUrl.default('http://localhost:4000'),
  NEXT_PUBLIC_API_BASE_URL: httpUrl.default('http://localhost:4000'),

  OPERATOR_API_KEY_HASH: optional(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character SHA-256 hex digest'),
  ),
  INTEGRATOR_API_KEY_HASH: optional(
    z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character SHA-256 hex digest'),
  ),

  RECEIPT_SIGNER_PRIVATE_KEY: optional(hexPrivateKey),
  RECEIPT_SIGNER_ADDRESS: optional(hexAddress),

  GUARD_ADAPTER_TESTNET_ADDRESS: optional(hexAddress),
  GUARD_ADAPTER_DEPLOYED_AT_BLOCK: optional(z.coerce.number().int().nonnegative()),
  PROTECTED_VAULT_TESTNET_ADDRESS: optional(hexAddress),
  FIXTURE_ASSET_TESTNET_ADDRESS: optional(hexAddress),
  FIXTURE_WRAPPER_TESTNET_ADDRESS: optional(hexAddress),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Names that must never be readable from a browser bundle. Kept as data so the rule can
 * be asserted in a test rather than trusted to review.
 */
export const SERVER_SECRET_KEYS = [
  'DATABASE_URL',
  'OPERATOR_API_KEY_HASH',
  'INTEGRATOR_API_KEY_HASH',
  'RECEIPT_SIGNER_PRIVATE_KEY',
  'XLAYER_MAINNET_RPC_URL',
  'XLAYER_TESTNET_RPC_URL',
] as const satisfies readonly (keyof Env)[];

/** The only variables allowed to reach the browser. */
export const PUBLIC_KEYS = ['NEXT_PUBLIC_API_BASE_URL'] as const satisfies readonly (keyof Env)[];
