/**
 * Public SDK types.
 *
 * Mirrors the versioned OpenAPI contract. The SDK deliberately does **not** re-implement
 * the safety predicate: a second copy of that logic in a client would be a second place for
 * it to be wrong, and a client-side ALLOW would be worthless anyway — only the server holds
 * the evidence, and only the adapter enforces on chain.
 */

export type ActionType = 'DEPOSIT' | 'WITHDRAW' | 'TRANSFER' | 'REDEEM';

export interface PreflightOperation {
  readonly chainId: number;
  readonly assetId: string;
  readonly target: string;
  readonly asset: string;
  readonly wrapper: string;
  readonly actionType: ActionType;
  readonly caller: string;
  readonly recipient: string;
  /** Base units. `bigint` so a uint256 amount survives; never a number. */
  readonly amount: bigint;
  readonly expectedMultiplierNonce: bigint;
}

export interface EvidenceSummary {
  readonly apiEvidenceAgeMs: number | null;
  readonly chainEvidenceAgeMs: number | null;
  readonly evidenceIds: readonly string[];
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
}

export interface Receipt {
  readonly schemaVersion: number;
  readonly receiptId: string;
  readonly caller: string;
  readonly target: string;
  readonly asset: string;
  readonly wrapper: string;
  readonly actionType: number;
  readonly recipient: string;
  readonly amount: string;
  readonly expectedMultiplierNonce: string;
  readonly operationDigest: string;
  readonly signature: string;
  readonly signer: string;
  readonly validAfter: string;
  readonly validUntil: string;
  readonly verifyingContract: string;
  readonly chainId: number;
}

export type PreflightDecision =
  | {
      readonly decision: 'ALLOW';
      readonly requestId: string;
      readonly evaluatedAt: string;
      readonly reasonCodes: readonly [];
      readonly evidence: EvidenceSummary;
      readonly operationDigest: string;
      readonly receipt: Receipt;
    }
  | {
      readonly decision: 'BLOCK';
      readonly requestId: string;
      readonly evaluatedAt: string;
      /** Stable, machine-readable, severity-ordered. Never empty for a BLOCK. */
      readonly reasonCodes: readonly string[];
      readonly reasonExplanations: readonly {
        readonly code: string;
        readonly explanation: string;
      }[];
      readonly evidence: EvidenceSummary;
      readonly operationDigest: string;
      // No `receipt` key exists on this branch, so a BLOCK carrying one is not
      // representable in the type system either.
    };

export type SdkErrorKind =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class GuardError extends Error {
  override readonly name = 'GuardError';
  constructor(
    readonly kind: SdkErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/**
 * Exit codes, shared by the SDK and the CLI.
 *
 * `ALLOW` and `BLOCK` are both successful *evaluations* and are deliberately distinct from
 * an error. A script that treats a BLOCK as a failure to retry would hammer the API; a
 * script that treats it as success would proceed with an operation the guard refused.
 *
 * ALLOW is not the same as execution success. It authorizes a submission; the transaction
 * can still revert.
 */
export const EXIT_CODE = {
  ALLOW: 0,
  BLOCK: 10,
  UNAVAILABLE: 20,
  INVALID_INPUT: 30,
  INTERNAL: 40,
} as const;
