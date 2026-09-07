/**
 * The B20 operation digest.
 *
 * Same discipline as the X Layer digest and for the same reason: ABI-encode the exact bound
 * fields and hash them, never JSON-stringify an object. A JSON encoding depends on key
 * order, number formatting and whitespace, none of which are consensus-stable, and Solidity
 * cannot reproduce it. `abi.encode` is what the adapter recomputes on chain, so it is what
 * gets hashed.
 *
 * A distinct domain tag from the X Layer digest, so a digest computed for one product is
 * structurally unusable as a digest for the other even if the field values happened to line
 * up.
 */

import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters } from 'viem';
import {
  B20_ACTION_CLASS_CODE,
  B20_RECEIPT_SCHEMA_VERSION,
  type B20OperationPayload,
} from './b20-schema.js';

const B20_OPERATION_PARAMS = parseAbiParameters(
  'uint16 schemaVersion, uint256 chainId, address verifyingContract, address asset, ' +
    'address sender, address recipient, uint8 actionClass, uint256 rawAmount, ' +
    'address targetContract, uint256 expectedMultiplierWad, bytes32 policyVersionHash',
);

export const B20_OPERATION_DIGEST_TAG = keccak256(
  new TextEncoder().encode('CorporateActionGuard.B20.OperationDigest.v1'),
);

/**
 * Hash a policy version string.
 *
 * The version travels as a hash rather than a string because the struct field is `bytes32`
 * and a variable-length string in typed data hashes differently across implementations that
 * disagree about encoding. Hashing here makes both sides encode the same 32 bytes.
 */
export function hashPolicyVersion(version: string): `0x${string}` {
  return keccak256(new TextEncoder().encode(version));
}

/** Deterministically hash a B20 operation. Identical inputs always give an identical digest. */
export function computeB20OperationDigest(operation: B20OperationPayload): `0x${string}` {
  const encoded = encodeAbiParameters(B20_OPERATION_PARAMS, [
    B20_RECEIPT_SCHEMA_VERSION,
    BigInt(operation.chainId),
    getAddress(operation.verifyingContract),
    getAddress(operation.asset),
    getAddress(operation.sender),
    getAddress(operation.recipient),
    B20_ACTION_CLASS_CODE[operation.actionClass],
    operation.rawAmount,
    getAddress(operation.targetContract),
    operation.expectedMultiplierWad,
    hashPolicyVersion(operation.integrationPolicyVersion),
  ]);

  return keccak256(`0x${B20_OPERATION_DIGEST_TAG.slice(2)}${encoded.slice(2)}`);
}

/**
 * The fields the digest binds.
 *
 * Data rather than a comment, so the mutation test iterates it. A field added to the encoded
 * parameters and missing here would go untested, which is the one way a binding can silently
 * stop binding.
 */
export const B20_DIGEST_BOUND_FIELDS = [
  'chainId',
  'verifyingContract',
  'asset',
  'sender',
  'recipient',
  'actionClass',
  'rawAmount',
  'targetContract',
  'expectedMultiplierWad',
  'integrationPolicyVersion',
] as const satisfies readonly (keyof B20OperationPayload)[];
