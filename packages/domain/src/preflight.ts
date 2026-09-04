/**
 * The safety predicate.
 *
 *   ALLOW(action) only if
 *     token and wrapper are canonical
 *     AND wrapper.asset() is the expected xStock
 *     AND the wrapper version is current
 *     AND action.multiplierNonce == onchain.multiplierNonce
 *     AND now is outside [activation - guardWindow, activation + guardWindow]
 *     AND required sources agree
 *     AND receipt.operationDigest binds chain, target, asset, amount, recipient
 *     AND the receipt is not expired or consumed
 *
 * This function is the single place that decides whether money may move. It is pure: no
 * clock, no network, no database, no environment. Everything it needs is an argument.
 *
 * Its structure is deliberate. It does not short-circuit on the first failure — it
 * collects *every* reason. An operator debugging a block needs the whole picture, and a
 * single-reason answer hides compounding faults.
 */

import type { Address, ChainId } from './brands.js';
import { addressEquals, isZeroAddress } from './brands.js';
import type { CanonicalityCheckName, CanonicalityResult, SourceComparison } from './evidence.js';
import { deriveGuardWindow, isInGuardWindow } from './lifecycle.js';
import type { MultiplierNonce } from './multiplier.js';
import type { BlockReason } from './reasons.js';
import { orderReasons } from './reasons.js';
import type { Instant, Millis } from './time.js';
import { isStale } from './time.js';

export type PreflightDecision = 'ALLOW' | 'BLOCK';

export type ActionType = 'DEPOSIT' | 'WITHDRAW' | 'TRANSFER' | 'REDEEM';

export interface PreflightAction {
  readonly chainId: ChainId;
  /** The contract the protected call targets. */
  readonly target: Address;
  readonly assetAddress: Address;
  readonly wrapperAddress: Address;
  readonly actionType: ActionType;
  readonly recipient: Address;
  /** Base units. Never a float, never a display string. */
  readonly amount: bigint;
  /** The multiplier epoch the caller formed this operation against. */
  readonly expectedMultiplierNonce: MultiplierNonce;
}

export interface ReceiptState {
  readonly validAfter: Instant;
  readonly validUntil: Instant;
  readonly consumed: boolean;
  /** Digest recomputed from the action fields by the caller of this function. */
  readonly recomputedOperationDigest: string;
  /** Digest carried by the receipt itself. */
  readonly boundOperationDigest: string;
}

export interface FreshnessPolicy {
  /** Maximum age of API evidence that may still authorize an action. */
  readonly apiMaxAge: Millis;
  /** Maximum age of chain evidence that may still authorize an action. */
  readonly chainMaxAge: Millis;
}

export interface PreflightInput {
  readonly action: PreflightAction;
  readonly supportedChainIds: readonly ChainId[];
  readonly supportedTargets: readonly Address[];
  readonly supportedActionTypes: readonly ActionType[];

  /** Chain on which the registry and contract evidence were observed. */
  readonly evidenceChainId?: ChainId;

  /** Absent when the asset is not in the discovered catalog at all. */
  readonly assetKnown: boolean;

  /** Registry-declared canonical addresses. Absent means UNKNOWN, never "anything goes". */
  readonly registryTokenAddress?: Address;
  readonly registryWrapperAddress?: Address;
  readonly registryWrapperIsCurrent?: boolean;

  /** What the wrapper reports as its underlying asset. Absent when the ABI does not expose it. */
  readonly observedWrapperAsset?: Address;

  readonly canonicality: CanonicalityResult;
  readonly sourceComparison: SourceComparison;

  /** Current on-chain nonce. Absent means the chain could not be read. */
  readonly onChainMultiplierNonce?: MultiplierNonce;

  readonly scheduledActivation?: Instant;
  readonly guardBefore: Millis;
  readonly guardAfter: Millis;

