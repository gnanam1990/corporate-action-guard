/**
 * Price freshness, as a policy rather than a timeout.
 *
 * There is no single "is this price fresh" answer, and pretending there is one is how a
 * weekend equity price ends up authorizing a liquidation. Three things vary:
 *
 * **The action.** Displaying a position tolerates an hours-old price. A liquidation does not.
 * The same round is simultaneously fine and unacceptable depending on what it is for.
 *
 * **The session.** An equity feed legitimately stops publishing outside market hours. At the
 * recorded provenance block the Coinbase AAPL feed's `updatedAt` was about 62 hours old
 * against an 86400 s heartbeat — a weekend, not an outage. A hold and a genuine stall
 * produce the *same* `updatedAt`, so only a declared session policy separates them, and
 * neither is ever silently called fresh.
 *
 * **The chain underneath.** A perfectly recent round means nothing if the sequencer was down
 * when it was published, or has only just recovered.
 *
 * All of this is pure. Every input — the round, the sequencer state, the pause state, the
 * evaluation time — arrives as an argument.
 */

/**
 * The action classes whose evidence requirements differ.
 *
 * Re-exported from `@cag/domain` rather than declared again here. Two lists would drift, and
 * the failure mode is silent: a class added to the preflight matrix with no freshness rule
 * would fall back to whatever the lookup returned for `undefined`.
 */
export {
  B20_ACTION_CLASSES as ACTION_CLASSES,
  type B20ActionClass as ActionClass,
} from '@cag/domain';
import type { B20ActionClass } from '@cag/domain';

export const PRICE_VERDICTS = [
  'FRESH',
  'EXPECTED_HOLD',
  'STALE',
  'ISSUER_PAUSED',
  'SEQUENCER_UNAVAILABLE',
  'INVALID_ROUND',
] as const;
export type PriceVerdict = (typeof PRICE_VERDICTS)[number];

/**
 * Per-action freshness policy.
 *
 * `maxAgeSeconds` is deliberately smaller than the feed's 86400 s heartbeat for every
 * money-moving class. A heartbeat is the issuer's promise about publication cadence, not a
 * statement that a day-old price is safe to liquidate against.
 *
 * `allowExpectedHold` is false everywhere except display. That is the whole point of the
 * distinction: a hold is a correct thing to *show* and never a correct thing to *act on*.
 */
export interface FreshnessPolicy {
  readonly version: string;
  readonly rules: Readonly<
    Record<B20ActionClass, { maxAgeSeconds: bigint; allowExpectedHold: boolean }>
  >;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  version: '2026-09-07.1',
  rules: {
    // Display may show a held or older price, provided it is labelled non-actionable.
    DISPLAY_POSITION: { maxAgeSeconds: 86_400n, allowExpectedHold: true },
    QUOTE: { maxAgeSeconds: 900n, allowExpectedHold: false },
    TRANSFER: { maxAgeSeconds: 900n, allowExpectedHold: false },
    VAULT_DEPOSIT: { maxAgeSeconds: 600n, allowExpectedHold: false },
    VAULT_WITHDRAW: { maxAgeSeconds: 600n, allowExpectedHold: false },
    COLLATERAL_VALUE: { maxAgeSeconds: 300n, allowExpectedHold: false },
    // The tightest: a stale price here liquidates a solvent position.
    LIQUIDATION_CHECK: { maxAgeSeconds: 120n, allowExpectedHold: false },
    INDEX_REBALANCE: { maxAgeSeconds: 300n, allowExpectedHold: false },
    AGENT_ORDER: { maxAgeSeconds: 120n, allowExpectedHold: false },
  },
};

/** A Chainlink round exactly as `latestRoundData` returned it. */
export interface FeedRound {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly startedAt: bigint;
  readonly updatedAt: bigint;
  readonly answeredInRound: bigint;
  readonly decimals: number;
}

/** The sequencer uptime feed's own round. Answer 0 is up, 1 is down. */
export interface SequencerStatus {
  readonly answer: bigint;
  /** When the current up/down state began. Recovery grace is measured from here. */
  readonly startedAt: bigint;
}

/**
 * Whether the market for this asset is expected to be publishing right now.
 *
 * Supplied by the caller from a declared, versioned session calendar — never inferred from
 * the feed's own silence, which would make "the feed stopped" its own excuse.
 */
export interface SessionState {
  readonly expectedPublishing: boolean;
  readonly policyVersion: string;
}

export interface FreshnessInput {
  readonly round: FeedRound;
  readonly sequencer: SequencerStatus;
  readonly issuerPaused: boolean;
  readonly tokenPaused: boolean;
  readonly session: SessionState;
  /** Block timestamp of the evaluation. Not a wall clock. */
  readonly evaluateAtSeconds: bigint;
  readonly sequencerGraceSeconds: bigint;
  /** Decimals recorded in the reviewed feed manifest, to compare against the live read. */
  readonly manifestDecimals: number;
  readonly action: B20ActionClass;
  readonly policy?: FreshnessPolicy;
}

