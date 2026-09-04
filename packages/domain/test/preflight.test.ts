import { describe, expect, it } from 'vitest';
import {
  BLOCK_REASONS,
  CANONICALITY_CHECK_NAMES,
  evaluatePreflight,
  instant,
  millis,
  summarizeCanonicality,
  unsafe,
  ZERO_ADDRESS,
  type BlockReason,
  type PreflightInput,
} from '../src/index.js';
import type { TOKEN, WRAPPER } from './fixtures.js';
import { allowingInput, NOW } from './fixtures.js';

describe('evaluatePreflight — the baseline', () => {
  it('ALLOWs when every condition holds, with zero reasons', () => {
    const result = evaluatePreflight(allowingInput(), NOW);
    expect(result.decision).toBe('ALLOW');
    expect(result.reasons).toEqual([]);
  });

  it('reports evidence ages so a caller can see how fresh the decision was', () => {
    const result = evaluatePreflight(allowingInput(), NOW);
    expect(result.apiEvidenceAgeMs).toBe(5_000);
    expect(result.chainEvidenceAgeMs).toBe(5_000);
  });
});

/**
 * One table row per reason code. Each mutates exactly one thing away from the ALLOW
 * baseline and asserts that specific code appears. A code with no row here fails the
 * coverage test below, so a new reason cannot be added without a test.
 */
const cases: ReadonlyArray<{
  reason: BlockReason;
  mutate: (i: PreflightInput) => PreflightInput;
}> = [
  {
    reason: 'UNSUPPORTED_CHAIN',
    mutate: (i) => ({ ...i, supportedChainIds: [unsafe.chainId(196)] }),
  },
  {
    reason: 'EVIDENCE_CHAIN_MISMATCH',
    mutate: (i) => ({ ...i, evidenceChainId: unsafe.chainId(196) }),
  },
  {
    reason: 'UNSUPPORTED_TARGET',
    mutate: (i) => ({ ...i, supportedTargets: [unsafe.address('0x' + '6'.repeat(40))] }),
  },
  {
    reason: 'UNSUPPORTED_ACTION',
    mutate: (i) => ({ ...i, supportedActionTypes: ['WITHDRAW'] }),
  },
  { reason: 'UNKNOWN_ASSET', mutate: (i) => ({ ...i, assetKnown: false }) },
  {
    reason: 'NON_CANONICAL_TOKEN',
    mutate: (i) => ({ ...i, registryTokenAddress: unsafe.address('0x' + '3'.repeat(40)) }),
  },
  {
    reason: 'NON_CANONICAL_WRAPPER',
    mutate: (i) => ({ ...i, registryWrapperAddress: unsafe.address('0x' + '4'.repeat(40)) }),
  },
  {
    reason: 'WRAPPER_ASSET_MISMATCH',
    mutate: (i) => ({ ...i, observedWrapperAsset: unsafe.address('0x' + '5'.repeat(40)) }),
  },
  { reason: 'OUTDATED_WRAPPER', mutate: (i) => ({ ...i, registryWrapperIsCurrent: false }) },
  {
    reason: 'API_UNAVAILABLE',
    mutate: (i) => {
      const { apiObservedAt: _drop, ...rest } = i;
      return rest;
    },
  },
  {
    reason: 'RPC_UNAVAILABLE',
    mutate: (i) => {
      const { chainObservedAt: _drop, ...rest } = i;
      return rest;
    },
  },
  {
    reason: 'STALE_API_EVIDENCE',
    mutate: (i) => ({ ...i, apiObservedAt: instant(NOW - 120_000) }),
  },
  {
    reason: 'STALE_CHAIN_EVIDENCE',
    mutate: (i) => ({ ...i, chainObservedAt: instant(NOW - 120_000) }),
  },
  {
    reason: 'SOURCE_MISMATCH',
    mutate: (i) => ({
      ...i,
      sourceComparison: { ...i.sourceComparison, agreement: 'MISMATCH' },
    }),
  },
  {
    reason: 'MULTIPLIER_NONCE_MISMATCH',
    mutate: (i) => ({ ...i, onChainMultiplierNonce: 8n }),
  },
  {
    reason: 'ACTIVATION_WINDOW',
    mutate: (i) => ({ ...i, scheduledActivation: instant(NOW + 60_000) }),
  },
  {
    reason: 'UNAPPLIED_CORPORATE_ACTION',
    mutate: (i) => ({ ...i, scheduledActivation: instant(NOW - 61 * 60_000) }),
  },
  { reason: 'MANUAL_REVIEW_REQUIRED', mutate: (i) => ({ ...i, manualReviewOpen: true }) },
  {
    reason: 'INVALID_OPERATION_BINDING',
    mutate: (i) => ({ ...i, action: { ...i.action, recipient: ZERO_ADDRESS } }),
  },
  {
    reason: 'RECEIPT_NOT_YET_VALID',
    mutate: (i) => ({
      ...i,
      receipt: {
        validAfter: instant(NOW + 1_000),
        validUntil: instant(NOW + 60_000),
        consumed: false,
        recomputedOperationDigest: '0xabc',
        boundOperationDigest: '0xabc',
      },
    }),
  },
  {
    reason: 'RECEIPT_EXPIRED',
    mutate: (i) => ({
      ...i,
      receipt: {
        validAfter: instant(NOW - 60_000),
        validUntil: instant(NOW - 1_000),
        consumed: false,
        recomputedOperationDigest: '0xabc',
        boundOperationDigest: '0xabc',
      },
    }),
  },
  {
    reason: 'RECEIPT_CONSUMED',
    mutate: (i) => ({
      ...i,
      receipt: {
        validAfter: instant(NOW - 1_000),
        validUntil: instant(NOW + 60_000),
        consumed: true,
        recomputedOperationDigest: '0xabc',
        boundOperationDigest: '0xabc',
      },
    }),
  },
];

