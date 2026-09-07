/**
 * B20 preflight.
 *
 * The property under test is that the *same evidence* produces different decisions for
 * different action classes — because that is the thing a single freshness threshold cannot
 * express, and it is why this evaluator exists alongside the X Layer one rather than
 * replacing it.
 *
 * The second property is that nothing falls through to ALLOW. Every way evidence can be
 * absent, degraded or contradictory has a named reason and a test.
 */
import { describe, expect, it } from 'vitest';
import {
  B20_ACTION_CLASSES,
  canonicalizeB20Operation,
  DEFAULT_B20_POLICY,
  evaluateB20Preflight,
  type B20ActionClass,
  type B20Operation,
  type B20PreflightEvidence,
} from '../../src/index.js';

const ONE = 1_000_000_000_000_000_000n;
const NOW = 1_788_776_091n;
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';

function operation(overrides: Partial<B20Operation> = {}): B20Operation {
  return {
    operationId: 'op-1',
    clientRequestId: 'req-1',
    chainId: 8453,
    assetAddress: AAPL,
    actionClass: 'TRANSFER',
    sender: '0xaaa0000000000000000000000000000000000001',
    recipient: '0xbbb0000000000000000000000000000000000002',
    rawAmount: 100_000_000n,
    targetContract: '0xccc0000000000000000000000000000000000003',
    operationDigest: `0x${'11'.repeat(32)}`,
    expectedMultiplierWad: ONE,
    integrationPolicyVersion: 'integrator-v3',
    ...overrides,
  };
}

/** Everything present, comparable and agreeing. */
function evidence(overrides: Partial<B20PreflightEvidence> = {}): B20PreflightEvidence {
  return {
    identityStatus: 'VERIFIED',
    isFixture: false,
    targetConfigured: true,
    priceVerdict: 'FRESH',
    pairingReviewed: true,
    sequencerHealthy: true,
    tokenPaused: false,
    scheduleCapability: 'LIVE',
    secondsUntilActivation: undefined,
    guardWindowSeconds: 3_600n,
    evidenceBlocksComparable: true,
    openIncident: false,
    evidenceEventIds: ['event-1', 'event-2'],
    ...overrides,
  };
}

const decide = (
  actionClass: B20ActionClass,
  overrides: Partial<B20PreflightEvidence> = {},
  observedMultiplierWad: bigint | undefined = ONE,
) =>
  evaluateB20Preflight({
    operation: operation({ actionClass }),
    evidence: evidence(overrides),
    observedMultiplierWad,
    evaluateAtSeconds: NOW,
    resultTtlSeconds: 300n,
  });

describe('the same evidence decides differently per action class', () => {
  it('allows display on an unreviewed pairing and refuses a transfer', () => {
    // The boundary token-feed-pairing.json draws. Since every pairing is currently
    // INFERRED_UNREVIEWED, this is the live behaviour on today's data, not a hypothetical.
    expect(decide('DISPLAY_POSITION', { pairingReviewed: false }).decision).toBe('ALLOW');
    const transfer = decide('TRANSFER', { pairingReviewed: false });
    expect(transfer.decision).toBe('BLOCK');
    expect(transfer.reasons).toContain('B20_FEED_PAIRING_UNREVIEWED');
  });

  it('allows display with no price at all and refuses a liquidation check', () => {
    expect(decide('DISPLAY_POSITION', { priceVerdict: undefined }).decision).toBe('ALLOW');
    expect(decide('LIQUIDATION_CHECK', { priceVerdict: undefined }).decision).toBe('BLOCK');
  });

  it('allows display on an expected weekend hold and refuses a quote', () => {
    // An explained old price is still an old price. Correct to show, wrong to act on.
    expect(decide('DISPLAY_POSITION', { priceVerdict: 'EXPECTED_HOLD' }).decision).toBe('ALLOW');
    const quote = decide('QUOTE', { priceVerdict: 'EXPECTED_HOLD' });
    expect(quote.decision).toBe('BLOCK');
    expect(quote.reasons).toContain('B20_FEED_EXPECTED_HOLD');
  });

  it('gives every action class a rule', () => {
    // A class with no rule would fall back to whatever the lookup returned for undefined.
    for (const actionClass of B20_ACTION_CLASSES) {
      expect(DEFAULT_B20_POLICY.rules[actionClass], actionClass).toBeDefined();
    }
  });

  it('makes only display exempt from a reviewed pairing', () => {
    for (const actionClass of B20_ACTION_CLASSES) {
      const rule = DEFAULT_B20_POLICY.rules[actionClass];
      if (actionClass === 'DISPLAY_POSITION') expect(rule.requiresReviewedPairing).toBe(false);
      else expect(rule.requiresReviewedPairing, actionClass).toBe(true);
    }
  });
});

