import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress, verifyTypedData, type TypedDataDomain } from 'viem';
import { computeOperationDigest } from './digest.js';
import {
  ACTION_TYPE,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  PREFLIGHT_RECEIPT_TYPE,
  RECEIPT_SCHEMA_VERSION,
  type Operation,
  type PreflightReceipt,
  type SignedReceipt,
} from './schema.js';

export class ReceiptError extends Error {
  override readonly name = 'ReceiptError';
  constructor(
    readonly kind:
      | 'SIGNER_UNAVAILABLE'
      | 'DECISION_NOT_ALLOW'
      | 'DIGEST_MISMATCH'
      | 'INVALID_SIGNATURE'
      | 'UNAUTHORIZED_SIGNER'
      | 'VALIDITY_WINDOW_INVALID',
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function receiptDomain(chainId: number, verifyingContract: string): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: verifyingContract as `0x${string}`,
  };
}

export interface IssueParams {
  readonly operation: Operation;
  readonly receiptId: string;
  readonly validAfter: bigint;
  readonly validUntil: bigint;
  /**
   * The already-complete deterministic decision.
   *
   * The signer accepts only ALLOW. It never re-derives the decision — that would put a
   * second, divergent copy of the safety predicate in the signing path.
   */
  readonly decision: 'ALLOW' | 'BLOCK';
  /** Evidence IDs the decision rested on. Journaled with the receipt. */
  readonly evidenceIds: readonly string[];
}

/**
 * Build the receipt struct for an operation.
 *
 * Separated from signing so a caller can compute exactly what *would* be signed without a
 * key present — which is what the verifier and the golden vectors use.
 */
export function buildReceipt(params: IssueParams): PreflightReceipt {
  if (params.validUntil <= params.validAfter) {
    throw new ReceiptError(
      'VALIDITY_WINDOW_INVALID',
      'validUntil must be strictly after validAfter',
      { validAfter: params.validAfter.toString(), validUntil: params.validUntil.toString() },
    );
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    receiptId: params.receiptId,
    caller: params.operation.caller,
    target: params.operation.target,
    asset: params.operation.asset,
    wrapper: params.operation.wrapper,
    actionType: ACTION_TYPE[params.operation.actionType],
    recipient: params.operation.recipient,
    amount: params.operation.amount,
    expectedMultiplierNonce: params.operation.expectedMultiplierNonce,
    validAfter: params.validAfter,
    validUntil: params.validUntil,
    operationDigest: computeOperationDigest(params.operation),
  };
}

/**
 * The signing boundary.
 *
 * Deliberately narrow. It accepts an already-complete ALLOW decision plus its evidence
 * IDs, and refuses everything else. It does not evaluate the safety predicate, because a
 * second copy of that logic in the signing path is a second place for it to be wrong.
 *
 * **Production gap, stated plainly:** the key lives in process memory for the lifetime of
 * a signature. Production requires HSM/KMS custody or threshold signing plus an auditable
 * rotation procedure (ADR 0002). That is documented, not implemented.
 */
export class ReceiptSigner {
  constructor(
    private readonly resolvePrivateKey: () => string | undefined,
    private readonly chainId: number,
    private readonly verifyingContract: string,
  ) {}

  /** The signer's address, or undefined when no key is configured. */
  address(): string | undefined {
    const key = this.resolvePrivateKey();
    if (key === undefined) return undefined;
    return privateKeyToAccount(key as `0x${string}`).address;
  }

