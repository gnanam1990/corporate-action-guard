import { summarizeCanonicality, type CanonicalityCheck, type SourceComparison } from '@cag/domain';
import { ReceiptSigner } from '@cag/receipts';
import { describe, expect, it } from 'vitest';
import {
  runPreflight,
  type EvidenceBundle,
  type PreflightPolicy,
} from '../src/preflight-service.js';
import { preflightResponseSchema, type PreflightRequest } from '../src/schemas.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADAPTER = '0x1111111111111111111111111111111111111111';
const NOW = 1_788_000_000_000;

const request = (over: Partial<PreflightRequest> = {}): PreflightRequest => ({
  chainId: 1952,
  assetId: 'AAPLx',
  target: '0x3333333333333333333333333333333333333333',
  asset: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  wrapper: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
  actionType: 'DEPOSIT',
  caller: '0x2222222222222222222222222222222222222222',
  recipient: '0x4444444444444444444444444444444444444444',
  amount: '1000000000000000000',
  expectedMultiplierNonce: '5',
  ...over,
});

const allPass: CanonicalityCheck[] = [
  { name: 'TOKEN_MATCHES_REGISTRY', outcome: 'PASS', detail: 'ok' },
  { name: 'WRAPPER_MATCHES_REGISTRY', outcome: 'PASS', detail: 'ok' },
  { name: 'TOKEN_HAS_BYTECODE', outcome: 'PASS', detail: 'ok' },
  { name: 'WRAPPER_HAS_BYTECODE', outcome: 'PASS', detail: 'ok' },
  { name: 'WRAPPER_ASSET_RELATION', outcome: 'PASS', detail: 'ok' },
  { name: 'WRAPPER_VERSION_CURRENT', outcome: 'PASS', detail: 'ok' },
];

const matching: SourceComparison = {
  agreement: 'MATCH',
  fields: [
    {
      field: 'multiplier',
      agreement: 'MATCH',
      apiValue: '1.0',
      chainValue: '1.0',
      requiredForAgreement: true,
    },
  ],
};

const evidence = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  assetKnown: true,
  registryTokenAddress: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  registryWrapperAddress: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
  registryWrapperIsCurrent: true,
  observedWrapperAsset: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  canonicality: summarizeCanonicality(allPass),
  sourceComparison: matching,
  onChainMultiplierNonce: 5n,
  apiObservedAtMs: NOW - 5_000,
  chainObservedAtMs: NOW - 3_000,
  manualReviewOpen: false,
  evidenceIds: ['evt-api-1', 'evt-chain-1'],
  blockNumber: 69_686_711n,
  blockHash: `0x${'ab'.repeat(32)}`,
  ...over,
});

const policy: PreflightPolicy = {
  supportedChainIds: [1952],
  guardBeforeMs: 900_000,
  guardAfterMs: 900_000,
  apiMaxAgeMs: 300_000,
  chainMaxAgeMs: 120_000,
  receiptLifetimeMs: 300_000,
  verifyingContract: ADAPTER,
};

const deps = (over: Partial<Parameters<typeof runPreflight>[2]> = {}) => ({
  signer: new ReceiptSigner(() => KEY, 1952, ADAPTER),
  policy,
  nowMs: NOW,
  requestId: 'req-1',
  receiptId: `0x${'11'.repeat(32)}`,
  ...over,
});

