import type { ChainSnapshot } from '@cag/xlayer-reader';
import type { XStocksAsset, XStocksDeployment } from '@cag/xstocks-client';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffRegistry, toRegistryEntry, verifyCanonicality } from '../src/index.js';

const TOKEN = '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a';
const WRAPPER = '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f';
const OTHER = `0x${'ee'.repeat(20)}`;

const deployment = (over: Partial<XStocksDeployment> = {}): XStocksDeployment =>
  ({
    address: TOKEN,
    network: 'XLayer',
    wrapperAddressV2: WRAPPER,
    ...over,
  }) as XStocksDeployment;

const asset = (over: Partial<XStocksAsset> = {}): XStocksAsset =>
  ({
    id: 'aaplx-id',
    name: 'Apple xStock',
    symbol: 'AAPLx',
    deployments: [deployment()],
    ...over,
  }) as XStocksAsset;

const snapshot = (over: Partial<ChainSnapshot> = {}): ChainSnapshot => ({
  chainId: 196,
  providerName: 'rpc.xlayer.tech',
  observedAtMs: 1_788_000_000_000,
  blockNumber: 69_686_711n,
  blockHash: `0x${'ab'.repeat(32)}`,
  blockTimestampMs: 1_788_000_000_000,
  tokenAddress: TOKEN,
  wrapperAddress: WRAPPER,
  tokenHasBytecode: true,
  wrapperHasBytecode: true,
  wrapperAsset: TOKEN,
  currentMultiplier: 1_003_269_012_539_818_700n,
  newMultiplier: 1_003_269_012_539_818_700n,
  multiplierNonce: 5n,
  scheduledActivationMs: undefined,
  tokenDecimals: 18,
  failedReads: [],
  complete: true,
  confirmationDepth: 32,
  settled: true,
  ...over,
});

const outcomeOf = (record: ReturnType<typeof verifyCanonicality>, name: string) =>
  record.checks.find((c) => c.name === name)?.outcome;

