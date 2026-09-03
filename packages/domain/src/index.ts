/**
 * @cag/domain — pure decision core for Corporate Action Guard.
 *
 * This package has no I/O: no clock, no network, no database, no filesystem, no
 * environment. Lint enforces that (see eslint.config.mjs). Everything a decision depends
 * on arrives as an argument, which is what makes replay byte-for-byte reproducible.
 */

export {
  addressEquals,
  isZeroAddress,
  normalizeAddress,
  parseAssetId,
  parseBlockHash,
  parseBlockNumber,
  parseChainId,
  parseTickerSymbol,
  parseTxHash,
  parseWrapperVersion,
  unsafe,
  ZERO_ADDRESS,
  type Address,
  type AssetId,
  type BlockHash,
  type BlockNumber,
  type ChainId,
  type ParseResult,
  type TickerSymbol,
  type TxHash,
  type WrapperVersion,
} from './brands.js';

export {
  addMillis,
  ageAt,
  HOUR,
  instant,
  isStale,
  millis,
  MINUTE,
  parseIsoInstant,
  SECOND,
  subMillis,
  toIso,
  type Instant,
  type Millis,
} from './time.js';

export {
  EXACT_TOLERANCE,
  MAX_MULTIPLIER_DECIMALS,
  multiplier,
  multiplierAbsDiff,
  multiplierEquals,
  multiplierToString,
  multiplierWithinTolerance,
  parseMultiplier,
  type Multiplier,
  type MultiplierNonce,
} from './multiplier.js';

export {
  BLOCK_REASONS,
  orderReasons,
  REASON_EXPLANATION,
  REASON_SEVERITY,
  type BlockReason,
  type ReasonSeverity,
} from './reasons.js';

export {
  CANONICALITY_CHECK_NAMES,
  COMPARABLE_FIELDS,
  DEFAULT_REQUIRED_AGREEMENT_FIELDS,
  summarizeCanonicality,
  type ApiObservation,
  type CanonicalityCheck,
  type CanonicalityCheckName,
  type CanonicalityResult,
  type ChainObservation,
  type CheckOutcome,
  type ComparableField,
  type Provenance,
  type SourceAgreement,
  type SourceComparison,
  type SourceComparisonField,
  type SourceKind,
  type TolerancePolicy,
} from './evidence.js';

export { compareSources } from './sources.js';

export {
  allLegalTransitions,
  deriveGuardWindow,
  deriveLifecycleState,
  isInGuardWindow,
  legalTransition,
  LIFECYCLE_EVENTS,
  LIFECYCLE_STATES,
  type GuardWindow,
  type LifecycleEvent,
  type LifecycleInput,
  type LifecycleState,
  type TransitionResult,
} from './lifecycle.js';

export {
  evaluatePreflight,
  type ActionType,
  type FreshnessPolicy,
  type PreflightAction,
  type PreflightDecision,
  type PreflightInput,
  type PreflightResult,
  type ReceiptState,
} from './preflight.js';
