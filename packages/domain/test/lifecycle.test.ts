import { describe, expect, it } from 'vitest';
import {
  allLegalTransitions,
  legalTransition,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  type LifecycleEvent,
  type LifecycleState,
} from '../src/index.js';

/**
 * The transition table is asserted exhaustively: every (state, event) pair in the product
 * is classified as legal-with-a-known-target or explicitly illegal. A silently accepted
 * transition would let history record a state the machine never permits.
 */
const LEGAL: ReadonlyArray<readonly [LifecycleState, LifecycleEvent, LifecycleState]> = [
  ['NORMAL', 'MULTIPLIER_SCHEDULED', 'PENDING'],
  ['NORMAL', 'RECONCILIATION_MISMATCHED', 'MISMATCH'],
  ['PENDING', 'MULTIPLIER_OVERRIDDEN', 'PENDING'],
  ['PENDING', 'GUARD_WINDOW_ENTERED', 'GUARD_WINDOW'],
  ['PENDING', 'RECONCILIATION_MISMATCHED', 'MISMATCH'],
  ['GUARD_WINDOW', 'MULTIPLIER_EFFECTIVE', 'APPLIED'],
  ['GUARD_WINDOW', 'RECONCILIATION_MISMATCHED', 'MISMATCH'],
  ['APPLIED', 'RECONCILIATION_MATCHED', 'RECONCILED'],
  ['APPLIED', 'RECONCILIATION_MISMATCHED', 'MISMATCH'],
  ['RECONCILED', 'MULTIPLIER_SCHEDULED', 'PENDING'],
  ['RECONCILED', 'RECONCILIATION_MISMATCHED', 'MISMATCH'],
  ['MISMATCH', 'MANUAL_REVIEW_OPENED', 'MANUAL_REVIEW'],
  ['MANUAL_REVIEW', 'MANUAL_REVIEW_RESOLVED', 'MANUAL_REVIEW'],
  ['MANUAL_REVIEW', 'SOURCE_RECOVERED', 'RECOVERED'],
  ['RECOVERED', 'MULTIPLIER_SCHEDULED', 'PENDING'],
  ['RECOVERED', 'RECONCILIATION_MATCHED', 'RECONCILED'],
  ['RECOVERED', 'RECONCILIATION_MISMATCHED', 'MISMATCH'],
];

describe('legalTransition', () => {
  for (const [from, event, to] of LEGAL) {
    it(`${from} --${event}--> ${to}`, () => {
      const result = legalTransition(from, event);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.to).toBe(to);
    });
  }

  it('the implementation table equals the expected table exactly', () => {
    const actual = allLegalTransitions()
      .map((t) => `${t.from}|${t.event}|${t.to}`)
      .sort();
    const expected = LEGAL.map(([f, e, t]) => `${f}|${e}|${t}`).sort();
    expect(actual).toEqual(expected);
  });

  it('rejects every pair not in the table', () => {
    const legal = new Set(LEGAL.map(([f, e]) => `${f}|${e}`));
    let illegalCount = 0;
    for (const from of LIFECYCLE_STATES) {
      for (const event of LIFECYCLE_EVENTS) {
        if (legal.has(`${from}|${event}`)) continue;
        illegalCount++;
        const result = legalTransition(from, event);
        expect(result.ok, `${from} --${event}--> should be illegal`).toBe(false);
      }
    }
    // 8 states x 9 events = 72 pairs; 17 legal leaves 55 illegal.
    expect(illegalCount).toBe(LIFECYCLE_STATES.length * LIFECYCLE_EVENTS.length - LEGAL.length);
  });
});

describe('safety-critical illegal transitions, called out explicitly', () => {
  const forbidden: ReadonlyArray<readonly [LifecycleState, LifecycleEvent, string]> = [
    ['MISMATCH', 'SOURCE_RECOVERED', 'a mismatch must pass through manual review, never self-heal'],
    [
      'MISMATCH',
      'RECONCILIATION_MATCHED',
      'a single agreeing observation does not clear a mismatch',
    ],
    [
      'MANUAL_REVIEW',
      'RECONCILIATION_MATCHED',
      'recovery requires the explicit SOURCE_RECOVERED event',
    ],
    [
      'NORMAL',
      'MULTIPLIER_EFFECTIVE',
      'a multiplier cannot become effective without being scheduled',
    ],
    ['NORMAL', 'GUARD_WINDOW_ENTERED', 'there is no window without a pending schedule'],
    ['GUARD_WINDOW', 'MULTIPLIER_SCHEDULED', 'a new schedule cannot be accepted mid-window'],
    ['RECONCILED', 'MULTIPLIER_EFFECTIVE', 'an already reconciled action cannot re-apply'],
  ];

  for (const [from, event, why] of forbidden) {
    it(`${from} --${event}--> is rejected: ${why}`, () => {
      const result = legalTransition(from, event);
      expect(result.ok).toBe(false);
    });
  }
});

describe('manual review cannot fabricate agreement', () => {
  it('resolving a review keeps the asset in MANUAL_REVIEW', () => {
    // Resolution records an operator decision. Only a later complete observation in which
    // the sources actually agree can move the asset to RECOVERED.
    const result = legalTransition('MANUAL_REVIEW', 'MANUAL_REVIEW_RESOLVED');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.to).toBe('MANUAL_REVIEW');
  });

  it('RECOVERED is reachable only through SOURCE_RECOVERED', () => {
    const paths = allLegalTransitions().filter((t) => t.to === 'RECOVERED');
    expect(paths).toEqual([{ from: 'MANUAL_REVIEW', event: 'SOURCE_RECOVERED', to: 'RECOVERED' }]);
  });
});
