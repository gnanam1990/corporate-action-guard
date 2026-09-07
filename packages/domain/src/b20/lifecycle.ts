/**
 * B20 multiplier lifecycle: facts, not decisions.
 *
 * The reducer here answers one question — *which multiplier is active at this block
 * timestamp, and why* — from ordered, provenance-bearing observations. It does not decide
 * whether an action is authorized, and it does not say what a multiplier change *means*.
 * That separation is ADR 0008: an untyped multiplier change is an on-chain fact, and the
 * legal category is a different question with a different evidence chain.
 *
 * Three traps this exists to avoid, all of them documented upstream:
 *
 * 1. **A scheduled update emits its event before it takes effect.** Activating on event
 *    arrival reads the future. Activation is `block.timestamp >= effectiveAt`, evaluated
 *    against the block being asked about.
 * 2. **Activation is lazy and emits nothing.** There is no event at `effectiveAt`. A
 *    reducer that waits for one waits forever.
 * 3. **One instant update emits two events.** `updateMultiplier` emits both the deprecated
 *    `MultiplierUpdated` and the canonical `UIMultiplierUpdated`. They are one business
 *    fact. Folding them is a semantic step, kept strictly separate from deduplication by
 *    event identity — two genuine updates to the same value must both survive.
 *
 * There is no clock in this file. `Date` is banned in this package by lint, and the
 * evaluation timestamp is always an argument, which is what makes replay reproducible.
 */

import type { BlockHash, BlockNumber } from '../brands.js';
import type { B20Reason } from './reasons.js';
import type { MultiplierWad } from './quantities.js';

/**
 * Lifecycle facts, as observed. These describe multiplier state; they are not outcomes and
 * they never appear as an authorization result.
 */
export const B20_LIFECYCLE_STATES = [
  /** A current multiplier is known and no pending update is live. */
  'LEGACY_ACTIVE',
  /** A pending update exists and its effectiveAt is in the future at the evaluated time. */
  'SCHEDULED_PENDING',
  /** effectiveAt has passed. The new multiplier is active, and no event marked the moment. */
  'SCHEDULED_ACTIVE_LAZY',
  /** A pending update was cancelled before it activated. */
  'CANCELLED',
  /** An instant `updateMultiplier` set the value and cleared any pending update. */
  'INSTANT_OVERRIDE',
  /** The token has paused a feature, typically bracketing a corporate action. */
  'PAUSED_FOR_ACTION',
  /** Observed state and derived state agree at a canonical block. */
  'RECONCILED',
  /** The branch that produced this state was replaced. Derived state is invalid. */
  'REORGED',
  /**
   * The chain does not expose the selector this answer needs. Distinct from "no pending
   * update": on Base mainnet today `newUIMultiplier()` and `effectiveAt()` are not dialed,
   * so reporting "nothing pending" would be a false negative on the most safety-critical
   * question this product answers.
   */
  'UNSUPPORTED_CAPABILITY',
] as const;

export type B20LifecycleState = (typeof B20_LIFECYCLE_STATES)[number];

/** Which surface an observation came from, so a capability gap is never silently filled. */
export const B20_CAPABILITY_SURFACES = ['BERYL', 'COBALT_ERC8056'] as const;
export type B20CapabilitySurface = (typeof B20_CAPABILITY_SURFACES)[number];

export const B20_CAPABILITY_OUTCOMES = [
  /** The selector is dialed and answered. */
  'LIVE',
  /** The selector reverted with exactly its own four bytes: this hardfork has not dialed it. */
  'NOT_DIALED',
  /** Dialed, but reverted for another reason. Still a capability. */
  'REVERTED',
  /** The RPC failed. This says nothing about the capability and must never be cached as one. */
  'UNAVAILABLE',
] as const;
export type B20CapabilityOutcome = (typeof B20_CAPABILITY_OUTCOMES)[number];

