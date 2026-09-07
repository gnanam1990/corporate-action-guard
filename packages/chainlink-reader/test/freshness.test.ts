/**
 * Price freshness.
 *
 * The case that motivates this whole module is real and is in the committed provenance: at
 * Base block 50993686 the Coinbase AAPL feed's `updatedAt` was about 62 hours old against an
 * 86400 s heartbeat. That is a weekend, not an outage — and the two are indistinguishable
 * from `updatedAt` alone. Every test below is about not guessing which one it is.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  DEFAULT_FRESHNESS_POLICY,
  evaluateFreshness,
  SEQUENCER_DOWN,
  SEQUENCER_UP,
  type FreshnessInput,
} from '../src/index.js';

/** Real values from provenance/base-b20/feed-manifest.json, AAPL at the recorded block. */
const NOW = 1_788_776_091n;
const RECENT = NOW - 60n;

function input(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    round: {
      roundId: 36_893_488_147_419_103_373n,
      answer: 32_008_000_000n,
      startedAt: RECENT,
      updatedAt: RECENT,
      answeredInRound: 36_893_488_147_419_103_373n,
      decimals: 8,
    },
    sequencer: { answer: SEQUENCER_UP, startedAt: NOW - 100_000n },
    issuerPaused: false,
    tokenPaused: false,
    session: { expectedPublishing: true, policyVersion: 'us-equities-2026' },
    evaluateAtSeconds: NOW,
    sequencerGraceSeconds: 1_800n,
    manifestDecimals: 8,
    action: 'LIQUIDATION_CHECK',
    ...overrides,
  };
}

describe('a fresh round', () => {
  it('is actionable for the tightest action class', () => {
    const result = evaluateFreshness(input());
    expect(result.verdict).toBe('FRESH');
    expect(result.actionable).toBe(true);
    expect(result.usableForDisplay).toBe(true);
  });

  it('records the policy version it was judged against', () => {
    // A policy change invalidates cached decisions, so the version travels with the verdict.
    expect(evaluateFreshness(input()).policyVersion).toBe(DEFAULT_FRESHNESS_POLICY.version);
  });
});

describe('the weekend, which is the whole problem', () => {
  const weekend = { updatedAt: NOW - 224_190n, startedAt: NOW - 224_190n };

  it('is an expected hold when a declared session policy explains it', () => {
    const result = evaluateFreshness(
      input({
        round: { ...input().round, ...weekend },
        session: { expectedPublishing: false, policyVersion: 'us-equities-2026' },
        action: 'DISPLAY_POSITION',
      }),
    );
    expect(result.verdict).toBe('EXPECTED_HOLD');
    expect(result.detail).toContain('us-equities-2026');
  });

  it('is displayable and still never actionable', () => {
    // An explained old price is still an old price. The gap between "correct to show" and
    // "correct to liquidate against" is exactly what this product sells.
    const result = evaluateFreshness(
      input({
        round: { ...input().round, ...weekend },
        session: { expectedPublishing: false, policyVersion: 'us-equities-2026' },
        action: 'DISPLAY_POSITION',
      }),
    );
    expect(result.actionable).toBe(false);
    expect(result.usableForDisplay).toBe(true);
  });

  it('is not even displayable for a money-moving class', () => {
    const result = evaluateFreshness(
      input({
        round: { ...input().round, ...weekend },
        session: { expectedPublishing: false, policyVersion: 'us-equities-2026' },
        action: 'LIQUIDATION_CHECK',
      }),
    );
    expect(result.verdict).toBe('EXPECTED_HOLD');
    expect(result.usableForDisplay).toBe(false);
  });

  it('is STALE, not a hold, when the market is supposed to be publishing', () => {
    // The same updatedAt. Only the declared session state separates the two, and the feed's
    // own silence may never be its own excuse.
    const result = evaluateFreshness(
      input({
        round: { ...input().round, ...weekend },
        session: { expectedPublishing: true, policyVersion: 'us-equities-2026' },
        action: 'DISPLAY_POSITION',
      }),
    );
    expect(result.verdict).toBe('STALE');
    expect(result.actionable).toBe(false);
    expect(result.usableForDisplay).toBe(false);
  });
});