  /** When each source was last observed. Absent means that source is unavailable. */
  readonly apiObservedAt?: Instant;
  readonly chainObservedAt?: Instant;
  readonly freshness: FreshnessPolicy;

  /** True while an incident on this asset is open and unresolved. */
  readonly manualReviewOpen: boolean;

  /** Present only when evaluating an existing receipt rather than issuing a new one. */
  readonly receipt?: ReceiptState;
}

export interface PreflightResult {
  readonly decision: PreflightDecision;
  /** Empty for ALLOW; non-empty and severity-ordered for BLOCK. */
  readonly reasons: readonly BlockReason[];
  /** Evidence ages at evaluation time, for the response and the journal. */
  readonly apiEvidenceAgeMs: number | undefined;
  readonly chainEvidenceAgeMs: number | undefined;
}

/**
 * Every canonicality check maps to exactly one block reason.
 *
 * Exhaustive over `CanonicalityCheckName`, so adding a check to the matrix without
 * deciding how it blocks is a compile error rather than a silent ALLOW.
 */
const CHECK_REASON: Readonly<Record<CanonicalityCheckName, BlockReason>> = {
  TOKEN_MATCHES_REGISTRY: 'NON_CANONICAL_TOKEN',
  WRAPPER_MATCHES_REGISTRY: 'NON_CANONICAL_WRAPPER',
  TOKEN_HAS_BYTECODE: 'NON_CANONICAL_TOKEN',
  WRAPPER_HAS_BYTECODE: 'NON_CANONICAL_WRAPPER',
  WRAPPER_ASSET_RELATION: 'WRAPPER_ASSET_MISMATCH',
  WRAPPER_VERSION_CURRENT: 'OUTDATED_WRAPPER',
};

/**
 * Evaluate the safety predicate.
 *
 * @param input every fact the decision depends on
 * @param now   the evaluation instant, supplied by the caller — never read from a clock
 */
