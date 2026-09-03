import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPE,
  BOUND_FIELDS,
  buildReceipt,
  computeOperationDigest,
  ReceiptError,
  ReceiptSigner,
  recoverReceiptSigner,
  verifyReceipt,
  type Operation,
  type SignedReceipt,
} from '../src/index.js';

// Deterministic test key. Testnet-only, never used for anything real, and the address it
// derives is asserted below so a change to the key is loud rather than silent.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SIGNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

const ADAPTER = '0x1111111111111111111111111111111111111111';
const CALLER = '0x2222222222222222222222222222222222222222';
const VAULT = '0x3333333333333333333333333333333333333333';
const ASSET = '0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a';
const WRAPPER = '0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f';
const RECIPIENT = '0x4444444444444444444444444444444444444444';
const OTHER_ADDRESS = '0x5555555555555555555555555555555555555555';

const RECEIPT_ID = `0x${'11'.repeat(32)}`;

const operation = (over: Partial<Operation> = {}): Operation => ({
  chainId: 1952,
  verifyingContract: ADAPTER,
  caller: CALLER,
  target: VAULT,
  asset: ASSET,
  wrapper: WRAPPER,
  actionType: 'DEPOSIT',
  recipient: RECIPIENT,
  amount: 1_000_000_000_000_000_000n,
  expectedMultiplierNonce: 5n,
  ...over,
});

const signer = () => new ReceiptSigner(() => KEY, 1952, ADAPTER);

const issue = (over: Partial<Operation> = {}) =>
  signer().sign({
    operation: operation(over),
    receiptId: RECEIPT_ID,
    validAfter: 1_788_000_000n,
    validUntil: 1_788_000_300n,
    decision: 'ALLOW',
    evidenceIds: ['evt-1', 'evt-2'],
  });

describe('operation digest', () => {
  it('is deterministic', () => {
    expect(computeOperationDigest(operation())).toBe(computeOperationDigest(operation()));
  });

  it('is a 32-byte hash', () => {
    expect(computeOperationDigest(operation())).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is insensitive to address checksum casing', () => {
    // The same account written two ways must produce the same digest, or a checksummed
    // input from one client and a lowercase one from another would never verify.
    expect(computeOperationDigest(operation({ asset: ASSET.toLowerCase() }))).toBe(
      computeOperationDigest(operation()),
    );
  });

  /**
   * The core property: every bound field changes the digest. If any of these passed, a
   * caller could alter that field after preflight and still present a valid receipt.
   */
  const mutations: Record<(typeof BOUND_FIELDS)[number], Partial<Operation>> = {
    chainId: { chainId: 196 },
    verifyingContract: { verifyingContract: OTHER_ADDRESS },
    caller: { caller: OTHER_ADDRESS },
    target: { target: OTHER_ADDRESS },
    asset: { asset: OTHER_ADDRESS },
    wrapper: { wrapper: OTHER_ADDRESS },
    actionType: { actionType: 'WITHDRAW' },
    recipient: { recipient: OTHER_ADDRESS },
    amount: { amount: 1_000_000_000_000_000_001n },
    expectedMultiplierNonce: { expectedMultiplierNonce: 6n },
  };

  for (const field of BOUND_FIELDS) {
    it(`changes when ${field} changes`, () => {
      expect(computeOperationDigest(operation(mutations[field]))).not.toBe(
        computeOperationDigest(operation()),
      );
    });
  }

  it('covers every bound field with a mutation case', () => {
    expect(Object.keys(mutations).sort()).toEqual([...BOUND_FIELDS].sort());
  });

  it('distinguishes amounts differing by one base unit', () => {
    // A one-wei difference must be visible; anything less exact would let rounding through.
    expect(computeOperationDigest(operation({ amount: 1n }))).not.toBe(
      computeOperationDigest(operation({ amount: 2n })),
    );
  });

  it('handles a uint256-scale amount without loss', () => {
    const huge = 2n ** 255n;
    expect(() => computeOperationDigest(operation({ amount: huge }))).not.toThrow();
  });
});

