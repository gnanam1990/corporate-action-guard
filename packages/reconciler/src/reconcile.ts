import {
  compareSources,
  deriveLifecycleState,
  instant,
  millis,
  orderReasons,
  type ApiObservation,
  type BlockReason,
  type ChainObservation,
  type Instant,
  type LifecycleState,
  type Millis,
  type SourceComparison,
  type TolerancePolicy,
} from '@cag/domain';
import type { CanonicalityRecord } from './canonicality.js';

/**
 * The deterministic reconciler.
 *
 * Takes immutable observations and a caller-supplied `now`, and returns the state those
 * facts imply plus the evidence events that should be journaled. It is a pure function:
 * it does not write projections, does not sign receipts, does not call a source, and does
 * not read a clock. That is what makes replay produce byte-identical decisions.
 */

export interface ReconcilePolicy {
  readonly tolerance: TolerancePolicy;
  readonly guardBefore: Millis;
  readonly guardAfter: Millis;
  readonly apiMaxAge: Millis;
  readonly chainMaxAge: Millis;
  /** Version stamped onto every decision, so a replay can report which rules produced it. */
  readonly policyVersion: string;
}

export interface ReconcileInput {
  readonly assetId: string;
  readonly api: ApiObservation | undefined;
  readonly chain: ChainObservation | undefined;
  readonly canonicality: CanonicalityRecord | undefined;
  /** Whether the chain observation was complete. A partial read cannot support agreement. */
  readonly chainComplete: boolean;
  readonly previousState: LifecycleState;
  readonly manualReviewOpen: boolean;
  /** Multiplier change already observed as effective on chain. */
  readonly appliedOnChain: boolean;
}

export type ReconcileOutcome =
  'MATCHED' | 'MISMATCHED' | 'INCOMPLETE_EVIDENCE' | 'SOURCE_UNAVAILABLE';

export interface ReconcileDecision {
  readonly assetId: string;
  readonly outcome: ReconcileOutcome;
  readonly state: LifecycleState;
  readonly previousState: LifecycleState;
  readonly comparison: SourceComparison | undefined;
  /** Ordered, deduplicated reasons the asset is not currently safe to act on. */
  readonly blockReasons: readonly BlockReason[];
  /**
   * Stable signature of the reason set. A repeating identical mismatch updates one
   * incident rather than creating an unbounded stream of duplicates.
   */
  readonly reasonSignature: string;
  readonly apiEvidenceAgeMs: number | undefined;
  readonly chainEvidenceAgeMs: number | undefined;
  readonly policyVersion: string;
  readonly evaluatedAtMs: number;
}

/** Deterministic and order-independent: derived from the ordered reason list. */
export function reasonSignature(reasons: readonly BlockReason[]): string {
  return orderReasons(reasons).join('|');
}

/**
 * Reconcile one asset.
 *
 * The order of checks encodes priority: a source that is entirely unavailable is reported
 * as unavailable rather than as a mismatch, because "we could not look" and "they
 * disagree" need different operator responses and different alerts.
 */
