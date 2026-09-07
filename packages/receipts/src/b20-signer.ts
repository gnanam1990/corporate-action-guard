/**
 * B20 receipt signing and verification.
 *
 * The rule this module exists to enforce: **a receipt is never signed from a decision the
 * caller handed us.** Issuance takes a re-verification callback, runs it inside a bounded
 * window, and signs only if the freshly re-read evidence is still `ALLOW`. Signing from a
 * stored flag would sign a decision that was true when it was made and false by the time the
 * signature exists — which is precisely the window a corporate action lands in.
 *
 * The signer also does not re-derive the decision. That would put a second, divergent copy of
 * the safety predicate in the signing path, and two copies of a predicate eventually
 * disagree. It calls back into the one evaluator and requires the answer to still be ALLOW.
 */

import { recoverTypedDataAddress, verifyTypedData, type TypedDataDomain } from 'viem';
import {
  B20_EIP712_DOMAIN_NAME,
  B20_EIP712_DOMAIN_VERSION,
  B20_RECEIPT_SCHEMA_VERSION,
  B20_RECEIPT_TYPE,
  validateB20Receipt,
  type B20Receipt,
  type SignedB20Receipt,
} from './b20-schema.js';

export type B20ReceiptErrorKind =
  | 'NOT_ALLOWED'
  | 'REVERIFICATION_FAILED'
  | 'REVERIFICATION_WINDOW_EXCEEDED'
  | 'RECEIPT_INVALID'
  | 'VALIDITY_WINDOW_INVALID'
  | 'SIGNER_UNAVAILABLE';

