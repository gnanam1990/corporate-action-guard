/**
 * The reference adapter, and the mutants that prove the suite has teeth.
 *
 * The reference is a *minimal correct integration*, not a wrapper around our engine. That
 * distinction matters: an adapter that delegated to `@cag/domain` would prove our domain
 * package agrees with itself. This one re-implements the handful of rules an integrator has
 * to get right, from the same primitives they would use, so passing it means the rules are
 * expressible — and each mutant is one line away from it.
 *
 * Every mutant is a real integration bug someone has shipped, not a synthetic fault.
 */

import { formatScaledInteger, rawToShares, unsafeB20 } from '@cag/domain';
import type { AdapterAnswer, ConformanceAdapter, MutationId } from './adapter.js';
import { ADAPTER_CONTRACT_VERSION } from './adapter.js';
import type { QuestionKind, ScenarioFact } from './scenarios.js';

const ONE = 1_000_000_000_000_000_000n;

/** One holder's position, fixed across all scenarios so answers are comparable. */
const RAW_HELD = 100_000_000n;
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';

interface State {
  address: string;
  decimals: number;
  multiplierWad: bigint;
  pendingMultiplierWad: bigint | undefined;
  pendingEffectiveAtSeconds: bigint | undefined;
  cancelled: boolean;
  superseded: boolean;
  duplicateEmission: boolean;
  symbol: string;
  onOfficialList: boolean;
  paused: boolean;
  reorged: boolean;
  issuerPaused: boolean;
  feedAnswer: bigint | undefined;
  feedDecimals: number;
  feedUpdatedAtSeconds: bigint | undefined;
  sessionExpectsPublishing: boolean;
  pairingReviewed: boolean;
  sequencerAnswer: bigint;
  sequencerStartedAtSeconds: bigint;
  /** Set of (block, txIndex, value) keys, so a legacy/canonical pair folds once. */
  seenUpdates: Set<string>;
  /** Business facts booked, which is where double-booking actually does damage. */
  restatements: number;
}

function freshState(): State {
  return {
    address: AAPL,
    decimals: 8,
    multiplierWad: ONE,
    pendingMultiplierWad: undefined,
    pendingEffectiveAtSeconds: undefined,
    cancelled: false,
    superseded: false,
    duplicateEmission: false,
    symbol: 'AAPLc',
    onOfficialList: true,
    paused: false,
    reorged: false,
    issuerPaused: false,
    feedAnswer: undefined,
    feedDecimals: 8,
    feedUpdatedAtSeconds: undefined,
    sessionExpectsPublishing: true,
    pairingReviewed: true,
    sequencerAnswer: 0n,
    sequencerStartedAtSeconds: 0n,
    seenUpdates: new Set(),
    restatements: 0,
  };
}

/** Behaviours a mutant flips. Each maps to exactly one shipped-integration bug. */
export interface MutantFlags {
  readonly rawAsShares?: boolean;
  readonly doubleMultiplier?: boolean;
  readonly activateOnArrival?: boolean;
  readonly ignoreCancel?: boolean;
  readonly keyByTicker?: boolean;
  readonly acceptStaleFeed?: boolean;
  readonly duplicateOnRetry?: boolean;
  readonly swallowReorg?: boolean;
}

const SEQUENCER_GRACE_SECONDS = 1_800n;
/** Deliberately generous: the reference is a *minimal* integration, not our policy matrix. */
const MAX_FEED_AGE_SECONDS = 3_600n;

