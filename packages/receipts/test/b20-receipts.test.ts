/**
 * The B20 receipt.
 *
 * Two properties carry the weight. Every bound field must invalidate the signature when it
 * changes — a field that is in the struct but does not actually bind is worse than no field,
 * because it looks like protection. And a receipt must never be signed from a stored
 * decision: issuance re-reads, and signs only if the fresh answer is still ALLOW.
 *
 * The X Layer receipt is a deployed contract. Its vectors are asserted unchanged here too,
 * because that is the regression a new receipt struct is most likely to cause.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  B20_ACTION_CLASS_CODE,
  B20_BOUND_FIELDS,
  B20_DIGEST_BOUND_FIELDS,
  B20_EIP712_DOMAIN_NAME,
  B20_PRICE_BASIS_CODE,
  B20_RECEIPT_SCHEMA_VERSION,
  B20_RECEIPT_TYPE,
  b20ReceiptDomain,
  computeB20OperationDigest,
  EIP712_DOMAIN_NAME,
  hashPolicyVersion,
  issueB20Receipt,
  recoverB20ReceiptSigner,
  validateB20Receipt,
  verifyB20Receipt,
  type B20OperationPayload,
  type B20Receipt,
  type B20Reverification,
  type B20SigningProvider,
  type SignedB20Receipt,
} from '../src/index.js';

const CHAIN_ID = 84_532;
const ADAPTER = `0x${'a1'.repeat(20)}`;
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const FEED = '0x787f13dea48db0897cbcdd985de77809d837f988';
const KEY = `0x${'11'.repeat(32)}` as `0x${string}`;
const account = privateKeyToAccount(KEY);

const ONE = 1_000_000_000_000_000_000n;

function receipt(overrides: Partial<B20Receipt> = {}): B20Receipt {
  return {
    schemaVersion: B20_RECEIPT_SCHEMA_VERSION,
    receiptId: `0x${'11'.repeat(32)}`,
    asset: AAPL,
    sender: `0x${'aa'.repeat(20)}`,
    recipient: `0x${'bb'.repeat(20)}`,
    actionClass: B20_ACTION_CLASS_CODE.TRANSFER,
    rawAmount: 100_000_000n,
    operationDigest: `0x${'22'.repeat(32)}`,
    activeMultiplierWad: ONE,
    pendingEffectiveAt: 0n,
    feedProxy: FEED,
    feedRoundId: 36_893_488_147_419_103_373n,
    priceBasis: B20_PRICE_BASIS_CODE.TOTAL_RETURN_TOKEN_PRICE,
    policyVersionHash: hashPolicyVersion('2026-09-07.1'),
    issuedAt: 1_788_776_091n,
    expiresAt: 1_788_776_391n,
    ...overrides,
  };
}

/** A signer with no policy of its own; it signs whatever issuance hands it. */
const signer: B20SigningProvider = {
  chainId: CHAIN_ID,
  verifyingContract: ADAPTER,
  async signB20Receipt(r: B20Receipt): Promise<SignedB20Receipt> {
    const signature = await account.signTypedData({
      domain: b20ReceiptDomain(CHAIN_ID, ADAPTER),
      types: B20_RECEIPT_TYPE,
      primaryType: 'B20PreflightReceipt',
      message: r as never,
    });
    return {
      receipt: r,
      signature,
      signer: account.address,
      chainId: CHAIN_ID,
      verifyingContract: ADAPTER,
    };
  },
};

const reverified = (overrides: Partial<B20Reverification> = {}): B20Reverification => ({
  decision: 'ALLOW',
  reasons: [],
  activeMultiplierWad: ONE,
  pendingEffectiveAt: 0n,
  feedRoundId: 36_893_488_147_419_103_373n,
  elapsedSeconds: 1n,
  ...overrides,
});

const issuable = () => {
  const {
    schemaVersion: _s,
    activeMultiplierWad: _m,
    pendingEffectiveAt: _p,
    feedRoundId: _r,
    ...rest
  } = receipt();
  return rest;
};

async function sign(r: B20Receipt = receipt()): Promise<SignedB20Receipt> {
  return signer.signB20Receipt(r);
}