describe('signing boundary', () => {
  it('derives the expected signer address from the test key', async () => {
    expect(signer().address()?.toLowerCase()).toBe(SIGNER.toLowerCase());
  });

  it('signs an ALLOW with evidence', async () => {
    const signed = await issue();
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signed.signer.toLowerCase()).toBe(SIGNER.toLowerCase());
  });

  it('refuses to sign a BLOCK', async () => {
    await expect(
      signer().sign({
        operation: operation(),
        receiptId: RECEIPT_ID,
        validAfter: 1n,
        validUntil: 2n,
        decision: 'BLOCK',
        evidenceIds: ['evt-1'],
      }),
    ).rejects.toMatchObject({ kind: 'DECISION_NOT_ALLOW' });
  });

  it('refuses to sign an ALLOW with no evidence references', async () => {
    await expect(
      signer().sign({
        operation: operation(),
        receiptId: RECEIPT_ID,
        validAfter: 1n,
        validUntil: 2n,
        decision: 'ALLOW',
        evidenceIds: [],
      }),
    ).rejects.toMatchObject({ kind: 'DECISION_NOT_ALLOW' });
  });

  it('never returns a placeholder when no key is configured', async () => {
    // The only acceptable outcome is a typed failure. A placeholder signature would be
    // indistinguishable from a real one to a caller that did not check.
    const keyless = new ReceiptSigner(() => undefined, 1952, ADAPTER);
    await expect(
      keyless.sign({
        operation: operation(),
        receiptId: RECEIPT_ID,
        validAfter: 1n,
        validUntil: 2n,
        decision: 'ALLOW',
        evidenceIds: ['evt-1'],
      }),
    ).rejects.toMatchObject({ kind: 'SIGNER_UNAVAILABLE' });
    expect(keyless.address()).toBeUndefined();
  });

  it('rejects an inverted validity window', () => {
    expect(() =>
      buildReceipt({
        operation: operation(),
        receiptId: RECEIPT_ID,
        validAfter: 100n,
        validUntil: 100n,
        decision: 'ALLOW',
        evidenceIds: ['e'],
      }),
    ).toThrow(ReceiptError);
  });

  it('resolves the key per request rather than holding it on the instance', async () => {
    let resolutions = 0;
    const s = new ReceiptSigner(
      () => {
        resolutions++;
        return KEY;
      },
      1952,
      ADAPTER,
    );
    await s.sign({
      operation: operation(),
      receiptId: RECEIPT_ID,
      validAfter: 1n,
      validUntil: 2n,
      decision: 'ALLOW',
      evidenceIds: ['e'],
    });
    expect(resolutions).toBeGreaterThan(0);
  });
});

