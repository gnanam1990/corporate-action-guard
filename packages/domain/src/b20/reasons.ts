/**
 * B20 reason codes.
 *
 * A separate list from `BLOCK_REASONS`, not an extension of it. The X Layer list is a
 * deployed public contract: it appears in API responses, the SDK, CLI exit behaviour and
 * signed evidence, `orderReasons` sorts by position in that array, and
 * `preflight.test.ts` asserts that every code in it is producible by `evaluatePreflight`.
 * Appending B20 codes there would reorder existing output and break that test for codes the
 * X Layer evaluator can never emit.
 *
 * So B20 gets its own array, its own severity map and its own explanation map, sharing only
 * the `ReasonSeverity` vocabulary and the ordering rule. Renaming a code here is a breaking
 * change requiring an ADR, exactly as on the X Layer side.
 */

import type { ReasonSeverity } from '../reasons.js';

export const B20_REASONS = [
  // Identity — the asset is not the asset the caller thinks it is.
  'B20_UNKNOWN_ASSET',
  'B20_NOT_ON_OFFICIAL_LIST',
  'B20_NOT_FACTORY_INITIALIZED',
  'B20_PREFIX_ONLY_IDENTITY',
  'B20_IDENTITY_DRIFT',
  'B20_FIXTURE_NOT_PRODUCTION',
  'B20_DUPLICATE_ASSET_ADDRESS',

  // Quantity and valuation — the arithmetic itself is unsafe.
  'B20_DOUBLE_MULTIPLIER_APPLIED',
  'B20_PRICE_BASIS_MISMATCH',
  'B20_VALUATION_ROUTE_CONFLICT',
  'B20_DECIMAL_MISMATCH',
  'B20_QUANTITY_OVERFLOW',

  // Lifecycle — the multiplier's state cannot be established.
  'B20_SCHEDULE_NOT_YET_EFFECTIVE',
  'B20_SCHEDULE_CANCELLED',
  'B20_SCHEDULE_SUPERSEDED',
  'B20_UNSUPPORTED_CAPABILITY',
  'B20_MULTIPLIER_CONTINUITY_BROKEN',
  'B20_DUPLICATE_EVENT_GENERATION',
  'B20_UNCLASSIFIED_BUSINESS_EVENT',

  // Price and source — the evidence is degraded.
  'B20_FEED_STALE',
  'B20_FEED_EXPECTED_HOLD',
  'B20_FEED_INVALID_ROUND',
  'B20_ISSUER_PAUSED',
  'B20_SEQUENCER_DOWN',
  'B20_SEQUENCER_GRACE_PERIOD',
  'B20_FEED_PAIRING_UNREVIEWED',
  'B20_FEED_REGISTRY_DISAGREEMENT',

  // Chain and evidence — the observation cannot be trusted or compared.
  'B20_WRONG_CHAIN',
  'B20_RPC_UNAVAILABLE',
  'B20_EVIDENCE_BLOCK_MISMATCH',
  'B20_REORG_DETECTED',
  'B20_REORG_BEYOND_LOOKBACK',
  'B20_TOKEN_PAUSED',
  'B20_POLICY_FORBIDS',

  // Request and operation — the caller's request is rejected on its own terms.
  'B20_UNSUPPORTED_ACTION_CLASS',
  'B20_IDEMPOTENCY_CONFLICT',
  'B20_RECEIPT_BINDING_MISMATCH',
  'B20_MANUAL_REVIEW_REQUIRED',
] as const;

export type B20Reason = (typeof B20_REASONS)[number];

/**
 * Severity, using the same three-way vocabulary as the X Layer codes so one incident queue
 * can order both. There is no numeric risk score anywhere in this product.
 */
