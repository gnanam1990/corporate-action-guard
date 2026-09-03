import { describe, expect, it } from 'vitest';
import {
  deriveGuardWindow,
  deriveLifecycleState,
  evaluatePreflight,
  instant,
  isInGuardWindow,
  millis,
  type LifecycleInput,
} from '../src/index.js';
import { allowingInput, NOW } from './fixtures.js';

const ACTIVATION = instant(1_760_000_600_000);
const BEFORE = millis(15 * 60_000);
const AFTER = millis(15 * 60_000);
const WINDOW = deriveGuardWindow(ACTIVATION, BEFORE, AFTER);

/**
 * The activation window endpoints are INCLUSIVE (documented in docs/domain-invariants.md).
 * These are the four instants where an off-by-one costs real money, so each is asserted
 * explicitly rather than sampled.
 */
describe('guard window boundaries are inclusive', () => {
  const at = (t: number) => isInGuardWindow(WINDOW, instant(t));

  it('one millisecond before the start is outside', () => {
    expect(at(WINDOW.start - 1)).toBe(false);
  });

  it('exactly at the start is inside', () => {
    expect(at(WINDOW.start)).toBe(true);
  });

  it('one millisecond after the start is inside', () => {
    expect(at(WINDOW.start + 1)).toBe(true);
  });

  it('exactly at the activation is inside', () => {
    expect(at(WINDOW.activation)).toBe(true);
  });

  it('one millisecond before the end is inside', () => {
    expect(at(WINDOW.end - 1)).toBe(true);
  });

  it('exactly at the end is inside', () => {
    expect(at(WINDOW.end)).toBe(true);
  });

  it('one millisecond after the end is outside', () => {
    expect(at(WINDOW.end + 1)).toBe(false);
  });
});

describe('preflight at guard-window boundaries', () => {
  const evaluateAt = (t: number) =>
    evaluatePreflight(
      {
        ...allowingInput(),
        scheduledActivation: ACTIVATION,
        apiObservedAt: instant(t - 1_000),
        chainObservedAt: instant(t - 1_000),
      },
      instant(t),
    );

  it('ALLOWs one millisecond before the window opens', () => {
    expect(evaluateAt(WINDOW.start - 1).decision).toBe('ALLOW');
  });

  it('BLOCKs exactly at the window start', () => {
    expect(evaluateAt(WINDOW.start).reasons).toContain('ACTIVATION_WINDOW');
  });

  it('BLOCKs exactly at the activation instant', () => {
    expect(evaluateAt(WINDOW.activation).reasons).toContain('ACTIVATION_WINDOW');
  });

  it('BLOCKs exactly at the window end', () => {
    expect(evaluateAt(WINDOW.end).reasons).toContain('ACTIVATION_WINDOW');
  });

  it('ALLOWs one millisecond after the window closes', () => {
    expect(evaluateAt(WINDOW.end + 1).decision).toBe('ALLOW');
  });
});

describe('deriveGuardWindow', () => {
  it('a zero-width window still blocks exactly at the activation instant', () => {
    const w = deriveGuardWindow(ACTIVATION, millis(0), millis(0));
    expect(isInGuardWindow(w, ACTIVATION)).toBe(true);
    expect(isInGuardWindow(w, instant(ACTIVATION - 1))).toBe(false);
    expect(isInGuardWindow(w, instant(ACTIVATION + 1))).toBe(false);
  });

  it('supports asymmetric before and after margins', () => {
    const w = deriveGuardWindow(ACTIVATION, millis(60_000), millis(5_000));
    expect(w.start).toBe(ACTIVATION - 60_000);
    expect(w.end).toBe(ACTIVATION + 5_000);
  });
});

describe('deriveLifecycleState', () => {
  const base: LifecycleInput = {
    guardBefore: BEFORE,
    guardAfter: AFTER,
    sourcesMismatched: false,
    manualReviewOpen: false,
    appliedOnChain: false,
    reconciled: false,
  };

  it('is NORMAL with no schedule and nothing wrong', () => {
    expect(deriveLifecycleState(base, NOW)).toBe('NORMAL');
  });

  it('is PENDING before the window opens', () => {
    expect(
      deriveLifecycleState({ ...base, scheduledActivation: ACTIVATION }, instant(WINDOW.start - 1)),
    ).toBe('PENDING');
  });

  it('is GUARD_WINDOW at the inclusive start', () => {
    expect(deriveLifecycleState({ ...base, scheduledActivation: ACTIVATION }, WINDOW.start)).toBe(
      'GUARD_WINDOW',
    );
  });

  it('is APPLIED after the window once observed on chain', () => {
    expect(
      deriveLifecycleState(
        { ...base, scheduledActivation: ACTIVATION, appliedOnChain: true },
        instant(WINDOW.end + 1),
      ),
    ).toBe('APPLIED');
  });

  it('is RECONCILED once post-activation reconciliation agrees', () => {
    expect(
      deriveLifecycleState(
        { ...base, scheduledActivation: ACTIVATION, appliedOnChain: true, reconciled: true },
        instant(WINDOW.end + 1),
      ),
    ).toBe('RECONCILED');
  });

  it('is MISMATCH when the window passed but the change was never observed on chain', () => {
    // An unaccounted-for schedule is not NORMAL. It is a disagreement between what was
    // announced and what happened.
    expect(
      deriveLifecycleState({ ...base, scheduledActivation: ACTIVATION }, instant(WINDOW.end + 1)),
    ).toBe('MISMATCH');
  });

  it('reports MISMATCH even inside the guard window — the operator needs the disagreement', () => {
    expect(
      deriveLifecycleState(
        { ...base, scheduledActivation: ACTIVATION, sourcesMismatched: true },
        WINDOW.activation,
      ),
    ).toBe('MISMATCH');
  });

  it('MANUAL_REVIEW outranks every other condition', () => {
    expect(
      deriveLifecycleState(
        {
          ...base,
          scheduledActivation: ACTIVATION,
          sourcesMismatched: true,
          manualReviewOpen: true,
          reconciled: true,
        },
        WINDOW.activation,
      ),
    ).toBe('MANUAL_REVIEW');
  });
});
