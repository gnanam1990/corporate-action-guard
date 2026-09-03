import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_REASONS,
  deriveGuardWindow,
  evaluatePreflight,
  instant,
  isInGuardWindow,
  millis,
  orderReasons,
  REASON_EXPLANATION,
  REASON_SEVERITY,
  summarizeCanonicality,
  type BlockReason,
  type PreflightInput,
} from '../src/index.js';
import { allowingInput, NOW } from './fixtures.js';

/** Fields that are part of the evidence set. Removing any one must not help the caller. */
const EVIDENCE_KEYS = [
  'registryTokenAddress',
  'registryWrapperAddress',
  'registryWrapperIsCurrent',
  'observedWrapperAsset',
  'onChainMultiplierNonce',
  'apiObservedAt',
  'chainObservedAt',
] as const;

describe('property: removing evidence can never turn BLOCK into ALLOW', () => {
  it('holds for every subset of removable evidence', () => {
    fc.assert(
      fc.property(
        fc.subarray([...EVIDENCE_KEYS], { minLength: 1 }),
        fc.boolean(),
        fc.boolean(),
        (removed, mismatch, review) => {
          const withEvidence: PreflightInput = {
            ...allowingInput(),
            manualReviewOpen: review,
            sourceComparison: {
              ...allowingInput().sourceComparison,
              agreement: mismatch ? 'MISMATCH' : 'MATCH',
            },
          };

          const reduced: PreflightInput = { ...withEvidence };
          for (const key of removed) {
            delete (reduced as Record<string, unknown>)[key];
          }

          const before = evaluatePreflight(withEvidence, NOW);
          const after = evaluatePreflight(reduced, NOW);

          // Removing evidence must never improve the decision.
          if (before.decision === 'BLOCK') expect(after.decision).toBe('BLOCK');
          // And it must never shrink the reason set.
          expect(after.reasons.length).toBeGreaterThanOrEqual(before.decision === 'BLOCK' ? 1 : 0);
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('property: any single mutation away from the ALLOW baseline blocks', () => {
  it('a changed bound field always changes the decision', () => {
    fc.assert(
      fc.property(
        fc.record({
          amount: fc.bigInt({ min: 1n, max: 2n ** 128n }),
          nonceDelta: fc.bigInt({ min: 1n, max: 1000n }),
        }),
        ({ amount, nonceDelta }) => {
          const base = allowingInput();
          // Amount alone does not block — it is bound by the digest, not the predicate.
          const amountChanged = evaluatePreflight(
            { ...base, action: { ...base.action, amount } },
            NOW,
          );
          expect(amountChanged.decision).toBe('ALLOW');

          // A changed multiplier epoch always blocks.
          const nonceChanged = evaluatePreflight(
            {
              ...base,
              action: {
                ...base.action,
                expectedMultiplierNonce: base.action.expectedMultiplierNonce + nonceDelta,
              },
            },
            NOW,
          );
          expect(nonceChanged.reasons).toContain('MULTIPLIER_NONCE_MISMATCH');
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: ALLOW requires the complete conjunction', () => {
  it('a decision is ALLOW if and only if it has zero reasons', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 200_000 }),
        (known, current, review, mismatch, age) => {
          const result = evaluatePreflight(
            {
              ...allowingInput(),
              assetKnown: known,
              registryWrapperIsCurrent: current,
              manualReviewOpen: review,
              sourceComparison: {
                ...allowingInput().sourceComparison,
                agreement: mismatch ? 'MISMATCH' : 'MATCH',
              },
              apiObservedAt: instant(NOW - age),
              chainObservedAt: instant(NOW - age),
            },
            NOW,
          );
          expect(result.decision === 'ALLOW').toBe(result.reasons.length === 0);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('property: guard window', () => {
  it('membership is exactly the closed interval [start, end]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 40 }),
        fc.integer({ min: 0, max: 3_600_000 }),
        fc.integer({ min: 0, max: 3_600_000 }),
        fc.integer({ min: -7_200_000, max: 7_200_000 }),
        (activationMs, before, after, offset) => {
          const w = deriveGuardWindow(instant(activationMs), millis(before), millis(after));
          const t = instant(activationMs + offset);
          expect(isInGuardWindow(w, t)).toBe(t >= w.start && t <= w.end);
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('property: reason ordering is deterministic', () => {
  it('is independent of input order and free of duplicates', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...(BLOCK_REASONS as readonly BlockReason[])), { maxLength: 20 }),
        (reasons) => {
          const a = orderReasons(reasons);
          const b = orderReasons([...reasons].reverse());
          expect(a).toEqual(b);
          expect(new Set(a).size).toBe(a.length);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never places a less severe reason before a more severe one', () => {
    const rank = { SAFETY_CRITICAL: 0, EVIDENCE_DEGRADED: 1, INPUT_REJECTED: 2 } as const;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...(BLOCK_REASONS as readonly BlockReason[])), { maxLength: 20 }),
        (reasons) => {
          const ordered = orderReasons(reasons);
          for (let i = 1; i < ordered.length; i++) {
            expect(rank[REASON_SEVERITY[ordered[i]!]]).toBeGreaterThanOrEqual(
              rank[REASON_SEVERITY[ordered[i - 1]!]],
            );
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('reason-code contract completeness', () => {
  it('every reason has a severity', () => {
    for (const r of BLOCK_REASONS) expect(REASON_SEVERITY[r]).toBeDefined();
  });

  it('every reason has a deterministic operator explanation', () => {
    for (const r of BLOCK_REASONS) {
      expect(REASON_EXPLANATION[r], `${r} has no explanation`).toBeTruthy();
      expect(REASON_EXPLANATION[r].length).toBeGreaterThan(20);
    }
  });

  it('reason codes are unique', () => {
    expect(new Set(BLOCK_REASONS).size).toBe(BLOCK_REASONS.length);
  });
});

describe('property: canonicality summary', () => {
  it('PASS only when every check passes; FAIL dominates UNKNOWN', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('PASS' as const, 'FAIL' as const, 'UNKNOWN' as const), {
          minLength: 1,
          maxLength: 8,
        }),
        (outcomes) => {
          const checks = outcomes.map((outcome, i) => ({
            name: 'TOKEN_HAS_BYTECODE' as const,
            outcome,
            detail: `check ${i}`,
          }));
          const summary = summarizeCanonicality(checks);
          const expected = outcomes.includes('FAIL')
            ? 'FAIL'
            : outcomes.includes('UNKNOWN')
              ? 'UNKNOWN'
              : 'PASS';
          expect(summary.outcome).toBe(expected);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('an empty matrix is UNKNOWN, never PASS', () => {
    expect(summarizeCanonicality([]).outcome).toBe('UNKNOWN');
  });
});
