/**
 * The conformance scenario catalogue.
 *
 * Every scenario is a small, deterministic world: a sequence of B20 facts and price rounds,
 * plus the single question the integration is asked at the end and the answer it has to give.
 * A scenario passes only when the integration produces the *correct specific* answer — a
 * generic error where a named safe state is required is a failure, because "something went
 * wrong" is not the same as "I refused to value a share-equivalent with a total-return
 * price".
 *
 * These run offline. No RPC, no database, no clock. That is what lets a customer put them in
 * their own CI and get the same result the hosted lab gets.
 */

import type { B20Reason } from '@cag/domain';

export const SCENARIO_IDS = [
  'DIVIDEND_SHAPED_INCREASE_STAYS_UNKNOWN',
  'FORWARD_SPLIT_10_TO_1',
  'REVERSE_SPLIT_1_TO_10_WITH_PAUSE',
  'SCHEDULE_CANCELLED_BEFORE_EFFECTIVE',
  'CANCEL_AND_RESCHEDULE',
  'INSTANT_OVERRIDE_CLEARS_PENDING',
  'LEGACY_AND_CANONICAL_ONE_UPDATE',
  'SYMBOL_RENAME_STABLE_IDENTITY',
  'CHAINLINK_ISSUER_PAUSE',
  'OFF_HOURS_HOLD_VERSUS_STALE',
  'SEQUENCER_DOWN_AND_GRACE',
  'SHALLOW_REORG_REPLACES_ACTION',
  'WRONG_TOKEN_FEED_MAPPING',
  'FAKE_B20_PREFIX_ASSET',
  'CONCURRENT_SAME_KEY_PREFLIGHT',
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** What the integration is asked to produce at the end of the scenario. */
export const QUESTION_KINDS = [
  /** "How many shares does this account hold?" — raw units and the multiplier are given. */
  'SHARE_EQUIVALENT',
  /** "What is this position worth?" */
  'POSITION_VALUE',
  /** "Is a corporate action pending, and when?" */
  'PENDING_ACTION',
  /** "What kind of corporate action was this?" */
  'ACTION_CLASSIFICATION',
  /** "May this operation proceed?" */
  'PREFLIGHT_DECISION',
  /** "Which asset is this?" */
  'ASSET_IDENTITY',
  /**
   * "How many corporate-action postings did you book?"
   *
   * This exists because `MultiplierUpdated` carries an *absolute* new multiplier, not a
   * delta — so booking one update twice leaves the multiplier correct and the ledger wrong.
   * Asking for the share count would let a double-booking integration pass. The damage is
   * two restatements against one business fact, so that is what gets asked.
   */
  'RESTATEMENT_COUNT',
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/**
 * A fact the scenario replays into the integration.
 *
 * Deliberately the same shape the reader produces, so a scenario is a recording rather than a
 * separate fixture format that can drift from reality.
 */
export interface ScenarioFact {
  readonly kind:
    | 'ASSET_STATE'
    | 'MULTIPLIER_UPDATED'
    | 'MULTIPLIER_UPDATED_LEGACY'
    | 'SCHEDULE_CANCELLED'
    | 'ANNOUNCEMENT_OPENED'
    | 'ANNOUNCEMENT_CLOSED'
    | 'PAUSED'
    | 'UNPAUSED'
    | 'METADATA_CHANGED'
    | 'FEED_ROUND'
    | 'SEQUENCER_STATUS'
    | 'REORG';
  readonly blockNumber: bigint;
  readonly blockTimestampSeconds: bigint;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly fields: Readonly<Record<string, string>>;
}

export interface ScenarioExpectation {
  readonly question: QuestionKind;
  /**
   * The exact answer required. A string so the comparison is unambiguous and an integration
   * cannot pass by returning something that coerces equal.
   */
  readonly answer: string;
  /** Reason codes the answer must carry. A superset is allowed; a missing one fails. */
  readonly requiredReasons: readonly B20Reason[];
  /** Reason codes the answer must NOT carry. */
  readonly forbiddenReasons: readonly B20Reason[];
  /** Why this is the right answer. Shown in the result so a failure explains itself. */
  readonly rationale: string;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly version: string;
  readonly title: string;
  /** What real-world failure this catches. Written for the integrator, not for us. */
  readonly catches: string;
  readonly facts: readonly ScenarioFact[];
  readonly evaluateAtSeconds: bigint;
  readonly expectation: ScenarioExpectation;
}

const ONE = 1_000_000_000_000_000_000n;
const T0 = 1_788_000_000n;
const at = (offset: number) => T0 + BigInt(offset) * 2n;

let sequence = 0;
function fact(
  kind: ScenarioFact['kind'],
  block: number,
  fields: Record<string, string> = {},
): ScenarioFact {
  sequence += 1;
  return {
    kind,
    blockNumber: BigInt(1000 + block),
    blockTimestampSeconds: at(block),
    transactionIndex: 0,
    logIndex: sequence % 8,
    fields,
  };
}

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';

/**
 * The catalogue.
 *
 * Ordered so the first one is the one most integrations fail: a dividend-shaped multiplier
 * increase that has to stay UNKNOWN. It is first because it is the one that separates an
 * integration that reports evidence from one that guesses.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'DIVIDEND_SHAPED_INCREASE_STAYS_UNKNOWN',
    version: '1',
    title: 'A small multiplier increase with no typed evidence',
    catches:
      'An integration that labels any multiplier increase a dividend or a split. The chain ' +
      'records the change; it does not record what the change means.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('ANNOUNCEMENT_OPENED', 5, { id: 'CA-1', description: 'Quarterly distribution' }),
      fact('MULTIPLIER_UPDATED', 5, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: ((ONE * 10_032n) / 10_000n).toString(),
        effectiveAtSeconds: at(5).toString(),
      }),
      fact('ANNOUNCEMENT_CLOSED', 5, { id: 'CA-1' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'ACTION_CLASSIFICATION',
      answer: 'UNKNOWN',
      requiredReasons: ['B20_UNCLASSIFIED_BUSINESS_EVENT'],
      forbiddenReasons: [],
      rationale:
        'A 1.0032x increase is the shape of a reinvested dividend and also the shape of a ' +
        'small split. Nothing on chain distinguishes them, so the honest answer is UNKNOWN ' +
        'while the state change itself is fully reconciled.',
    },
  },
  {
    id: 'FORWARD_SPLIT_10_TO_1',
    version: '1',
    title: '10:1 forward split with a compensated price',
    catches:
      'Two errors at once: reading balanceOf as a share count, and multiplying the resulting ' +
      'share count by the already-adjusted Chainlink price.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('FEED_ROUND', 0, { answer: '20000000000', decimals: '8' }),
      fact('MULTIPLIER_UPDATED', 10, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 10n).toString(),
        effectiveAtSeconds: at(10).toString(),
      }),
      // The total-return token price does NOT move. `totalReturn = underlying * multiplier`,
      // so a split that divides the underlying by ten and multiplies the multiplier by ten
      // leaves the token price exactly where it was. That invariance is the entire reason
      // route A is the safe route, and publishing a divided token price here would have made
      // the scenario reward the wrong arithmetic.
      fact('FEED_ROUND', 11, { answer: '20000000000', decimals: '8' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'POSITION_VALUE',
      // 1.0 raw token at 8 decimals x $200.00 total-return price, at 16 decimals.
      answer: '200.0000000000000000',
      requiredReasons: [],
      forbiddenReasons: ['B20_DOUBLE_MULTIPLIER_APPLIED'],
      rationale:
        'The share count went from 1 to 10 and the underlying price from $200 to $20, so the ' +
        'position is still worth $200 — and the total-return token price never moved. Route A ' +
        'reads $200 straight off the raw amount. An integration reporting $2,000 multiplied ' +
        'the new share count by a price that already contained the multiplier.',
    },
  },
  {
    id: 'REVERSE_SPLIT_1_TO_10_WITH_PAUSE',
    version: '1',
    title: '1:10 reverse split inside a pause window',
    catches:
      'An integration that values or transfers during the pause window, or that reports the ' +
      'post-split share count before the multiplier actually moved.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('PAUSED', 5, { features: 'TRANSFER' }),
      fact('MULTIPLIER_UPDATED', 6, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE / 10n).toString(),
        effectiveAtSeconds: at(6).toString(),
      }),
      fact('UNPAUSED', 8, { features: 'TRANSFER' }),
    ],
    evaluateAtSeconds: at(7),
    expectation: {
      question: 'PREFLIGHT_DECISION',
      answer: 'BLOCK',
      requiredReasons: ['B20_TOKEN_PAUSED'],
      forbiddenReasons: [],
      rationale:
        'At block 1007 the token is still paused for transfers. A preflight that allows a ' +
        'transfer here produces an operation the token will revert.',
    },
  },
  {
    id: 'SCHEDULE_CANCELLED_BEFORE_EFFECTIVE',
    version: '1',
    title: 'A scheduled update cancelled before it activates',
    catches:
      'An integration that applies a scheduled multiplier on event arrival, or that never ' +
      'processes the cancellation.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('MULTIPLIER_UPDATED', 5, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 10n).toString(),
        effectiveAtSeconds: at(100).toString(),
      }),
      fact('SCHEDULE_CANCELLED', 50, {
        cancelledMultiplierWad: (ONE * 10n).toString(),
        cancelledEffectiveAtSeconds: at(100).toString(),
      }),
    ],
    evaluateAtSeconds: at(200),
    expectation: {
      question: 'SHARE_EQUIVALENT',
      answer: '100000000',
      requiredReasons: ['B20_SCHEDULE_CANCELLED'],
      forbiddenReasons: [],
      rationale:
        'The 10x was cancelled 50 seconds before it would have activated. An integration ' +
        'reporting 1000000000 applied a multiplier that never took effect.',
    },
  },
  {
    id: 'CANCEL_AND_RESCHEDULE',
    version: '1',
    title: 'Cancel and reschedule in one announcement',
    catches:
      'An integration that treats the cancel and the new schedule as two independent events ' +
      'and ends up with two pending updates.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('MULTIPLIER_UPDATED', 5, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 10n).toString(),
        effectiveAtSeconds: at(100).toString(),
      }),
      fact('ANNOUNCEMENT_OPENED', 50, { id: 'CA-2', description: 'Revised effective date' }),
      fact('SCHEDULE_CANCELLED', 50, {
        cancelledMultiplierWad: (ONE * 10n).toString(),
        cancelledEffectiveAtSeconds: at(100).toString(),
      }),
      fact('MULTIPLIER_UPDATED', 50, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 10n).toString(),
        effectiveAtSeconds: at(300).toString(),
      }),
      fact('ANNOUNCEMENT_CLOSED', 50, { id: 'CA-2' }),
    ],
    evaluateAtSeconds: at(150),
    expectation: {
      question: 'PENDING_ACTION',
      answer: at(300).toString(),
      requiredReasons: ['B20_SCHEDULE_NOT_YET_EFFECTIVE'],
      forbiddenReasons: [],
      rationale:
        'Exactly one pending update exists, effective at the revised time. An integration ' +
        'still holding the original effective time will act a whole window early.',
    },
  },
  {
    id: 'INSTANT_OVERRIDE_CLEARS_PENDING',
    version: '1',
    title: 'An emergency instant override clears a pending schedule',
    catches:
      'An integration that keeps a pending schedule alive after an instant update superseded ' +
      'it, and applies it again when the original effective time arrives.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('MULTIPLIER_UPDATED', 5, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 10n).toString(),
        effectiveAtSeconds: at(100).toString(),
      }),
      fact('MULTIPLIER_UPDATED_LEGACY', 50, { newMultiplierWad: (ONE * 2n).toString() }),
      fact('MULTIPLIER_UPDATED', 50, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 2n).toString(),
        effectiveAtSeconds: at(50).toString(),
      }),
    ],
    evaluateAtSeconds: at(200),
    expectation: {
      question: 'SHARE_EQUIVALENT',
      answer: '200000000',
      requiredReasons: ['B20_SCHEDULE_SUPERSEDED'],
      forbiddenReasons: [],
      rationale:
        'The override set 2x and cleared the pending 10x. An integration reporting ' +
        '1000000000 applied a schedule the override cancelled.',
    },
  },
  {
    id: 'LEGACY_AND_CANONICAL_ONE_UPDATE',
    version: '1',
    title: 'One instant update, two events',
    catches:
      'An integration indexing both topics that books the change twice, and one indexing only ' +
      'the canonical topic that misses legacy emissions entirely.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      // Both events come from the same transaction, which is what makes them one business
      // fact. An integration that folds by block alone, or that books each topic separately,
      // ends up applying the change twice.
      fact('MULTIPLIER_UPDATED_LEGACY', 10, { newMultiplierWad: (ONE * 3n).toString() }),
      fact('MULTIPLIER_UPDATED', 10, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 3n).toString(),
        effectiveAtSeconds: at(10).toString(),
      }),
      // A second, genuinely separate update in a later block. It must survive: two updates
      // that happen to set the same value are two corporate actions, and a fold keyed on the
      // value rather than the transaction would erase this one.
      fact('MULTIPLIER_UPDATED', 14, {
        oldMultiplierWad: (ONE * 3n).toString(),
        newMultiplierWad: (ONE * 3n).toString(),
        effectiveAtSeconds: at(14).toString(),
      }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'RESTATEMENT_COUNT',
      answer: '2',
      requiredReasons: ['B20_DUPLICATE_EVENT_GENERATION'],
      forbiddenReasons: [],
      rationale:
        'Three events, two business facts: the legacy and canonical emissions of one instant ' +
        'update fold into one, and the later update is genuinely separate. An integration ' +
        'reporting 3 booked the paired emission twice; one reporting 1 folded by value and ' +
        'erased a real corporate action. Note that the multiplier is 3x either way, which is ' +
        'exactly why asking for the share count here would let both bugs pass.',
    },
  },
  {
    id: 'SYMBOL_RENAME_STABLE_IDENTITY',
    version: '1',
    title: 'The symbol changes; the asset does not',
    catches: 'An integration keyed on ticker, which loses the position on a rename.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8', symbol: 'AAPLc' }),
      fact('METADATA_CHANGED', 10, { symbol: 'AAPLXc', name: 'Apple Inc.' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'ASSET_IDENTITY',
      answer: `8453:${AAPL}`,
      requiredReasons: ['B20_IDENTITY_DRIFT'],
      forbiddenReasons: ['B20_UNKNOWN_ASSET'],
      rationale:
        'Identity is (chainId, address) and is unchanged. An integration that now reports a ' +
        'different asset, or none, was keyed on the ticker.',
    },
  },
  {
    id: 'CHAINLINK_ISSUER_PAUSE',
    version: '1',
    title: 'The issuer pauses the price feed',
    catches: 'An integration that keeps valuing against the last round published before the pause.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('FEED_ROUND', 0, { answer: '20000000000', decimals: '8', issuerPaused: 'false' }),
      fact('FEED_ROUND', 10, { answer: '20000000000', decimals: '8', issuerPaused: 'true' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'POSITION_VALUE',
      answer: 'UNAVAILABLE',
      requiredReasons: ['B20_ISSUER_PAUSED'],
      forbiddenReasons: [],
      rationale:
        'A paused feed has no current price. Returning the last one as though it were current ' +
        'is what makes a pause invisible to the customer.',
    },
  },
  {
    id: 'OFF_HOURS_HOLD_VERSUS_STALE',
    version: '1',
    title: 'A weekend and an outage look identical',
    catches:
      'An integration that calls an off-hours hold "fresh", and one that calls a genuine ' +
      'outage "expected".',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      // ~62 hours old, exactly what the live AAPL feed showed at the provenance block.
      fact('FEED_ROUND', 0, {
        answer: '32008000000',
        decimals: '8',
        updatedAtSeconds: (at(20) - 224_190n).toString(),
        sessionExpectsPublishing: 'false',
      }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'POSITION_VALUE',
      answer: 'NON_ACTIONABLE',
      requiredReasons: ['B20_FEED_EXPECTED_HOLD'],
      forbiddenReasons: ['B20_FEED_STALE'],
      rationale:
        'The declared session policy explains the silence, so this is a hold rather than a ' +
        'stall — and an explained old price is still an old price. Displayable, never ' +
        'actionable.',
    },
  },
  {
    id: 'SEQUENCER_DOWN_AND_GRACE',
    version: '1',
    title: 'The sequencer recovers and the grace period has not elapsed',
    catches:
      'An integration that resumes valuing the instant the sequencer answers "up", pricing ' +
      'against a market the chain could not see.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('SEQUENCER_STATUS', 10, { answer: '1', startedAtSeconds: at(10).toString() }),
      fact('SEQUENCER_STATUS', 18, { answer: '0', startedAtSeconds: at(18).toString() }),
      fact('FEED_ROUND', 19, { answer: '20000000000', decimals: '8' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'PREFLIGHT_DECISION',
      answer: 'BLOCK',
      requiredReasons: ['B20_SEQUENCER_GRACE_PERIOD'],
      forbiddenReasons: [],
      rationale:
        'The sequencer came back four seconds ago. Without a grace period a recovery ' +
        'immediately liquidates people against prices published while the chain was blind.',
    },
  },
  {
    id: 'SHALLOW_REORG_REPLACES_ACTION',
    version: '1',
    title: 'A reorg replaces the block the action was in',
    catches:
      'An integration that keeps the multiplier change from an orphaned block, or that ' +
      'deletes the original observation instead of compensating it.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('MULTIPLIER_UPDATED', 10, {
        oldMultiplierWad: ONE.toString(),
        newMultiplierWad: (ONE * 10n).toString(),
        effectiveAtSeconds: at(10).toString(),
      }),
      fact('REORG', 12, { forkPointBlock: '1010', depth: '3' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'SHARE_EQUIVALENT',
      answer: 'REORGED',
      requiredReasons: ['B20_REORG_DETECTED'],
      forbiddenReasons: [],
      rationale:
        'The block carrying the multiplier change was replaced. Derived state is invalid ' +
        'until replay; reporting the pre-reorg share count as current is the failure.',
    },
  },
  {
    id: 'WRONG_TOKEN_FEED_MAPPING',
    version: '1',
    title: 'The feed belongs to a different asset',
    catches:
      'An integration that pairs a token to a feed by matching ticker strings, which is a ' +
      'guess dressed as a lookup.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8', symbol: 'AAPLc' }),
      fact('FEED_ROUND', 0, {
        answer: '45000000000',
        decimals: '8',
        feedBaseAsset: 'MSFT',
        pairingReviewed: 'false',
      }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'POSITION_VALUE',
      answer: 'UNAVAILABLE',
      requiredReasons: ['B20_FEED_PAIRING_UNREVIEWED'],
      forbiddenReasons: [],
      rationale:
        'Nothing on chain links a B20 token to a Chainlink proxy. An unreviewed pairing may ' +
        'be displayed with a label and may never back a value-sensitive decision.',
    },
  },
  {
    id: 'FAKE_B20_PREFIX_ASSET',
    version: '1',
    title: 'An address with the right prefix that is not a Coinbase stock',
    catches:
      'An integration that accepts an asset because it starts with 0xb2 and the factory says ' +
      'it made it.',
    facts: [
      fact('ASSET_STATE', 0, {
        address: '0xb2000000000000000000000000000000deadbeef',
        multiplierWad: ONE.toString(),
        decimals: '8',
        onOfficialList: 'false',
        factoryInitialized: 'true',
      }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'ASSET_IDENTITY',
      answer: 'UNKNOWN',
      requiredReasons: ['B20_NOT_ON_OFFICIAL_LIST', 'B20_PREFIX_ONLY_IDENTITY'],
      forbiddenReasons: [],
      rationale:
        'isB20 is recovered from the address prefix, so anyone can satisfy it. Issuer ' +
        'provenance comes from the official list, and this address is not on it.',
    },
  },
  {
    id: 'CONCURRENT_SAME_KEY_PREFLIGHT',
    version: '1',
    title: 'The same idempotency key arrives twice at once',
    catches:
      'An integration that retries a preflight on timeout and ends up with two receipts for ' +
      'one operation.',
    facts: [
      fact('ASSET_STATE', 0, { multiplierWad: ONE.toString(), decimals: '8' }),
      fact('FEED_ROUND', 0, { answer: '20000000000', decimals: '8' }),
    ],
    evaluateAtSeconds: at(20),
    expectation: {
      question: 'PREFLIGHT_DECISION',
      answer: 'ONE_RESULT_ONE_RECEIPT',
      requiredReasons: [],
      forbiddenReasons: ['B20_IDEMPOTENCY_CONFLICT'],
      rationale:
        'Two concurrent calls with the same key and the same body produce one logical result ' +
        'and at most one receipt. A different body under the same key is a 409.',
    },
  },
];

export function scenarioById(id: ScenarioId): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * A stable hash of a scenario's inputs.
 *
 * Recorded on every run so a result can be tied to the exact fixture that produced it. If a
 * scenario is edited, old results stop matching and are visibly from a different scenario
 * rather than silently comparable.
 */
export function scenarioInputHash(scenario: Scenario): string {
  const canonical = JSON.stringify(
    {
      id: scenario.id,
      version: scenario.version,
      evaluateAtSeconds: scenario.evaluateAtSeconds.toString(),
      facts: scenario.facts.map((f) => ({
        ...f,
        blockNumber: f.blockNumber.toString(),
        blockTimestampSeconds: f.blockTimestampSeconds.toString(),
      })),
      expectation: scenario.expectation,
    },
    Object.keys({
      id: 0,
      version: 0,
      evaluateAtSeconds: 0,
      facts: 0,
      expectation: 0,
      kind: 0,
      blockNumber: 0,
      blockTimestampSeconds: 0,
      transactionIndex: 0,
      logIndex: 0,
      fields: 0,
      question: 0,
      answer: 0,
      requiredReasons: 0,
      forbiddenReasons: 0,
      rationale: 0,
    }).sort(),
  );
  // A small, dependency-free FNV-1a. This is a fixture fingerprint, not a security boundary;
  // using it as one would be a mistake, so it is deliberately not called a digest.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}