export const B20_REASON_SEVERITY: Readonly<Record<B20Reason, ReasonSeverity>> = {
  // A protected action would act on wrong or unverifiable facts.
  B20_NOT_ON_OFFICIAL_LIST: 'SAFETY_CRITICAL',
  B20_NOT_FACTORY_INITIALIZED: 'SAFETY_CRITICAL',
  B20_PREFIX_ONLY_IDENTITY: 'SAFETY_CRITICAL',
  B20_IDENTITY_DRIFT: 'SAFETY_CRITICAL',
  B20_FIXTURE_NOT_PRODUCTION: 'SAFETY_CRITICAL',
  B20_DUPLICATE_ASSET_ADDRESS: 'SAFETY_CRITICAL',
  B20_DOUBLE_MULTIPLIER_APPLIED: 'SAFETY_CRITICAL',
  B20_PRICE_BASIS_MISMATCH: 'SAFETY_CRITICAL',
  B20_VALUATION_ROUTE_CONFLICT: 'SAFETY_CRITICAL',
  B20_MULTIPLIER_CONTINUITY_BROKEN: 'SAFETY_CRITICAL',
  B20_DUPLICATE_EVENT_GENERATION: 'SAFETY_CRITICAL',
  B20_FEED_REGISTRY_DISAGREEMENT: 'SAFETY_CRITICAL',
  B20_WRONG_CHAIN: 'SAFETY_CRITICAL',
  B20_EVIDENCE_BLOCK_MISMATCH: 'SAFETY_CRITICAL',
  B20_REORG_DETECTED: 'SAFETY_CRITICAL',
  B20_REORG_BEYOND_LOOKBACK: 'SAFETY_CRITICAL',
  B20_MANUAL_REVIEW_REQUIRED: 'SAFETY_CRITICAL',
  B20_RECEIPT_BINDING_MISMATCH: 'SAFETY_CRITICAL',

  // Evidence is missing, unreviewed, or too old to decide on.
  B20_UNKNOWN_ASSET: 'EVIDENCE_DEGRADED',
  B20_UNSUPPORTED_CAPABILITY: 'EVIDENCE_DEGRADED',
  B20_UNCLASSIFIED_BUSINESS_EVENT: 'EVIDENCE_DEGRADED',
  B20_FEED_STALE: 'EVIDENCE_DEGRADED',
  B20_FEED_EXPECTED_HOLD: 'EVIDENCE_DEGRADED',
  B20_FEED_INVALID_ROUND: 'EVIDENCE_DEGRADED',
  B20_ISSUER_PAUSED: 'EVIDENCE_DEGRADED',
  B20_SEQUENCER_DOWN: 'EVIDENCE_DEGRADED',
  B20_SEQUENCER_GRACE_PERIOD: 'EVIDENCE_DEGRADED',
  B20_FEED_PAIRING_UNREVIEWED: 'EVIDENCE_DEGRADED',
  B20_RPC_UNAVAILABLE: 'EVIDENCE_DEGRADED',
  B20_TOKEN_PAUSED: 'EVIDENCE_DEGRADED',
  B20_POLICY_FORBIDS: 'EVIDENCE_DEGRADED',
  B20_SCHEDULE_NOT_YET_EFFECTIVE: 'EVIDENCE_DEGRADED',

  // The request is malformed, superseded, or out of scope.
  B20_SCHEDULE_CANCELLED: 'INPUT_REJECTED',
  B20_SCHEDULE_SUPERSEDED: 'INPUT_REJECTED',
  B20_DECIMAL_MISMATCH: 'INPUT_REJECTED',
  B20_QUANTITY_OVERFLOW: 'INPUT_REJECTED',
  B20_UNSUPPORTED_ACTION_CLASS: 'INPUT_REJECTED',
  B20_IDEMPOTENCY_CONFLICT: 'INPUT_REJECTED',
};

const SEVERITY_RANK: Readonly<Record<ReasonSeverity, number>> = {
  SAFETY_CRITICAL: 0,
  EVIDENCE_DEGRADED: 1,
  INPUT_REJECTED: 2,
};

const DECLARATION_RANK: ReadonlyMap<B20Reason, number> = new Map(B20_REASONS.map((r, i) => [r, i]));

/** Severity first, then declaration order. Never input order. Mirrors `orderReasons`. */
export function orderB20Reasons(reasons: readonly B20Reason[]): readonly B20Reason[] {
  const unique = [...new Set(reasons)];
  return unique.sort((a, b) => {
    const bySeverity =
      SEVERITY_RANK[B20_REASON_SEVERITY[a]] - SEVERITY_RANK[B20_REASON_SEVERITY[b]];
    if (bySeverity !== 0) return bySeverity;
    return (DECLARATION_RANK.get(a) ?? 0) - (DECLARATION_RANK.get(b) ?? 0);
  });
}

/**
 * Deterministic operator-facing text, derived from the code alone.
 *
 * The console explains a block without a model and without inventing a cause. Kept beside
 * the codes so a new code cannot be added without one — a test enforces it.
 */
