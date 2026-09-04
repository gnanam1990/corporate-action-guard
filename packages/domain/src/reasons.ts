/**
 * Decision reason codes.
 *
 * These are a stable public contract: they appear in API responses, the SDK, the CLI's
 * exit behaviour, the console, and incident evidence. Renaming one is a breaking change
 * requiring an ADR. They are machine-readable first and human-readable second — a code is
 * never derived from a message string.
 */

export const BLOCK_REASONS = [
  'UNKNOWN_ASSET',
  'NON_CANONICAL_TOKEN',
  'NON_CANONICAL_WRAPPER',
  'WRAPPER_ASSET_MISMATCH',
  'OUTDATED_WRAPPER',
  'API_UNAVAILABLE',
  'RPC_UNAVAILABLE',
  'STALE_API_EVIDENCE',
  'STALE_CHAIN_EVIDENCE',
  'SOURCE_MISMATCH',
  'ACTIVATION_WINDOW',
  'UNAPPLIED_CORPORATE_ACTION',
  'MULTIPLIER_NONCE_MISMATCH',
  'INVALID_OPERATION_BINDING',
  'RECEIPT_NOT_YET_VALID',
  'RECEIPT_EXPIRED',
  'RECEIPT_CONSUMED',
  'UNSUPPORTED_CHAIN',
  'EVIDENCE_CHAIN_MISMATCH',
  'UNSUPPORTED_TARGET',
  'UNSUPPORTED_ACTION',
  'MANUAL_REVIEW_REQUIRED',
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Severity category, used for ordering incidents and alerts.
 * Deterministic and finite — there is no numeric "risk score" anywhere in this product.
 */
export type ReasonSeverity = 'SAFETY_CRITICAL' | 'EVIDENCE_DEGRADED' | 'INPUT_REJECTED';

/**
 * Ordering rule: reasons are always reported most-severe first, and within a severity in
 * the declaration order below. A caller reading only the first reason must get the most
 * important one, and the ordering must not depend on object iteration order.
 */
export const REASON_SEVERITY: Readonly<Record<BlockReason, ReasonSeverity>> = {
  // A protected action would act on wrong or unverifiable on-chain facts.
  WRAPPER_ASSET_MISMATCH: 'SAFETY_CRITICAL',
  NON_CANONICAL_TOKEN: 'SAFETY_CRITICAL',
  NON_CANONICAL_WRAPPER: 'SAFETY_CRITICAL',
  OUTDATED_WRAPPER: 'SAFETY_CRITICAL',
  SOURCE_MISMATCH: 'SAFETY_CRITICAL',
  MULTIPLIER_NONCE_MISMATCH: 'SAFETY_CRITICAL',
  ACTIVATION_WINDOW: 'SAFETY_CRITICAL',
  UNAPPLIED_CORPORATE_ACTION: 'SAFETY_CRITICAL',
  MANUAL_REVIEW_REQUIRED: 'SAFETY_CRITICAL',

  // Evidence is missing or too old to decide on.
  API_UNAVAILABLE: 'EVIDENCE_DEGRADED',
  RPC_UNAVAILABLE: 'EVIDENCE_DEGRADED',
  STALE_API_EVIDENCE: 'EVIDENCE_DEGRADED',
  STALE_CHAIN_EVIDENCE: 'EVIDENCE_DEGRADED',
  UNKNOWN_ASSET: 'EVIDENCE_DEGRADED',

  // The request itself is malformed, expired, replayed, or out of scope.
  INVALID_OPERATION_BINDING: 'INPUT_REJECTED',
  RECEIPT_NOT_YET_VALID: 'INPUT_REJECTED',
  RECEIPT_EXPIRED: 'INPUT_REJECTED',
  RECEIPT_CONSUMED: 'INPUT_REJECTED',
  UNSUPPORTED_CHAIN: 'INPUT_REJECTED',
  EVIDENCE_CHAIN_MISMATCH: 'SAFETY_CRITICAL',
  UNSUPPORTED_TARGET: 'INPUT_REJECTED',
  UNSUPPORTED_ACTION: 'INPUT_REJECTED',
};

const SEVERITY_RANK: Readonly<Record<ReasonSeverity, number>> = {
  SAFETY_CRITICAL: 0,
  EVIDENCE_DEGRADED: 1,
  INPUT_REJECTED: 2,
};

const DECLARATION_RANK: ReadonlyMap<BlockReason, number> = new Map(
  BLOCK_REASONS.map((r, i) => [r, i]),
);

/** Deterministic ordering: severity first, then declaration order. Never input order. */
export function orderReasons(reasons: readonly BlockReason[]): readonly BlockReason[] {
  const unique = [...new Set(reasons)];
  return unique.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[REASON_SEVERITY[a]] - SEVERITY_RANK[REASON_SEVERITY[b]];
    if (bySeverity !== 0) return bySeverity;
    return (DECLARATION_RANK.get(a) ?? 0) - (DECLARATION_RANK.get(b) ?? 0);
  });
}

