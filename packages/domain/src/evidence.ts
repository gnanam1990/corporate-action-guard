/**
 * Observations and canonicality.
 *
 * An observation carries its own provenance: when it was taken, what the source said its
 * own time was, where it came from, and — for chain evidence — the exact block it was read
 * at. Evidence without provenance cannot be replayed, so it cannot authorize anything.
 */

import type {
  Address,
  BlockHash,
  BlockNumber,
  ChainId,
  TickerSymbol,
  WrapperVersion,
} from './brands.js';
import type { Multiplier, MultiplierNonce } from './multiplier.js';
import type { Instant } from './time.js';

export type SourceKind = 'XSTOCKS_API' | 'XLAYER_RPC';

export interface Provenance {
  readonly sourceKind: SourceKind;
  /** Where this came from: an endpoint path, or an RPC provider identifier. Never a URL containing credentials. */
  readonly sourceLocator: string;
  /** When this process observed the value. */
  readonly observedAt: Instant;
  /** When the source claims the value was true, if it says. Never substituted by observedAt. */
  readonly sourceTime?: Instant;
}

export interface ApiObservation {
  readonly provenance: Provenance & { readonly sourceKind: 'XSTOCKS_API' };
  readonly symbol: TickerSymbol;
  readonly tokenAddress: Address;
  /** Present only when the API exposes it. Absent is UNKNOWN, never "no wrapper". */
  readonly wrapperAddress?: Address;
  readonly wrapperVersion?: WrapperVersion;
  readonly multiplier?: Multiplier;
  readonly multiplierNonce?: MultiplierNonce;
  readonly scheduledActivation?: Instant;
}

export interface ChainObservation {
  readonly provenance: Provenance & { readonly sourceKind: 'XLAYER_RPC' };
  readonly chainId: ChainId;
  /** The block this read was taken at. `latest` is never used without recording what it resolved to. */
  readonly blockNumber: BlockNumber;
  readonly blockHash: BlockHash;
  readonly tokenAddress: Address;
  readonly wrapperAddress: Address;
  /** False when eth_getCode returned 0x. An address with no bytecode is not a contract. */
  readonly tokenHasBytecode: boolean;
  readonly wrapperHasBytecode: boolean;
  /** The asset the wrapper itself reports. Absent when the verified ABI does not expose it. */
  readonly wrapperAsset?: Address;
  readonly multiplier?: Multiplier;
  readonly multiplierNonce?: MultiplierNonce;
  readonly scheduledActivation?: Instant;
}

/**
 * Three-valued check outcome.
 *
 * `UNKNOWN` is deliberately distinct from `FAIL`: "we could not determine this" and "this
 * is wrong" call for different operator responses, and collapsing them would let missing
 * evidence read as a pass. Neither ever produces an ALLOW.
 */
export type CheckOutcome = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface CanonicalityCheck {
  readonly name: CanonicalityCheckName;
  readonly outcome: CheckOutcome;
  /** Deterministic explanation. Never a free-form or model-generated sentence. */
  readonly detail: string;
}

export const CANONICALITY_CHECK_NAMES = [
  'TOKEN_MATCHES_REGISTRY',
  'WRAPPER_MATCHES_REGISTRY',
  'TOKEN_HAS_BYTECODE',
  'WRAPPER_HAS_BYTECODE',
  'WRAPPER_ASSET_RELATION',
  'WRAPPER_VERSION_CURRENT',
] as const;

export type CanonicalityCheckName = (typeof CANONICALITY_CHECK_NAMES)[number];

export interface CanonicalityResult {
  readonly checks: readonly CanonicalityCheck[];
  /** PASS only when every check passed. Any FAIL or UNKNOWN prevents it. */
  readonly outcome: CheckOutcome;
}

/** A canonicality result is PASS only if every check is PASS; any FAIL dominates UNKNOWN. */
export function summarizeCanonicality(checks: readonly CanonicalityCheck[]): CanonicalityResult {
  if (checks.length === 0) {
    return {
      checks,
      outcome: 'UNKNOWN',
    };
  }
  const hasFail = checks.some((c) => c.outcome === 'FAIL');
  const hasUnknown = checks.some((c) => c.outcome === 'UNKNOWN');
  const outcome: CheckOutcome = hasFail ? 'FAIL' : hasUnknown ? 'UNKNOWN' : 'PASS';
  return { checks, outcome };
}

export type SourceAgreement = 'MATCH' | 'MISMATCH' | 'INCOMPLETE';

export interface SourceComparisonField {
  readonly field: 'multiplier' | 'multiplierNonce' | 'scheduledActivation' | 'wrapperAddress';
  readonly agreement: SourceAgreement;
  readonly apiValue: string | undefined;
  readonly chainValue: string | undefined;
}

export interface SourceComparison {
  readonly agreement: SourceAgreement;
  readonly fields: readonly SourceComparisonField[];
}

export interface TolerancePolicy {
  /** Zero for enforcement. A non-zero tolerance is only ever used for alerting. */
  readonly multiplierTolerance: Multiplier;
  /** Permitted difference between API and chain activation instants, in milliseconds. */
  readonly activationToleranceMs: number;
}
