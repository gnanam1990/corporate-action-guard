/**
 * Corporate-action lifecycle.
 *
 *   NORMAL -> PENDING -> GUARD_WINDOW -> APPLIED -> RECONCILED
 *                      \-> MISMATCH -> MANUAL_REVIEW -> RECOVERED
 *
 * Two separate things are modelled here and must not be confused:
 *  - `deriveLifecycleState` computes the state implied by evidence and time. It is a pure
 *    function of its inputs and has no memory.
 *  - `legalTransition` constrains how the *recorded* state may move in response to an
 *    event, so history cannot jump illegally.
 */

import type { Instant, Millis } from './time.js';

export const LIFECYCLE_STATES = [
  'NORMAL',
  'PENDING',
  'GUARD_WINDOW',
  'APPLIED',
  'RECONCILED',
  'MISMATCH',
  'MANUAL_REVIEW',
  'RECOVERED',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_EVENTS = [
  'MULTIPLIER_SCHEDULED',
  'MULTIPLIER_OVERRIDDEN',
  'GUARD_WINDOW_ENTERED',
  'MULTIPLIER_EFFECTIVE',
  'RECONCILIATION_MATCHED',
  'RECONCILIATION_MISMATCHED',
  'MANUAL_REVIEW_OPENED',
  'MANUAL_REVIEW_RESOLVED',
  'SOURCE_RECOVERED',
] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/**
 * The complete legal transition table.
 *
 * Written out in full rather than derived, so that an illegal transition is a data fact
 * a test can assert against, not an emergent property of branching code.
 */
const TRANSITIONS: Readonly<
  Record<LifecycleState, Partial<Record<LifecycleEvent, LifecycleState>>>
> = {
  NORMAL: {
    MULTIPLIER_SCHEDULED: 'PENDING',
    RECONCILIATION_MISMATCHED: 'MISMATCH',
  },
  PENDING: {
    // An override replaces the pending schedule; the asset stays pending on the new one.
    MULTIPLIER_OVERRIDDEN: 'PENDING',
    GUARD_WINDOW_ENTERED: 'GUARD_WINDOW',
    RECONCILIATION_MISMATCHED: 'MISMATCH',
  },
  GUARD_WINDOW: {
    MULTIPLIER_EFFECTIVE: 'APPLIED',
    RECONCILIATION_MISMATCHED: 'MISMATCH',
  },
  APPLIED: {
    RECONCILIATION_MATCHED: 'RECONCILED',
    RECONCILIATION_MISMATCHED: 'MISMATCH',
  },
  RECONCILED: {
    MULTIPLIER_SCHEDULED: 'PENDING',
    RECONCILIATION_MISMATCHED: 'MISMATCH',
  },
  MISMATCH: {
    MANUAL_REVIEW_OPENED: 'MANUAL_REVIEW',
  },
  MANUAL_REVIEW: {
    // Resolution records a decision; it does not by itself assert the sources now agree.
    MANUAL_REVIEW_RESOLVED: 'MANUAL_REVIEW',
    // Only a later complete observation in which the sources actually agree recovers.
    SOURCE_RECOVERED: 'RECOVERED',
  },
  RECOVERED: {
    MULTIPLIER_SCHEDULED: 'PENDING',
    RECONCILIATION_MATCHED: 'RECONCILED',
    RECONCILIATION_MISMATCHED: 'MISMATCH',
  },
};

export type TransitionResult =
  | { readonly ok: true; readonly to: LifecycleState }
  | { readonly ok: false; readonly reason: string };

/** Apply an event to a state. Illegal combinations are rejected, never silently ignored. */
export function legalTransition(from: LifecycleState, event: LifecycleEvent): TransitionResult {
  const to = TRANSITIONS[from][event];
  if (to === undefined) {
    return { ok: false, reason: `${event} is not a legal transition from ${from}` };
  }
  return { ok: true, to };
}

/** Every legal (state, event) pair. Used by exhaustiveness tests and documentation. */
export function allLegalTransitions(): readonly {
  from: LifecycleState;
  event: LifecycleEvent;
  to: LifecycleState;
}[] {
  const out: { from: LifecycleState; event: LifecycleEvent; to: LifecycleState }[] = [];
  for (const from of LIFECYCLE_STATES) {
    for (const event of LIFECYCLE_EVENTS) {
      const to = TRANSITIONS[from][event];
      if (to !== undefined) out.push({ from, event, to });
    }
  }
  return out;
}

export interface GuardWindow {
  /** Inclusive start. */
  readonly start: Instant;
  readonly activation: Instant;
  /** Inclusive end. */
  readonly end: Instant;
}

/**
 * The interval around an activation during which protected actions are refused.
 *
 * Both endpoints are **inclusive**. At exactly `start` and exactly `end` the action is
 * blocked. Ties resolve toward blocking: an off-by-one-millisecond ALLOW at a boundary is
 * a wrong balance, while an off-by-one BLOCK is a retry.
 */
export function deriveGuardWindow(activation: Instant, before: Millis, after: Millis): GuardWindow {
  return {
    start: (activation - before) as Instant,
    activation,
    end: (activation + after) as Instant,
  };
}

/** True when `now` is inside the inclusive guard window. */
export function isInGuardWindow(window: GuardWindow, now: Instant): boolean {
  return now >= window.start && now <= window.end;
}

export interface LifecycleInput {
  /** The pending scheduled activation, if any is known. */
  readonly scheduledActivation?: Instant;
  readonly guardBefore: Millis;
  readonly guardAfter: Millis;
  /** True when the latest complete observation showed the sources disagreeing. */
  readonly sourcesMismatched: boolean;
  /** True when an incident on this asset is open and awaiting operator review. */
  readonly manualReviewOpen: boolean;
  /** True when the scheduled multiplier has been observed as effective on chain. */
  readonly appliedOnChain: boolean;
  /** True when post-activation reconciliation confirmed the sources agree again. */
  readonly reconciled: boolean;
}

/**
 * State implied by current evidence at `now`.
 *
 * Order matters and encodes priority: an unsafe condition outranks a progress condition.
 * A mismatch is reported as MISMATCH even mid-guard-window, because the operator needs to
 * see the disagreement, not the schedule.
 */
export function deriveLifecycleState(input: LifecycleInput, now: Instant): LifecycleState {
  if (input.manualReviewOpen) return 'MANUAL_REVIEW';
  if (input.sourcesMismatched) return 'MISMATCH';

  if (input.scheduledActivation !== undefined) {
    const window = deriveGuardWindow(
      input.scheduledActivation,
      input.guardBefore,
      input.guardAfter,
    );
    if (isInGuardWindow(window, now)) return 'GUARD_WINDOW';
    if (now < window.start) return 'PENDING';
    // Past the window.
    if (input.reconciled) return 'RECONCILED';
    if (input.appliedOnChain) return 'APPLIED';
    // The window has passed but the change was never observed on chain. That is not
    // NORMAL — the schedule is unaccounted for.
    return 'MISMATCH';
  }

  if (input.reconciled) return 'RECONCILED';
  return 'NORMAL';
}