describe('the chain underneath is checked first', () => {
  it('refuses while the sequencer is down, however recent the round', () => {
    const result = evaluateFreshness(
      input({ sequencer: { answer: SEQUENCER_DOWN, startedAt: NOW - 10n } }),
    );
    expect(result.verdict).toBe('SEQUENCER_UNAVAILABLE');
  });

  it('refuses during the recovery grace period', () => {
    // Prices published while the chain was catching up reflect a market it could not see.
    // Without this, a recovery immediately liquidates people.
    const result = evaluateFreshness(
      input({ sequencer: { answer: SEQUENCER_UP, startedAt: NOW - 60n } }),
    );
    expect(result.verdict).toBe('SEQUENCER_UNAVAILABLE');
    expect(result.detail).toContain('grace period');
  });

  it('accepts once the grace period has elapsed', () => {
    const result = evaluateFreshness(
      input({ sequencer: { answer: SEQUENCER_UP, startedAt: NOW - 1_801n } }),
    );
    expect(result.verdict).toBe('FRESH');
  });

  it('checks the sequencer before the round age, because the order changes the answer', () => {
    // A round published while the sequencer was down is not "recent", it is unreliable.
    // Checking age first would let it pass.
    const result = evaluateFreshness(
      input({
        sequencer: { answer: SEQUENCER_DOWN, startedAt: NOW - 10n },
        round: { ...input().round, updatedAt: NOW },
      }),
    );
    expect(result.verdict).toBe('SEQUENCER_UNAVAILABLE');
  });
});

describe('deliberate pauses', () => {
  it('reports an issuer pause, which usually brackets a corporate action', () => {
    expect(evaluateFreshness(input({ issuerPaused: true })).verdict).toBe('ISSUER_PAUSED');
  });

  it('reports a token pause covering the operation', () => {
    expect(evaluateFreshness(input({ tokenPaused: true })).verdict).toBe('ISSUER_PAUSED');
  });
});

describe('round integrity', () => {
  it('rejects decimals that differ from the reviewed manifest', () => {
    // Adopting the live value would silently rescale every price by orders of magnitude.
    const result = evaluateFreshness(
      input({ round: { ...input().round, decimals: 18 }, manifestDecimals: 8 }),
    );
    expect(result.verdict).toBe('INVALID_ROUND');
    expect(result.detail).toContain('decimals');
  });

  it('rejects a non-positive answer', () => {
    expect(evaluateFreshness(input({ round: { ...input().round, answer: 0n } })).verdict).toBe(
      'INVALID_ROUND',
    );
    expect(evaluateFreshness(input({ round: { ...input().round, answer: -1n } })).verdict).toBe(
      'INVALID_ROUND',
    );
  });

  it('rejects a zero updatedAt: the round was never completed', () => {
    expect(evaluateFreshness(input({ round: { ...input().round, updatedAt: 0n } })).verdict).toBe(
      'INVALID_ROUND',
    );
  });

  it('rejects a future updatedAt, which would compute as extremely fresh', () => {
    const result = evaluateFreshness(input({ round: { ...input().round, updatedAt: NOW + 600n } }));
    expect(result.verdict).toBe('INVALID_ROUND');
    expect(result.detail).toContain('future');
  });

  it('rejects an answer carried over from an earlier round', () => {
    const result = evaluateFreshness(
      input({
        round: { ...input().round, roundId: 100n, answeredInRound: 99n },
      }),
    );
    expect(result.verdict).toBe('INVALID_ROUND');
    expect(result.detail).toContain('answeredInRound');
  });
});

describe('the policy is per action, not one timeout', () => {
  it('gives every action class a rule', () => {
    for (const action of ACTION_CLASSES) {
      expect(DEFAULT_FRESHNESS_POLICY.rules[action], `${action} has no rule`).toBeDefined();
    }
  });

  it('keeps every money-moving class well inside the feed heartbeat', () => {
    // The 86400 s heartbeat is the issuer's promise about cadence, not a statement that a
    // day-old price is safe to liquidate against.
    for (const action of ACTION_CLASSES) {
      if (action === 'DISPLAY_POSITION') continue;
      expect(DEFAULT_FRESHNESS_POLICY.rules[action].maxAgeSeconds).toBeLessThan(86_400n);
      expect(DEFAULT_FRESHNESS_POLICY.rules[action].allowExpectedHold).toBe(false);
    }
  });

  it('accepts a round for display that it refuses for a liquidation', () => {
    // The same round, simultaneously fine and unacceptable. That is the point of the matrix.
    const hourOld = { ...input().round, updatedAt: NOW - 3_600n };
    expect(evaluateFreshness(input({ round: hourOld, action: 'DISPLAY_POSITION' })).verdict).toBe(
      'FRESH',
    );
    expect(evaluateFreshness(input({ round: hourOld, action: 'LIQUIDATION_CHECK' })).verdict).toBe(
      'STALE',
    );
  });

  it('is tightest for liquidation and agent orders', () => {
    const rules = DEFAULT_FRESHNESS_POLICY.rules;
    const tightest = Math.min(...ACTION_CLASSES.map((a) => Number(rules[a].maxAgeSeconds)));
    expect(Number(rules.LIQUIDATION_CHECK.maxAgeSeconds)).toBe(tightest);
    expect(Number(rules.AGENT_ORDER.maxAgeSeconds)).toBe(tightest);
  });
});