export function createReferenceAdapter(
  flags: MutantFlags = {},
  name = 'reference',
): ConformanceAdapter {
  let state = freshState();

  return {
    name,
    contractVersion: ADAPTER_CONTRACT_VERSION,

    reset(): void {
      state = freshState();
    },

    ingest(fact: ScenarioFact): void {
      const f = fact.fields;
      switch (fact.kind) {
        case 'ASSET_STATE': {
          if (f['address'] !== undefined) state.address = f['address'];
          if (f['decimals'] !== undefined) state.decimals = Number(f['decimals']);
          if (f['multiplierWad'] !== undefined) state.multiplierWad = BigInt(f['multiplierWad']);
          if (f['symbol'] !== undefined) state.symbol = f['symbol'];
          if (f['onOfficialList'] !== undefined)
            state.onOfficialList = f['onOfficialList'] === 'true';
          break;
        }
        case 'MULTIPLIER_UPDATED_LEGACY': {
          // The deprecated topic. Folding is by (block, tx, value): the canonical event that
          // accompanies it carries the same new value in the same transaction.
          const key = `${String(fact.blockNumber)}:${String(fact.transactionIndex)}:${f['newMultiplierWad'] ?? ''}`;
          if (state.seenUpdates.has(key) && flags.duplicateOnRetry !== true) break;
          state.seenUpdates.add(key);
          state.duplicateEmission = true;
          state.restatements += 1;
          if (f['newMultiplierWad'] !== undefined) {
            state.multiplierWad = BigInt(f['newMultiplierWad']);
            if (state.pendingMultiplierWad !== undefined) state.superseded = true;
            state.pendingMultiplierWad = undefined;
            state.pendingEffectiveAtSeconds = undefined;
          }
          break;
        }
        case 'MULTIPLIER_UPDATED': {
          const newValue = BigInt(f['newMultiplierWad'] ?? '0');
          const effectiveAt = BigInt(f['effectiveAtSeconds'] ?? '0');
          const key = `${String(fact.blockNumber)}:${String(fact.transactionIndex)}:${String(newValue)}`;
          const isDuplicate = state.seenUpdates.has(key);
          if (isDuplicate && flags.duplicateOnRetry !== true) {
            state.duplicateEmission = true;
            break;
          }
          state.seenUpdates.add(key);
          if (isDuplicate) {
            state.duplicateEmission = true;
            // The mutant books it anyway. That is the whole bug: one business fact, two
            // postings, and a multiplier that still reads correct.
            state.restatements += 1;
          } else {
            state.restatements += 1;
          }

          const scheduled = effectiveAt > fact.blockTimestampSeconds;
          if (scheduled && flags.activateOnArrival !== true) {
            state.pendingMultiplierWad = newValue;
            state.pendingEffectiveAtSeconds = effectiveAt;
            state.cancelled = false;
          } else {
            // Instant, or a mutant that applies a schedule the moment it arrives.
            if (state.pendingMultiplierWad !== undefined) state.superseded = true;
            state.pendingMultiplierWad = undefined;
            state.pendingEffectiveAtSeconds = undefined;
            state.multiplierWad = newValue;
          }
          break;
        }
        case 'SCHEDULE_CANCELLED': {
          if (flags.ignoreCancel === true) break;
          state.pendingMultiplierWad = undefined;
          state.pendingEffectiveAtSeconds = undefined;
          state.cancelled = true;
          break;
        }
        case 'PAUSED':
          state.paused = true;
          break;
        case 'UNPAUSED':
          state.paused = false;
          break;
        case 'METADATA_CHANGED':
          if (f['symbol'] !== undefined) state.symbol = f['symbol'];
          break;
        case 'FEED_ROUND': {
          state.feedAnswer = BigInt(f['answer'] ?? '0');
          state.feedDecimals = Number(f['decimals'] ?? '8');
          state.feedUpdatedAtSeconds =
            f['updatedAtSeconds'] !== undefined
              ? BigInt(f['updatedAtSeconds'])
              : fact.blockTimestampSeconds;
          if (f['issuerPaused'] !== undefined) state.issuerPaused = f['issuerPaused'] === 'true';
          if (f['sessionExpectsPublishing'] !== undefined) {
            state.sessionExpectsPublishing = f['sessionExpectsPublishing'] === 'true';
          }
          if (f['pairingReviewed'] !== undefined) {
            state.pairingReviewed = f['pairingReviewed'] === 'true';
          }
          break;
        }
        case 'SEQUENCER_STATUS':
          state.sequencerAnswer = BigInt(f['answer'] ?? '0');
          state.sequencerStartedAtSeconds = BigInt(f['startedAtSeconds'] ?? '0');
          break;
        case 'REORG':
          if (flags.swallowReorg !== true) state.reorged = true;
          break;
        case 'ANNOUNCEMENT_OPENED':
        case 'ANNOUNCEMENT_CLOSED':
          break;
      }
    },

    answer(question: QuestionKind, evaluateAtSeconds: bigint): AdapterAnswer {
      const reasons: string[] = [];

      // Lazy activation: nothing is emitted at effectiveAt, so this is the only place the
      // transition can happen.
      let multiplier = state.multiplierWad;
      let pendingLive = false;
      if (
        state.pendingMultiplierWad !== undefined &&
        state.pendingEffectiveAtSeconds !== undefined
      ) {
        if (evaluateAtSeconds >= state.pendingEffectiveAtSeconds) {
          multiplier = state.pendingMultiplierWad;
        } else {
          pendingLive = true;
          reasons.push('B20_SCHEDULE_NOT_YET_EFFECTIVE');
        }
      }
      if (state.cancelled) reasons.push('B20_SCHEDULE_CANCELLED');
      if (state.superseded) reasons.push('B20_SCHEDULE_SUPERSEDED');
      if (state.duplicateEmission) reasons.push('B20_DUPLICATE_EVENT_GENERATION');
      if (state.reorged) reasons.push('B20_REORG_DETECTED');

      if (state.reorged && question !== 'ASSET_IDENTITY') {
        return { answer: 'REORGED', reasons };
      }

      switch (question) {
        case 'ASSET_IDENTITY': {
          if (!state.onOfficialList) {
            reasons.push('B20_NOT_ON_OFFICIAL_LIST');
            if (state.address.startsWith('0xb2')) reasons.push('B20_PREFIX_ONLY_IDENTITY');
            return { answer: 'UNKNOWN', reasons };
          }
          if (state.symbol !== 'AAPLc') reasons.push('B20_IDENTITY_DRIFT');
          // Identity is (chainId, address). A mutant keyed on ticker loses it on a rename.
          return {
            answer:
              flags.keyByTicker === true && state.symbol !== 'AAPLc'
                ? 'UNKNOWN'
                : `8453:${state.address}`,
            reasons,
          };
        }

        case 'RESTATEMENT_COUNT':
          return { answer: String(state.restatements), reasons };

        case 'PENDING_ACTION': {
          if (!pendingLive) return { answer: 'NONE', reasons };
          return { answer: String(state.pendingEffectiveAtSeconds), reasons };
        }

        case 'ACTION_CLASSIFICATION': {
          // Never inferred from the multiplier's shape. Without structured evidence — which no
          // scenario supplies — the honest answer is UNKNOWN.
          reasons.push('B20_UNCLASSIFIED_BUSINESS_EVENT');
          return { answer: 'UNKNOWN', reasons };
        }

        case 'SHARE_EQUIVALENT': {
          if (flags.rawAsShares === true) return { answer: String(RAW_HELD), reasons };
          const shares = rawToShares(
            unsafeB20.rawAmount(RAW_HELD),
            unsafeB20.multiplierWad(multiplier),
          );
          if (!shares.ok) return { answer: 'ERROR', reasons, detail: shares.detail };
          return { answer: String(shares.value.shares), reasons };
        }

        case 'POSITION_VALUE': {
          const freshness = judgeFreshness(state, evaluateAtSeconds, flags);
          if (freshness.reason !== undefined) reasons.push(freshness.reason);
          if (freshness.answer !== undefined) return { answer: freshness.answer, reasons };

          const price = state.feedAnswer ?? 0n;
          if (flags.doubleMultiplier === true) {
            // The forbidden route: shares valued at the total-return price.
            const shares = rawToShares(
              unsafeB20.rawAmount(RAW_HELD),
              unsafeB20.multiplierWad(multiplier),
            );
            const quantity = shares.ok ? shares.value.shares : 0n;
            return {
              answer: formatScaledInteger(quantity * price, state.decimals + state.feedDecimals),
              reasons,
            };
          }
          // Route A: the raw amount with the price that already contains the multiplier.
          return {
            answer: formatScaledInteger(RAW_HELD * price, state.decimals + state.feedDecimals),
            reasons,
          };
        }

        case 'PREFLIGHT_DECISION': {
          if (state.paused) {
            reasons.push('B20_TOKEN_PAUSED');
            return { answer: 'BLOCK', reasons };
          }
          if (state.sequencerAnswer !== 0n) {
            reasons.push('B20_SEQUENCER_DOWN');
            return { answer: 'BLOCK', reasons };
          }
          if (
            state.sequencerStartedAtSeconds > 0n &&
            evaluateAtSeconds - state.sequencerStartedAtSeconds < SEQUENCER_GRACE_SECONDS
          ) {
            reasons.push('B20_SEQUENCER_GRACE_PERIOD');
            return { answer: 'BLOCK', reasons };
          }
          // The idempotency scenario asks only that one result and one receipt come back.
          return { answer: 'ONE_RESULT_ONE_RECEIPT', reasons };
        }
      }
    },
  };
}

