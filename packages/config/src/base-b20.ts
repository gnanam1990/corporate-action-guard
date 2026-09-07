/**
 * Base B20 configuration.
 *
 * Two shapes here do real work, and both are shapes rather than checks.
 *
 * The Base mainnet configuration has **no signer field of any kind**. Not an empty one, not
 * an optional one — the type has nowhere to put a key. A chain-ID guard is one deleted line
 * away from a mainnet broadcast; a config with no signer cannot be defeated that way. See
 * ADR 0007.
 *
 * A Base Sepolia write requires five independent conditions to be simultaneously true, and
 * `resolveSepoliaWriteGate` returns the list of the ones that are missing rather than a
 * boolean. An address string existing in the environment enables nothing.
 */

import { z } from 'zod';

/** Base mainnet. Read-only for the entire lifetime of this product. */
export const BASE_MAINNET_CHAIN_ID = 8453 as const;
/** Base Sepolia. The only Base chain this product may ever write to. */
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

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

const optional = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? undefined : v), inner.optional());

const boolFlag = z.preprocess(
  (v) => (v === '' || v === undefined ? 'false' : v),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
);

/**
 * Duration bound in seconds.
 *
 * Zero is rejected everywhere it appears. A zero staleness window means "nothing is ever
 * stale", which reads as a tightening and is in fact the loosest possible setting — the
 * kind of misconfiguration that only shows up during an outage.
 */
const positiveSeconds = z.coerce.number().int().positive();

