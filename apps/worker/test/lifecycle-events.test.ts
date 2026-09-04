import { describe, expect, it } from 'vitest';
import { lifecycleTransitionEvent } from '../src/discovery.js';

describe('worker lifecycle event emission', () => {
  it('does not call an unchanged schedule an override', () => {
    const activation = new Date('2026-09-04T12:00:00.000Z');
    expect(
      lifecycleTransitionEvent({
        nextState: 'PENDING',
        previousState: 'PENDING',
        previousActivation: activation,
        nextActivation: activation.getTime(),
      }),
    ).toBeUndefined();
  });

  it('emits an override only when the activation actually changes', () => {
    expect(
      lifecycleTransitionEvent({
        nextState: 'PENDING',
        previousState: 'PENDING',
        previousActivation: new Date('2026-09-04T12:00:00.000Z'),
        nextActivation: Date.parse('2026-09-04T13:00:00.000Z'),
      }),
    ).toBe('MULTIPLIER_OVERRIDDEN');
  });

  it('never records manual review as a reconciliation match', () => {
    expect(
      lifecycleTransitionEvent({
        nextState: 'MANUAL_REVIEW',
        previousState: 'MISMATCH',
        previousActivation: null,
        nextActivation: undefined,
      }),
    ).toBeUndefined();
  });

  it('does not duplicate an unchanged mismatch transition', () => {
    expect(
      lifecycleTransitionEvent({
        nextState: 'MISMATCH',
        previousState: 'MISMATCH',
        previousActivation: null,
        nextActivation: undefined,
      }),
    ).toBeUndefined();
  });
});
