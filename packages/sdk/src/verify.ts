import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  getAddress,
  verifyTypedData,
} from 'viem';
import type { PreflightOperation, Receipt } from './types.js';

/**
 * Local receipt verification.
 *
 * Lets an integrator confirm, before spending any gas, that a receipt actually authorizes
 * the operation they are about to submit. It re-derives the operation digest from their own
 * fields and checks the signature — exactly what the adapter will do on chain.
 *
 * This is the one place the SDK duplicates server logic, and it does so deliberately: it
 * duplicates the *encoding*, which is a frozen cross-artifact contract with golden vectors,
 * not the *decision*. Catching a mismatch here turns a reverted transaction into a local
 * error.
 *
 * A pass here is not permission. The adapter still re-verifies the nonce, the wrapper
 * relation, the guard window, and consumption at execution time, and any of those can have
 * changed since issuance.
 */

const OPERATION_PARAMS = parseAbiParameters(
  'uint16 schemaVersion, uint256 chainId, address verifyingContract, address caller, address target, address asset, address wrapper, uint8 actionType, address recipient, uint256 amount, uint256 expectedMultiplierNonce',
);

const OPERATION_DIGEST_TAG = keccak256(
  new TextEncoder().encode('CorporateActionGuard.OperationDigest.v1'),
);

const SCHEMA_VERSION = 1;

const ACTION_TYPE = { DEPOSIT: 1, WITHDRAW: 2, TRANSFER: 3, REDEEM: 4 } as const;

const PREFLIGHT_RECEIPT_TYPE = {
  PreflightReceipt: [
    { name: 'schemaVersion', type: 'uint16' },
    { name: 'receiptId', type: 'bytes32' },
    { name: 'caller', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'wrapper', type: 'address' },
    { name: 'actionType', type: 'uint8' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expectedMultiplierNonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'operationDigest', type: 'bytes32' },
  ],
} as const;

export function computeOperationDigest(
  operation: PreflightOperation,
  verifyingContract: string,
): `0x${string}` {
  const encoded = encodeAbiParameters(OPERATION_PARAMS, [
    SCHEMA_VERSION,
    BigInt(operation.chainId),
    getAddress(verifyingContract),
    getAddress(operation.caller),
    getAddress(operation.target),
    getAddress(operation.asset),
    getAddress(operation.wrapper),
    ACTION_TYPE[operation.actionType],
    getAddress(operation.recipient),
    operation.amount,
    operation.expectedMultiplierNonce,
  ]);
  return keccak256(`0x${OPERATION_DIGEST_TAG.slice(2)}${encoded.slice(2)}`);
}

export type VerificationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly code: VerificationFailure };

export type VerificationFailure =
  | 'DIGEST_MISMATCH'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'BAD_SIGNATURE'
  | 'SIGNER_NOT_EXPECTED'
  | 'CHAIN_MISMATCH';

export interface VerifyOptions {
  readonly receipt: Receipt;
  /** The operation the caller is actually about to submit, from their own fields. */
  readonly operation: PreflightOperation;
  readonly operationDigest: string;
  /** Signers the integrator is willing to trust. Optional but strongly recommended. */
  readonly expectedSigners?: readonly string[];
  /** Seconds since the epoch, supplied by the caller. */
  readonly nowSeconds: bigint;
}

/**
 * Verify a receipt against the operation about to be submitted.
 *
 * Checks are ordered so the cheapest and most diagnostic run first: a digest mismatch means
 * the caller changed something after preflight, which is a different bug from an expired
 * receipt.
 */
export async function verifyReceiptLocally(options: VerifyOptions): Promise<VerificationResult> {
  const { receipt, operation } = options;

  if (receipt.chainId !== operation.chainId) {
    return {
      ok: false,
      code: 'CHAIN_MISMATCH',
      reason: `the receipt is for chain ${receipt.chainId} but the operation targets ${operation.chainId}`,
    };
  }

  const recomputed = computeOperationDigest(operation, receipt.verifyingContract);
  if (recomputed.toLowerCase() !== options.operationDigest.toLowerCase()) {
    return {
      ok: false,
      code: 'DIGEST_MISMATCH',
      reason:
        'the operation does not reproduce the bound digest — a field changed after preflight. ' +
        'Submitting this would revert on chain.',
    };
  }

  const validAfter = BigInt(Math.floor(Date.parse(receipt.validAfter) / 1_000));
  const validUntil = BigInt(Math.floor(Date.parse(receipt.validUntil) / 1_000));

  if (options.nowSeconds < validAfter) {
    return {
      ok: false,
      code: 'NOT_YET_VALID',
      reason: `the receipt is not valid until ${receipt.validAfter}`,
    };
  }
  // Inclusive upper bound, matching the adapter exactly. Ties block.
  if (options.nowSeconds >= validUntil) {
    return { ok: false, code: 'EXPIRED', reason: `the receipt expired at ${receipt.validUntil}` };
  }

  let valid: boolean;
  try {
    valid = await verifyTypedData({
      address: receipt.signer as `0x${string}`,
      domain: {
        name: 'CorporateActionGuard',
        version: '1',
        chainId: receipt.chainId,
        verifyingContract: receipt.verifyingContract as `0x${string}`,
      },
      types: PREFLIGHT_RECEIPT_TYPE,
      primaryType: 'PreflightReceipt',
      message: {
        schemaVersion: SCHEMA_VERSION,
        receiptId: receipt.receiptId as `0x${string}`,
        caller: getAddress(operation.caller),
        target: getAddress(operation.target),
        asset: getAddress(operation.asset),
        wrapper: getAddress(operation.wrapper),
        actionType: ACTION_TYPE[operation.actionType],
        recipient: getAddress(operation.recipient),
        amount: operation.amount,
        expectedMultiplierNonce: operation.expectedMultiplierNonce,
        validAfter,
        validUntil,
        operationDigest: options.operationDigest as `0x${string}`,
      } as never,
      signature: receipt.signature as `0x${string}`,
    });
  } catch {
    return { ok: false, code: 'BAD_SIGNATURE', reason: 'the signature could not be verified' };
  }

  if (!valid) {
    return {
      ok: false,
      code: 'BAD_SIGNATURE',
      reason: 'the signature does not match the claimed signer',
    };
  }

  if (options.expectedSigners !== undefined) {
    const expected = options.expectedSigners.map((s) => s.toLowerCase());
    if (!expected.includes(receipt.signer.toLowerCase())) {
      return {
        ok: false,
        code: 'SIGNER_NOT_EXPECTED',
        reason: `signed by ${receipt.signer}, which is not in the expected signer list`,
      };
    }
  }

  return { ok: true };
}