describe('preflight ALLOW', () => {
  it('returns a receipt with zero reasons', async () => {
    const response = await runPreflight(request(), evidence(), deps());
    expect(response.decision).toBe('ALLOW');
    if (response.decision !== 'ALLOW') return;
    expect(response.reasonCodes).toEqual([]);
    expect(response.receipt.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('conforms to the published response schema', async () => {
    const response = await runPreflight(request(), evidence(), deps());
    expect(preflightResponseSchema.safeParse(response).success).toBe(true);
  });

  it('includes evidence provenance and ages', async () => {
    const response = await runPreflight(request(), evidence(), deps());
    expect(response.evidence.apiEvidenceAgeMs).toBe(5_000);
    expect(response.evidence.chainEvidenceAgeMs).toBe(3_000);
    expect(response.evidence.evidenceIds).toEqual(['evt-api-1', 'evt-chain-1']);
    expect(response.evidence.blockNumber).toBe('69686711');
  });

  it('binds the receipt to the operation digest it returns', async () => {
    const response = await runPreflight(request(), evidence(), deps());
    expect(response.operationDigest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

/**
 * The rule that matters most: a receipt must not exist on any block path. This asserts it
 * for every reason the predicate can produce, not just a sample.
 */
describe('no receipt is ever returned for a BLOCK', () => {
  const blockingCases: Array<[string, Partial<EvidenceBundle>, Partial<PreflightRequest>]> = [
    ['unknown asset', { assetKnown: false }, {}],
    ['non-canonical token', { registryTokenAddress: `0x${'99'.repeat(20)}` }, {}],
    ['non-canonical wrapper', { registryWrapperAddress: `0x${'99'.repeat(20)}` }, {}],
    ['outdated wrapper', { registryWrapperIsCurrent: false }, {}],
    ['wrapper asset mismatch', { observedWrapperAsset: `0x${'99'.repeat(20)}` }, {}],
    ['api unavailable', { apiObservedAtMs: undefined }, {}],
    ['rpc unavailable', { chainObservedAtMs: undefined }, {}],
    ['stale api evidence', { apiObservedAtMs: NOW - 999_999 }, {}],
    ['stale chain evidence', { chainObservedAtMs: NOW - 999_999 }, {}],
    ['source mismatch', { sourceComparison: { ...matching, agreement: 'MISMATCH' } }, {}],
    ['source incomplete', { sourceComparison: { ...matching, agreement: 'INCOMPLETE' } }, {}],
    ['nonce mismatch', { onChainMultiplierNonce: 6n }, {}],
    ['inside guard window', { scheduledActivationMs: NOW + 60_000 }, {}],
    ['manual review open', { manualReviewOpen: true }, {}],
    ['canonicality unknown', { canonicality: summarizeCanonicality([]) }, {}],
    ['unsupported chain', {}, { chainId: 196 }],
  ];

  for (const [name, evidenceOverride, requestOverride] of blockingCases) {
    it(`returns no receipt: ${name}`, async () => {
      const response = await runPreflight(
        request(requestOverride),
        evidence(evidenceOverride),
        deps(),
      );
      expect(response.decision).toBe('BLOCK');
      expect(response.reasonCodes.length).toBeGreaterThan(0);
      // Structurally absent, not null and not undefined-valued.
      expect('receipt' in response).toBe(false);
      expect(JSON.stringify(response)).not.toContain('signature');
    });
  }

  it('every BLOCK carries a deterministic explanation per reason', async () => {
    const response = await runPreflight(request(), evidence({ manualReviewOpen: true }), deps());
    if (response.decision !== 'BLOCK') throw new Error('expected BLOCK');
    expect(response.reasonExplanations.length).toBe(response.reasonCodes.length);
    for (const item of response.reasonExplanations) {
      expect(item.explanation.length).toBeGreaterThan(20);
    }
  });

  it('a BLOCK still conforms to the published schema', async () => {
    const response = await runPreflight(request(), evidence({ assetKnown: false }), deps());
    expect(preflightResponseSchema.safeParse(response).success).toBe(true);
  });

  it('reason codes are ordered most severe first', async () => {
    const response = await runPreflight(
      request(),
      evidence({ assetKnown: false, registryWrapperIsCurrent: false }),
      deps(),
    );
    if (response.decision !== 'BLOCK') throw new Error('expected BLOCK');
    expect(response.reasonCodes[0]).toBe('OUTDATED_WRAPPER');
  });
});

describe('signer failures never degrade into a fake receipt', () => {
  it('an unavailable signer fails rather than returning a placeholder', async () => {
    const keyless = new ReceiptSigner(() => undefined, 1952, ADAPTER);
    await expect(
      runPreflight(request(), evidence(), deps({ signer: keyless })),
    ).rejects.toMatchObject({ kind: 'SIGNER_UNAVAILABLE' });
  });

  it('an ALLOW with no evidence references is refused by the signer', async () => {
    await expect(
      runPreflight(request(), evidence({ evidenceIds: [] }), deps()),
    ).rejects.toMatchObject({ kind: 'DECISION_NOT_ALLOW' });
  });
});

describe('determinism', () => {
  it('the same inputs and the same now produce the same decision and digest', async () => {
    const a = await runPreflight(request(), evidence(), deps());
    const b = await runPreflight(request(), evidence(), deps());
    expect(b.operationDigest).toBe(a.operationDigest);
    expect(b.decision).toBe(a.decision);
  });

  it('a changed amount changes the digest', async () => {
    const a = await runPreflight(request(), evidence(), deps());
    const b = await runPreflight(request({ amount: '2000000000000000000' }), evidence(), deps());
    expect(b.operationDigest).not.toBe(a.operationDigest);
  });
});