describe('nothing falls through to ALLOW', () => {
  const blocked: readonly {
    name: string;
    evidence: Partial<B20PreflightEvidence>;
    reason: string;
  }[] = [
    {
      name: 'unknown identity',
      evidence: { identityStatus: undefined },
      reason: 'B20_UNKNOWN_ASSET',
    },
    {
      name: 'identity conflict',
      evidence: { identityStatus: 'CONFLICT' },
      reason: 'B20_IDENTITY_DRIFT',
    },
    {
      name: 'retired asset',
      evidence: { identityStatus: 'RETIRED' },
      reason: 'B20_NOT_ON_OFFICIAL_LIST',
    },
    { name: 'a fixture', evidence: { isFixture: true }, reason: 'B20_FIXTURE_NOT_PRODUCTION' },
    {
      name: 'incomparable evidence blocks',
      evidence: { evidenceBlocksComparable: false },
      reason: 'B20_EVIDENCE_BLOCK_MISMATCH',
    },
    {
      name: 'unconfigured target',
      evidence: { targetConfigured: false },
      reason: 'B20_UNSUPPORTED_ACTION_CLASS',
    },
    { name: 'paused token', evidence: { tokenPaused: true }, reason: 'B20_TOKEN_PAUSED' },
    {
      name: 'a chain that cannot report a schedule',
      evidence: { scheduleCapability: 'NOT_DIALED' },
      reason: 'B20_UNSUPPORTED_CAPABILITY',
    },
    {
      name: 'an activation inside the guard window',
      evidence: { secondsUntilActivation: 60n },
      reason: 'B20_SCHEDULE_NOT_YET_EFFECTIVE',
    },
    { name: 'a stale price', evidence: { priceVerdict: 'STALE' }, reason: 'B20_FEED_STALE' },
    {
      name: 'an invalid round',
      evidence: { priceVerdict: 'INVALID_ROUND' },
      reason: 'B20_FEED_INVALID_ROUND',
    },
    {
      name: 'an issuer pause',
      evidence: { priceVerdict: 'ISSUER_PAUSED' },
      reason: 'B20_ISSUER_PAUSED',
    },
    {
      name: 'a down sequencer',
      evidence: { sequencerHealthy: false },
      reason: 'B20_SEQUENCER_DOWN',
    },
    {
      name: 'an unread sequencer',
      evidence: { sequencerHealthy: undefined },
      reason: 'B20_RPC_UNAVAILABLE',
    },
  ];

  for (const testCase of blocked) {
    it(`refuses a transfer with ${testCase.name}`, () => {
      const result = decide('TRANSFER', testCase.evidence);
      expect(result.decision).not.toBe('ALLOW');
      expect(result.reasons).toContain(testCase.reason);
      expect(result.receiptEligible).toBe(false);
    });
  }

  it('allows only when every mandatory source agrees', () => {
    const result = decide('TRANSFER');
    expect(result.decision).toBe('ALLOW');
    expect(result.reasons).toEqual([]);
    expect(result.receiptEligible).toBe(true);
  });
});

describe('the multiplier the caller assumed', () => {
  it('blocks when it disagrees with the observed one', () => {
    // An operation sized against the wrong multiplier is the wrong size. Not a warning.
    const result = decide('TRANSFER', {}, ONE * 10n);
    expect(result.decision).toBe('BLOCK');
    expect(result.reasons).toContain('B20_MULTIPLIER_CONTINUITY_BROKEN');
  });

  it('blocks when the multiplier could not be read at all', () => {
    // Called directly rather than through the helper: passing `undefined` to a parameter
    // with a default silently uses the default, and the test would assert nothing.
    const result = evaluateB20Preflight({
      operation: operation({ actionClass: 'TRANSFER' }),
      evidence: evidence(),
      observedMultiplierWad: undefined,
      evaluateAtSeconds: NOW,
      resultTtlSeconds: 300n,
    });
    expect(result.decision).toBe('BLOCK');
    expect(result.reasons).toContain('B20_RPC_UNAVAILABLE');
  });
});

