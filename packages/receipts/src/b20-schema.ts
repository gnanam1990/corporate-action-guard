/**
 * The B20 receipt.
 *
 * A separate typed-data struct from `PreflightReceipt`, not an extension of it. That one is
 * deployed on X Layer and its vectors are frozen fixtures; adding a field would change every
 * digest and reject every receipt already in flight. Two structs is the cost of not breaking
 * a live product.
 *
 * The B20 struct binds more than the X Layer one because more can change between deciding
 * and executing on Base. Each field is here because leaving it out lets something move:
 *
 *   schemaVersion       an adapter that understood v1 must not accept a v2 body
 *   receiptId           consumed exactly once
 *   chainId, target     (in the domain) stops replay onto another chain or adapter
 *   asset               stops substituting a different token
 *   sender, recipient   stops re-attributing or redirecting the movement
 *   rawAmount           stops resizing it — and it is *raw*, never share-equivalent
 *   actionClass         stops a deposit receipt authorizing a withdrawal
 *   operationDigest     binds the exact calldata
 *   activeMultiplierWad stops the operation surviving a corporate action
 *   pendingEffectiveAt  stops it surviving a *scheduled* one that activates mid-flight
 *   feedProxy, roundId  binds the price the decision was made against
 *   priceBasis          a total-return price and an underlying price are not interchangeable
 *   policyVersion       a changed policy invalidates the decision behind this receipt
 *   issuedAt/expiresAt  bounds the window
 *
 * `rawAmount` deserves its own note. Binding a share-equivalent quantity would mean the
 * adapter has to reproduce the multiplier conversion to check it — and if it computed that
 * conversion differently, the receipt would verify against a different amount than the one
 * that was authorized. Raw units are what actually transfer.
 */

/** Domain name and version, distinct from the X Layer domain so the two cannot cross-verify. */
export const B20_EIP712_DOMAIN_NAME = 'CorporateActionGuardB20';
export const B20_EIP712_DOMAIN_VERSION = '1';

/** Schema version inside the struct, separate from the domain version. */
export const B20_RECEIPT_SCHEMA_VERSION = 1;

/**
 * The typed-data struct.
 *
 * Field order is part of the type hash and therefore part of the contract with the adapter.
 * Reordering these lines changes every digest.
 */