describe('evaluatePreflight — every block reason', () => {
  for (const { reason, mutate } of cases) {
    it(`BLOCKs with ${reason}`, () => {
      const result = evaluatePreflight(mutate(allowingInput()), NOW);
      expect(result.decision).toBe('BLOCK');
      expect(result.reasons).toContain(reason);
    });
  }

  it('covers every declared reason code', () => {
    const covered = new Set(cases.map((c) => c.reason));
    const missing = BLOCK_REASONS.filter((r) => !covered.has(r));
    expect(missing, `reason codes with no table-test row: ${missing.join(', ')}`).toEqual([]);
  });

  it('BLOCK always carries at least one reason', () => {
    for (const { mutate } of cases) {
      const result = evaluatePreflight(mutate(allowingInput()), NOW);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('orders reasons by severity, most severe first', () => {
    const input: PreflightInput = {
      ...allowingInput(),
      assetKnown: false, // EVIDENCE_DEGRADED
      registryWrapperIsCurrent: false, // SAFETY_CRITICAL
      action: { ...allowingInput().action, recipient: ZERO_ADDRESS }, // INPUT_REJECTED
    };
    const { reasons } = evaluatePreflight(input, NOW);
    expect(reasons[0]).toBe('OUTDATED_WRAPPER');
    expect(reasons).toContain('UNKNOWN_ASSET');
    expect(reasons.at(-1)).toBe('INVALID_OPERATION_BINDING');
  });

  it('never repeats a reason code', () => {
    // Both the direct wrapper check and the canonicality matrix report OUTDATED_WRAPPER.
    const input: PreflightInput = {
      ...allowingInput(),
      registryWrapperIsCurrent: false,
      canonicality: summarizeCanonicality([
        { name: 'WRAPPER_VERSION_CURRENT', outcome: 'FAIL', detail: 'superseded' },
      ]),
    };
    const { reasons } = evaluatePreflight(input, NOW);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('evaluatePreflight — missing evidence is never an implicit match', () => {
  const optionalEvidence: ReadonlyArray<keyof PreflightInput> = [
    'registryTokenAddress',
    'registryWrapperAddress',
    'registryWrapperIsCurrent',
    'observedWrapperAsset',
    'onChainMultiplierNonce',
    'apiObservedAt',
    'chainObservedAt',
    'evidenceChainId',
  ];

  for (const key of optionalEvidence) {
    it(`removing ${String(key)} turns ALLOW into BLOCK`, () => {
      const input = { ...allowingInput() };
      delete (input as Record<string, unknown>)[key as string];
      const result = evaluatePreflight(input as PreflightInput, NOW);
      expect(result.decision).toBe('BLOCK');
    });
  }

  it('an INCOMPLETE source comparison is not agreement', () => {
    const result = evaluatePreflight(
      {
        ...allowingInput(),
        sourceComparison: { ...allowingInput().sourceComparison, agreement: 'INCOMPLETE' },
      },
      NOW,
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.reasons).toContain('SOURCE_MISMATCH');
  });

  it('an empty canonicality matrix is unproven, not proven — regression', () => {
    // Regression: an indeterminate matrix once produced ALLOW because only FAIL outcomes
    // for specific named checks contributed a reason.
    const result = evaluatePreflight(
      { ...allowingInput(), canonicality: summarizeCanonicality([]) },
      NOW,
    );
    expect(result.decision).toBe('BLOCK');
    expect(result.reasons).toContain('NON_CANONICAL_TOKEN');
  });

  it('every canonicality check name blocks when it is UNKNOWN', () => {
    for (const name of CANONICALITY_CHECK_NAMES) {
      const result = evaluatePreflight(
        {
          ...allowingInput(),
          canonicality: summarizeCanonicality([
            { name, outcome: 'UNKNOWN', detail: 'not determined' },
          ]),
        },
        NOW,
      );
      expect(result.decision, `${name} UNKNOWN must block`).toBe('BLOCK');
    }
  });

  it('an UNKNOWN canonicality check can never produce ALLOW', () => {
    const result = evaluatePreflight(
      {
        ...allowingInput(),
        canonicality: summarizeCanonicality([
          {
            name: 'WRAPPER_ASSET_RELATION',
            outcome: 'UNKNOWN',
            detail: 'ABI does not expose asset()',
          },
        ]),
      },
      NOW,
    );
    expect(result.decision).toBe('BLOCK');
  });
});

describe('evaluatePreflight — checksum casing must not manufacture a mismatch', () => {
  it('accepts a checksummed registry address against a lowercase action address', () => {
    const checksummed = '0x9D275685Dc284c8Eb1c79F6ABa7A63dc75Ec890A';
    const input = allowingInput();
    const result = evaluatePreflight(
      {
        ...input,
        registryTokenAddress: checksummed as typeof TOKEN,
        observedWrapperAsset: checksummed as typeof TOKEN,
      },
      NOW,
    );
    expect(result.decision).toBe('ALLOW');
  });

  it('accepts a checksummed wrapper address', () => {
    const checksummed = '0x943BF64d566c32A2BCD41ac92fB63c111cC9de8F';
    const result = evaluatePreflight(
      { ...allowingInput(), registryWrapperAddress: checksummed as typeof WRAPPER },
      NOW,
    );
    expect(result.decision).toBe('ALLOW');
  });
});

describe('evaluatePreflight — amount semantics', () => {
  it('rejects a zero amount', () => {
    const input = allowingInput();
    const result = evaluatePreflight({ ...input, action: { ...input.action, amount: 0n } }, NOW);
    expect(result.reasons).toContain('INVALID_OPERATION_BINDING');
  });

  it('rejects a negative amount', () => {
    const input = allowingInput();
    const result = evaluatePreflight({ ...input, action: { ...input.action, amount: -1n } }, NOW);
    expect(result.reasons).toContain('INVALID_OPERATION_BINDING');
  });

  it('accepts an amount far beyond Number.MAX_SAFE_INTEGER without loss', () => {
    const input = allowingInput();
    const huge = 2n ** 200n;
    const result = evaluatePreflight({ ...input, action: { ...input.action, amount: huge } }, NOW);
    expect(result.decision).toBe('ALLOW');
  });
});

describe('evaluatePreflight — freshness boundary', () => {
  const at = (age: number) =>
    evaluatePreflight(
      {
        ...allowingInput(),
        apiObservedAt: instant(NOW - age),
        freshness: { apiMaxAge: millis(60_000), chainMaxAge: millis(60_000) },
      },
      NOW,
    );

  it('one millisecond inside the limit still ALLOWs', () => {
    expect(at(59_999).decision).toBe('ALLOW');
  });

  it('exactly at the limit is already stale — ties resolve toward blocking', () => {
    expect(at(60_000).reasons).toContain('STALE_API_EVIDENCE');
  });

  it('one millisecond past the limit is stale', () => {
    expect(at(60_001).reasons).toContain('STALE_API_EVIDENCE');
  });
});

/**
 * These cases were added because mutation testing found the suite did not detect two
 * weakened guards: the operation-digest binding check, and the inclusive upper bound of
 * the receipt validity window. See scripts/mutate-preflight.mjs.
 */
describe('receipt binding and validity boundaries', () => {
  const withReceipt = (over: Partial<NonNullable<PreflightInput['receipt']>>) =>
    evaluatePreflight(
      {
        ...allowingInput(),
        receipt: {
          validAfter: instant(NOW - 60_000),
          validUntil: instant(NOW + 60_000),
          consumed: false,
          recomputedOperationDigest: '0xdigest',
          boundOperationDigest: '0xdigest',
          ...over,
        },
      },
      NOW,
    );

  it('ALLOWs when the recomputed digest reproduces the bound digest', () => {
    expect(withReceipt({}).decision).toBe('ALLOW');
  });

  it('BLOCKs when the recomputed digest differs from the bound digest', () => {
    const result = withReceipt({ recomputedOperationDigest: '0xtampered' });
    expect(result.decision).toBe('BLOCK');
    expect(result.reasons).toContain('INVALID_OPERATION_BINDING');
  });

  it('a single differing character in the digest is enough to block', () => {
    const result = withReceipt({
      boundOperationDigest: '0xdigesT',
    });
    expect(result.reasons).toContain('INVALID_OPERATION_BINDING');
  });

  it('is valid one millisecond before validUntil', () => {
    expect(withReceipt({ validUntil: instant(NOW + 1) }).decision).toBe('ALLOW');
  });

  it('is expired exactly at validUntil — the upper bound is inclusive', () => {
    expect(withReceipt({ validUntil: instant(NOW) }).reasons).toContain('RECEIPT_EXPIRED');
  });

  it('is expired one millisecond past validUntil', () => {
    expect(withReceipt({ validUntil: instant(NOW - 1) }).reasons).toContain('RECEIPT_EXPIRED');
  });

  it('is valid exactly at validAfter — the lower bound is inclusive', () => {
    expect(withReceipt({ validAfter: instant(NOW) }).decision).toBe('ALLOW');
  });

  it('is not yet valid one millisecond before validAfter', () => {
    expect(withReceipt({ validAfter: instant(NOW + 1) }).reasons).toContain(
      'RECEIPT_NOT_YET_VALID',
    );
  });
});
