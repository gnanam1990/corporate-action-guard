/**
 * B20 preflight: one decision, bound to one exact operation.
 *
 * The X Layer evaluator in `preflight.ts` is untouched and stays byte-compatible. This is a
 * separate evaluator because the question is genuinely different: B20 decisions vary by
 * *action class*. Displaying a position tolerates an hours-old price; a liquidation check
 * does not. The same evidence is simultaneously sufficient and inadequate depending on what
 * it is for, and a single freshness threshold cannot express that.
 *
 * So the requirements are a versioned data table rather than a chain of `if`s. That matters
 * for a reason beyond tidiness: a policy version travels with every decision, and a changed
 * policy invalidates cached decisions. A rule buried in control flow has no version.
 *
 * Pure. No clock, no I/O, no receipt issuance — issuing a receipt requires re-reading the
 * evidence inside a bounded window, which is a different module and a later step.
 */

import type { B20Reason } from './reasons.js';

/**
 * Action classes.
 *
 * The canonical list. `@cag/chainlink-reader` imports it rather than declaring its own, so a
 * class added here cannot be silently missing a freshness rule there.
 */
export const B20_ACTION_CLASSES = [
  'DISPLAY_POSITION',
  'QUOTE',
  'TRANSFER',
  'VAULT_DEPOSIT',
  'VAULT_WITHDRAW',
  'COLLATERAL_VALUE',
  'LIQUIDATION_CHECK',
  'INDEX_REBALANCE',
  'AGENT_ORDER',
] as const;
export type B20ActionClass = (typeof B20_ACTION_CLASSES)[number];

export const B20_DECISIONS = ['ALLOW', 'BLOCK', 'REVIEW'] as const;
export type B20Decision = (typeof B20_DECISIONS)[number];

/**
 * What one action class requires.
 *
 * `movesValue` is not decoration. It is what separates a class that may proceed on a
 * labelled non-actionable price from one that may not, and it is asserted against the
 * freshness rules so the two tables cannot drift apart.
 */
export interface B20EvidenceRequirement {
  /** True when a wrong answer moves someone's money. */
  readonly movesValue: boolean;
  /** Identity must be VERIFIED, not merely known. */
  readonly requiresVerifiedIdentity: boolean;
  /** A price is required at all. */
  readonly requiresPrice: boolean;
  /** The price must be FRESH — not merely present, and never an EXPECTED_HOLD. */
  readonly requiresActionablePrice: boolean;
  /** The token-to-feed pairing must be REVIEWED_VERIFIED, not an inference. */
  readonly requiresReviewedPairing: boolean;
  /** The sequencer must be up and past its recovery grace. */
  readonly requiresHealthySequencer: boolean;
  /** The chain must be able to answer whether an update is scheduled. */
  readonly requiresScheduleVisibility: boolean;
  /** A pending activation inside the guard window blocks. */
  readonly blockedByGuardWindow: boolean;
  /** The operation must name a configured target contract. */
  readonly requiresConfiguredTarget: boolean;
}

export interface B20PolicyMatrix {
  readonly version: string;
  readonly rules: Readonly<Record<B20ActionClass, B20EvidenceRequirement>>;
}

const displayOnly: B20EvidenceRequirement = {
  movesValue: false,
  requiresVerifiedIdentity: true,
  requiresPrice: false,
  requiresActionablePrice: false,
  requiresReviewedPairing: false,
  requiresHealthySequencer: false,
  requiresScheduleVisibility: false,
  blockedByGuardWindow: false,
  requiresConfiguredTarget: false,
};

const movesValue: B20EvidenceRequirement = {
  movesValue: true,
  requiresVerifiedIdentity: true,
  requiresPrice: true,
  requiresActionablePrice: true,
  requiresReviewedPairing: true,
  requiresHealthySequencer: true,
  requiresScheduleVisibility: true,
  blockedByGuardWindow: true,
  requiresConfiguredTarget: true,
};

