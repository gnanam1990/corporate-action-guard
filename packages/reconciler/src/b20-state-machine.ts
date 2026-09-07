/**
 * The B20 reconciliation state machine.
 *
 * Turns evidence into one operational status an operator can act on, with a reason for every
 * transition and a proof test for every edge.
 *
 * The rule that shapes it: **missing data never equals a match.** A transition to VERIFIED
 * requires every mandatory input to be present, comparable and in agreement. An absent feed,
 * an unreachable RPC, an unreviewed pairing and a capability the chain does not expose all
 * lead away from VERIFIED, each by its own named path — because an operator needs to know
 * which of those it is before deciding what to do.
 *
 * Recovery needs *new evidence and a new transition*. There is no path that edits a state
 * back to healthy, which is what makes the transition history worth reading.
 *
 * Pure: transitions in, transition out. Journaling is the caller's job, and it happens before
 * any projection updates.
 */

import type { B20Reason } from '@cag/domain';

export const B20_STATES = [
  'DISCOVERED',
  'OBSERVING',
  'NORMAL',
  'ACTION_PENDING',
  'GUARD_WINDOW',
  'ACTION_EFFECTIVE',
  'RECONCILING',
  'VERIFIED',
  'CONFLICT',
  'INSUFFICIENT_EVIDENCE',
  'REORGED',
  'MANUAL_REVIEW',
  'RECOVERING',
  'UNSUPPORTED',
] as const;
export type B20State = (typeof B20_STATES)[number];

/** States a run can end in without further evidence arriving. */
const TERMINAL_UNTIL_NEW_EVIDENCE = new Set<B20State>([
  'VERIFIED',
  'CONFLICT',
  'MANUAL_REVIEW',
  'UNSUPPORTED',
]);

/**
 * Everything a transition may look at.
 *
 * Every field is explicit about the difference between "false" and "unknown". `feedFresh:
 * undefined` means the feed was not read; `false` means it was read and is not fresh. The
 * machine treats those differently, and flattening them into a boolean is how a source
 * outage becomes a confident answer.
 */
export interface B20MachineInput {
  readonly assetVerified: boolean | undefined;
  readonly assetIsFixture: boolean;
  readonly capabilityScheduledUpdates: 'LIVE' | 'NOT_DIALED' | 'REVERTED' | 'UNAVAILABLE';
  readonly rpcReachable: boolean;
  readonly pendingSchedule: { readonly effectiveAtSeconds: bigint } | undefined;
  readonly guardWindowSeconds: bigint;
  readonly evaluateAtSeconds: bigint;
  readonly feedVerdict:
    | 'FRESH'
    | 'EXPECTED_HOLD'
    | 'STALE'
    | 'ISSUER_PAUSED'
    | 'SEQUENCER_UNAVAILABLE'
    | 'INVALID_ROUND'
    | undefined;
  readonly feedPairingReviewed: boolean;
  readonly tokenPaused: boolean;
  readonly caseOutcome:
    'VERIFIED' | 'PENDING' | 'CONFLICT' | 'INSUFFICIENT_EVIDENCE' | 'MANUAL_REVIEW' | undefined;
  readonly reorgDetected: boolean;
  readonly reorgBeyondLookback: boolean;
  /** Evidence observed at incompatible blocks cannot be compared, whatever it says. */
  readonly evidenceBlocksComparable: boolean;
  /** A changed policy version invalidates a cached decision. */
  readonly policyVersion: string;
  readonly openIncident: boolean;
}

export interface B20Transition {
  readonly from: B20State;
  readonly to: B20State;
  readonly reasons: readonly B20Reason[];
  readonly detail: string;
  /** Deterministic from the reasons, never a score. */
  readonly severity: 'SAFETY_CRITICAL' | 'EVIDENCE_DEGRADED' | 'INPUT_REJECTED' | 'INFORMATIONAL';
  readonly policyVersion: string;
  readonly atSeconds: bigint;
}

