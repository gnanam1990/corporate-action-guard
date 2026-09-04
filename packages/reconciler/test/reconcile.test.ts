import {
  instant,
  millis,
  summarizeCanonicality,
  unsafe,
  type ApiObservation,
  type ChainObservation,
} from '@cag/domain';
import { describe, expect, it } from 'vitest';
import {
  canRecover,
  defaultPolicy,
  reasonSignature,
  reconcileAsset,
  type CanonicalityRecord,
  type ReconcileInput,
} from '../src/index.js';

const NOW = instant(1_788_000_000_000);
const TOKEN = unsafe.address('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a');
const WRAPPER = unsafe.address('0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f');

const api = (over: Partial<ApiObservation> = {}): ApiObservation => ({
  provenance: {
    sourceKind: 'XSTOCKS_API',
    sourceLocator: '/public/assets/AAPLx',
    observedAt: instant(NOW - 5_000),
  },
  symbol: unsafe.symbol('AAPLx'),
  tokenAddress: TOKEN,
  wrapperAddress: WRAPPER,
  multiplier: { value: 10_032_690_125_398_187n, decimals: 16 },
  ...over,
});

const chain = (over: Partial<ChainObservation> = {}): ChainObservation => ({
  provenance: {
    sourceKind: 'XLAYER_RPC',
    sourceLocator: 'rpc.xlayer.tech',
    observedAt: instant(NOW - 3_000),
  },
  chainId: unsafe.chainId(196),
  blockNumber: unsafe.blockNumber(69_686_711n),
  blockHash: unsafe.blockHash(`0x${'ab'.repeat(32)}`),
  tokenAddress: TOKEN,
  wrapperAddress: WRAPPER,
  tokenHasBytecode: true,
  wrapperHasBytecode: true,
  wrapperAsset: TOKEN,
  // 1003269012539818700 at 18dp is the same value as 1.0032690125398187 at 16dp.
  multiplier: { value: 1_003_269_012_539_818_700n, decimals: 18 },
  multiplierNonce: 5n,
  ...over,
});

const passingCanonicality = (): CanonicalityRecord => ({
  ...summarizeCanonicality([
    { name: 'TOKEN_MATCHES_REGISTRY', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_MATCHES_REGISTRY', outcome: 'PASS', detail: 'ok' },
    { name: 'TOKEN_HAS_BYTECODE', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_HAS_BYTECODE', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_ASSET_RELATION', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_VERSION_CURRENT', outcome: 'PASS', detail: 'ok' },
  ]),
  assetId: 'AAPLx',
  symbol: 'AAPLx',
  apiTokenAddress: TOKEN,
  apiCurrentWrapperAddress: WRAPPER,
  apiWrapperVersion: 2,
  observedWrapperAsset: TOKEN,
  chainId: 196,
  blockNumber: 69_686_711n,
  blockHash: `0x${'ab'.repeat(32)}`,
  apiSourceLocator: '/public/assets/AAPLx',
  chainProviderName: 'rpc.xlayer.tech',
  observedAtMs: NOW - 3_000,
});

const healthy = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  assetId: 'AAPLx',
  api: api(),
  chain: chain(),
  canonicality: passingCanonicality(),
  chainComplete: true,
  previousState: 'NORMAL',
  manualReviewOpen: false,
  appliedOnChain: false,
  ...over,
});

const policy = defaultPolicy();

describe('the healthy path', () => {
  it('MATCHES when both sources agree and canonicality passes', () => {
    const d = reconcileAsset(healthy(), policy, NOW);
    expect(d.outcome).toBe('MATCHED');
    expect(d.blockReasons).toEqual([]);
    expect(d.state).toBe('NORMAL');
  });

  it('matches across differing decimal scales', () => {
    // The API reports 1.0032690125398187 (16dp); the chain reports the same value at 18dp.
    // Comparing without rescaling would produce a permanent false mismatch.
    const d = reconcileAsset(healthy(), policy, NOW);
    expect(d.comparison?.agreement).toBe('MATCH');
  });

  it('stamps the policy version so a replay can report which rules produced it', () => {
    expect(reconcileAsset(healthy(), policy, NOW).policyVersion).toBe('1.0.0');
  });

  it('reports evidence ages', () => {
    const d = reconcileAsset(healthy(), policy, NOW);
    expect(d.apiEvidenceAgeMs).toBe(5_000);
    expect(d.chainEvidenceAgeMs).toBe(3_000);
  });
});