export interface FreshnessResult {
  readonly verdict: PriceVerdict;
  /**
   * May this price back a money-moving decision? True only for `FRESH`.
   *
   * `EXPECTED_HOLD` is deliberately excluded even though it is a *correct* price: an
   * explained old price is still an old price, and the gap between "correct to show" and
   * "correct to liquidate against" is exactly what this product sells.
   */
  readonly actionable: boolean;
  /**
   * May this price be rendered at all, clearly labelled as non-current?
   *
   * True for `FRESH`, and for `EXPECTED_HOLD` where the action class permits it — which is
   * display only. Never true for `STALE`, a pause, an invalid round or a sequencer outage:
   * those are states where showing a number invites acting on it.
   */
  readonly usableForDisplay: boolean;
  readonly ageSeconds: bigint;
  readonly maxAgeSeconds: bigint;
  readonly policyVersion: string;
  readonly detail: string;
}

/**
 * Resolve a price verdict.
 *
 * The order is load-bearing: each earlier condition makes the later readings meaningless. A
 * round published while the sequencer was down is not "recent", it is unreliable, and
 * checking its age first would let it pass.
 */
export function evaluateFreshness(input: FreshnessInput): FreshnessResult {
  const policy = input.policy ?? DEFAULT_FRESHNESS_POLICY;
  const rule = policy.rules[input.action];
  if (rule === undefined) {
    // Only reachable if an action class exists in the shared list with no freshness rule.
    // Refusing is the safe direction: an unknown class must not inherit a permissive default.
    throw new RangeError(
      `no freshness rule for action class ${input.action}; every class in B20_ACTION_CLASSES ` +
        'must have one',
    );
  }
  const age = input.evaluateAtSeconds - input.round.updatedAt;

  const result = (verdict: PriceVerdict, detail: string, actionable = false): FreshnessResult => ({
    verdict,
    actionable,
    usableForDisplay: actionable || (verdict === 'EXPECTED_HOLD' && rule.allowExpectedHold),
    ageSeconds: age,
    maxAgeSeconds: rule.maxAgeSeconds,
    policyVersion: policy.version,
    detail,
  });

  // 1. The chain underneath.
  if (input.sequencer.answer !== 0n) {
    return result('SEQUENCER_UNAVAILABLE', 'the Base sequencer uptime feed reports it is down');
  }
  const sinceRecovery = input.evaluateAtSeconds - input.sequencer.startedAt;
  if (sinceRecovery < input.sequencerGraceSeconds) {
    // Prices published while the chain was catching up reflect a market the chain could not
    // see. The grace period is what stops a recovery from immediately liquidating people.
    return result(
      'SEQUENCER_UNAVAILABLE',
      `the sequencer recovered ${String(sinceRecovery)}s ago, inside the ` +
        `${String(input.sequencerGraceSeconds)}s grace period`,
    );
  }

  // 2. Deliberate pauses, which usually bracket a corporate action.
  if (input.issuerPaused) return result('ISSUER_PAUSED', 'the issuer has paused this feed');
  if (input.tokenPaused) {
    return result('ISSUER_PAUSED', 'the token has paused the feature this action requires');
  }

  // 3. The round's own integrity.
  if (input.round.decimals !== input.manifestDecimals) {
    return result(
      'INVALID_ROUND',
      `feed reports ${String(input.round.decimals)} decimals, the reviewed manifest records ` +
        `${String(input.manifestDecimals)}`,
    );
  }
  if (input.round.answer <= 0n) {
    return result('INVALID_ROUND', 'a non-positive answer is never a price');
  }
  if (input.round.updatedAt === 0n) {
    return result('INVALID_ROUND', 'updatedAt is zero: the round was never completed');
  }
  if (input.round.updatedAt > input.evaluateAtSeconds) {
    // A future timestamp means the clocks disagree or the data is fabricated. Either way the
    // age computation below would be negative and would read as extremely fresh.
    return result('INVALID_ROUND', 'updatedAt is in the future relative to the evaluated block');
  }
  if (input.round.answeredInRound < input.round.roundId) {
    return result('INVALID_ROUND', 'answeredInRound is behind roundId: the answer is carried over');
  }

  // 4. Age, interpreted through the session policy.
  if (age <= rule.maxAgeSeconds) {
    return result('FRESH', `${String(age)}s old, within ${String(rule.maxAgeSeconds)}s`, true);
  }
  if (!input.session.expectedPublishing) {
    // The market is closed by a declared calendar, so the silence is explained. It is still
    // not actionable: an explained old price is an old price.
    return result(
      'EXPECTED_HOLD',
      `${String(age)}s old; the ${input.session.policyVersion} session policy expects no ` +
        'publication right now. Displayable where the action class permits it, never actionable',
    );
  }
  return result(
    'STALE',
    `${String(age)}s old, beyond ${String(rule.maxAgeSeconds)}s, with no session policy ` +
      'explaining the gap',
  );
}