/**
 * The default matrix.
 *
 * `DISPLAY_POSITION` is the only class that may proceed without a price, and it is the only
 * one that does not require a reviewed token-to-feed pairing — which is exactly the boundary
 * `provenance/base-b20/token-feed-pairing.json` draws. Since every pairing is currently
 * `INFERRED_UNREVIEWED`, on today's data this matrix allows display and refuses everything
 * else, and that is the honest position rather than an accident.
 */
export const DEFAULT_B20_POLICY: B20PolicyMatrix = {
  version: '2026-09-07.1',
  rules: {
    DISPLAY_POSITION: displayOnly,
    // A quote is shown to a human who is about to act on it, so it needs a real price — but
    // it does not itself move funds, so it does not need a configured target.
    QUOTE: { ...movesValue, movesValue: false, requiresConfiguredTarget: false },
    TRANSFER: movesValue,
    VAULT_DEPOSIT: movesValue,
    VAULT_WITHDRAW: movesValue,
    COLLATERAL_VALUE: movesValue,
    LIQUIDATION_CHECK: movesValue,
    INDEX_REBALANCE: movesValue,
    AGENT_ORDER: movesValue,
  },
};

/** The evidence a decision is made from. Every field distinguishes absent from negative. */
export interface B20PreflightEvidence {
  /** VERIFIED / CHANGED / CONFLICT / RETIRED / UNKNOWN, or undefined if not looked up. */
  readonly identityStatus: string | undefined;
  readonly isFixture: boolean;
  readonly targetConfigured: boolean;
  /** FRESH / EXPECTED_HOLD / STALE / ISSUER_PAUSED / SEQUENCER_UNAVAILABLE / INVALID_ROUND. */
  readonly priceVerdict: string | undefined;
  readonly pairingReviewed: boolean;
  readonly sequencerHealthy: boolean | undefined;
  readonly tokenPaused: boolean;
  /** LIVE / NOT_DIALED / REVERTED / UNAVAILABLE. */
  readonly scheduleCapability: string;
  /** Seconds until a pending activation, when one is visible. */
  readonly secondsUntilActivation: bigint | undefined;
  readonly guardWindowSeconds: bigint;
  /** Every observation used came from one comparable block. */
  readonly evidenceBlocksComparable: boolean;
  readonly openIncident: boolean;
  /** Journal event ids behind this decision. */
  readonly evidenceEventIds: readonly string[];
}

/** The operation the decision is bound to. Changing any field changes the decision. */
export interface B20Operation {
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly chainId: number;
  readonly assetAddress: string;
  readonly actionClass: B20ActionClass;
  readonly sender: string;
  readonly recipient: string;
  readonly rawAmount: bigint;
  readonly targetContract: string;
  /** Hash of the canonical operation payload, so the receipt can bind to it exactly. */
  readonly operationDigest: string;
  /** The multiplier the caller believes is active. A mismatch is not a warning. */
  readonly expectedMultiplierWad: bigint;
  readonly integrationPolicyVersion: string;
}

export interface B20PreflightResult {
  readonly decision: B20Decision;
  readonly reasons: readonly B20Reason[];
  readonly actionClass: B20ActionClass;
  readonly policyVersion: string;
  /** Only ever true for ALLOW. A receipt still requires re-verification at issuance. */
  readonly receiptEligible: boolean;
  readonly evaluatedAtSeconds: bigint;
  readonly expiresAtSeconds: bigint;
  readonly evidenceEventIds: readonly string[];
  /** Human-readable, derived from the codes. Never generated by a model. */
  readonly explanation: string;
}

export interface B20PreflightInput {
  readonly operation: B20Operation;
  readonly evidence: B20PreflightEvidence;
  readonly observedMultiplierWad: bigint | undefined;
  /** Block timestamp of the evaluation. Never a wall clock. */
  readonly evaluateAtSeconds: bigint;
  readonly resultTtlSeconds: bigint;
  readonly policy?: B20PolicyMatrix;
}

/**
 * Decide.
 *
 * Ordered so the most fundamental problem is reported first: an operation against the wrong
 * asset is worse than one against a stale price, and an operator reading only the first
 * reason must get the one that matters.
 *
 * Nothing here has a catch-all. Every path that does not accumulate a blocking reason falls
 * through to ALLOW explicitly, so an unhandled case is a compile error rather than a silent
 * authorization.
 */