describe('REVIEW is reserved for things a human could sign off', () => {
  it('reviews a renamed asset when nothing else is wrong', () => {
    // A rename does not change identity; it does need a look, because a symbol that suddenly
    // reads like another asset's is how a display-layer confusion starts.
    const result = decide('TRANSFER', { identityStatus: 'CHANGED' });
    expect(result.decision).toBe('REVIEW');
    expect(result.reasons).toContain('B20_IDENTITY_DRIFT');
    expect(result.receiptEligible).toBe(false);
  });

  it('blocks rather than reviews when a hard reason is also present', () => {
    // No amount of operator confidence makes an operation against a stale price safe.
    const result = decide('TRANSFER', { identityStatus: 'CHANGED', priceVerdict: 'STALE' });
    expect(result.decision).toBe('BLOCK');
  });

  it('reviews an open incident', () => {
    const result = decide('TRANSFER', { openIncident: true });
    expect(result.decision).toBe('REVIEW');
    expect(result.reasons).toContain('B20_MANUAL_REVIEW_REQUIRED');
  });
});

describe('the result carries what a caller needs', () => {
  it('records the policy version, so a policy change can invalidate it', () => {
    expect(decide('TRANSFER').policyVersion).toBe(DEFAULT_B20_POLICY.version);
  });

  it('expires', () => {
    const result = decide('TRANSFER');
    expect(result.expiresAtSeconds).toBe(NOW + 300n);
    expect(result.evaluatedAtSeconds).toBe(NOW);
  });

  it('links to the evidence behind it', () => {
    expect(decide('TRANSFER').evidenceEventIds).toEqual(['event-1', 'event-2']);
  });

  it('never marks a display decision receipt-eligible', () => {
    // Display does not move value, so there is nothing for a receipt to authorize.
    expect(decide('DISPLAY_POSITION').receiptEligible).toBe(false);
    expect(decide('QUOTE').receiptEligible).toBe(false);
  });

  it('explains itself from the codes, with no model in the path', () => {
    const blocked = decide('TRANSFER', { priceVerdict: 'STALE' });
    expect(blocked.explanation).toContain('B20_FEED_STALE');
    expect(decide('TRANSFER').explanation).toContain('agree');
  });

  it('deduplicates reasons without losing one', () => {
    const result = decide('TRANSFER', {
      priceVerdict: 'SEQUENCER_UNAVAILABLE',
      sequencerHealthy: false,
    });
    expect(new Set(result.reasons).size).toBe(result.reasons.length);
    expect(result.reasons).toContain('B20_SEQUENCER_DOWN');
  });
});

describe('canonicalization', () => {
  it('does not depend on how the caller ordered its object keys', () => {
    // Idempotency keyed on a hash that moved with key order would treat a reformatted retry
    // as a different request and issue a second receipt.
    const a = operation();
    const b: B20Operation = {
      integrationPolicyVersion: a.integrationPolicyVersion,
      expectedMultiplierWad: a.expectedMultiplierWad,
      operationDigest: a.operationDigest,
      targetContract: a.targetContract,
      rawAmount: a.rawAmount,
      recipient: a.recipient,
      sender: a.sender,
      actionClass: a.actionClass,
      assetAddress: a.assetAddress,
      chainId: a.chainId,
      clientRequestId: a.clientRequestId,
      operationId: a.operationId,
    };
    expect(canonicalizeB20Operation(b)).toBe(canonicalizeB20Operation(a));
  });

  it('is insensitive to address casing, which is a checksum not an identity', () => {
    expect(
      canonicalizeB20Operation(operation({ assetAddress: AAPL.toUpperCase().replace('0X', '0x') })),
    ).toBe(canonicalizeB20Operation(operation()));
  });

  it('changes when the amount changes', () => {
    expect(canonicalizeB20Operation(operation({ rawAmount: 1n }))).not.toBe(
      canonicalizeB20Operation(operation()),
    );
  });

  it('excludes the server-assigned operation id', () => {
    // The id is assigned by us, so including it would make every request unique and defeat
    // idempotency entirely.
    expect(canonicalizeB20Operation(operation({ operationId: 'op-999' }))).toBe(
      canonicalizeB20Operation(operation()),
    );
  });
});