/**
 * Operator-facing explanation templates.
 *
 * Deterministic text derived from the code, so the console can explain a block without an
 * LLM and without inventing a cause. Kept beside the codes so a new code cannot be added
 * without one (enforced by a test).
 */
export const REASON_EXPLANATION: Readonly<Record<BlockReason, string>> = {
  UNKNOWN_ASSET:
    'The asset is not present in the discovered catalog, so no evidence exists to evaluate.',
  NON_CANONICAL_TOKEN:
    'The token address does not match the canonical address declared by the live registry.',
  NON_CANONICAL_WRAPPER:
    'The wrapper address does not match the canonical wrapper declared by the live registry.',
  WRAPPER_ASSET_MISMATCH:
    'The wrapper reports a different underlying asset than the one this operation names.',
  OUTDATED_WRAPPER:
    'This wrapper version is superseded. Only the current wrapper may be used for protected actions.',
  API_UNAVAILABLE:
    'The xStocks API could not be reached, so off-chain agreement cannot be established.',
  RPC_UNAVAILABLE: 'The X Layer RPC could not be reached, so on-chain facts cannot be confirmed.',
  STALE_API_EVIDENCE:
    'The most recent API observation is older than the freshness limit for authorizing an action.',
  STALE_CHAIN_EVIDENCE:
    'The most recent chain observation is older than the freshness limit for authorizing an action.',
  SOURCE_MISMATCH:
    'The API and on-chain observations disagree. Disagreement always blocks; it is never averaged or ignored.',
  ACTIVATION_WINDOW:
    'The current time falls inside the guard window around a scheduled multiplier activation.',
  UNAPPLIED_CORPORATE_ACTION:
    'The activation window has passed but the scheduled corporate action remains unapplied.',
  MULTIPLIER_NONCE_MISMATCH:
    'The multiplier nonce in the request does not equal the current on-chain nonce.',
  INVALID_OPERATION_BINDING: 'The operation fields do not reproduce the bound operation digest.',
  RECEIPT_NOT_YET_VALID: 'The receipt validity window has not started.',
  RECEIPT_EXPIRED: 'The receipt validity window has ended.',
  RECEIPT_CONSUMED:
    'This receipt has already been consumed. A receipt authorizes exactly one action.',
  UNSUPPORTED_CHAIN: 'The requested chain is not a supported target for protected actions.',
  EVIDENCE_CHAIN_MISMATCH:
    'The evidence was observed on a different chain than the requested protected action.',
  UNSUPPORTED_TARGET: 'The requested target is not configured for protected actions.',
  UNSUPPORTED_ACTION: 'The requested action type is not supported by the configured target.',
  MANUAL_REVIEW_REQUIRED:
    'An open incident requires operator review before protected actions on this asset resume.',
};