export class B20ReceiptError extends Error {
  override readonly name = 'B20ReceiptError';
  constructor(
    readonly kind: B20ReceiptErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function b20ReceiptDomain(chainId: number, verifyingContract: string): TypedDataDomain {
  return {
    name: B20_EIP712_DOMAIN_NAME,
    version: B20_EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: verifyingContract as `0x${string}`,
  };
}

/** What the caller must be able to redo at issuance time. */
export interface B20Reverification {
  /** The decision as re-derived from freshly read evidence. */
  readonly decision: 'ALLOW' | 'BLOCK' | 'REVIEW';
  readonly reasons: readonly string[];
  /** The multiplier observed during re-verification. Bound into the receipt. */
  readonly activeMultiplierWad: bigint;
  /** A pending activation observed during re-verification, or 0n for none. */
  readonly pendingEffectiveAt: bigint;
  readonly feedRoundId: bigint;
  /** Seconds the re-read took. Compared against the issuance window. */
  readonly elapsedSeconds: bigint;
}

export interface B20IssueParams {
  readonly receipt: Omit<
    B20Receipt,
    'schemaVersion' | 'activeMultiplierWad' | 'pendingEffectiveAt' | 'feedRoundId'
  >;
  /**
   * Re-read every mandatory source and re-decide. Called *inside* issuance, after the stored
   * intent is loaded and before anything is signed.
   */
  readonly reverify: () => Promise<B20Reverification>;
  /**
   * How long re-verification may take before its result is itself too old to sign against.
   *
   * Without this, a slow re-read produces a receipt bound to evidence that was fresh when the
   * read started and stale when the signature landed.
   */
  readonly maxReverificationSeconds: bigint;
}

export interface B20SigningProvider {
  readonly chainId: number;
  readonly verifyingContract: string;
  signB20Receipt(receipt: B20Receipt): Promise<SignedB20Receipt>;
}

/**
 * Issue a receipt, or refuse.
 *
 * Returns a discriminated result rather than throwing on a refusal: a `BLOCK` at
 * re-verification is a normal, expected outcome that the caller reports to the client, not
 * an exception. Only a genuine fault throws.
 */
export type IssueOutcome =
  | { readonly ok: true; readonly signed: SignedB20Receipt }
  | {
      readonly ok: false;
      readonly kind: B20ReceiptErrorKind;
      readonly reasons: readonly string[];
      readonly detail: string;
    };

export async function issueB20Receipt(
  signer: B20SigningProvider,
  params: B20IssueParams,
): Promise<IssueOutcome> {
  if (params.receipt.expiresAt <= params.receipt.issuedAt) {
    throw new B20ReceiptError(
      'VALIDITY_WINDOW_INVALID',
      'expiresAt must be strictly after issuedAt',
    );
  }

  const reverified = await params.reverify();

  if (reverified.elapsedSeconds > params.maxReverificationSeconds) {
    // The re-read itself took too long. Its result describes a moment that has passed.
    return {
      ok: false,
      kind: 'REVERIFICATION_WINDOW_EXCEEDED',
      reasons: reverified.reasons,
      detail:
        `re-verification took ${String(reverified.elapsedSeconds)}s, beyond the ` +
        `${String(params.maxReverificationSeconds)}s issuance window`,
    };
  }

  if (reverified.decision !== 'ALLOW') {
    // State changed between the decision and this moment. No signature, and the reasons the
    // re-read produced go back to the caller rather than the ones from the original decision.
    return {
      ok: false,
      kind: 'NOT_ALLOWED',
      reasons: reverified.reasons,
      detail: `re-verification returned ${reverified.decision}; nothing was signed`,
    };
  }

  // The multiplier and round bound into the receipt come from the *re-read*, not from the
  // original decision. Binding the original values would produce a receipt that commits to a
  // state the chain has already left.
  const receipt: B20Receipt = {
    ...params.receipt,
    schemaVersion: B20_RECEIPT_SCHEMA_VERSION,
    activeMultiplierWad: reverified.activeMultiplierWad,
    pendingEffectiveAt: reverified.pendingEffectiveAt,
    feedRoundId: reverified.feedRoundId,
  };

  const issues = validateB20Receipt(receipt);
  if (issues.length > 0) {
    throw new B20ReceiptError('RECEIPT_INVALID', 'refusing to sign a malformed receipt', {
      issues,
    });
  }

  return { ok: true, signed: await signer.signB20Receipt(receipt) };
}

export interface B20VerifyParams {
  readonly signed: SignedB20Receipt;
  readonly expectedSigner: string;
  /** Block timestamp of verification. Never a wall clock. */
  readonly atSeconds: bigint;
  readonly expectedChainId: number;
  readonly expectedVerifyingContract: string;
}

export type B20VerifyResult =
  { readonly valid: true } | { readonly valid: false; readonly reason: string };

/**
 * Verify a signed receipt off chain.
 *
 * The adapter does the same checks on chain; this exists so an SDK consumer can verify
 * independently rather than trusting an API's success flag. Both must agree, which is why
 * the golden vectors are shared.
 */
export async function verifyB20Receipt(params: B20VerifyParams): Promise<B20VerifyResult> {
  const { signed } = params;

  if (signed.chainId !== params.expectedChainId) {
    return { valid: false, reason: 'chain id does not match the expected domain' };
  }
  if (signed.verifyingContract.toLowerCase() !== params.expectedVerifyingContract.toLowerCase()) {
    return { valid: false, reason: 'verifying contract does not match the expected domain' };
  }
  if (signed.receipt.schemaVersion !== B20_RECEIPT_SCHEMA_VERSION) {
    // An adapter that understood v1 must not accept a v2 body it cannot fully interpret.
    return { valid: false, reason: 'unsupported receipt schema version' };
  }
  if (params.atSeconds >= signed.receipt.expiresAt) {
    return { valid: false, reason: 'receipt has expired' };
  }
  if (params.atSeconds < signed.receipt.issuedAt) {
    return { valid: false, reason: 'receipt is not yet valid' };
  }

  const ok = await verifyTypedData({
    address: params.expectedSigner as `0x${string}`,
    domain: b20ReceiptDomain(signed.chainId, signed.verifyingContract),
    types: B20_RECEIPT_TYPE,
    primaryType: 'B20PreflightReceipt',
    message: signed.receipt as never,
    signature: signed.signature as `0x${string}`,
  });

  return ok
    ? { valid: true }
    : { valid: false, reason: 'signature does not match the expected signer' };
}

/** Recover the signer, for diagnosing a rejected receipt without trusting its claim. */
export async function recoverB20ReceiptSigner(signed: SignedB20Receipt): Promise<string> {
  return recoverTypedDataAddress({
    domain: b20ReceiptDomain(signed.chainId, signed.verifyingContract),
    types: B20_RECEIPT_TYPE,
    primaryType: 'B20PreflightReceipt',
    message: signed.receipt as never,
    signature: signed.signature as `0x${string}`,
  });
}