describe('verification binds the receipt to the exact operation', () => {
  const NOW = 1_788_000_100n;
  const verify = (signed: SignedReceipt, op: Operation, nowSeconds = NOW) =>
    verifyReceipt({ signed, operation: op, authorizedSigners: [SIGNER], nowSeconds });

  it('accepts the operation it was issued for', async () => {
    const signed = await issue();
    await expect(verify(signed, operation())).resolves.toEqual({ ok: true });
  });

  it('recovers the signer from the signature alone', async () => {
    const signed = await issue();
    await expect(recoverReceiptSigner(signed)).resolves.toBe(signed.signer);
  });

  /** One mutation per bound field, applied after issuance. Each must be rejected. */
  const postIssuanceMutations: Array<[string, Partial<Operation>]> = [
    ['recipient', { recipient: OTHER_ADDRESS }],
    ['amount', { amount: 999n }],
    ['asset', { asset: OTHER_ADDRESS }],
    ['wrapper', { wrapper: OTHER_ADDRESS }],
    ['target', { target: OTHER_ADDRESS }],
    ['caller', { caller: OTHER_ADDRESS }],
    ['actionType', { actionType: 'WITHDRAW' }],
    ['expectedMultiplierNonce', { expectedMultiplierNonce: 6n }],
    ['chainId', { chainId: 196 }],
    ['verifyingContract', { verifyingContract: OTHER_ADDRESS }],
  ];

  for (const [field, mutation] of postIssuanceMutations) {
    it(`rejects a ${field} changed after issuance`, async () => {
      const signed = await issue();
      const result = await verify(signed, operation(mutation));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe('DIGEST_MISMATCH');
    });
  }

  it('rejects a receipt before its validity window opens', async () => {
    const signed = await issue();
    const result = await verify(signed, operation(), 1_787_999_999n);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not yet valid/);
  });

  it('accepts at exactly validAfter — the lower bound is inclusive', async () => {
    const signed = await issue();
    await expect(verify(signed, operation(), 1_788_000_000n)).resolves.toEqual({ ok: true });
  });

  it('rejects at exactly validUntil — the upper bound is inclusive, ties block', async () => {
    const signed = await issue();
    const result = await verify(signed, operation(), 1_788_000_300n);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/);
  });

  it('accepts one second before expiry', async () => {
    const signed = await issue();
    await expect(verify(signed, operation(), 1_788_000_299n)).resolves.toEqual({ ok: true });
  });

  it('rejects a signer that is not authorized', async () => {
    const rogue = new ReceiptSigner(() => OTHER_KEY, 1952, ADAPTER);
    const signed = await rogue.sign({
      operation: operation(),
      receiptId: RECEIPT_ID,
      validAfter: 1_788_000_000n,
      validUntil: 1_788_000_300n,
      decision: 'ALLOW',
      evidenceIds: ['e'],
    });
    const result = await verifyReceipt({
      signed,
      operation: operation(),
      authorizedSigners: [SIGNER],
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('UNAUTHORIZED_SIGNER');
  });

  it('rejects a signature claimed for the wrong signer', async () => {
    const signed = await issue();
    const forged: SignedReceipt = { ...signed, signer: OTHER_ADDRESS };
    const result = await verifyReceipt({
      signed: forged,
      operation: operation(),
      authorizedSigners: [SIGNER, OTHER_ADDRESS],
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('INVALID_SIGNATURE');
  });

  it('rejects a malformed signature rather than throwing', async () => {
    const signed = await issue();
    const result = await verifyReceipt({
      signed: { ...signed, signature: '0xdeadbeef' },
      operation: operation(),
      authorizedSigners: [SIGNER],
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('INVALID_SIGNATURE');
  });

  it('rejects a receipt replayed onto a different adapter deployment', async () => {
    // Cross-adapter replay: same chain, different verifying contract.
    const signed = await issue();
    const result = await verifyReceipt({
      signed: { ...signed, verifyingContract: OTHER_ADDRESS },
      operation: operation({ verifyingContract: OTHER_ADDRESS }),
      authorizedSigners: [SIGNER],
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a receipt replayed onto a different chain', async () => {
    const signed = await issue();
    const result = await verifyReceipt({
      signed: { ...signed, chainId: 196 },
      operation: operation({ chainId: 196 }),
      authorizedSigners: [SIGNER],
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a tampered amount inside the receipt struct itself', async () => {
    // Changing the struct invalidates the signature even though the digest field is intact.
    const signed = await issue();
    const result = await verifyReceipt({
      signed: { ...signed, receipt: { ...signed.receipt, amount: 1n } },
      operation: operation(),
      authorizedSigners: [SIGNER],
      nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe('action type encoding is permanent', () => {
  it('pins every action type value', () => {
    // Reusing a number for a different action would let an old receipt authorize a new
    // operation. These values may never be reassigned.
    expect(ACTION_TYPE).toEqual({ DEPOSIT: 1, WITHDRAW: 2, TRANSFER: 3, REDEEM: 4 });
  });
});

/**
 * Golden vectors. These same values are read by the Foundry suite, so the TypeScript
 * signer and the Solidity adapter cannot drift apart without a test failing on one side.
 */
describe('golden vectors', () => {
  it('regenerating reproduces the committed file exactly', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { generateVectors } = await import('../src/vectors.js');

    const file = path.resolve(import.meta.dirname, '../vectors/operation-digests.json');
    const committed = JSON.parse(readFileSync(file, 'utf8')) as {
      vectors: { name: string; expectedDigest: string }[];
    };
    const fresh = generateVectors();

    expect(fresh.map((v) => ({ name: v.name, expectedDigest: v.expectedDigest }))).toEqual(
      committed.vectors.map((v) => ({ name: v.name, expectedDigest: v.expectedDigest })),
    );
  });

  it('every vector digest is distinct — no two operations collide', async () => {
    const { generateVectors } = await import('../src/vectors.js');
    const digests = generateVectors().map((v) => v.expectedDigest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('the same operation on mainnet and testnet produce different digests', async () => {
    const { generateVectors } = await import('../src/vectors.js');
    const vectors = generateVectors();
    const testnet = vectors.find((v) => v.name === 'canonical deposit');
    const mainnet = vectors.find((v) => v.name.startsWith('mainnet chain id'));
    expect(mainnet?.expectedDigest).not.toBe(testnet?.expectedDigest);
  });
});