describe('"could not look" is not "they disagree"', () => {
  it('reports SOURCE_UNAVAILABLE when the API is missing', () => {
    const { api: _drop, ...rest } = healthy();
    const d = reconcileAsset(rest as ReconcileInput, policy, NOW);
    expect(d.outcome).toBe('SOURCE_UNAVAILABLE');
    expect(d.blockReasons).toContain('API_UNAVAILABLE');
    expect(d.blockReasons).not.toContain('SOURCE_MISMATCH');
  });

  it('reports SOURCE_UNAVAILABLE when the RPC is missing', () => {
    const { chain: _drop, ...rest } = healthy();
    const d = reconcileAsset(rest as ReconcileInput, policy, NOW);
    expect(d.outcome).toBe('SOURCE_UNAVAILABLE');
    expect(d.blockReasons).toContain('RPC_UNAVAILABLE');
  });

  it('reports INCOMPLETE_EVIDENCE for a partial chain read, not a mismatch', () => {
    // A partial read is an absence, and it is already reported as such.
    const d = reconcileAsset(healthy({ chainComplete: false }), policy, NOW);
    expect(d.outcome).toBe('INCOMPLETE_EVIDENCE');
    expect(d.blockReasons).not.toContain('SOURCE_MISMATCH');
  });
});

describe('disagreement', () => {
  it('MISMATCHES on a differing multiplier', () => {
    const d = reconcileAsset(
      healthy({
        chain: chain({ multiplier: { value: 2_000_000_000_000_000_000n, decimals: 18 } }),
      }),
      policy,
      NOW,
    );
    expect(d.outcome).toBe('MISMATCHED');
    expect(d.blockReasons).toContain('SOURCE_MISMATCH');
    expect(d.state).toBe('MISMATCH');
  });

  it('MISMATCHES when the API is ahead of the chain', () => {
    const d = reconcileAsset(
      healthy({ api: api({ scheduledActivation: instant(NOW + 3_600_000) }) }),
      policy,
      NOW,
    );
    expect(d.blockReasons).toContain('SOURCE_MISMATCH');
  });

  it('MISMATCHES when the chain is ahead of the API', () => {
    const d = reconcileAsset(
      healthy({ chain: chain({ scheduledActivation: instant(NOW + 3_600_000) }) }),
      policy,
      NOW,
    );
    expect(d.blockReasons).toContain('SOURCE_MISMATCH');
  });

  it('blocks on a wrapper-asset mismatch from canonicality', () => {
    const record = passingCanonicality();
    const broken: CanonicalityRecord = {
      ...record,
      ...summarizeCanonicality([
        { name: 'WRAPPER_ASSET_RELATION', outcome: 'FAIL', detail: 'points elsewhere' },
      ]),
    };
    const d = reconcileAsset(healthy({ canonicality: broken }), policy, NOW);
    expect(d.blockReasons).toContain('WRAPPER_ASSET_MISMATCH');
  });

  it('blocks when canonicality was never computed', () => {
    const { canonicality: _drop, ...rest } = healthy();
    const d = reconcileAsset(rest as ReconcileInput, policy, NOW);
    expect(d.blockReasons).toContain('NON_CANONICAL_TOKEN');
  });
});

describe('freshness', () => {
  it('blocks stale API evidence at the inclusive limit', () => {
    const d = reconcileAsset(
      healthy({
        api: api({
          provenance: {
            sourceKind: 'XSTOCKS_API',
            sourceLocator: '/x',
            observedAt: instant(NOW - 5 * 60_000),
          },
        }),
      }),
      policy,
      NOW,
    );
    expect(d.blockReasons).toContain('STALE_API_EVIDENCE');
  });

  it('accepts evidence one millisecond inside the limit', () => {
    const d = reconcileAsset(
      healthy({
        api: api({
          provenance: {
            sourceKind: 'XSTOCKS_API',
            sourceLocator: '/x',
            observedAt: instant(NOW - 5 * 60_000 + 1),
          },
        }),
      }),
      policy,
      NOW,
    );
    expect(d.blockReasons).not.toContain('STALE_API_EVIDENCE');
  });
});

describe('incident deduplication', () => {
  it('an identical repeated mismatch produces an identical signature', () => {
    const broken = healthy({ chain: chain({ multiplier: { value: 5n, decimals: 0 } }) });
    const a = reconcileAsset(broken, policy, NOW);
    const b = reconcileAsset(broken, policy, instant(NOW + 60_000));
    expect(b.reasonSignature).toBe(a.reasonSignature);
    expect(a.reasonSignature).not.toBe('');
  });

  it('a different failure produces a different signature', () => {
    const a = reconcileAsset(
      healthy({ chain: chain({ multiplier: { value: 5n, decimals: 0 } }) }),
      policy,
      NOW,
    );
    const b = reconcileAsset(healthy({ manualReviewOpen: true }), policy, NOW);
    expect(b.reasonSignature).not.toBe(a.reasonSignature);
  });

  it('the signature is independent of the order reasons were discovered', () => {
    expect(reasonSignature(['RECEIPT_EXPIRED', 'SOURCE_MISMATCH'])).toBe(
      reasonSignature(['SOURCE_MISMATCH', 'RECEIPT_EXPIRED']),
    );
  });
});

