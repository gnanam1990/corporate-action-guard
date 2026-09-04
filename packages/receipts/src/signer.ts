import { createPublicKey } from 'node:crypto';
import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { privateKeyToAccount, publicKeyToAddress } from 'viem/accounts';
import {
  hashTypedData,
  recoverAddress,
  recoverTypedDataAddress,
  serializeSignature,
  toHex,
  verifyTypedData,
  type Hex,
  type TypedDataDomain,
} from 'viem';
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

export interface ReceiptSigningProvider {
  /** Public signer identity used by readiness and on-chain authorization checks. */
  address(): string | undefined;
  /** Active custody/readiness probe. It must not sign a receipt or expose key material. */
  health(): Promise<{ readonly ok: boolean; readonly detail: string }>;
  sign(params: IssueParams): Promise<SignedReceipt>;
}

function assertIssuable(params: IssueParams): void {
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
 * Local/development signer. Production startup rejects this implementation because its
 * private key necessarily enters process memory; `AwsKmsReceiptSigner` is the production
 * custody boundary.
 */
export class ReceiptSigner implements ReceiptSigningProvider {
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

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    try {
      const signer = this.address();
      return signer === undefined
        ? { ok: false, detail: 'no signing key configured' }
        : { ok: true, detail: `local signer ${signer}` };
    } catch {
      return { ok: false, detail: 'local signing key is invalid' };
    }
  }

  async sign(params: IssueParams): Promise<SignedReceipt> {
    // A receipt is only ever issued for an ALLOW. There is no path that signs a BLOCK, and
    // no placeholder signature exists to return when something goes wrong.
    assertIssuable(params);

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

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

interface KmsSignResult {
  readonly Signature?: Uint8Array;
  readonly PublicKey?: Uint8Array;
  readonly KeySpec?: string;
  readonly KeyUsage?: string;
  readonly SigningAlgorithms?: readonly string[];
}

interface KmsSignClient {
  send(
    command: SignCommand | GetPublicKeyCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<KmsSignResult>;
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; next: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error('truncated DER length');
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };

  const width = first & 0x7f;
  if (width === 0 || width > 2) throw new Error('unsupported DER length');
  let length = 0;
  for (let i = 0; i < width; i++) {
    const value = bytes[offset + 1 + i];
    if (value === undefined) throw new Error('truncated DER length');
    length = length * 256 + value;
  }
  return { length, next: offset + 1 + width };
}

/** Parse the ASN.1 DER ECDSA shape returned by AWS KMS. */
export function parseKmsDerSignature(bytes: Uint8Array): {
  readonly r: bigint;
  readonly s: bigint;
} {
  if (bytes[0] !== 0x30) throw new Error('KMS signature is not a DER sequence');
  const sequence = readDerLength(bytes, 1);
  if (sequence.next + sequence.length !== bytes.length) {
    throw new Error('KMS signature has an invalid sequence length');
  }

  let offset = sequence.next;
  const readInteger = (): bigint => {
    if (bytes[offset] !== 0x02) throw new Error('KMS signature contains a non-integer');
    const encoded = readDerLength(bytes, offset + 1);
    offset = encoded.next;
    const end = offset + encoded.length;
    if (encoded.length === 0 || end > bytes.length) throw new Error('truncated DER integer');
    const raw = bytes.slice(offset, end);
    offset = end;
    if ((raw[0]! & 0x80) !== 0) throw new Error('negative DER integer');
    if (raw.length > 1 && raw[0] === 0 && (raw[1]! & 0x80) === 0) {
      throw new Error('non-canonical DER integer');
    }
    const unsigned = raw[0] === 0 ? raw.slice(1) : raw;
    if (unsigned.length === 0 || unsigned.length > 32) throw new Error('invalid ECDSA integer');
    return BigInt(`0x${Buffer.from(unsigned).toString('hex')}`);
  };

  const r = readInteger();
  const s = readInteger();
  if (offset !== bytes.length || r <= 0n || r >= SECP256K1_N || s <= 0n || s >= SECP256K1_N) {
    throw new Error('KMS signature is outside the secp256k1 scalar range');
  }
  return { r, s };
}

export interface AwsKmsReceiptSignerOptions {
  readonly keyId: string;
  readonly region: string;
  /** Address derived from the KMS public key and authorized on the adapter. */
  readonly signerAddress: string;
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly timeoutMs?: number;
  /** Test seam; production constructs the AWS client from region and ambient IAM identity. */
  readonly client?: KmsSignClient;
}

/** Convert an AWS KMS SubjectPublicKeyInfo document into its Ethereum address. */
export function ethereumAddressFromKmsPublicKey(publicKey: Uint8Array): string {
  const jwk = createPublicKey({
    key: Buffer.from(publicKey),
    format: 'der',
    type: 'spki',
  }).export({ format: 'jwk' });
  if (jwk.crv !== 'secp256k1' || jwk.x === undefined || jwk.y === undefined) {
    throw new Error('KMS public key is not secp256k1');
  }
  const rawPublicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return publicKeyToAddress(toHex(rawPublicKey));
}

/**
 * Production signer backed by an AWS KMS ECC_SECG_P256K1 key.
 *
 * The private key never enters this process. KMS returns DER `(r,s)` without Ethereum's
 * recovery bit, so both bits are tried and the one recovering the configured public
 * address wins. High-s signatures are normalized before recovery and return.
 */
export class AwsKmsReceiptSigner implements ReceiptSigningProvider {
  private readonly client: KmsSignClient;
  private readonly expectedAddress: string;
  private healthCache:
    | {
        readonly expiresAt: number;
        readonly result: { readonly ok: boolean; readonly detail: string };
      }
    | undefined;

  constructor(private readonly options: AwsKmsReceiptSignerOptions) {
    this.client = options.client ?? (new KMSClient({ region: options.region }) as KmsSignClient);
    this.expectedAddress = options.signerAddress.toLowerCase();
  }

  address(): string {
    return this.options.signerAddress;
  }

  async health(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    if (this.healthCache !== undefined && this.healthCache.expiresAt > Date.now()) {
      return this.healthCache.result;
    }
    let result: { readonly ok: boolean; readonly detail: string };
    try {
      const response = await this.client.send(
        new GetPublicKeyCommand({ KeyId: this.options.keyId }),
        { abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000) },
      );
      if (
        response.PublicKey === undefined ||
        response.KeySpec !== 'ECC_SECG_P256K1' ||
        response.KeyUsage !== 'SIGN_VERIFY' ||
        !response.SigningAlgorithms?.includes('ECDSA_SHA_256')
      ) {
        throw new Error('KMS key metadata is incompatible with Ethereum signing');
      }
      const actualAddress = ethereumAddressFromKmsPublicKey(response.PublicKey);
      if (actualAddress.toLowerCase() !== this.expectedAddress) {
        throw new Error('KMS public key does not match RECEIPT_SIGNER_ADDRESS');
      }
      result = { ok: true, detail: `AWS KMS signer ${this.options.signerAddress}` };
    } catch (error) {
      result = {
        ok: false,
        // This reaches a public readiness endpoint. Report the class, never an AWS message
        // that may contain a key ARN, account id, or request metadata.
        detail: `AWS KMS signer unavailable (${error instanceof Error ? error.name : 'unknown'})`,
      };
    }
    this.healthCache = { expiresAt: Date.now() + 30_000, result };
    return result;
  }

  async sign(params: IssueParams): Promise<SignedReceipt> {
    assertIssuable(params);
    const receipt = buildReceipt(params);
    const domain = receiptDomain(this.options.chainId, this.options.verifyingContract);
    const digest = hashTypedData({
      domain,
      types: PREFLIGHT_RECEIPT_TYPE,
      primaryType: 'PreflightReceipt',
      message: receipt as never,
    });

    let der: Uint8Array | undefined;
    try {
      const result = await this.client.send(
        new SignCommand({
          KeyId: this.options.keyId,
          Message: Buffer.from(digest.slice(2), 'hex'),
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
        { abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000) },
      );
      der = result.Signature;
    } catch (error) {
      throw new ReceiptError('SIGNER_UNAVAILABLE', 'AWS KMS signing failed', {
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (der === undefined) {
      throw new ReceiptError('SIGNER_UNAVAILABLE', 'AWS KMS returned no signature');
    }

    let scalars: { readonly r: bigint; readonly s: bigint };
    try {
      scalars = parseKmsDerSignature(der);
    } catch (error) {
      throw new ReceiptError('INVALID_SIGNATURE', 'AWS KMS returned an invalid DER signature', {
        cause: error instanceof Error ? error.message : 'unknown',
      });
    }
    const s = scalars.s > SECP256K1_HALF_N ? SECP256K1_N - scalars.s : scalars.s;
    const rHex = toHex(scalars.r, { size: 32 }) as Hex;
    const sHex = toHex(s, { size: 32 }) as Hex;

    let signature: Hex | undefined;
    for (const yParity of [0, 1] as const) {
      const candidate = serializeSignature({ r: rHex, s: sHex, yParity });
      const recovered = await recoverAddress({ hash: digest, signature: candidate });
      if (recovered.toLowerCase() === this.expectedAddress) {
        signature = candidate;
        break;
      }
    }
    if (signature === undefined) {
      throw new ReceiptError(
        'INVALID_SIGNATURE',
        'AWS KMS signature does not recover the configured signer address',
      );
    }

    return {
      receipt,
      signature,
      signer: this.options.signerAddress,
      chainId: this.options.chainId,
      verifyingContract: this.options.verifyingContract,
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
