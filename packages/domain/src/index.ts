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

export { fixtureEvidenceMessage, type FixtureEvidencePayload } from './fixture-evidence.js';

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

/*
 * Base B20 — additive, and deliberately namespaced.
 *
 * The X Layer exports above are a deployed public contract. Nothing below renames,
 * reorders, or changes the behaviour of anything above it. See ADR 0005.
 */

export {
  isActionableFreshness,
  MAX_PRICE_DECIMALS,
  MAX_RAW_AMOUNT,
  MAX_TOKEN_DECIMALS,
  MAX_UI_MULTIPLIER,
  MIN_TOKEN_DECIMALS,
  PRICE_BASES,
  PRICE_FRESHNESS,
  PRICE_ORIGINS,
  WAD_PRECISION,
  evidenceVersion,
  feedRoundId,
  multiplierWad,
  priceDecimals,
  rawAmount,
  shareEquivalentAmount,
  tokenDecimals,
  totalReturnTokenPrice,
  underlyingEquityPrice,
  unsafeB20,
  type EvidenceVersion,
  type FeedRoundId,
  type MultiplierWad,
  type PriceBasis,
  type PriceDecimals,
  type PriceFreshness,
  type PriceOrigin,
  type PricePoint,
  type RawAmount,
  type ShareEquivalentAmount,
  type TokenDecimals,
  type TotalReturnPricePoint,
  type TotalReturnTokenPrice,
  type UnderlyingEquityPrice,
  type UnderlyingPricePoint,
} from './b20/quantities.js';

export {
  B20_ARITHMETIC_ERRORS,
  VALUATION_ROUTES,
  compareValuationRoutes,
  formatScaledInteger,
  parseScaledInteger,
  rawToShares,
  rejectDoubleMultiplier,
  sharesToRaw,
  valueRawWithTotalReturnPrice,
  valueSharesWithUnderlyingPrice,
  type ArithmeticResult,
  type B20ArithmeticError,
  type RawConversion,
  type RouteComparison,
  type SharesConversion,
  type Valuation,
  type ValuationRoute,
} from './b20/arithmetic.js';

export {
  B20_REASON_EXPLANATION,
  B20_REASON_SEVERITY,
  B20_REASONS,
  orderB20Reasons,
  type B20Reason,
} from './b20/reasons.js';

export {
  B20_CAPABILITY_OUTCOMES,
  B20_CAPABILITY_SURFACES,
  B20_FACT_KINDS,
  B20_LIFECYCLE_STATES,
  reduceB20Lifecycle,
  type B20CapabilityOutcome,
  type B20CapabilitySet,
  type B20CapabilitySurface,
  type B20FactKind,
  type B20LifecycleFact,
  type B20LifecycleInput,
  type B20LifecycleResult,
  type B20LifecycleState,
  type B20Provenance,
  type MultiplierEpoch,
} from './b20/lifecycle.js';

export {
  B20_ASSET_STATUSES,
  b20AssetKey,
  searchB20Candidates,
  verifyB20Identity,
  type B20AssetStatus,
  type B20IdentityEvidence,
  type B20IdentityVerdict,
  type B20KnownIdentity,
  type B20SearchCandidate,
} from './b20/registry.js';