export function evaluateB20Preflight(input: B20PreflightInput): B20PreflightResult {
  const policy = input.policy ?? DEFAULT_B20_POLICY;
  const rule = policy.rules[input.operation.actionClass];
  const evidence = input.evidence;
  const reasons: B20Reason[] = [];
  let review = false;

  // Identity.
  if (evidence.isFixture) reasons.push('B20_FIXTURE_NOT_PRODUCTION');
  if (evidence.identityStatus === undefined) {
    reasons.push('B20_UNKNOWN_ASSET');
  } else if (evidence.identityStatus === 'CONFLICT') {
    reasons.push('B20_IDENTITY_DRIFT');
  } else if (evidence.identityStatus === 'CHANGED') {
    // A rename does not change identity, so this is not a block — but a symbol that suddenly
    // reads like another asset's is how a display-layer confusion starts, so it needs a look.
    reasons.push('B20_IDENTITY_DRIFT');
    review = true;
  } else if (evidence.identityStatus !== 'VERIFIED' && rule.requiresVerifiedIdentity) {
    reasons.push('B20_NOT_ON_OFFICIAL_LIST');
  }

  // Comparability. Two facts from different heights describe two different worlds, and the
  // agreement or conflict that falls out of comparing them is an artifact of timing.
  if (!evidence.evidenceBlocksComparable) reasons.push('B20_EVIDENCE_BLOCK_MISMATCH');

  // The caller's assumed multiplier against the observed one. Not a warning: an operation
  // sized against the wrong multiplier is the wrong size.
  if (evidence.identityStatus !== undefined) {
    if (input.observedMultiplierWad === undefined) {
      reasons.push('B20_RPC_UNAVAILABLE');
    } else if (input.observedMultiplierWad !== input.operation.expectedMultiplierWad) {
      reasons.push('B20_MULTIPLIER_CONTINUITY_BROKEN');
    }
  }

  // Target.
  if (rule.requiresConfiguredTarget && !evidence.targetConfigured) {
    reasons.push('B20_UNSUPPORTED_ACTION_CLASS');
  }

  // Pause.
  if (evidence.tokenPaused) reasons.push('B20_TOKEN_PAUSED');

  // Schedule visibility, and the guard window around an activation.
  if (rule.requiresScheduleVisibility && evidence.scheduleCapability !== 'LIVE') {
    // On Base mainnet today this fires for every value-moving action, and that is the
    // truthful position: the chain cannot be asked whether an action is coming, so a
    // money-moving decision cannot claim to have checked.
    reasons.push('B20_UNSUPPORTED_CAPABILITY');
  }
  if (
    rule.blockedByGuardWindow &&
    evidence.secondsUntilActivation !== undefined &&
    evidence.secondsUntilActivation > 0n &&
    evidence.secondsUntilActivation <= evidence.guardWindowSeconds
  ) {
    reasons.push('B20_SCHEDULE_NOT_YET_EFFECTIVE');
  }

  // Price.
  if (rule.requiresReviewedPairing && !evidence.pairingReviewed) {
    reasons.push('B20_FEED_PAIRING_UNREVIEWED');
  }
  if (rule.requiresPrice) {
    if (evidence.priceVerdict === undefined) {
      reasons.push('B20_RPC_UNAVAILABLE');
    } else if (rule.requiresActionablePrice && evidence.priceVerdict !== 'FRESH') {
      reasons.push(priceReason(evidence.priceVerdict));
    }
  }

  // Sequencer.
  if (rule.requiresHealthySequencer) {
    if (evidence.sequencerHealthy === undefined) reasons.push('B20_RPC_UNAVAILABLE');
    else if (!evidence.sequencerHealthy) reasons.push('B20_SEQUENCER_DOWN');
  }

  // An operator has already said this needs a human.
  if (evidence.openIncident) {
    reasons.push('B20_MANUAL_REVIEW_REQUIRED');
    review = true;
  }

  const decision: B20Decision =
    reasons.length === 0 ? 'ALLOW' : review && !hasHardBlock(reasons) ? 'REVIEW' : 'BLOCK';

  return {
    decision,
    reasons: dedupe(reasons),
    actionClass: input.operation.actionClass,
    policyVersion: policy.version,
    // Eligible, not issued. Issuance re-reads every mandatory source inside a bounded window
    // and requires the result to still be ALLOW; signing from this flag would sign a stale one.
    receiptEligible: decision === 'ALLOW' && rule.movesValue,
    evaluatedAtSeconds: input.evaluateAtSeconds,
    expiresAtSeconds: input.evaluateAtSeconds + input.resultTtlSeconds,
    evidenceEventIds: evidence.evidenceEventIds,
    explanation: explain(decision, dedupe(reasons)),
  };
}