/** The capability set an evaluation is allowed to rely on. */
export interface B20CapabilitySet {
  readonly currentMultiplier: B20CapabilityOutcome;
  readonly scheduledUpdate: B20CapabilityOutcome;
  readonly announcements: B20CapabilityOutcome;
  readonly pause: B20CapabilityOutcome;
  readonly observedAtBlock: BlockNumber;
}

/** Where a fact was observed. Every fact carries this; a fact without it cannot be ordered. */
export interface B20Provenance {
  readonly blockNumber: BlockNumber;
  readonly blockHash: BlockHash;
  readonly blockTimestampSeconds: bigint;
  readonly transactionIndex: number;
  readonly logIndex: number;
  /** Chain-unique event identity: chainId + blockHash + txHash + logIndex, pre-hashed. */
  readonly eventId: string;
}

export const B20_FACT_KINDS = [
  /** `MultiplierUpdated(uint256)` — the deprecated instant event. */
  'LEGACY_MULTIPLIER_UPDATED',
  /** `UIMultiplierUpdated(uint256,uint256,uint256)` — the canonical event. */
  'UI_MULTIPLIER_UPDATED',
  /** `UIMultiplierUpdateCancelled(uint256,uint256)`. */
  'UI_MULTIPLIER_UPDATE_CANCELLED',
  /** A direct state read, used to seed or corroborate the epoch chain. */
  'STATE_SNAPSHOT',
] as const;
export type B20FactKind = (typeof B20_FACT_KINDS)[number];

/**
 * One observed lifecycle fact.
 *
 * `effectiveAtSeconds` is present on `UI_MULTIPLIER_UPDATED` and distinguishes the two
 * shapes the canonical event carries: an instant update reports an effectiveAt at or before
 * the emitting block, a scheduled one reports a future timestamp.
 */
export interface B20LifecycleFact {
  readonly kind: B20FactKind;
  readonly provenance: B20Provenance;
  readonly oldMultiplierWad?: MultiplierWad;
  readonly newMultiplierWad?: MultiplierWad;
  readonly effectiveAtSeconds?: bigint;
  readonly cancelledMultiplierWad?: MultiplierWad;
  readonly cancelledEffectiveAtSeconds?: bigint;
}

/** One period during which a single multiplier was active. */
export interface MultiplierEpoch {
  readonly multiplierWad: MultiplierWad;
  readonly activeFromSeconds: bigint;
  /** Exclusive. Absent means the epoch is still open at the evaluated timestamp. */
  readonly activeUntilSeconds?: bigint;
  /** Event ids that produced this epoch. Plural: one instant update emits two events. */
  readonly sourceEventIds: readonly string[];
  /** True when the epoch began by an instant override rather than a scheduled activation. */
  readonly viaInstantOverride: boolean;
}

export interface B20LifecycleInput {
  /** Facts in any order. The reducer sorts them; caller order must not change the result. */
  readonly facts: readonly B20LifecycleFact[];
  /** The block timestamp being asked about. Never a wall clock. */
  readonly evaluateAtSeconds: bigint;
  readonly capabilities: B20CapabilitySet;
  /** Multiplier before the first supplied fact, when the fact window does not reach genesis. */
  readonly seedMultiplierWad?: MultiplierWad;
}

export interface B20LifecycleResult {
  readonly state: B20LifecycleState;
  /** Absent when no multiplier can be established from the supplied evidence. */
  readonly activeMultiplierWad?: MultiplierWad;
  readonly pendingMultiplierWad?: MultiplierWad;
  readonly pendingEffectiveAtSeconds?: bigint;
  readonly epochs: readonly MultiplierEpoch[];
  readonly reasons: readonly B20Reason[];
  /** Every event id that contributed, so any conclusion traces back to raw observations. */
  readonly evidenceEventIds: readonly string[];
}

/**
 * Total order over facts.
 *
 * Block number, then transaction index, then log index. Timestamps tie within a block and
 * across blocks with the same timestamp, so ordering by timestamp alone is ambiguous. The
 * result must not depend on how the caller paginated its input, which is exactly what this
 * makes true.
 */