/**
 * Legal transitions.
 *
 * Enumerated rather than implied, so an impossible transition is rejected rather than
 * silently accepted by whatever code path produced it. Recovery goes through RECOVERING; a
 * jump straight from CONFLICT to VERIFIED does not exist.
 */
const LEGAL: Readonly<Record<B20State, readonly B20State[]>> = {
  DISCOVERED: ['OBSERVING', 'UNSUPPORTED', 'INSUFFICIENT_EVIDENCE', 'CONFLICT'],
  OBSERVING: ['NORMAL', 'INSUFFICIENT_EVIDENCE', 'CONFLICT', 'UNSUPPORTED', 'REORGED'],
  NORMAL: [
    'ACTION_PENDING',
    'ACTION_EFFECTIVE',
    'INSUFFICIENT_EVIDENCE',
    'CONFLICT',
    'REORGED',
    'MANUAL_REVIEW',
    'NORMAL',
  ],
  ACTION_PENDING: ['GUARD_WINDOW', 'NORMAL', 'CONFLICT', 'REORGED', 'INSUFFICIENT_EVIDENCE'],
  GUARD_WINDOW: ['ACTION_EFFECTIVE', 'NORMAL', 'CONFLICT', 'REORGED', 'MANUAL_REVIEW'],
  ACTION_EFFECTIVE: ['RECONCILING', 'CONFLICT', 'REORGED', 'INSUFFICIENT_EVIDENCE'],
  RECONCILING: ['VERIFIED', 'CONFLICT', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'REORGED'],
  VERIFIED: ['NORMAL', 'ACTION_PENDING', 'REORGED', 'CONFLICT', 'MANUAL_REVIEW'],
  CONFLICT: ['RECOVERING', 'MANUAL_REVIEW', 'REORGED'],
  INSUFFICIENT_EVIDENCE: ['RECOVERING', 'OBSERVING', 'MANUAL_REVIEW', 'REORGED'],
  REORGED: ['RECOVERING', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['RECOVERING'],
  RECOVERING: ['NORMAL', 'OBSERVING', 'VERIFIED', 'CONFLICT', 'MANUAL_REVIEW'],
  UNSUPPORTED: ['DISCOVERED', 'OBSERVING'],
};

export function isLegalTransition(from: B20State, to: B20State): boolean {
  return (LEGAL[from] ?? []).includes(to);
}

export function allLegalB20Transitions(): readonly { from: B20State; to: B20State }[] {
  return B20_STATES.flatMap((from) => (LEGAL[from] ?? []).map((to) => ({ from, to })));
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';
  constructor(from: B20State, to: B20State) {
    super(`${from} -> ${to} is not a legal transition`);
  }
}

const SEVERITY_OF: Readonly<Record<B20State, B20Transition['severity']>> = {
  DISCOVERED: 'INFORMATIONAL',
  OBSERVING: 'INFORMATIONAL',
  NORMAL: 'INFORMATIONAL',
  ACTION_PENDING: 'INFORMATIONAL',
  GUARD_WINDOW: 'EVIDENCE_DEGRADED',
  ACTION_EFFECTIVE: 'INFORMATIONAL',
  RECONCILING: 'INFORMATIONAL',
  VERIFIED: 'INFORMATIONAL',
  CONFLICT: 'SAFETY_CRITICAL',
  INSUFFICIENT_EVIDENCE: 'EVIDENCE_DEGRADED',
  REORGED: 'SAFETY_CRITICAL',
  MANUAL_REVIEW: 'SAFETY_CRITICAL',
  RECOVERING: 'EVIDENCE_DEGRADED',
  UNSUPPORTED: 'EVIDENCE_DEGRADED',
};

/**
 * Decide the next state.
 *
 * The order below is the priority order, and it is deliberate: a reorg invalidates everything
 * derived from the replaced branch, so it is checked before any conclusion drawn from that
 * branch's data. Identity comes next, because evidence about the wrong asset is worse than
 * no evidence. Only then does freshness matter.
 */
export function nextB20State(from: B20State, input: B20MachineInput): B20Transition {
  const reasons: B20Reason[] = [];

  const transition = (to: B20State, detail: string): B20Transition => {
    if (!isLegalTransition(from, to)) throw new IllegalTransitionError(from, to);
    return {
      from,
      to,
      reasons,
      detail,
      severity: SEVERITY_OF[to],
      policyVersion: input.policyVersion,
      atSeconds: input.evaluateAtSeconds,
    };
  };

  // 1. A reorg invalidates every conclusion drawn from the replaced branch.
  if (input.reorgBeyondLookback) {
    reasons.push('B20_REORG_BEYOND_LOOKBACK');
    return transition(
      isLegalTransition(from, 'MANUAL_REVIEW') ? 'MANUAL_REVIEW' : 'REORGED',
      'the reorg is deeper than the retained lookback; history cannot be reconstructed automatically',
    );
  }
  if (input.reorgDetected) {
    reasons.push('B20_REORG_DETECTED');
    return transition('REORGED', 'a parent-hash mismatch invalidated derived state');
  }

  // 2. Identity. Evidence about the wrong asset is worse than no evidence.
  if (input.assetIsFixture) {
    reasons.push('B20_FIXTURE_NOT_PRODUCTION');
    return transition('UNSUPPORTED', 'a TESTNET FIXTURE never reaches a production route');
  }
  if (input.assetVerified === undefined) {
    reasons.push('B20_UNKNOWN_ASSET');
    return transition('INSUFFICIENT_EVIDENCE', 'asset identity has not been established');
  }
  if (!input.assetVerified) {
    reasons.push('B20_NOT_ON_OFFICIAL_LIST');
    return transition('CONFLICT', 'asset identity did not verify against the official list');
  }

  // 3. Can we see the chain at all?
  if (!input.rpcReachable) {
    reasons.push('B20_RPC_UNAVAILABLE');
    return transition(
      isLegalTransition(from, 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'OBSERVING',
      'the Base RPC could not be reached; nothing is known about current state',
    );
  }
  if (!input.evidenceBlocksComparable) {
    // Two facts from different heights describe two different worlds. The agreement or
    // conflict that falls out of comparing them is an artifact of timing.
    reasons.push('B20_EVIDENCE_BLOCK_MISMATCH');
    return transition('CONFLICT', 'evidence was observed at blocks that cannot be compared');
  }

  // 4. An operator has already said this needs a human.
  if (input.openIncident) {
    reasons.push('B20_MANUAL_REVIEW_REQUIRED');
    return transition(
      isLegalTransition(from, 'MANUAL_REVIEW') ? 'MANUAL_REVIEW' : 'RECOVERING',
      'an open incident blocks protected actions on this asset',
    );
  }

  // 5. The case, when correlation produced one.
  if (input.caseOutcome === 'CONFLICT') {
    reasons.push('B20_MULTIPLIER_CONTINUITY_BROKEN');
    return transition('CONFLICT', 'correlated evidence for this action disagrees');
  }
  if (input.caseOutcome === 'MANUAL_REVIEW') {
    reasons.push('B20_MANUAL_REVIEW_REQUIRED');
    return transition(
      isLegalTransition(from, 'MANUAL_REVIEW') ? 'MANUAL_REVIEW' : 'RECOVERING',
      'an incomplete action outran its SLA',
    );
  }

  // 6. The pending schedule and the guard window around it.
  if (input.pendingSchedule !== undefined) {
    const untilEffective = input.pendingSchedule.effectiveAtSeconds - input.evaluateAtSeconds;
    if (untilEffective > input.guardWindowSeconds) {
      reasons.push('B20_SCHEDULE_NOT_YET_EFFECTIVE');
      return transition(
        isLegalTransition(from, 'ACTION_PENDING') ? 'ACTION_PENDING' : 'NORMAL',
        'a multiplier update is scheduled beyond the guard window',
      );
    }
    if (untilEffective > 0n) {
      // Inside the window the multiplier is about to move and any decision made now can be
      // wrong by the time it executes.
      reasons.push('B20_SCHEDULE_NOT_YET_EFFECTIVE');
      return transition(
        isLegalTransition(from, 'GUARD_WINDOW') ? 'GUARD_WINDOW' : 'ACTION_PENDING',
        'inside the guard window around a scheduled activation',
      );
    }
    return transition(
      isLegalTransition(from, 'ACTION_EFFECTIVE') ? 'ACTION_EFFECTIVE' : 'RECONCILING',
      'the scheduled multiplier has activated and reconciliation is due',
    );
  }

  // 7. Capability. Only reached once nothing more urgent applies, and it stops the machine
  //    from claiming a clean bill of health it cannot support.
  if (input.capabilityScheduledUpdates !== 'LIVE') {
    reasons.push('B20_UNSUPPORTED_CAPABILITY');
    return transition(
      isLegalTransition(from, 'NORMAL') ? 'NORMAL' : 'OBSERVING',
      'the chain does not expose a scheduled-update surface; a pending action cannot be ' +
        'observed here, which is not the same as none existing',
    );
  }

  // 8. Price and pause evidence.
  if (input.tokenPaused) {
    reasons.push('B20_TOKEN_PAUSED');
    // A pause reached from NORMAL is the guard window opening around an action. Reached from
    // RECONCILING it means the reconciliation cannot complete, which is missing evidence
    // rather than a window — the same fact, two different operational meanings.
    return transition(
      isLegalTransition(from, 'GUARD_WINDOW')
        ? 'GUARD_WINDOW'
        : isLegalTransition(from, 'INSUFFICIENT_EVIDENCE')
          ? 'INSUFFICIENT_EVIDENCE'
          : 'NORMAL',
      'the token has paused the feature this asset needs',
    );
  }
  if (!input.feedPairingReviewed) {
    reasons.push('B20_FEED_PAIRING_UNREVIEWED');
    return transition(
      isLegalTransition(from, 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'OBSERVING',
      'the token-to-feed pairing is an unreviewed inference; display only',
    );
  }
  if (input.feedVerdict === undefined) {
    reasons.push('B20_RPC_UNAVAILABLE');
    return transition(
      isLegalTransition(from, 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'OBSERVING',
      'no feed round was read',
    );
  }
  if (input.feedVerdict !== 'FRESH') {
    reasons.push(feedReason(input.feedVerdict));
    return transition(
      isLegalTransition(from, 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : 'OBSERVING',
      `price evidence is ${input.feedVerdict}`,
    );
  }

  // 9. Everything mandatory is present, comparable and in agreement.
  if (from === 'RECONCILING' || from === 'ACTION_EFFECTIVE' || from === 'RECOVERING') {
    return transition(
      isLegalTransition(from, 'VERIFIED') ? 'VERIFIED' : 'NORMAL',
      'every mandatory source agrees at a comparable block',
    );
  }
  if (from === 'DISCOVERED') return transition('OBSERVING', 'identity established; observing');
  return transition(
    isLegalTransition(from, 'NORMAL') ? 'NORMAL' : from,
    'every mandatory source agrees at a comparable block',
  );
}

function feedReason(verdict: NonNullable<B20MachineInput['feedVerdict']>): B20Reason {
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

/**
 * Whether a state can move without new evidence arriving.
 *
 * Used by the worker to decide what to re-evaluate. A VERIFIED asset with unchanged evidence
 * does not need re-deciding; a CONFLICT does not resolve by being looked at again.
 */
export function needsNewEvidence(state: B20State): boolean {
  return TERMINAL_UNTIL_NEW_EVIDENCE.has(state);
}

/**
 * A stable signature for incident deduplication.
 *
 * Repeated identical incidents collapse into one record with an occurrence count, so an
 * operator sees one row that happened 400 times rather than 400 rows. The signature contains
 * the asset, the state and the ordered reasons — but not the timestamp or the block, because
 * including those would defeat the deduplication entirely.
 */
export function incidentSignature(
  chainId: number,
  assetAddress: string,
  transition: B20Transition,
): string {
  return [
    String(chainId),
    assetAddress.toLowerCase(),
    transition.to,
    [...transition.reasons].sort().join(','),
  ].join('|');
}