export const baseEnvSchema = z.object({
  BASE_MAINNET_CHAIN_ID: z.coerce
    .number()
    .int()
    .refine((v) => v === BASE_MAINNET_CHAIN_ID, {
      message: `Base mainnet chain id is pinned to ${BASE_MAINNET_CHAIN_ID}`,
    })
    .default(BASE_MAINNET_CHAIN_ID),
  BASE_SEPOLIA_CHAIN_ID: z.coerce
    .number()
    .int()
    .refine((v) => v === BASE_SEPOLIA_CHAIN_ID, {
      message: `Base Sepolia chain id is pinned to ${BASE_SEPOLIA_CHAIN_ID}`,
    })
    .default(BASE_SEPOLIA_CHAIN_ID),

  BASE_MAINNET_RPC_URL: optional(httpUrl),
  BASE_SEPOLIA_RPC_URL: optional(httpUrl),

  // Reading at head would pin evidence to a block a reorg can delete. The reorg lookback
  // bounds how far compensation can reach before the answer becomes MANUAL_REVIEW.
  BASE_CONFIRMATIONS: z.coerce.number().int().positive().default(200),
  BASE_REORG_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(600),

  B20_OFFICIAL_ASSET_MANIFEST_PATH: optional(z.string().min(1)),
  B20_CAPABILITY_MATRIX_PATH: optional(z.string().min(1)),
  CHAINLINK_FEED_MANIFEST_PATH: optional(z.string().min(1)),
  B20_TOKEN_FEED_PAIRING_PATH: optional(z.string().min(1)),

  // A provider's log-range limit is discovered and adapted to. This is the starting bound.
  B20_MAX_EVENT_RANGE: z.coerce.number().int().positive().max(10_000).default(2_000),
  B20_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(12_000),

  CHAINLINK_SEQUENCER_FEED_ADDRESS: optional(hexAddress),
  CHAINLINK_DEFAULT_STALE_AFTER_SECONDS: positiveSeconds.default(3_600),
  // After the sequencer recovers, prices published during recovery are not yet trustworthy.
  CHAINLINK_SEQUENCER_GRACE_SECONDS: positiveSeconds.default(1_800),

  B20_GUARD_ADAPTER_SEPOLIA_ADDRESS: optional(hexAddress),
  B20_PROTECTED_VAULT_SEPOLIA_ADDRESS: optional(hexAddress),
  B20_FIXTURE_SEPOLIA_ADDRESS: optional(hexAddress),
  BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: optional(hexPrivateKey),
  BASE_SEPOLIA_WRITES_ENABLED: boolFlag,

  B20_READS_ENABLED: boolFlag,
  B20_LEDGER_ENABLED: boolFlag,
  B20_PREFLIGHT_ENABLED: boolFlag,
  B20_ADAPTER_ENABLED: boolFlag,
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Base variables that must never reach a browser bundle. */
export const BASE_SERVER_SECRET_KEYS = [
  'BASE_MAINNET_RPC_URL',
  'BASE_SEPOLIA_RPC_URL',
  'BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY',
] as const satisfies readonly (keyof BaseEnv)[];

/**
 * The Base mainnet read configuration.
 *
 * There is no signer field, no wallet, no `sendTransaction`. That absence is the whole
 * design: a reader that could write would eventually be asked to.
 */
export interface BaseMainnetReadConfig {
  readonly chainId: typeof BASE_MAINNET_CHAIN_ID;
  readonly rpcUrl: string;
  readonly confirmations: number;
  readonly reorgLookbackBlocks: number;
  readonly maxEventRange: number;
  readonly pollIntervalMs: number;
  readonly readOnly: true;
}

export function resolveBaseMainnetRead(env: BaseEnv): BaseMainnetReadConfig | undefined {
  if (!env.B20_READS_ENABLED) return undefined;
  if (env.BASE_MAINNET_RPC_URL === undefined) return undefined;
  return {
    chainId: BASE_MAINNET_CHAIN_ID,
    rpcUrl: env.BASE_MAINNET_RPC_URL,
    confirmations: env.BASE_CONFIRMATIONS,
    reorgLookbackBlocks: env.BASE_REORG_LOOKBACK_BLOCKS,
    maxEventRange: env.B20_MAX_EVENT_RANGE,
    pollIntervalMs: env.B20_POLL_INTERVAL_MS,
    readOnly: true,
  };
}

/**
 * The five conditions a Base Sepolia write needs.
 *
 * Returned as a list of what is missing, not as a boolean, so an operator reading a refusal
 * learns which of the five to fix. "Writes are disabled" with no reason is the message that
 * makes people start deleting checks.
 */
export const SEPOLIA_WRITE_CONDITIONS = [
  'EXPLICIT_FLAG',
  'RPC_ENDPOINT',
  'SIGNER',
  'DEPLOYMENT_MANIFEST',
  'VERIFIED_CAPABILITY',
] as const;
export type SepoliaWriteCondition = (typeof SEPOLIA_WRITE_CONDITIONS)[number];

export interface SepoliaWriteGate {
  readonly enabled: boolean;
  readonly missing: readonly SepoliaWriteCondition[];
  readonly chainId: typeof BASE_SEPOLIA_CHAIN_ID;
}

/**
 * `capabilityVerified` is supplied by the caller, not read from the environment, on purpose:
 * it can only come from a live probe at a recorded block. No environment variable may assert
 * that a chain supports something.
 */
export function resolveSepoliaWriteGate(
  env: BaseEnv,
  capabilityVerified: boolean,
): SepoliaWriteGate {
  const missing: SepoliaWriteCondition[] = [];
  if (!env.BASE_SEPOLIA_WRITES_ENABLED) missing.push('EXPLICIT_FLAG');
  if (env.BASE_SEPOLIA_RPC_URL === undefined) missing.push('RPC_ENDPOINT');
  if (env.BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY === undefined) missing.push('SIGNER');
  // An address alone is not a deployment. Both the adapter and the vault must be present,
  // because a half-deployed pair silently routes value through an unprotected path.
  if (
    env.B20_GUARD_ADAPTER_SEPOLIA_ADDRESS === undefined ||
    env.B20_PROTECTED_VAULT_SEPOLIA_ADDRESS === undefined
  ) {
    missing.push('DEPLOYMENT_MANIFEST');
  }
  if (!capabilityVerified) missing.push('VERIFIED_CAPABILITY');

  return { enabled: missing.length === 0, missing, chainId: BASE_SEPOLIA_CHAIN_ID };
}

/**
 * Feature availability.
 *
 * A flag alone does not enable a feature; its dependencies have to be present too. Returning
 * the blocking reason is what turns "the B20 page is empty" into a diagnosable state.
 */
export interface B20FeatureState {
  readonly enabled: boolean;
  readonly blockedBy?: string;
}

export function resolveB20Features(env: BaseEnv): {
  readonly reads: B20FeatureState;
  readonly ledger: B20FeatureState;
  readonly preflight: B20FeatureState;
  readonly adapter: B20FeatureState;
} {
  const off = (flag: string): B20FeatureState => ({ enabled: false, blockedBy: `${flag}=false` });

  const reads: B20FeatureState = !env.B20_READS_ENABLED
    ? off('B20_READS_ENABLED')
    : env.BASE_MAINNET_RPC_URL === undefined
      ? { enabled: false, blockedBy: 'BASE_MAINNET_RPC_URL is not set' }
      : env.B20_OFFICIAL_ASSET_MANIFEST_PATH === undefined
        ? { enabled: false, blockedBy: 'B20_OFFICIAL_ASSET_MANIFEST_PATH is not set' }
        : { enabled: true };

  // Everything downstream needs verified reads. A ledger built on unverified identity is a
  // ledger of the wrong asset.
  const dependent = (flag: boolean, name: string): B20FeatureState =>
    !flag
      ? off(name)
      : !reads.enabled
        ? { enabled: false, blockedBy: `depends on B20 reads: ${reads.blockedBy ?? 'unavailable'}` }
        : { enabled: true };

  const preflight: B20FeatureState = !env.B20_PREFLIGHT_ENABLED
    ? off('B20_PREFLIGHT_ENABLED')
    : !reads.enabled
      ? { enabled: false, blockedBy: `depends on B20 reads: ${reads.blockedBy ?? 'unavailable'}` }
      : env.CHAINLINK_FEED_MANIFEST_PATH === undefined
        ? { enabled: false, blockedBy: 'CHAINLINK_FEED_MANIFEST_PATH is not set' }
        : { enabled: true };

  return {
    reads,
    ledger: dependent(env.B20_LEDGER_ENABLED, 'B20_LEDGER_ENABLED'),
    preflight,
    // The adapter authorizes value movement, so it needs the preflight that issues receipts,
    // not merely reads.
    adapter: !env.B20_ADAPTER_ENABLED
      ? off('B20_ADAPTER_ENABLED')
      : !preflight.enabled
        ? {
            enabled: false,
            blockedBy: `depends on B20 preflight: ${preflight.blockedBy ?? 'unavailable'}`,
          }
        : { enabled: true },
  };
}

/**
 * Startup validation for Base configuration.
 *
 * Returns every problem rather than the first, and never echoes a value — a message that
 * quotes an RPC URL leaks its API key into the logs.
 */
export function validateBaseEnv(env: BaseEnv, nodeEnv: string): readonly string[] {
  const issues: string[] = [];

  // The same endpoint for both chains means every "wrong chain" assertion passes while the
  // evidence is labelled with a chain it did not come from.
  if (
    env.BASE_MAINNET_RPC_URL !== undefined &&
    env.BASE_SEPOLIA_RPC_URL !== undefined &&
    env.BASE_MAINNET_RPC_URL === env.BASE_SEPOLIA_RPC_URL
  ) {
    issues.push('BASE_MAINNET_RPC_URL and BASE_SEPOLIA_RPC_URL must not be the same endpoint');
  }

  // Compensating a reorg needs more history than the confirmation depth waits for.
  if (env.BASE_REORG_LOOKBACK_BLOCKS <= env.BASE_CONFIRMATIONS) {
    issues.push(
      'BASE_REORG_LOOKBACK_BLOCKS must exceed BASE_CONFIRMATIONS, or a reorg deeper than the ' +
        'confirmation depth has no window to be compensated in',
    );
  }

  if (env.BASE_SEPOLIA_WRITES_ENABLED && env.BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY === undefined) {
    issues.push('BASE_SEPOLIA_WRITES_ENABLED is true but no Sepolia signer is configured');
  }

  if (nodeEnv === 'production') {
    // In production a raw key in the environment is a key in a process listing, a core dump
    // and a crash report.
    if (env.BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY !== undefined) {
      issues.push('BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY must not be set in production');
    }
    if (env.B20_READS_ENABLED && env.B20_OFFICIAL_ASSET_MANIFEST_PATH === undefined) {
      issues.push('B20_READS_ENABLED requires B20_OFFICIAL_ASSET_MANIFEST_PATH in production');
    }
    if (env.B20_PREFLIGHT_ENABLED && env.CHAINLINK_FEED_MANIFEST_PATH === undefined) {
      issues.push('B20_PREFLIGHT_ENABLED requires CHAINLINK_FEED_MANIFEST_PATH in production');
    }
  }

  return issues;
}