/**
 * Whether any reason is a hard block rather than something a human could sign off.
 *
 * A stale price is a REVIEW candidate only when nothing worse is present. A wrong asset is
 * never one: no amount of operator confidence makes an operation against the wrong contract
 * safe.
 */
function hasHardBlock(reasons: readonly B20Reason[]): boolean {
  const hard: readonly B20Reason[] = [
    'B20_FIXTURE_NOT_PRODUCTION',
    'B20_NOT_ON_OFFICIAL_LIST',
    'B20_UNKNOWN_ASSET',
    'B20_EVIDENCE_BLOCK_MISMATCH',
    'B20_MULTIPLIER_CONTINUITY_BROKEN',
    'B20_UNSUPPORTED_ACTION_CLASS',
    'B20_TOKEN_PAUSED',
    'B20_SEQUENCER_DOWN',
    'B20_FEED_PAIRING_UNREVIEWED',
    'B20_UNSUPPORTED_CAPABILITY',
    'B20_SCHEDULE_NOT_YET_EFFECTIVE',
    'B20_FEED_STALE',
    'B20_FEED_EXPECTED_HOLD',
    'B20_FEED_INVALID_ROUND',
    'B20_ISSUER_PAUSED',
    'B20_RPC_UNAVAILABLE',
  ];
  return reasons.some((r) => hard.includes(r));
}

function priceReason(verdict: string): B20Reason {
  switch (verdict) {
    case 'EXPECTED_HOLD':
      return 'B20_FEED_EXPECTED_HOLD';
    case 'STALE':
      return 'B20_FEED_STALE';
    case 'ISSUER_PAUSED':
      return 'B20_ISSUER_PAUSED';
    case 'SEQUENCER_UNAVAILABLE':
      return 'B20_SEQUENCER_DOWN';
    case 'INVALID_ROUND':
      return 'B20_FEED_INVALID_ROUND';
    default:
      return 'B20_FEED_STALE';
  }
}

function dedupe(reasons: readonly B20Reason[]): readonly B20Reason[] {
  return [...new Set(reasons)];
}

function explain(decision: B20Decision, reasons: readonly B20Reason[]): string {
  if (decision === 'ALLOW') return 'Every mandatory source for this action class agrees.';
  const verb = decision === 'REVIEW' ? 'needs operator review' : 'is blocked';
  return `This operation ${verb}: ${reasons.join(', ')}.`;
}

/**
 * Canonicalize an operation for hashing and idempotency.
 *
 * Field order is fixed and every value is a string, so two callers who serialize their JSON
 * differently still produce the same bytes. Idempotency that depended on key order would
 * treat a reformatted request as a different one and issue a second receipt.
 */
export function canonicalizeB20Operation(operation: B20Operation): string {
  return JSON.stringify([
    ['actionClass', operation.actionClass],
    ['assetAddress', operation.assetAddress.toLowerCase()],
    ['chainId', String(operation.chainId)],
    ['clientRequestId', operation.clientRequestId],
    ['expectedMultiplierWad', operation.expectedMultiplierWad.toString()],
    ['integrationPolicyVersion', operation.integrationPolicyVersion],
    ['operationDigest', operation.operationDigest.toLowerCase()],
    ['rawAmount', operation.rawAmount.toString()],
    ['recipient', operation.recipient.toLowerCase()],
    ['sender', operation.sender.toLowerCase()],
    ['targetContract', operation.targetContract.toLowerCase()],
  ]);
}
