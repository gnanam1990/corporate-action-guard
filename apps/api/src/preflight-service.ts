import {
  evaluatePreflight,
  instant,
  millis,
  orderReasons,
  REASON_EXPLANATION,
  type BlockReason,
  type CanonicalityResult,
  type ChainId,
  type PreflightInput,
  type SourceComparison,
} from '@cag/domain';
import { computeOperationDigest, type Operation, type ReceiptSigner } from '@cag/receipts';
import type { PreflightRequest, PreflightResponse } from './schemas.js';

/**
 * The preflight service.
 *
 * Route handlers stay thin: this composes the pure domain decision with receipt issuance.
 * It does not re-implement the safety predicate, and it is the only place that decides
 * whether a receipt is issued.
 */

export interface EvidenceBundle {
  readonly assetKnown: boolean;
  readonly chainId?: number;
  readonly registryTokenAddress?: string;
  readonly registryWrapperAddress?: string;
  readonly registryWrapperIsCurrent?: boolean;
  readonly observedWrapperAsset?: string;
  readonly canonicality: CanonicalityResult;
  readonly sourceComparison: SourceComparison;
  readonly onChainMultiplierNonce?: bigint;
  readonly scheduledActivationMs?: number;
  readonly apiObservedAtMs?: number;
  readonly chainObservedAtMs?: number;
  readonly manualReviewOpen: boolean;
  readonly evidenceIds: readonly string[];
  readonly blockNumber?: bigint;
  readonly blockHash?: string;
}

export interface PreflightPolicy {
  readonly supportedChainIds: readonly number[];
  readonly supportedTargets: readonly string[];
  readonly supportedActionTypes: readonly PreflightRequest['actionType'][];
  readonly guardBeforeMs: number;
  readonly guardAfterMs: number;
  readonly apiMaxAgeMs: number;
  readonly chainMaxAgeMs: number;
  readonly receiptLifetimeMs: number;
  readonly verifyingContract: string;
}