export function evaluatePreflight(input: PreflightInput, now: Instant): PreflightResult {
  const reasons: BlockReason[] = [];
  const { action } = input;

  // --- Scope -------------------------------------------------------------
  if (!input.supportedChainIds.includes(action.chainId)) {
    reasons.push('UNSUPPORTED_CHAIN');
  }

  if (input.evidenceChainId === undefined || input.evidenceChainId !== action.chainId) {
    reasons.push('EVIDENCE_CHAIN_MISMATCH');
  }

  if (!input.supportedTargets.some((target) => addressEquals(target, action.target))) {
    reasons.push('UNSUPPORTED_TARGET');
  }

  if (!input.supportedActionTypes.includes(action.actionType)) {
    reasons.push('UNSUPPORTED_ACTION');
  }

  if (!input.assetKnown) {
    reasons.push('UNKNOWN_ASSET');
  }

  // --- Operation shape ---------------------------------------------------
  // A zero address or zero amount is not a safe operation to bind a receipt to.
  if (
    isZeroAddress(action.target) ||
    isZeroAddress(action.assetAddress) ||
    isZeroAddress(action.wrapperAddress) ||
    isZeroAddress(action.recipient) ||
    action.amount <= 0n
  ) {
    reasons.push('INVALID_OPERATION_BINDING');
  }

  // --- Canonicality ------------------------------------------------------
  // An absent registry value is UNKNOWN. Unknown never passes.
  if (
    input.registryTokenAddress === undefined ||
    !addressEquals(input.registryTokenAddress, action.assetAddress)
  ) {
    reasons.push('NON_CANONICAL_TOKEN');
  }
  if (
    input.registryWrapperAddress === undefined ||
    !addressEquals(input.registryWrapperAddress, action.wrapperAddress)
  ) {
    reasons.push('NON_CANONICAL_WRAPPER');
  }
  if (input.registryWrapperIsCurrent !== true) {
    reasons.push('OUTDATED_WRAPPER');
  }
  if (
    input.observedWrapperAsset === undefined ||
    !addressEquals(input.observedWrapperAsset, action.assetAddress)
  ) {
    reasons.push('WRAPPER_ASSET_MISMATCH');
  }
  // The canonicality matrix blocks on its own, independent of the individual checks above.
  //
  // Any outcome that is not PASS contributes a reason — UNKNOWN as much as FAIL. "We could
  // not determine this" is not permission. Every check name maps to a reason, so a check
  // added to the matrix cannot be silently ignored here, and a matrix that is not PASS but
  // maps to nothing still blocks via the fail-closed default below.
  if (input.canonicality.outcome !== 'PASS') {
    const before = reasons.length;
    for (const check of input.canonicality.checks) {
      if (check.outcome === 'PASS') continue;
      reasons.push(CHECK_REASON[check.name]);
    }
    if (reasons.length === before) {
      // An empty or wholly indeterminate matrix means canonicality was never proven.
      reasons.push('NON_CANONICAL_TOKEN', 'NON_CANONICAL_WRAPPER');
    }
  }

  // --- Source availability and freshness ---------------------------------
  if (input.apiObservedAt === undefined) {
    reasons.push('API_UNAVAILABLE');
  } else if (isStale(input.apiObservedAt, now, input.freshness.apiMaxAge)) {
    reasons.push('STALE_API_EVIDENCE');
  }

  if (input.chainObservedAt === undefined) {
    reasons.push('RPC_UNAVAILABLE');
  } else if (isStale(input.chainObservedAt, now, input.freshness.chainMaxAge)) {
    reasons.push('STALE_CHAIN_EVIDENCE');
  }

  // --- Source agreement --------------------------------------------------
  // INCOMPLETE is not agreement. Both INCOMPLETE and MISMATCH block.
  if (input.sourceComparison.agreement !== 'MATCH') {
    reasons.push('SOURCE_MISMATCH');
  }

  // --- Multiplier epoch --------------------------------------------------
  if (
    input.onChainMultiplierNonce === undefined ||
    input.onChainMultiplierNonce !== action.expectedMultiplierNonce
  ) {
    reasons.push('MULTIPLIER_NONCE_MISMATCH');
  }

  // --- Activation guard window -------------------------------------------
  if (input.scheduledActivation !== undefined) {
    const window = deriveGuardWindow(
      input.scheduledActivation,
      input.guardBefore,
      input.guardAfter,
    );
    if (isInGuardWindow(window, now)) {
      reasons.push('ACTIVATION_WINDOW');
    } else if (now > window.end) {
      reasons.push('UNAPPLIED_CORPORATE_ACTION');
    }
  }

  // --- Open incident ------------------------------------------------------
  if (input.manualReviewOpen) {
    reasons.push('MANUAL_REVIEW_REQUIRED');
  }

  // --- Receipt state, when one is being evaluated -------------------------
  if (input.receipt !== undefined) {
    const r = input.receipt;
    if (r.recomputedOperationDigest !== r.boundOperationDigest) {
      reasons.push('INVALID_OPERATION_BINDING');
    }
    // Both bounds inclusive-safe: before validAfter is not yet valid; at or after
    // validUntil is expired. Ties resolve toward blocking.
    if (now < r.validAfter) reasons.push('RECEIPT_NOT_YET_VALID');
    if (now >= r.validUntil) reasons.push('RECEIPT_EXPIRED');
    if (r.consumed) reasons.push('RECEIPT_CONSUMED');
  }

  const ordered = orderReasons(reasons);
  return {
    decision: ordered.length === 0 ? 'ALLOW' : 'BLOCK',
    reasons: ordered,
    apiEvidenceAgeMs:
      input.apiObservedAt === undefined ? undefined : Math.max(0, now - input.apiObservedAt),
    chainEvidenceAgeMs:
      input.chainObservedAt === undefined ? undefined : Math.max(0, now - input.chainObservedAt),
  };
}
