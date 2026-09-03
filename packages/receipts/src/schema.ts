/**
 * The EIP-712 receipt schema.
 *
 * **This is a frozen cross-artifact contract.** The same struct definition exists in
 * Solidity (`contracts/src/ActionGuardAdapter.sol`). Changing either side without the
 * other silently breaks every signature, so golden test vectors assert both produce
 * byte-identical digests.
 *
 * Every field here exists because leaving it out would let something change between
 * preflight and execution:
 *
 *  - `chainId` + `verifyingContract` (domain) — stops replay onto another chain or another
 *    adapter deployment.
 *  - `caller` — stops one integrator using a receipt issued to another.
 *  - `target` + `actionType` — stops the receipt authorizing a different call.
 *  - `asset` + `wrapper` — stops substituting a different token or wrapper.
 *  - `recipient` — stops redirecting the funds.
 *  - `amount` — stops changing the size.
 *  - `expectedMultiplierNonce` — stops the operation surviving a corporate action.
 *  - `validAfter` / `validUntil` — bounds the window.
 *  - `receiptId` — makes each receipt individually consumable exactly once.
 */

export const EIP712_DOMAIN_NAME = 'CorporateActionGuard';
export const EIP712_DOMAIN_VERSION = '1';

/** Schema version carried inside the struct, separate from the domain version. */
export const RECEIPT_SCHEMA_VERSION = 1;

/**
 * The typed-data struct.
 *
 * Field order is part of the type hash and therefore part of the contract. Reordering
 * these lines changes every digest.
 */
export const PREFLIGHT_RECEIPT_TYPE = {
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

/**
 * Action types, encoded as a `uint8` so the adapter can compare cheaply and exhaustively.
 * Values are permanent: reusing a number for a different action would let an old receipt
 * authorize a new operation.
 */
export const ACTION_TYPE = {
  DEPOSIT: 1,
  WITHDRAW: 2,
  TRANSFER: 3,
  REDEEM: 4,
} as const;

export type ActionTypeName = keyof typeof ACTION_TYPE;
export type ActionTypeValue = (typeof ACTION_TYPE)[ActionTypeName];

export const ACTION_TYPE_NAME: Readonly<Record<number, ActionTypeName>> = Object.fromEntries(
  Object.entries(ACTION_TYPE).map(([k, v]) => [v, k as ActionTypeName]),
);

/** The canonical operation payload the digest is computed over. */
export interface Operation {
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly caller: string;
  readonly target: string;
  readonly asset: string;
  readonly wrapper: string;
  readonly actionType: ActionTypeName;
  readonly recipient: string;
  /** Base units. Never a float, never a display string. */
  readonly amount: bigint;
  readonly expectedMultiplierNonce: bigint;
}

export interface PreflightReceipt {
  readonly schemaVersion: number;
  readonly receiptId: string;
  readonly caller: string;
  readonly target: string;
  readonly asset: string;
  readonly wrapper: string;
  readonly actionType: ActionTypeValue;
  readonly recipient: string;
  readonly amount: bigint;
  readonly expectedMultiplierNonce: bigint;
  readonly validAfter: bigint;
  readonly validUntil: bigint;
  readonly operationDigest: string;
}

export interface SignedReceipt {
  readonly receipt: PreflightReceipt;
  readonly signature: string;
  readonly signer: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}