  async sign(params: IssueParams): Promise<SignedReceipt> {
    // A receipt is only ever issued for an ALLOW. There is no path that signs a BLOCK, and
    // no placeholder signature exists to return when something goes wrong.
    if (params.decision !== 'ALLOW') {
      throw new ReceiptError(
        'DECISION_NOT_ALLOW',
        'a receipt may only be issued for an ALLOW decision',
        {
          decision: params.decision,
        },
      );
    }
    if (params.evidenceIds.length === 0) {
      throw new ReceiptError(
        'DECISION_NOT_ALLOW',
        'an ALLOW with no evidence references cannot be signed',
      );
    }

    // Resolved at request time, never held on the instance, never logged.
    const key = this.resolvePrivateKey();
    if (key === undefined) {
      throw new ReceiptError('SIGNER_UNAVAILABLE', 'no receipt signing key is configured');
    }

    const receipt = buildReceipt(params);
    const account = privateKeyToAccount(key as `0x${string}`);

    const signature = await account.signTypedData({
      domain: receiptDomain(this.chainId, this.verifyingContract),
      types: PREFLIGHT_RECEIPT_TYPE,
      primaryType: 'PreflightReceipt',
      message: receipt as never,
    });

    return {
      receipt,
      signature,
      signer: account.address,
      chainId: this.chainId,
      verifyingContract: this.verifyingContract,
    };
  }
}

export interface VerifyParams {
  readonly signed: SignedReceipt;
  /** The operation the caller is about to execute, rebuilt from its own fields. */
  readonly operation: Operation;
  readonly authorizedSigners: readonly string[];
  /** Seconds since the epoch, supplied by the caller. */
  readonly nowSeconds: bigint;
}

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly kind: ReceiptError['kind'] };

/**
 * Verify a receipt against the operation actually being executed.
 *
 * The point is not "is this signature well-formed" but "does this signature authorize
 * *this exact* operation". Recomputing the digest from the caller's own fields is what
 * catches a payload mutated after preflight.
 */
export async function verifyReceipt(params: VerifyParams): Promise<VerifyResult> {
  const { signed, operation } = params;

  const recomputed = computeOperationDigest(operation);
  if (recomputed.toLowerCase() !== signed.receipt.operationDigest.toLowerCase()) {
    return {
      ok: false,
      kind: 'DIGEST_MISMATCH',
      reason: 'the operation does not reproduce the digest bound in the receipt',
    };
  }

  if (params.nowSeconds < signed.receipt.validAfter) {
    return { ok: false, kind: 'VALIDITY_WINDOW_INVALID', reason: 'receipt is not yet valid' };
  }
  // Inclusive upper bound: at exactly validUntil the receipt is expired. Ties block.
  if (params.nowSeconds >= signed.receipt.validUntil) {
    return { ok: false, kind: 'VALIDITY_WINDOW_INVALID', reason: 'receipt has expired' };
  }

  let valid: boolean;
  try {
    valid = await verifyTypedData({
      address: signed.signer as `0x${string}`,
      domain: receiptDomain(signed.chainId, signed.verifyingContract),
      types: PREFLIGHT_RECEIPT_TYPE,
      primaryType: 'PreflightReceipt',
      message: signed.receipt as never,
      signature: signed.signature as `0x${string}`,
    });
  } catch {
    return { ok: false, kind: 'INVALID_SIGNATURE', reason: 'signature could not be verified' };
  }
  if (!valid) {
    return {
      ok: false,
      kind: 'INVALID_SIGNATURE',
      reason: 'signature does not match the claimed signer',
    };
  }

  const authorized = params.authorizedSigners.map((a) => a.toLowerCase());
  if (!authorized.includes(signed.signer.toLowerCase())) {
    return { ok: false, kind: 'UNAUTHORIZED_SIGNER', reason: 'signer is not authorized' };
  }

  return { ok: true };
}

/** Recover the signing address from a signed receipt. */
export async function recoverReceiptSigner(signed: SignedReceipt): Promise<string> {
  return recoverTypedDataAddress({
    domain: receiptDomain(signed.chainId, signed.verifyingContract),
    types: PREFLIGHT_RECEIPT_TYPE,
    primaryType: 'PreflightReceipt',
    message: signed.receipt as never,
    signature: signed.signature as `0x${string}`,
  });
}