export const B20_REASON_EXPLANATION: Readonly<Record<B20Reason, string>> = {
  B20_UNKNOWN_ASSET:
    'This (chainId, address) is not in the verified asset registry, so no evidence exists to evaluate.',
  B20_NOT_ON_OFFICIAL_LIST:
    'The address is not on the official Coinbase/Base tokenized-stock list, which is the only source of issuer provenance.',
  B20_NOT_FACTORY_INITIALIZED:
    'The B20 factory does not report this address as an initialized B20 token.',
  B20_PREFIX_ONLY_IDENTITY:
    'Identity was asserted from the B20 address prefix alone. The prefix proves format, not that Coinbase issued the asset.',
  B20_IDENTITY_DRIFT:
    'The on-chain name or symbol changed. Identity is unchanged — it is (chainId, address) — but the metadata history must be reviewed.',
  B20_FIXTURE_NOT_PRODUCTION:
    'This is a TESTNET FIXTURE. It can never satisfy production issuer verification.',
  B20_DUPLICATE_ASSET_ADDRESS:
    'Two registry entries claim the same (chainId, address). One address is one asset.',
  B20_DOUBLE_MULTIPLIER_APPLIED:
    'A share-equivalent quantity was combined with a total-return token price. The multiplier is already inside that price, so this applies it twice.',
  B20_PRICE_BASIS_MISMATCH: 'The quantity and the price basis do not form a valid valuation route.',
  B20_VALUATION_ROUTE_CONFLICT:
    'The two valuation routes disagree by more than floor loss can explain. Disagreement is never averaged.',
  B20_DECIMAL_MISMATCH:
    'A declared scale does not match the observed decimals of the token or the feed.',
  B20_QUANTITY_OVERFLOW:
    'The quantity exceeds the bounds the on-chain supply cap and multiplier guard allow.',
  B20_SCHEDULE_NOT_YET_EFFECTIVE:
    'A multiplier update is scheduled but its effectiveAt has not been reached at the evaluated block timestamp.',
  B20_SCHEDULE_CANCELLED: 'The scheduled multiplier update was cancelled before it activated.',
  B20_SCHEDULE_SUPERSEDED: 'An instant multiplier override cleared the pending scheduled update.',
  B20_UNSUPPORTED_CAPABILITY:
    'The chain does not expose the selector this answer requires. This is not a negative answer — the question cannot be asked here.',
  B20_MULTIPLIER_CONTINUITY_BROKEN:
    'The old multiplier in an observed update does not match the previously known current multiplier. The epoch chain is broken.',
  B20_DUPLICATE_EVENT_GENERATION:
    'One multiplier change produced both the legacy and the canonical event. They are one business fact, folded once.',
  B20_UNCLASSIFIED_BUSINESS_EVENT:
    'The on-chain state change is reconciled, but no structured issuer evidence types it as a split, dividend, or reference change.',
  B20_FEED_STALE:
    'The feed round is older than the freshness limit for this action class, with no session policy that explains the hold.',
  B20_FEED_EXPECTED_HOLD:
    'The feed is holding as the declared session policy expects. Valid for display, not for a money-moving decision.',
  B20_FEED_INVALID_ROUND:
    'The round failed validation: a non-positive answer, a zero or future updatedAt, or answeredInRound behind roundId.',
  B20_ISSUER_PAUSED:
    'The issuer has paused this feed, which typically brackets a corporate action.',
  B20_SEQUENCER_DOWN: 'The Base sequencer uptime feed reports the sequencer is down.',
  B20_SEQUENCER_GRACE_PERIOD:
    'The sequencer recovered recently and the configured grace period has not elapsed. Prices during recovery are not yet trustworthy.',
  B20_FEED_PAIRING_UNREVIEWED:
    'The token-to-feed pairing is an unreviewed ticker inference. It is permitted for display only.',
  B20_FEED_REGISTRY_DISAGREEMENT:
    'The feed answer is inconsistent with the verified registry multiplier beyond the documented tolerance.',
  B20_WRONG_CHAIN: 'The evidence was observed on a different chain than the requested action.',
  B20_RPC_UNAVAILABLE: 'The Base RPC could not be reached, so on-chain facts cannot be confirmed.',
  B20_EVIDENCE_BLOCK_MISMATCH:
    'Two observations were read at blocks or rounds that cannot be compared. Absence of comparison is never agreement.',
  B20_REORG_DETECTED:
    'A parent-hash mismatch was observed. Derived state is invalidated and replayed; raw observations are retained.',
  B20_REORG_BEYOND_LOOKBACK:
    'The reorg is deeper than the configured lookback, so history cannot be reconstructed automatically.',
  B20_TOKEN_PAUSED: 'The token has paused the feature this action requires.',
  B20_POLICY_FORBIDS: 'The policy registry does not authorize a party to this operation.',
  B20_UNSUPPORTED_ACTION_CLASS: 'This action class is not configured for this asset or target.',
  B20_IDEMPOTENCY_CONFLICT: 'This idempotency key was already used with a different request body.',
  B20_RECEIPT_BINDING_MISMATCH:
    'The operation fields do not reproduce the digest bound into the receipt.',
  B20_MANUAL_REVIEW_REQUIRED:
    'An open incident requires operator review before protected actions on this asset resume.',
};