export function reconcileAsset(
  input: ReconcileInput,
  policy: ReconcilePolicy,
  now: Instant,
): ReconcileDecision {
  const reasons: BlockReason[] = [];

  const apiAge =
    input.api === undefined ? undefined : Math.max(0, now - input.api.provenance.observedAt);
  const chainAge =
    input.chain === undefined ? undefined : Math.max(0, now - input.chain.provenance.observedAt);

  if (input.api === undefined) reasons.push('API_UNAVAILABLE');
  else if (apiAge !== undefined && apiAge >= policy.apiMaxAge) reasons.push('STALE_API_EVIDENCE');

  if (input.chain === undefined) reasons.push('RPC_UNAVAILABLE');
  else if (chainAge !== undefined && chainAge >= policy.chainMaxAge)
    reasons.push('STALE_CHAIN_EVIDENCE');

  if (input.canonicality === undefined) {
    reasons.push('NON_CANONICAL_TOKEN', 'NON_CANONICAL_WRAPPER');
  } else if (input.canonicality.outcome !== 'PASS') {
    for (const check of input.canonicality.checks) {
      if (check.outcome === 'PASS') continue;
      switch (check.name) {
        case 'TOKEN_MATCHES_REGISTRY':
        case 'TOKEN_HAS_BYTECODE':
          reasons.push('NON_CANONICAL_TOKEN');
          break;
        case 'WRAPPER_MATCHES_REGISTRY':
        case 'WRAPPER_HAS_BYTECODE':
          reasons.push('NON_CANONICAL_WRAPPER');
          break;
        case 'WRAPPER_ASSET_RELATION':
          reasons.push('WRAPPER_ASSET_MISMATCH');
          break;
        case 'WRAPPER_VERSION_CURRENT':
          reasons.push('OUTDATED_WRAPPER');
          break;
      }
    }
  }

  // Source agreement is only meaningful when both sides actually reported. A partial chain
  // read is not a disagreement — it is an absence, and it is already reported above.
  let comparison: SourceComparison | undefined;
  if (input.api !== undefined && input.chain !== undefined && input.chainComplete) {
    comparison = compareSources(input.api, input.chain, policy.tolerance);
    if (comparison.agreement !== 'MATCH') reasons.push('SOURCE_MISMATCH');
  }

  if (input.manualReviewOpen) reasons.push('MANUAL_REVIEW_REQUIRED');

  const scheduledActivation = input.chain?.scheduledActivation ?? input.api?.scheduledActivation;

  let state = deriveLifecycleState(
    {
      ...(scheduledActivation !== undefined ? { scheduledActivation } : {}),
      guardBefore: policy.guardBefore,
      guardAfter: policy.guardAfter,
      sourcesMismatched: comparison !== undefined && comparison.agreement !== 'MATCH',
      manualReviewOpen: input.manualReviewOpen,
      appliedOnChain: input.appliedOnChain,
      reconciled: input.previousState === 'RECONCILED' && reasons.length === 0,
    },
    now,
  );

  const outcome: ReconcileOutcome =
    input.api === undefined || input.chain === undefined
      ? 'SOURCE_UNAVAILABLE'
      : !input.chainComplete || comparison === undefined
        ? 'INCOMPLETE_EVIDENCE'
        : comparison.agreement === 'MATCH' && reasons.length === 0
          ? 'MATCHED'
          : 'MISMATCHED';

  // These two states require memory of the recorded lifecycle and therefore cannot be
  // derived by the memoryless lifecycle helper alone. A review only recovers after a new
  // complete match; an applied change becomes reconciled on the following complete match.
  if (outcome === 'MATCHED' && reasons.length === 0) {
    if (input.previousState === 'MANUAL_REVIEW') state = 'RECOVERED';
    else if (input.previousState === 'APPLIED' || input.previousState === 'RECOVERED') {
      state = 'RECONCILED';
    }
  }

  const ordered = orderReasons(reasons);

  return {
    assetId: input.assetId,
    outcome,
    state,
    previousState: input.previousState,
    comparison,
    blockReasons: ordered,
    reasonSignature: ordered.join('|'),
    apiEvidenceAgeMs: apiAge,
    chainEvidenceAgeMs: chainAge,
    policyVersion: policy.policyVersion,
    evaluatedAtMs: now,
  };
}

/**
 * Can a manual review resolution move this asset to RECOVERED?
 *
 * **Only if the evidence itself now agrees.** An operator records a decision; they do not
 * assert that two sources concur. If the sources still disagree, the resolution is
 * recorded and protected actions stay blocked (ADR 0002).
 */
export function canRecover(decision: ReconcileDecision): boolean {
  return decision.outcome === 'MATCHED' && decision.blockReasons.length === 0;
}

/** Convenience for callers assembling a policy from configuration. */
export function defaultPolicy(over: Partial<ReconcilePolicy> = {}): ReconcilePolicy {
  return {
    tolerance: {
      multiplierTolerance: { value: 0n, decimals: 0 },
      activationToleranceMs: 0,
      requiredAgreementFields: ['multiplier', 'scheduledActivation', 'wrapperAddress'],
    },
    guardBefore: millis(15 * 60_000),
    guardAfter: millis(15 * 60_000),
    apiMaxAge: millis(5 * 60_000),
    chainMaxAge: millis(2 * 60_000),
    policyVersion: '1.0.0',
    ...over,
  };
}

export { instant };