describe('canonicality matrix', () => {
  it('PASSes when the registry and the chain agree on everything', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot(),
    });
    expect(record.outcome).toBe('PASS');
    expect(record.checks).toHaveLength(6);
    expect(record.checks.every((c) => c.outcome === 'PASS')).toBe(true);
  });

  it('gives every check an explanation, never a bare boolean', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot(),
    });
    for (const c of record.checks) {
      expect(c.detail.length).toBeGreaterThan(10);
    }
  });

  it('records the block the chain evidence came from', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot(),
    });
    expect(record.blockNumber).toBe(69_686_711n);
    expect(record.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(record.chainProviderName).toBe('rpc.xlayer.tech');
  });

  it('FAILs when the wrapper points at another asset — the hard block', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot({ wrapperAsset: OTHER }),
    });
    expect(outcomeOf(record, 'WRAPPER_ASSET_RELATION')).toBe('FAIL');
    expect(record.outcome).toBe('FAIL');
  });

  it('is UNKNOWN — not PASS — when wrapper.asset() could not be read', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot({
        wrapperAsset: undefined,
        failedReads: ['wrapper.asset()'],
        complete: false,
      }),
    });
    expect(outcomeOf(record, 'WRAPPER_ASSET_RELATION')).toBe('UNKNOWN');
    expect(record.outcome).not.toBe('PASS');
  });

  it('FAILs when the token holds no bytecode', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot({ tokenHasBytecode: false }),
    });
    expect(outcomeOf(record, 'TOKEN_HAS_BYTECODE')).toBe('FAIL');
    expect(record.outcome).toBe('FAIL');
  });

  it('is UNKNOWN when eth_getCode itself failed — undetermined is not absent', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot({
        tokenHasBytecode: false,
        failedReads: ['eth_getCode(token)'],
        complete: false,
      }),
    });
    expect(outcomeOf(record, 'TOKEN_HAS_BYTECODE')).toBe('UNKNOWN');
  });

  it('is UNKNOWN when the registry declares no current wrapper', () => {
    // An absent declaration is not permission to accept the caller's address.
    const d = deployment({ wrapperAddressV2: undefined });
    const record = verifyCanonicality({
      asset: asset({ deployments: [d] }),
      deployment: d,
      snapshot: snapshot(),
    });
    expect(outcomeOf(record, 'WRAPPER_MATCHES_REGISTRY')).toBe('UNKNOWN');
    expect(outcomeOf(record, 'WRAPPER_VERSION_CURRENT')).toBe('UNKNOWN');
    expect(record.outcome).not.toBe('PASS');
  });

  it('FAILs an old wrapper that still holds bytecode', () => {
    // A legacy wrapper with live code is still a legacy wrapper.
    const legacy = `0x${'11'.repeat(20)}`;
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot({ wrapperAddress: legacy, wrapperHasBytecode: true, wrapperAsset: TOKEN }),
    });
    expect(outcomeOf(record, 'WRAPPER_HAS_BYTECODE')).toBe('PASS');
    expect(outcomeOf(record, 'WRAPPER_VERSION_CURRENT')).toBe('FAIL');
    expect(record.outcome).toBe('FAIL');
  });

  it('FAILs when the chain was read at a different token than the registry declares', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment(),
      snapshot: snapshot({ tokenAddress: OTHER }),
    });
    expect(outcomeOf(record, 'TOKEN_MATCHES_REGISTRY')).toBe('FAIL');
  });

  it('checksum casing never manufactures a mismatch', () => {
    const record = verifyCanonicality({
      asset: asset(),
      deployment: deployment({ address: '0x9D275685Dc284c8Eb1c79F6ABa7A63dc75Ec890A' }),
      snapshot: snapshot(),
    });
    expect(record.outcome).toBe('PASS');
  });

  it('property: no UNKNOWN check can ever produce a canonical PASS', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (dropWrapperAsset, dropCode, dropRegistryWrapper, badRelation) => {
          const d = deployment(dropRegistryWrapper ? { wrapperAddressV2: undefined } : {});
          const record = verifyCanonicality({
            asset: asset({ deployments: [d] }),
            deployment: d,
            snapshot: snapshot({
              ...(dropWrapperAsset
                ? { wrapperAsset: undefined, failedReads: ['wrapper.asset()'] }
                : badRelation
                  ? { wrapperAsset: OTHER }
                  : {}),
              ...(dropCode ? { tokenHasBytecode: false, failedReads: ['eth_getCode(token)'] } : {}),
            }),
          });
          const hasNonPass = record.checks.some((c) => c.outcome !== 'PASS');
          if (hasNonPass) expect(record.outcome).not.toBe('PASS');
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('registry diff', () => {
  const entry = (over: Partial<ReturnType<typeof toRegistryEntry>> = {}) => ({
    assetId: 'aaplx-id',
    symbol: 'AAPLx',
    tokenAddress: TOKEN,
    currentWrapperAddress: WRAPPER,
    ...over,
  });

  it('reports NO_CHANGE explicitly, so "checked and unchanged" is distinguishable from "not checked"', () => {
    const changes = diffRegistry([entry()], [entry()]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe('NO_CHANGE');
  });

  it('detects a newly discovered asset without opening review', () => {
    const changes = diffRegistry([], [entry()]);
    expect(changes[0]?.kind).toBe('DEPLOYMENT_ADDED');
    expect(changes[0]?.opensReview).toBe(false);
  });

  it('opens review when the current wrapper changes', () => {
    // Outstanding receipts were bound to the old wrapper.
    const changes = diffRegistry([entry()], [entry({ currentWrapperAddress: OTHER })]);
    const change = changes.find((c) => c.kind === 'WRAPPER_CHANGED');
    expect(change?.opensReview).toBe(true);
    expect(change?.previous).toBe(WRAPPER);
    expect(change?.current).toBe(OTHER);
  });

  it('opens review when a deployment disappears, never silently applying it', () => {
    const changes = diffRegistry([entry()], []);
    expect(changes[0]?.kind).toBe('DEPLOYMENT_REMOVED');
    expect(changes[0]?.opensReview).toBe(true);
  });

  it('opens review when the canonical token address changes', () => {
    const changes = diffRegistry([entry()], [entry({ tokenAddress: OTHER })]);
    const change = changes.find((c) => c.field === 'tokenAddress');
    expect(change?.opensReview).toBe(true);
  });

  it('does not open review for a cosmetic field change', () => {
    const changes = diffRegistry([entry()], [entry({ symbol: 'AAPLx2' })]);
    const change = changes.find((c) => c.field === 'symbol');
    expect(change?.opensReview).toBe(false);
  });

  it('a wrapper appearing where there was none is a change, not a no-op', () => {
    const changes = diffRegistry(
      [entry({ currentWrapperAddress: undefined })],
      [entry({ currentWrapperAddress: WRAPPER })],
    );
    expect(changes.some((c) => c.kind === 'WRAPPER_CHANGED')).toBe(true);
  });

  it('checksum casing alone is not a wrapper change', () => {
    const changes = diffRegistry(
      [entry()],
      [entry({ currentWrapperAddress: '0x943BF64d566c32A2BCD41ac92fB63c111cC9de8F' })],
    );
    expect(changes[0]?.kind).toBe('NO_CHANGE');
  });

  it('preserves history: a change reports both the previous and the current value', () => {
    const changes = diffRegistry([entry()], [entry({ currentWrapperAddress: OTHER })]);
    const change = changes.find((c) => c.kind === 'WRAPPER_CHANGED');
    expect(change?.previous).toBeDefined();
    expect(change?.current).toBeDefined();
  });
});