function judgeFreshness(
  state: State,
  evaluateAtSeconds: bigint,
  flags: MutantFlags,
): { readonly answer?: string; readonly reason?: string } {
  if (!state.pairingReviewed) {
    return { answer: 'UNAVAILABLE', reason: 'B20_FEED_PAIRING_UNREVIEWED' };
  }
  if (state.issuerPaused) return { answer: 'UNAVAILABLE', reason: 'B20_ISSUER_PAUSED' };
  if (state.feedAnswer === undefined) {
    return { answer: 'UNAVAILABLE', reason: 'B20_RPC_UNAVAILABLE' };
  }
  if (flags.acceptStaleFeed === true) return {};

  const age = evaluateAtSeconds - (state.feedUpdatedAtSeconds ?? evaluateAtSeconds);
  if (age > MAX_FEED_AGE_SECONDS) {
    return state.sessionExpectsPublishing
      ? { answer: 'NON_ACTIONABLE', reason: 'B20_FEED_STALE' }
      : { answer: 'NON_ACTIONABLE', reason: 'B20_FEED_EXPECTED_HOLD' };
  }
  return {};
}

/** The mutant each scenario is designed to kill. */
export const MUTANT_TARGETS: readonly {
  readonly mutation: MutationId;
  readonly flags: MutantFlags;
  readonly scenarioId: string;
}[] = [
  {
    mutation: 'RAW_AS_SHARES',
    flags: { rawAsShares: true },
    scenarioId: 'INSTANT_OVERRIDE_CLEARS_PENDING',
  },
  {
    mutation: 'DOUBLE_MULTIPLIER',
    flags: { doubleMultiplier: true },
    scenarioId: 'FORWARD_SPLIT_10_TO_1',
  },
  {
    mutation: 'ACTIVATE_ON_ARRIVAL',
    flags: { activateOnArrival: true },
    scenarioId: 'CANCEL_AND_RESCHEDULE',
  },
  {
    mutation: 'IGNORE_CANCEL',
    flags: { ignoreCancel: true },
    scenarioId: 'SCHEDULE_CANCELLED_BEFORE_EFFECTIVE',
  },
  {
    mutation: 'KEY_BY_TICKER',
    flags: { keyByTicker: true },
    scenarioId: 'SYMBOL_RENAME_STABLE_IDENTITY',
  },
  {
    mutation: 'ACCEPT_STALE_FEED',
    flags: { acceptStaleFeed: true },
    scenarioId: 'OFF_HOURS_HOLD_VERSUS_STALE',
  },
  {
    mutation: 'DUPLICATE_ON_RETRY',
    flags: { duplicateOnRetry: true },
    scenarioId: 'LEGACY_AND_CANONICAL_ONE_UPDATE',
  },
  {
    mutation: 'SWALLOW_REORG',
    flags: { swallowReorg: true },
    scenarioId: 'SHALLOW_REORG_REPLACES_ACTION',
  },
];
