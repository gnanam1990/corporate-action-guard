import { encodeFunctionData } from 'viem';
import type { Receipt } from './types.js';

export const ACTION_GUARD_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'receipt',
        type: 'tuple',
        components: [
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
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** Encode the exact adapter call represented by an ALLOW response. */
export function encodeGuardExecution(receipt: Receipt): `0x${string}` {
  return encodeFunctionData({
    abi: ACTION_GUARD_EXECUTE_ABI,
    functionName: 'execute',
    args: [
      {
        schemaVersion: receipt.schemaVersion,
        receiptId: receipt.receiptId as `0x${string}`,
        caller: receipt.caller as `0x${string}`,
        target: receipt.target as `0x${string}`,
        asset: receipt.asset as `0x${string}`,
        wrapper: receipt.wrapper as `0x${string}`,
        actionType: receipt.actionType,
        recipient: receipt.recipient as `0x${string}`,
        amount: BigInt(receipt.amount),
        expectedMultiplierNonce: BigInt(receipt.expectedMultiplierNonce),
        validAfter: BigInt(Math.floor(Date.parse(receipt.validAfter) / 1_000)),
        validUntil: BigInt(Math.floor(Date.parse(receipt.validUntil) / 1_000)),
        operationDigest: receipt.operationDigest as `0x${string}`,
      },
      receipt.signature as `0x${string}`,
    ],
  });
}

export interface GuardTransactionRequest {
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly data: `0x${string}`;
  readonly value: 0n;
}

/** A wallet-ready, zero-value transaction; broadcasting remains the caller's decision. */
export function buildGuardTransaction(receipt: Receipt): GuardTransactionRequest {
  return {
    chainId: receipt.chainId,
    from: receipt.caller,
    to: receipt.verifyingContract,
    data: encodeGuardExecution(receipt),
    value: 0n,
  };
}