function compareFacts(a: B20LifecycleFact, b: B20LifecycleFact): number {
  const p = a.provenance;
  const q = b.provenance;
  if (p.blockNumber !== q.blockNumber) return p.blockNumber < q.blockNumber ? -1 : 1;
  if (p.transactionIndex !== q.transactionIndex) return p.transactionIndex - q.transactionIndex;
  if (p.logIndex !== q.logIndex) return p.logIndex - q.logIndex;
  return p.eventId < q.eventId ? -1 : p.eventId > q.eventId ? 1 : 0;
}

/**
 * Fold the two events one instant update emits into one business fact.
 *
 * Strictly *not* value-based deduplication. Two separate updates that happen to set the same
 * multiplier are two business facts and both survive; only a legacy and a canonical event in
 * the same transaction, carrying the same new value, are one. Merging by value would erase a
 * real second corporate action.
 */
function foldDuplicateEmissions(sorted: readonly B20LifecycleFact[]): {
  readonly facts: readonly B20LifecycleFact[];
  readonly folded: number;
} {
  const out: B20LifecycleFact[] = [];
  let folded = 0;
  for (const fact of sorted) {
    if (fact.kind !== 'LEGACY_MULTIPLIER_UPDATED') {
      out.push(fact);
      continue;
    }
    const twin = sorted.find(
      (other) =>
        other.kind === 'UI_MULTIPLIER_UPDATED' &&
        other.provenance.blockHash === fact.provenance.blockHash &&
        other.provenance.transactionIndex === fact.provenance.transactionIndex &&
        other.newMultiplierWad === fact.newMultiplierWad,
    );
    if (twin === undefined) {
      // A legacy event with no canonical twin still carries the fact. Dropping it because
      // the canonical one is "supposed to" be there would lose a real update.
      out.push(fact);
      continue;
    }
    folded++;
  }
  return { facts: out, folded };
}

/**
 * Derive lifecycle state and multiplier epochs at an explicit block timestamp.
 *
 * Pure. No I/O, no clock, no ambient state. Given the same facts and timestamp it returns
 * the same result forever, which is what makes historical queries and replay trustworthy.
 */