export interface PreflightDeps {
  readonly signer: ReceiptSigner;
  readonly policy: PreflightPolicy;
  /** Supplied by the caller; nothing here reads a clock. */
  readonly nowMs: number;
  readonly requestId: string;
  readonly receiptId: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function runPreflight(
  request: PreflightRequest,
  evidence: EvidenceBundle,
  deps: PreflightDeps,
): Promise<PreflightResponse> {
  const now = instant(deps.nowMs);

  const input: PreflightInput = {
    action: {
      chainId: request.chainId as ChainId,
      target: request.target.toLowerCase() as never,
      assetAddress: request.asset.toLowerCase() as never,
      wrapperAddress: request.wrapper.toLowerCase() as never,
      actionType: request.actionType,
      recipient: request.recipient.toLowerCase() as never,
      amount: BigInt(request.amount),
      expectedMultiplierNonce: BigInt(request.expectedMultiplierNonce),
    },
    supportedChainIds: deps.policy.supportedChainIds as readonly ChainId[],
    supportedTargets: deps.policy.supportedTargets.map((target) => target.toLowerCase()) as never,
    supportedActionTypes: deps.policy.supportedActionTypes,
    ...(evidence.chainId === undefined ? {} : { evidenceChainId: evidence.chainId as ChainId }),
    assetKnown: evidence.assetKnown,
    ...(evidence.registryTokenAddress === undefined
      ? {}
      : { registryTokenAddress: evidence.registryTokenAddress as never }),
    ...(evidence.registryWrapperAddress === undefined
      ? {}
      : { registryWrapperAddress: evidence.registryWrapperAddress as never }),
    ...(evidence.registryWrapperIsCurrent === undefined
      ? {}
      : { registryWrapperIsCurrent: evidence.registryWrapperIsCurrent }),
    ...(evidence.observedWrapperAsset === undefined
      ? {}
      : { observedWrapperAsset: evidence.observedWrapperAsset as never }),
    canonicality: evidence.canonicality,
    sourceComparison: evidence.sourceComparison,
    ...(evidence.onChainMultiplierNonce === undefined
      ? {}
      : { onChainMultiplierNonce: evidence.onChainMultiplierNonce }),
    ...(evidence.scheduledActivationMs === undefined
      ? {}
      : { scheduledActivation: instant(evidence.scheduledActivationMs) }),
    guardBefore: millis(deps.policy.guardBeforeMs),
    guardAfter: millis(deps.policy.guardAfterMs),
    ...(evidence.apiObservedAtMs === undefined
      ? {}
      : { apiObservedAt: instant(evidence.apiObservedAtMs) }),
    ...(evidence.chainObservedAtMs === undefined
      ? {}
      : { chainObservedAt: instant(evidence.chainObservedAtMs) }),
    freshness: {
      apiMaxAge: millis(deps.policy.apiMaxAgeMs),
      chainMaxAge: millis(deps.policy.chainMaxAgeMs),
    },
    manualReviewOpen: evidence.manualReviewOpen,
  };

  const result = evaluatePreflight(input, now);

  const operation: Operation = {
    chainId: request.chainId,
    verifyingContract: deps.policy.verifyingContract,
    caller: request.caller,
    target: request.target,
    asset: request.asset,
    wrapper: request.wrapper,
    actionType: request.actionType,
    recipient: request.recipient,
    amount: BigInt(request.amount),
    expectedMultiplierNonce: BigInt(request.expectedMultiplierNonce),
  };
  const operationDigest = computeOperationDigest(operation);

  const evidenceBlock = {
    apiEvidenceAgeMs: result.apiEvidenceAgeMs ?? null,
    chainEvidenceAgeMs: result.chainEvidenceAgeMs ?? null,
    evidenceIds: [...evidence.evidenceIds],
    blockNumber: evidence.blockNumber?.toString() ?? null,
    blockHash: evidence.blockHash ?? null,
  };

  if (result.decision === 'BLOCK') {
    const reasons = orderReasons(result.reasons);
    return {
      decision: 'BLOCK',
      requestId: deps.requestId,
      evaluatedAt: iso(deps.nowMs),
      reasonCodes: [...reasons],
      reasonExplanations: reasons.map((code: BlockReason) => ({
        code,
        explanation: REASON_EXPLANATION[code],
      })),
      evidence: evidenceBlock,
      operationDigest,
    };
  }

  // ALLOW. A receipt is issued only here, and only with the evidence the decision rested
  // on. An ALLOW that somehow reached this point without evidence references is refused by
  // the signer rather than signed.
  const signed = await deps.signer.sign({
    operation,
    receiptId: deps.receiptId,
    validAfter: BigInt(Math.floor(deps.nowMs / 1_000)),
    validUntil: BigInt(Math.floor((deps.nowMs + deps.policy.receiptLifetimeMs) / 1_000)),
    decision: 'ALLOW',
    evidenceIds: evidence.evidenceIds,
  });

  return {
    decision: 'ALLOW',
    requestId: deps.requestId,
    evaluatedAt: iso(deps.nowMs),
    reasonCodes: [],
    evidence: evidenceBlock,
    operationDigest,
    receipt: {
      schemaVersion: signed.receipt.schemaVersion,
      receiptId: signed.receipt.receiptId,
      caller: signed.receipt.caller,
      target: signed.receipt.target,
      asset: signed.receipt.asset,
      wrapper: signed.receipt.wrapper,
      actionType: signed.receipt.actionType,
      recipient: signed.receipt.recipient,
      amount: signed.receipt.amount.toString(),
      expectedMultiplierNonce: signed.receipt.expectedMultiplierNonce.toString(),
      operationDigest: signed.receipt.operationDigest,
      signature: signed.signature,
      signer: signed.signer,
      validAfter: iso(Number(signed.receipt.validAfter) * 1_000),
      validUntil: iso(Number(signed.receipt.validUntil) * 1_000),
      verifyingContract: signed.verifyingContract,
      chainId: signed.chainId,
    },
  };
}