describe('recovery cannot be asserted by an operator', () => {
  it('refuses recovery while the sources still disagree', () => {
    // An operator records a decision; they do not assert that two sources concur.
    const d = reconcileAsset(
      healthy({ chain: chain({ multiplier: { value: 5n, decimals: 0 } }) }),
      policy,
      NOW,
    );
    expect(canRecover(d)).toBe(false);
  });

  it('refuses recovery while evidence is merely unavailable', () => {
    const { api: _drop, ...rest } = healthy();
    expect(canRecover(reconcileAsset(rest as ReconcileInput, policy, NOW))).toBe(false);
  });

  it('permits recovery only when a complete observation agrees', () => {
    expect(canRecover(reconcileAsset(healthy(), policy, NOW))).toBe(true);
  });

  it('an open review keeps the asset in MANUAL_REVIEW and blocks', () => {
    const d = reconcileAsset(healthy({ manualReviewOpen: true }), policy, NOW);
    expect(d.state).toBe('MANUAL_REVIEW');
    expect(d.blockReasons).toContain('MANUAL_REVIEW_REQUIRED');
    expect(canRecover(d)).toBe(false);
  });

  it('records RECOVERED only after a resolved review is followed by a complete match', () => {
    const d = reconcileAsset(healthy({ previousState: 'MANUAL_REVIEW' }), policy, NOW);
    expect(d.outcome).toBe('MATCHED');
    expect(d.state).toBe('RECOVERED');
  });

  it('moves RECOVERED to RECONCILED on the next complete match', () => {
    const d = reconcileAsset(healthy({ previousState: 'RECOVERED' }), policy, NOW);
    expect(d.state).toBe('RECONCILED');
  });
});

describe('guard window', () => {
  it('enters GUARD_WINDOW from a chain-reported activation', () => {
    const d = reconcileAsset(
      healthy({
        api: api({ scheduledActivation: instant(NOW + 60_000) }),
        chain: chain({ scheduledActivation: instant(NOW + 60_000) }),
      }),
      policy,
      NOW,
    );
    expect(d.state).toBe('GUARD_WINDOW');
  });

  it('is PENDING before the window opens', () => {
    const activation = instant(NOW + 60 * 60_000);
    const d = reconcileAsset(
      healthy({
        api: api({ scheduledActivation: activation }),
        chain: chain({ scheduledActivation: activation }),
      }),
      policy,
      NOW,
    );
    expect(d.state).toBe('PENDING');
  });

  it('records APPLIED when a previously scheduled activation disappears on chain', () => {
    const d = reconcileAsset(
      healthy({ previousState: 'GUARD_WINDOW', appliedOnChain: true }),
      policy,
      NOW,
    );
    expect(d.state).toBe('APPLIED');
  });

  it('moves APPLIED to RECONCILED on the next complete match', () => {
    const d = reconcileAsset(healthy({ previousState: 'APPLIED' }), policy, NOW);
    expect(d.state).toBe('RECONCILED');
  });
});

describe('determinism', () => {
  it('the same inputs and the same now produce byte-identical decisions', () => {
    const input = healthy();
    const a = reconcileAsset(input, policy, NOW);
    const b = reconcileAsset(input, policy, NOW);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('nothing is read from a clock — a different now is the only thing that changes', () => {
    const input = healthy();
    const a = reconcileAsset(input, policy, NOW);
    const b = reconcileAsset(input, policy, instant(NOW + 1_000));
    expect(b.evaluatedAtMs).toBe(a.evaluatedAtMs + 1_000);
    expect(b.apiEvidenceAgeMs).toBe((a.apiEvidenceAgeMs ?? 0) + 1_000);
    expect(b.outcome).toBe(a.outcome);
  });

  it('a custom policy changes the outcome deterministically', () => {
    const strict = defaultPolicy({ apiMaxAge: millis(1_000), policyVersion: '2.0.0-strict' });
    const d = reconcileAsset(healthy(), strict, NOW);
    expect(d.blockReasons).toContain('STALE_API_EVIDENCE');
    expect(d.policyVersion).toBe('2.0.0-strict');
  });
});