export function reduceB20Lifecycle(input: B20LifecycleInput): B20LifecycleResult {
  const reasons: B20Reason[] = [];
  const sorted = [...input.facts].sort(compareFacts);
  const evidenceEventIds = sorted.map((f) => f.provenance.eventId);

  if (input.capabilities.currentMultiplier === 'UNAVAILABLE') {
    // The RPC failed. That is not evidence that no multiplier exists.
    return {
      state: 'UNSUPPORTED_CAPABILITY',
      epochs: [],
      reasons: ['B20_RPC_UNAVAILABLE'],
      evidenceEventIds,
    };
  }

  const { facts, folded } = foldDuplicateEmissions(sorted);
  if (folded > 0) reasons.push('B20_DUPLICATE_EVENT_GENERATION');

  const epochs: MultiplierEpoch[] = [];
  let active: MultiplierWad | undefined = input.seedMultiplierWad;
  let pendingMultiplier: MultiplierWad | undefined;
  let pendingEffectiveAt: bigint | undefined;
  let lastInstantOverride = false;
  let cancelledSomething = false;
  let supersededSomething = false;

  const openEpoch = (
    multiplier: MultiplierWad,
    fromSeconds: bigint,
    eventIds: readonly string[],
    viaInstantOverride: boolean,
  ) => {
    const previous = epochs[epochs.length - 1];
    if (previous !== undefined && previous.activeUntilSeconds === undefined) {
      epochs[epochs.length - 1] = { ...previous, activeUntilSeconds: fromSeconds };
    }
    epochs.push({
      multiplierWad: multiplier,
      activeFromSeconds: fromSeconds,
      sourceEventIds: eventIds,
      viaInstantOverride,
    });
  };

  for (const fact of facts) {
    const at = fact.provenance.blockTimestampSeconds;

    // A fact from after the evaluated moment must not influence the answer. This is what
    // makes a historical query at block n give the same answer at block n + 10^6.
    if (at > input.evaluateAtSeconds) break;

    if (fact.kind === 'STATE_SNAPSHOT') {
      if (fact.newMultiplierWad !== undefined && active === undefined) {
        active = fact.newMultiplierWad;
        openEpoch(fact.newMultiplierWad, at, [fact.provenance.eventId], false);
      }
      continue;
    }

    if (fact.kind === 'UI_MULTIPLIER_UPDATE_CANCELLED') {
      pendingMultiplier = undefined;
      pendingEffectiveAt = undefined;
      cancelledSomething = true;
      continue;
    }

    if (fact.newMultiplierWad === undefined) continue;

    // Continuity: the update's old value must equal what we believed was current. A break
    // means the fact window has a hole or an observation is from a different branch, and
    // guessing past it would produce a confident wrong multiplier.
    if (
      fact.oldMultiplierWad !== undefined &&
      active !== undefined &&
      fact.oldMultiplierWad !== active
    ) {
      reasons.push('B20_MULTIPLIER_CONTINUITY_BROKEN');
    }

    const scheduled =
      fact.kind === 'UI_MULTIPLIER_UPDATED' &&
      fact.effectiveAtSeconds !== undefined &&
      fact.effectiveAtSeconds > at;

    if (scheduled) {
      pendingMultiplier = fact.newMultiplierWad;
      pendingEffectiveAt = fact.effectiveAtSeconds;
      lastInstantOverride = false;
      continue;
    }

    // Instant: applies now and, per IB20Asset, clears any live pending update.
    if (pendingMultiplier !== undefined) supersededSomething = true;
    pendingMultiplier = undefined;
    pendingEffectiveAt = undefined;
    active = fact.newMultiplierWad;
    lastInstantOverride = fact.kind === 'LEGACY_MULTIPLIER_UPDATED' || folded > 0;
    openEpoch(fact.newMultiplierWad, at, [fact.provenance.eventId], lastInstantOverride);
  }

  // Lazy activation. There is no event at effectiveAt, so this is the only place the
  // transition can happen: by comparing the evaluated timestamp against the schedule.
  let state: B20LifecycleState;
  if (pendingMultiplier !== undefined && pendingEffectiveAt !== undefined) {
    if (input.evaluateAtSeconds >= pendingEffectiveAt) {
      active = pendingMultiplier;
      openEpoch(pendingMultiplier, pendingEffectiveAt, [], false);
      state = 'SCHEDULED_ACTIVE_LAZY';
      pendingMultiplier = undefined;
      pendingEffectiveAt = undefined;
    } else {
      state = 'SCHEDULED_PENDING';
      reasons.push('B20_SCHEDULE_NOT_YET_EFFECTIVE');
    }
  } else if (supersededSomething) {
    state = 'INSTANT_OVERRIDE';
    reasons.push('B20_SCHEDULE_SUPERSEDED');
  } else if (cancelledSomething) {
    state = 'CANCELLED';
    reasons.push('B20_SCHEDULE_CANCELLED');
  } else if (lastInstantOverride) {
    state = 'INSTANT_OVERRIDE';
  } else {
    state = 'LEGACY_ACTIVE';
  }

  // The capability gate comes last and overrides an optimistic "nothing is pending". If the
  // chain cannot be asked whether an update is scheduled, the honest answer is that the
  // question is unanswerable here, not that the answer is no.
  if (
    input.capabilities.scheduledUpdate === 'NOT_DIALED' &&
    (state === 'LEGACY_ACTIVE' || state === 'INSTANT_OVERRIDE')
  ) {
    reasons.push('B20_UNSUPPORTED_CAPABILITY');
  }

  const result: B20LifecycleResult = {
    state,
    epochs,
    reasons,
    evidenceEventIds,
    ...(active !== undefined ? { activeMultiplierWad: active } : {}),
    ...(pendingMultiplier !== undefined ? { pendingMultiplierWad: pendingMultiplier } : {}),
    ...(pendingEffectiveAt !== undefined ? { pendingEffectiveAtSeconds: pendingEffectiveAt } : {}),
  };
  return result;
}
