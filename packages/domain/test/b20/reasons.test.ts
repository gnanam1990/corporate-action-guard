/**
 * B20 reason codes, and the X Layer contract they must not disturb.
 *
 * Half of this file is about the *existing* codes. `BLOCK_REASONS` is a deployed public
 * contract — `orderReasons` sorts by position in that array, the SDK and CLI branch on the
 * values, and signed evidence carries them. The Base work adds a parallel list precisely so
 * that array can stay frozen, and these tests are what make "frozen" mean something.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  B20_REASON_EXPLANATION,
  B20_REASON_SEVERITY,
  B20_REASONS,
  BLOCK_REASONS,
  orderB20Reasons,
  REASON_SEVERITY,
  type B20Reason,
} from '../../src/index.js';

/**
 * The X Layer reason contract as deployed, in order.
 *
 * Written out rather than snapshotted so a reviewer sees exactly what is frozen. Inserting a
 * code into the middle of `BLOCK_REASONS` would silently reorder every consumer's output
 * without changing a single line of consumer code; this is the test that catches it.
 */
const FROZEN_X_LAYER_REASONS = [
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
];

describe('the X Layer reason contract stays frozen', () => {
  it('has the same codes in the same order as when B20 work began', () => {
    expect([...BLOCK_REASONS]).toEqual(FROZEN_X_LAYER_REASONS);
  });

  it('gained no B20 codes', () => {
    // If a B20 code were appended here, preflight.test.ts would demand that the X Layer
    // evaluator can emit it — which it never can.
    const leaked = BLOCK_REASONS.filter((r) => (r as string).startsWith('B20_'));
    expect(leaked).toEqual([]);
  });

  it('shares no code name with the B20 list', () => {
    // One namespace across the API means a collision would make a response ambiguous.
    const overlap = B20_REASONS.filter((r) => (BLOCK_REASONS as readonly string[]).includes(r));
    expect(overlap).toEqual([]);
  });

  it('uses the same three-way severity vocabulary, so one queue can order both', () => {
    const xLayerSeverities = new Set(Object.values(REASON_SEVERITY));
    for (const severity of Object.values(B20_REASON_SEVERITY)) {
      expect(xLayerSeverities.has(severity)).toBe(true);
    }
  });
});

describe('B20 reason codes', () => {
  it('are unique', () => {
    expect(new Set(B20_REASONS).size).toBe(B20_REASONS.length);
  });

  it('all carry a severity and an explanation', () => {
    // Kept exhaustive by the Record type; asserted here so a widened type cannot hide a gap.
    for (const reason of B20_REASONS) {
      expect(B20_REASON_SEVERITY[reason], `${reason} has no severity`).toBeDefined();
      const explanation = B20_REASON_EXPLANATION[reason];
      expect(explanation, `${reason} has no explanation`).toBeDefined();
      expect(explanation.length, `${reason} explanation is too short to be useful`).toBeGreaterThan(
        30,
      );
    }
  });

  it('explains an unsupported capability as unanswerable, not as a negative answer', () => {
    // The distinction this whole product turns on. The text is what an operator reads at
    // 3am, so it says the question cannot be asked rather than implying nothing is pending.
    const text = B20_REASON_EXPLANATION.B20_UNSUPPORTED_CAPABILITY;
    expect(text).toMatch(/cannot be asked|not a negative answer/i);
  });

  it('names the double multiplier as safety critical', () => {
    expect(B20_REASON_SEVERITY.B20_DOUBLE_MULTIPLIER_APPLIED).toBe('SAFETY_CRITICAL');
    expect(B20_REASON_SEVERITY.B20_PRICE_BASIS_MISMATCH).toBe('SAFETY_CRITICAL');
    expect(B20_REASON_SEVERITY.B20_VALUATION_ROUTE_CONFLICT).toBe('SAFETY_CRITICAL');
  });

  it('treats an expected feed hold as degraded evidence, not as an input error', () => {
    // A weekend hold is not the caller's fault and not a safety failure. It is simply not
    // fresh enough to move money on, and the severity has to say that.
    expect(B20_REASON_SEVERITY.B20_FEED_EXPECTED_HOLD).toBe('EVIDENCE_DEGRADED');
  });
});

describe('ordering', () => {
  const arb = fc.array(fc.constantFrom(...(B20_REASONS as readonly B20Reason[])), {
    maxLength: 20,
  });

  it('does not depend on input order', () => {
    // A caller reading only the first reason must always get the most important one.
    fc.assert(
      fc.property(arb, (reasons) => {
        const forwards = orderB20Reasons(reasons);
        const backwards = orderB20Reasons([...reasons].reverse());
        return JSON.stringify(forwards) === JSON.stringify(backwards);
      }),
    );
  });

  it('puts every safety-critical reason before every less severe one', () => {
    fc.assert(
      fc.property(arb, (reasons) => {
        const ordered = orderB20Reasons(reasons);
        const rank = { SAFETY_CRITICAL: 0, EVIDENCE_DEGRADED: 1, INPUT_REJECTED: 2 } as const;
        for (let i = 1; i < ordered.length; i++) {
          const previous = ordered[i - 1];
          const current = ordered[i];
          if (previous === undefined || current === undefined) continue;
          if (rank[B20_REASON_SEVERITY[previous]] > rank[B20_REASON_SEVERITY[current]])
            return false;
        }
        return true;
      }),
    );
  });

  it('deduplicates without losing a code', () => {
    fc.assert(
      fc.property(arb, (reasons) => {
        const ordered = orderB20Reasons(reasons);
        return (
          new Set(ordered).size === ordered.length &&
          new Set(ordered).size === new Set(reasons).size
        );
      }),
    );
  });
});