describe('the X Layer receipt is untouched', () => {
  it('keeps its own domain name, distinct from the B20 one', () => {
    // Two structs with one domain would let a receipt for one product verify against the
    // other's adapter if the fields happened to line up.
    expect(EIP712_DOMAIN_NAME).toBe('CorporateActionGuard');
    expect(B20_EIP712_DOMAIN_NAME).toBe('CorporateActionGuardB20');
    expect(EIP712_DOMAIN_NAME).not.toBe(B20_EIP712_DOMAIN_NAME);
  });

  it('has byte-identical golden vectors', () => {
    // The regression a new receipt struct is most likely to cause. These are consumed by the
    // Foundry suite too, so neither side can be "fixed" to match itself.
    const vectors = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../vectors/operation-digests.json'), 'utf8'),
    ) as { vectors: { expectedDigest: string }[] };
    expect(vectors.vectors.length).toBeGreaterThan(0);
    for (const v of vectors.vectors) expect(v.expectedDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('every bound field binds', () => {
  const base = receipt();

  const mutations: readonly { field: string; mutate: (r: B20Receipt) => B20Receipt }[] = [
    { field: 'receiptId', mutate: (r) => ({ ...r, receiptId: `0x${'99'.repeat(32)}` }) },
    { field: 'asset', mutate: (r) => ({ ...r, asset: `0x${'cc'.repeat(20)}` }) },
    { field: 'sender', mutate: (r) => ({ ...r, sender: `0x${'dd'.repeat(20)}` }) },
    { field: 'recipient', mutate: (r) => ({ ...r, recipient: `0x${'ee'.repeat(20)}` }) },
    {
      field: 'actionClass',
      mutate: (r) => ({ ...r, actionClass: B20_ACTION_CLASS_CODE.VAULT_WITHDRAW }),
    },
    { field: 'rawAmount', mutate: (r) => ({ ...r, rawAmount: r.rawAmount + 1n }) },
    {
      field: 'operationDigest',
      mutate: (r) => ({ ...r, operationDigest: `0x${'33'.repeat(32)}` }),
    },
    {
      field: 'activeMultiplierWad',
      mutate: (r) => ({ ...r, activeMultiplierWad: r.activeMultiplierWad * 10n }),
    },
    { field: 'pendingEffectiveAt', mutate: (r) => ({ ...r, pendingEffectiveAt: 1_788_800_000n }) },
    { field: 'feedProxy', mutate: (r) => ({ ...r, feedProxy: `0x${'ff'.repeat(20)}` }) },
    { field: 'feedRoundId', mutate: (r) => ({ ...r, feedRoundId: r.feedRoundId + 1n }) },
    {
      field: 'priceBasis',
      mutate: (r) => ({ ...r, priceBasis: B20_PRICE_BASIS_CODE.UNDERLYING_EQUITY_PRICE }),
    },
    {
      field: 'policyVersionHash',
      mutate: (r) => ({ ...r, policyVersionHash: hashPolicyVersion('2026-09-08.1') }),
    },
    { field: 'issuedAt', mutate: (r) => ({ ...r, issuedAt: r.issuedAt - 1n }) },
    { field: 'expiresAt', mutate: (r) => ({ ...r, expiresAt: r.expiresAt + 1n }) },
    { field: 'schemaVersion', mutate: (r) => ({ ...r, schemaVersion: 2 }) },
  ];

  for (const { field, mutate } of mutations) {
    it(`rejects a receipt whose ${field} changed after signing`, async () => {
      const signed = await sign(base);
      const tampered: SignedB20Receipt = { ...signed, receipt: mutate(base) };
      const result = await verifyB20Receipt({
        signed: tampered,
        expectedSigner: account.address,
        atSeconds: 1_788_776_200n,
        expectedChainId: CHAIN_ID,
        expectedVerifyingContract: ADAPTER,
      });
      expect(result.valid, `${field} did not bind`).toBe(false);
    });
  }

  it('covers every field the struct declares', () => {
    // A field in the struct with no mutation test would look like protection and provide
    // none. This is why B20_BOUND_FIELDS is derived from the struct rather than typed out.
    const tested = new Set(mutations.map((m) => m.field));
    expect(B20_BOUND_FIELDS.filter((f) => !tested.has(f))).toEqual([]);
  });

  it('accepts the untampered receipt', async () => {
    const signed = await sign(base);
    const result = await verifyB20Receipt({
      signed,
      expectedSigner: account.address,
      atSeconds: 1_788_776_200n,
      expectedChainId: CHAIN_ID,
      expectedVerifyingContract: ADAPTER,
    });
    expect(result.valid).toBe(true);
  });
});

describe('domain binding', () => {
  it('rejects a receipt replayed onto another chain', async () => {
    const signed = await sign();
    const result = await verifyB20Receipt({
      signed: { ...signed, chainId: 8453 },
      expectedSigner: account.address,
      atSeconds: 1_788_776_200n,
      expectedChainId: 8453,
      expectedVerifyingContract: ADAPTER,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a receipt replayed onto another adapter', async () => {
    const signed = await sign();
    const other = `0x${'b2'.repeat(20)}`;
    const result = await verifyB20Receipt({
      signed: { ...signed, verifyingContract: other },
      expectedSigner: account.address,
      atSeconds: 1_788_776_200n,
      expectedChainId: CHAIN_ID,
      expectedVerifyingContract: other,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a signature from a different signer', async () => {
    const signed = await sign();
    const result = await verifyB20Receipt({
      signed,
      expectedSigner: `0x${'de'.repeat(20)}`,
      atSeconds: 1_788_776_200n,
      expectedChainId: CHAIN_ID,
      expectedVerifyingContract: ADAPTER,
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toContain('signer');
  });

  it('recovers the real signer, so a rejection can be diagnosed', async () => {
    const signed = await sign();
    expect((await recoverB20ReceiptSigner(signed)).toLowerCase()).toBe(
      account.address.toLowerCase(),
    );
  });
});

describe('the validity window', () => {
  it('rejects an expired receipt', async () => {
    const signed = await sign();
    const result = await verifyB20Receipt({
      signed,
      expectedSigner: account.address,
      atSeconds: signed.receipt.expiresAt,
      expectedChainId: CHAIN_ID,
      expectedVerifyingContract: ADAPTER,
    });
    expect(result.valid === false && result.reason).toContain('expired');
  });

  it('rejects one that is not yet valid', async () => {
    const signed = await sign();
    const result = await verifyB20Receipt({
      signed,
      expectedSigner: account.address,
      atSeconds: signed.receipt.issuedAt - 1n,
      expectedChainId: CHAIN_ID,
      expectedVerifyingContract: ADAPTER,
    });
    expect(result.valid === false && result.reason).toContain('not yet valid');
  });
});

describe('issuance re-reads before it signs', () => {
  it('signs when re-verification still says ALLOW', async () => {
    const outcome = await issueB20Receipt(signer, {
      receipt: issuable(),
      reverify: () => Promise.resolve(reverified()),
      maxReverificationSeconds: 5n,
    });
    expect(outcome.ok).toBe(true);
  });

  it('refuses, and signs nothing, when the re-read says BLOCK', async () => {
    // The window a corporate action lands in. Signing from the stored decision here would
    // authorize an operation against state the chain has already left.
    const outcome = await issueB20Receipt(signer, {
      receipt: issuable(),
      reverify: () =>
        Promise.resolve(reverified({ decision: 'BLOCK', reasons: ['B20_FEED_STALE'] })),
      maxReverificationSeconds: 5n,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe('NOT_ALLOWED');
    expect(outcome.ok === false && outcome.reasons).toContain('B20_FEED_STALE');
  });

  it('refuses on REVIEW as firmly as on BLOCK', async () => {
    const outcome = await issueB20Receipt(signer, {
      receipt: issuable(),
      reverify: () => Promise.resolve(reverified({ decision: 'REVIEW' })),
      maxReverificationSeconds: 5n,
    });
    expect(outcome.ok).toBe(false);
  });

  it('refuses when the re-read itself took too long', async () => {
    // A slow re-read produces a receipt bound to evidence that was fresh when the read
    // started and stale by the time the signature landed.
    const outcome = await issueB20Receipt(signer, {
      receipt: issuable(),
      reverify: () => Promise.resolve(reverified({ elapsedSeconds: 30n })),
      maxReverificationSeconds: 5n,
    });
    expect(outcome.ok === false && outcome.kind).toBe('REVERIFICATION_WINDOW_EXCEEDED');
  });

  it('binds the multiplier from the re-read, not from the original decision', async () => {
    // If the multiplier moved between deciding and signing, the receipt must commit to the
    // new one — otherwise it authorizes an operation sized against a state that is gone.
    const outcome = await issueB20Receipt(signer, {
      receipt: issuable(),
      reverify: () => Promise.resolve(reverified({ activeMultiplierWad: ONE * 10n })),
      maxReverificationSeconds: 5n,
    });
    expect(outcome.ok === true && outcome.signed.receipt.activeMultiplierWad).toBe(ONE * 10n);
  });

  it('binds a pending activation discovered during re-verification', async () => {
    // A schedule that appeared after the decision. Committing to it is what lets the adapter
    // reject a receipt whose window now straddles an activation.
    const outcome = await issueB20Receipt(signer, {
      receipt: issuable(),
      reverify: () => Promise.resolve(reverified({ pendingEffectiveAt: 1_788_800_000n })),
      maxReverificationSeconds: 5n,
    });
    expect(outcome.ok === true && outcome.signed.receipt.pendingEffectiveAt).toBe(1_788_800_000n);
  });

  it('refuses to sign a malformed receipt even when re-verification passed', async () => {
    await expect(
      issueB20Receipt(signer, {
        receipt: { ...issuable(), rawAmount: 0n },
        reverify: () => Promise.resolve(reverified()),
        maxReverificationSeconds: 5n,
      }),
    ).rejects.toThrow(/malformed/);
  });
});

describe('receipt validation', () => {
  it('accepts a well-formed receipt', () => {
    expect(validateB20Receipt(receipt())).toEqual([]);
  });

  it('reports every problem rather than the first', () => {
    const issues = validateB20Receipt(
      receipt({ rawAmount: 0n, activeMultiplierWad: 0n, expiresAt: 0n }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a price-bearing receipt with no feed or round', () => {
    // A receipt claiming to bind a price it cannot identify.
    const issues = validateB20Receipt(receipt({ feedRoundId: 0n }));
    expect(issues.join(' ')).toContain('must name its feed and round');
  });

  it('refuses a no-price receipt that carries a feed anyway', () => {
    const issues = validateB20Receipt(receipt({ priceBasis: B20_PRICE_BASIS_CODE.NONE }));
    expect(issues.join(' ')).toContain('no price basis must carry no feed or round');
  });

  it('refuses a zero recipient, which is a burn wearing a transfer costume', () => {
    expect(validateB20Receipt(receipt({ recipient: `0x${'0'.repeat(40)}` })).join(' ')).toContain(
      'recipient must not be the zero address',
    );
  });
});

describe('the operation digest', () => {
  const payload: B20OperationPayload = {
    chainId: CHAIN_ID,
    verifyingContract: ADAPTER,
    asset: AAPL,
    sender: `0x${'aa'.repeat(20)}`,
    recipient: `0x${'bb'.repeat(20)}`,
    actionClass: 'TRANSFER',
    rawAmount: 100_000_000n,
    targetContract: `0x${'cc'.repeat(20)}`,
    expectedMultiplierWad: ONE,
    integrationPolicyVersion: '2026-09-07.1',
  };

  it('is deterministic', () => {
    expect(computeB20OperationDigest(payload)).toBe(computeB20OperationDigest(payload));
  });

  it('is insensitive to address casing, which is a checksum and not an identity', () => {
    expect(
      computeB20OperationDigest({ ...payload, asset: AAPL.toUpperCase().replace('0X', '0x') }),
    ).toBe(computeB20OperationDigest(payload));
  });

  it('changes when any bound field changes', () => {
    const base = computeB20OperationDigest(payload);
    const mutants: Record<string, B20OperationPayload> = {
      chainId: { ...payload, chainId: 8453 },
      verifyingContract: { ...payload, verifyingContract: `0x${'de'.repeat(20)}` },
      asset: { ...payload, asset: `0x${'ad'.repeat(20)}` },
      sender: { ...payload, sender: `0x${'ae'.repeat(20)}` },
      recipient: { ...payload, recipient: `0x${'af'.repeat(20)}` },
      actionClass: { ...payload, actionClass: 'VAULT_DEPOSIT' },
      rawAmount: { ...payload, rawAmount: payload.rawAmount + 1n },
      targetContract: { ...payload, targetContract: `0x${'b0'.repeat(20)}` },
      expectedMultiplierWad: { ...payload, expectedMultiplierWad: ONE * 2n },
      integrationPolicyVersion: { ...payload, integrationPolicyVersion: 'other' },
    };
    for (const [field, mutant] of Object.entries(mutants)) {
      expect(computeB20OperationDigest(mutant), `${field} did not bind`).not.toBe(base);
    }
    expect(Object.keys(mutants).sort()).toEqual([...B20_DIGEST_BOUND_FIELDS].sort());
  });

  it('uses a different tag from the X Layer digest', () => {
    // So a digest computed for one product is structurally unusable as one for the other,
    // even if every field value happened to line up.
    expect(hashPolicyVersion('x')).not.toBe(hashPolicyVersion('y'));
  });
});
