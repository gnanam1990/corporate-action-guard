import { computeOperationDigest } from './digest.js';
import { ACTION_TYPE, RECEIPT_SCHEMA_VERSION, type Operation } from './schema.js';

/**
 * Golden test vectors.
 *
 * The TypeScript signer and the Solidity adapter must agree byte for byte on the operation
 * digest and the EIP-712 struct hash. If they drift, every receipt this service issues is
 * rejected on chain — and the failure surfaces at execution time, not at build time.
 *
 * These vectors are generated here, written to `vectors/operation-digests.json`, and read
 * by BOTH the TypeScript test suite and the Foundry test suite, so neither side can be
 * "fixed" to match itself.
 */

export interface GoldenVector {
  readonly name: string;
  readonly operation: {
    readonly chainId: number;
    readonly verifyingContract: string;
    readonly caller: string;
    readonly target: string;
    readonly asset: string;
    readonly wrapper: string;
    readonly actionType: number;
    readonly recipient: string;
    readonly amount: string;
    readonly expectedMultiplierNonce: string;
  };
  readonly expectedDigest: string;
}

const A = (byte: string) => `0x${byte.repeat(20)}`;

const CASES: readonly { name: string; operation: Operation }[] = [
  {
    name: 'canonical deposit',
    operation: {
      chainId: 1952,
      verifyingContract: A('11'),
      caller: A('22'),
      target: A('33'),
      asset: A('44'),
      wrapper: A('55'),
      actionType: 'DEPOSIT',
      recipient: A('66'),
      amount: 1_000_000_000_000_000_000n,
      expectedMultiplierNonce: 5n,
    },
  },
  {
    name: 'withdraw with a different action type',
    operation: {
      chainId: 1952,
      verifyingContract: A('11'),
      caller: A('22'),
      target: A('33'),
      asset: A('44'),
      wrapper: A('55'),
      actionType: 'WITHDRAW',
      recipient: A('66'),
      amount: 1_000_000_000_000_000_000n,
      expectedMultiplierNonce: 5n,
    },
  },
  {
    name: 'zero amount edge',
    operation: {
      chainId: 1952,
      verifyingContract: A('11'),
      caller: A('22'),
      target: A('33'),
      asset: A('44'),
      wrapper: A('55'),
      actionType: 'DEPOSIT',
      recipient: A('66'),
      amount: 0n,
      expectedMultiplierNonce: 0n,
    },
  },
  {
    name: 'uint256 maximum amount',
    operation: {
      chainId: 1952,
      verifyingContract: A('11'),
      caller: A('22'),
      target: A('33'),
      asset: A('44'),
      wrapper: A('55'),
      actionType: 'REDEEM',
      recipient: A('66'),
      amount: 2n ** 256n - 1n,
      expectedMultiplierNonce: 2n ** 256n - 1n,
    },
  },
  {
    name: 'mainnet chain id must produce a different digest',
    operation: {
      chainId: 196,
      verifyingContract: A('11'),
      caller: A('22'),
      target: A('33'),
      asset: A('44'),
      wrapper: A('55'),
      actionType: 'DEPOSIT',
      recipient: A('66'),
      amount: 1_000_000_000_000_000_000n,
      expectedMultiplierNonce: 5n,
    },
  },
];

export function generateVectors(): readonly GoldenVector[] {
  return CASES.map(({ name, operation }) => ({
    name,
    operation: {
      chainId: operation.chainId,
      verifyingContract: operation.verifyingContract,
      caller: operation.caller,
      target: operation.target,
      asset: operation.asset,
      wrapper: operation.wrapper,
      actionType: ACTION_TYPE[operation.actionType],
      recipient: operation.recipient,
      amount: operation.amount.toString(),
      expectedMultiplierNonce: operation.expectedMultiplierNonce.toString(),
    },
    expectedDigest: computeOperationDigest(operation),
  }));
}

export const VECTOR_SCHEMA_VERSION = RECEIPT_SCHEMA_VERSION;
