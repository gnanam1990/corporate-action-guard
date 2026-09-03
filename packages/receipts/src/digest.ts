import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters } from 'viem';
import { ACTION_TYPE, RECEIPT_SCHEMA_VERSION, type Operation } from './schema.js';

/**
 * The operation digest.
 *
 * Computed by ABI-encoding the exact bound fields and hashing them — **never** by
 * JSON-stringifying an object. A JSON encoding depends on key order, number formatting,
 * and whitespace, none of which are consensus-stable, and Solidity cannot reproduce it.
 * `abi.encode` is what the adapter can recompute on chain, so it is what we hash.
 *
 * Amounts are `uint256` base units throughout. No floating point appears anywhere in this
 * path.
 */

const OPERATION_PARAMS = parseAbiParameters(
  'uint16 schemaVersion, uint256 chainId, address verifyingContract, address caller, address target, address asset, address wrapper, uint8 actionType, address recipient, uint256 amount, uint256 expectedMultiplierNonce',
);

/**
 * A domain separator string mixed into the digest.
 *
 * Belt and braces alongside the EIP-712 domain: it makes a digest computed for this
 * product unusable as a digest for anything else that happens to encode the same fields.
 */
export const OPERATION_DIGEST_TAG = keccak256(
  new TextEncoder().encode('CorporateActionGuard.OperationDigest.v1'),
);

/** Deterministically hash an operation. Identical inputs always give an identical digest. */
export function computeOperationDigest(operation: Operation): `0x${string}` {
  const encoded = encodeAbiParameters(OPERATION_PARAMS, [
    RECEIPT_SCHEMA_VERSION,
    BigInt(operation.chainId),
    getAddress(operation.verifyingContract),
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

/** The fields the digest binds. Used by tests to prove each one changes the digest. */
export const BOUND_FIELDS = [
  'chainId',
  'verifyingContract',
  'caller',
  'target',
  'asset',
  'wrapper',
  'actionType',
  'recipient',
  'amount',
  'expectedMultiplierNonce',
] as const satisfies readonly (keyof Operation)[];