export const B20_RECEIPT_TYPE = {
  B20PreflightReceipt: [
    { name: 'schemaVersion', type: 'uint16' },
    { name: 'receiptId', type: 'bytes32' },
    { name: 'asset', type: 'address' },
    { name: 'sender', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'actionClass', type: 'uint8' },
    { name: 'rawAmount', type: 'uint256' },
    { name: 'operationDigest', type: 'bytes32' },
    { name: 'activeMultiplierWad', type: 'uint256' },
    { name: 'pendingEffectiveAt', type: 'uint64' },
    { name: 'feedProxy', type: 'address' },
    { name: 'feedRoundId', type: 'uint80' },
    { name: 'priceBasis', type: 'uint8' },
    { name: 'policyVersionHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

/**
 * Action classes as `uint8`, so the adapter can compare cheaply and exhaustively.
 *
 * Values are permanent. Reusing a number for a different class would let an old receipt
 * authorize a new kind of operation — the same reason the X Layer `ACTION_TYPE` numbers are
 * frozen. New classes append.
 */
export const B20_ACTION_CLASS_CODE = {
  DISPLAY_POSITION: 1,
  QUOTE: 2,
  TRANSFER: 3,
  VAULT_DEPOSIT: 4,
  VAULT_WITHDRAW: 5,
  COLLATERAL_VALUE: 6,
  LIQUIDATION_CHECK: 7,
  INDEX_REBALANCE: 8,
  AGENT_ORDER: 9,
} as const;

export type B20ActionClassName = keyof typeof B20_ACTION_CLASS_CODE;
export type B20ActionClassCode = (typeof B20_ACTION_CLASS_CODE)[B20ActionClassName];

export const B20_ACTION_CLASS_NAME: Readonly<Record<number, B20ActionClassName>> =
  Object.fromEntries(
    Object.entries(B20_ACTION_CLASS_CODE).map(([k, v]) => [v, k as B20ActionClassName]),
  );

/**
 * Price basis as `uint8`.
 *
 * On the wire because the adapter must be able to tell them apart. A receipt bound to a
 * total-return price that an adapter interpreted as an underlying price would authorize an
 * operation sized against a value ten times off after a split.
 */
export const B20_PRICE_BASIS_CODE = {
  /** No price was required for this action class. */
  NONE: 0,
  TOTAL_RETURN_TOKEN_PRICE: 1,
  UNDERLYING_EQUITY_PRICE: 2,
} as const;

export type B20PriceBasisName = keyof typeof B20_PRICE_BASIS_CODE;
export type B20PriceBasisCode = (typeof B20_PRICE_BASIS_CODE)[B20PriceBasisName];

/** The canonical operation payload the B20 operation digest is computed over. */
export interface B20OperationPayload {
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly asset: string;
  readonly sender: string;
  readonly recipient: string;
  readonly actionClass: B20ActionClassName;
  readonly rawAmount: bigint;
  readonly targetContract: string;
  readonly expectedMultiplierWad: bigint;
  readonly integrationPolicyVersion: string;
}

export interface B20Receipt {
  readonly schemaVersion: number;
  readonly receiptId: string;
  readonly asset: string;
  readonly sender: string;
  readonly recipient: string;
  readonly actionClass: B20ActionClassCode;
  readonly rawAmount: bigint;
  readonly operationDigest: string;
  readonly activeMultiplierWad: bigint;
  /**
   * The pending activation this receipt was issued against, or 0 for none.
   *
   * Zero is a *commitment* that no activation was pending, not an absence of information.
   * The adapter re-reads and rejects if one has appeared, which is what stops a receipt
   * surviving a corporate action that was scheduled after it was issued.
   */
  readonly pendingEffectiveAt: bigint;
  readonly feedProxy: string;
  readonly feedRoundId: bigint;
  readonly priceBasis: B20PriceBasisCode;
  readonly policyVersionHash: string;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

export interface SignedB20Receipt {
  readonly receipt: B20Receipt;
  readonly signature: string;
  readonly signer: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

export const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
export const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;

/**
 * Validate a receipt's shape before signing.
 *
 * Returns every problem rather than the first, and refuses rather than normalising: a signer
 * that quietly lowercased an address or clamped a timestamp would produce a receipt that
 * does not match what the caller believes it asked for.
 */
export function validateB20Receipt(receipt: B20Receipt): readonly string[] {
  const issues: string[] = [];
  const address = /^0x[0-9a-f]{40}$/;
  const bytes32 = /^0x[0-9a-f]{64}$/;

  if (receipt.schemaVersion !== B20_RECEIPT_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${String(B20_RECEIPT_SCHEMA_VERSION)}`);
  }
  if (!bytes32.test(receipt.receiptId)) issues.push('receiptId must be lowercase bytes32');
  if (!bytes32.test(receipt.operationDigest)) {
    issues.push('operationDigest must be lowercase bytes32');
  }
  if (!bytes32.test(receipt.policyVersionHash)) {
    issues.push('policyVersionHash must be lowercase bytes32');
  }
  for (const [field, value] of [
    ['asset', receipt.asset],
    ['sender', receipt.sender],
    ['recipient', receipt.recipient],
    ['feedProxy', receipt.feedProxy],
  ] as const) {
    if (!address.test(value)) issues.push(`${field} must be a lowercase 0x address`);
  }
  if (receipt.asset === ZERO_ADDRESS) issues.push('asset must not be the zero address');
  if (receipt.recipient === ZERO_ADDRESS) issues.push('recipient must not be the zero address');
  if (receipt.rawAmount <= 0n) issues.push('rawAmount must be positive');
  if (receipt.activeMultiplierWad <= 0n) issues.push('activeMultiplierWad must be positive');
  if (receipt.expiresAt <= receipt.issuedAt) issues.push('expiresAt must be after issuedAt');

  // A price-bearing basis with no round is a receipt that claims to bind a price it cannot
  // identify. A NONE basis with a round is the reverse.
  const hasPrice = receipt.priceBasis !== B20_PRICE_BASIS_CODE.NONE;
  if (hasPrice && (receipt.feedRoundId <= 0n || receipt.feedProxy === ZERO_ADDRESS)) {
    issues.push('a price-bearing receipt must name its feed and round');
  }
  if (!hasPrice && (receipt.feedRoundId !== 0n || receipt.feedProxy !== ZERO_ADDRESS)) {
    issues.push('a receipt with no price basis must carry no feed or round');
  }

  return issues;
}

/**
 * Fields whose change must invalidate a signature.
 *
 * Data, so a mutation test can iterate it rather than hard-coding a list that drifts from
 * the struct. A field in the struct and missing here would go untested.
 */
export const B20_BOUND_FIELDS = B20_RECEIPT_TYPE.B20PreflightReceipt.map((f) => f.name);
