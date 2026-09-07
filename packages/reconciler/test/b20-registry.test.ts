/**
 * The verified B20 asset registry.
 *
 * Half of these tests are about refusing. The registry's job is to say "no" to a
 * plausible-looking address, and every way an address can look plausible without being a
 * Coinbase-issued tokenized stock gets a case here.
 *
 * The manifest under test is the real committed one, so a capture that changes the shape of
 * `provenance/base-b20/asset-manifest.json` fails here rather than at runtime.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  b20AssetKey,
  unsafeB20,
  verifyB20Identity,
  searchB20Candidates,
  type B20IdentityEvidence,
  type ChainId,
} from '@cag/domain';
import {
  diffB20Registry,
  ManifestError,
  parseB20AssetManifest,
  projectB20Registry,
  resolveB20Asset,
  type B20RegistryEntry,
} from '../src/index.js';

const CHAIN = 8453 as ChainId;
const ROOT = path.resolve(import.meta.dirname, '../../..');

const REAL_MANIFEST = parseB20AssetManifest(
  JSON.parse(readFileSync(path.join(ROOT, 'provenance/base-b20/asset-manifest.json'), 'utf8')),
);

/** AAPLc, from the committed manifest. Real address, real values. */
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';

function evidence(overrides: Partial<B20IdentityEvidence> = {}): B20IdentityEvidence {
  return {
    chainId: CHAIN,
    address: AAPL,
    onOfficialList: true,
    factoryInitialized: true,
    prefixMatches: true,
    onchainName: 'Apple Inc.',
    onchainSymbol: 'AAPLc',
    decimals: unsafeB20.tokenDecimals(8),
    multiplierWad: unsafeB20.multiplierWad(1_000_000_000_000_000_000n),
    observedAtBlock: 50_993_686n as never,
    observedAtBlockHash: `0x${'ab'.repeat(32)}` as never,
    isFixture: false,
    ...overrides,
  };
}

describe('identity verification', () => {
  it('verifies an asset when the list, the factory and the chain all agree', () => {
    const verdict = verifyB20Identity(evidence());
    expect(verdict.status).toBe('VERIFIED');
    expect(verdict.usableForProtectedAction).toBe(true);
  });

  it('refuses an address that only looks like a B20', () => {
    // The whole trap in one test: the prefix matches, the factory says it was created, and
    // it is still not a Coinbase tokenized stock because it is not on the official list.
    const verdict = verifyB20Identity(
      evidence({ onOfficialList: false, address: '0xb2000000000000000000000000000000deadbeef' }),
    );
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.usableForProtectedAction).toBe(false);
    expect(verdict.reasons).toContain('B20_PREFIX_ONLY_IDENTITY');
    expect(verdict.reasons).toContain('B20_NOT_ON_OFFICIAL_LIST');
  });

  it('treats two primary sources contradicting each other as a conflict, not a preference', () => {
    const verdict = verifyB20Identity(evidence({ factoryInitialized: false }));
    expect(verdict.status).toBe('CONFLICT');
    expect(verdict.reasons).toContain('B20_NOT_FACTORY_INITIALIZED');
  });

  it('does not read a missing probe as a negative answer', () => {
    const verdict = verifyB20Identity(evidence({ factoryInitialized: undefined }));
    expect(verdict.status).toBe('UNKNOWN');
    expect(verdict.reasons).toContain('B20_RPC_UNAVAILABLE');
  });

  it('keeps identity through a rename and asks for review', () => {
    // updateSymbol exists on chain. A rename is real, it does not change (chainId, address),
    // and it is exactly how a display-layer confusion starts — so it opens review.
    const verdict = verifyB20Identity(evidence({ onchainSymbol: 'AAPLXc' }), {
      onchainName: 'Apple Inc.',
      onchainSymbol: 'AAPLc',
      decimals: unsafeB20.tokenDecimals(8),
      status: 'VERIFIED',
    });
    expect(verdict.status).toBe('CHANGED');
    expect(verdict.changedAttributes).toEqual(['symbol']);
    expect(verdict.usableForProtectedAction).toBe(false);
  });

  it('treats a decimals change as a different contract', () => {
    // There is no setter for decimals. A change is not an update, it is a different asset.
    const verdict = verifyB20Identity(evidence({ decimals: unsafeB20.tokenDecimals(18) }), {
      onchainName: 'Apple Inc.',
      onchainSymbol: 'AAPLc',
      decimals: unsafeB20.tokenDecimals(8),
      status: 'VERIFIED',
    });
    expect(verdict.status).toBe('CONFLICT');
    expect(verdict.reasons).toContain('B20_DECIMAL_MISMATCH');
  });

  it('retires an asset that leaves the official list without erasing it', () => {
    const verdict = verifyB20Identity(evidence({ onOfficialList: false }), {
      onchainName: 'Apple Inc.',
      onchainSymbol: 'AAPLc',
      decimals: unsafeB20.tokenDecimals(8),
      status: 'VERIFIED',
    });
    expect(verdict.status).toBe('RETIRED');
    expect(verdict.usableForProtectedAction).toBe(false);
  });

  it('refuses a fixture on a production route no matter how well formed it is', () => {
    const verdict = verifyB20Identity(evidence({ isFixture: true }));
    expect(verdict.usableForProtectedAction).toBe(false);
    expect(verdict.reasons).toContain('B20_FIXTURE_NOT_PRODUCTION');
  });

  it('rejects a checksummed address as a second identity for the same asset', () => {
    const verdict = verifyB20Identity(
      evidence({ address: '0xB200000000000000000000C2E324D24D7EECD1FB' }),
    );
    expect(verdict.status).toBe('CONFLICT');
  });
});

describe('manifest parsing', () => {
  it('accepts the committed manifest', () => {
    expect(REAL_MANIFEST.assets.length).toBeGreaterThan(0);
    expect(REAL_MANIFEST.observation.chainId).toBe(8453);
  });

  it('reports every problem, not just the first', () => {
    let caught: unknown;
    try {
      parseB20AssetManifest({
        schemaVersion: 1,
        observation: { chainId: 8453, blockNumber: '1', blockHash: `0x${'aa'.repeat(32)}` },
        officialList: { url: 'x', bodySha256: 'y' },
        assets: [
          { ...REAL_MANIFEST.assets[0], decimals: 99 },
          { ...REAL_MANIFEST.assets[1], issuerSource: '' },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestError);
    expect((caught as ManifestError).issues).toHaveLength(2);
  });

  it('refuses an unknown schema version rather than guessing at the shape', () => {
    expect(() => parseB20AssetManifest({ ...REAL_MANIFEST, schemaVersion: 2 })).toThrow(
      ManifestError,
    );
  });

  it('refuses a manifest captured on the wrong chain', () => {
    expect(() =>
      parseB20AssetManifest({
        ...REAL_MANIFEST,
        observation: { ...REAL_MANIFEST.observation, chainId: 1 },
      }),
    ).toThrow(ManifestError);
  });

  it('refuses a duplicate address', () => {
    const first = REAL_MANIFEST.assets[0];
    expect(() => parseB20AssetManifest({ ...REAL_MANIFEST, assets: [first, first] })).toThrow(
      ManifestError,
    );
  });

  it('refuses a checksummed address, which would be a second identity for one asset', () => {
    const first = REAL_MANIFEST.assets[0];
    expect(() =>
      parseB20AssetManifest({
        ...REAL_MANIFEST,
        assets: [{ ...first, address: first.address.toUpperCase().replace('0X', '0x') }],
      }),
    ).toThrow(ManifestError);
  });

  it('refuses an address with no issuer provenance', () => {
    const first = REAL_MANIFEST.assets[0];
    expect(() =>
      parseB20AssetManifest({ ...REAL_MANIFEST, assets: [{ ...first, issuerSource: '' }] }),
    ).toThrow(ManifestError);
  });
});

describe('registry projection', () => {
  const live = new Map(
    REAL_MANIFEST.assets.map((asset) => [
      b20AssetKey(asset.chainId as ChainId, asset.address),
      evidence({
        address: asset.address,
        onchainName: asset.onchainName,
        onchainSymbol: asset.onchainSymbol,
        decimals: unsafeB20.tokenDecimals(asset.decimals),
      }),
    ]),
  );

  it('verifies every officially listed asset when live reads agree', () => {
    const entries = projectB20Registry(REAL_MANIFEST, live);
    expect(entries).toHaveLength(REAL_MANIFEST.assets.length);
    expect(entries.every((e) => e.status === 'VERIFIED')).toBe(true);
    expect(entries.every((e) => e.usableForProtectedAction)).toBe(true);
  });

  it('does not carry a manifest value forward as a live observation', () => {
    // The manifest says what was true at capture. With no live read, the honest answer is
    // UNKNOWN, not "the manifest said it was fine".
    const entries = projectB20Registry(REAL_MANIFEST, new Map());
    expect(entries.every((e) => e.status === 'UNKNOWN')).toBe(true);
    expect(entries.every((e) => !e.usableForProtectedAction)).toBe(true);
  });

  it('resolves by (chainId, address) and by nothing else', () => {
    const entries = projectB20Registry(REAL_MANIFEST, live);
    expect(resolveB20Asset(entries, CHAIN, AAPL)?.displaySymbol).toBe('AAPLc');
    // Same address, wrong chain: not the same asset.
    expect(resolveB20Asset(entries, 1 as ChainId, AAPL)).toBeUndefined();
    // A checksummed spelling still resolves, because the key lowercases both sides.
    expect(resolveB20Asset(entries, CHAIN, AAPL.toUpperCase().replace('0X', '0x'))).toBeDefined();
  });
});

describe('search returns candidates, never an identity', () => {
  const candidates = REAL_MANIFEST.assets.map((a) => ({
    key: b20AssetKey(a.chainId as ChainId, a.address),
    chainId: a.chainId as ChainId,
    address: a.address,
    displaySymbol: a.displaySymbol,
    onchainName: a.onchainName,
    status: 'VERIFIED' as const,
  }));

  it('finds by symbol, name and address fragment', () => {
    expect(searchB20Candidates(candidates, 'AAPL')).toHaveLength(1);
    expect(searchB20Candidates(candidates, 'Apple')).toHaveLength(1);
    expect(searchB20Candidates(candidates, 'c2e324d2')).toHaveLength(1);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchB20Candidates(candidates, '   ')).toEqual([]);
  });

  it('returns a list even for an exact symbol match, so the caller must choose', () => {
    const results = searchB20Candidates(candidates, 'AAPLc');
    expect(Array.isArray(results)).toBe(true);
    expect(results[0]?.key).toContain(AAPL);
  });
});

describe('refresh diffing', () => {
  const live = new Map(
    REAL_MANIFEST.assets.map((asset) => [
      b20AssetKey(asset.chainId as ChainId, asset.address),
      evidence({
        address: asset.address,
        onchainName: asset.onchainName,
        onchainSymbol: asset.onchainSymbol,
        decimals: unsafeB20.tokenDecimals(asset.decimals),
      }),
    ]),
  );
  const baseline = projectB20Registry(REAL_MANIFEST, live);

  it('reports no change when nothing moved', () => {
    expect(diffB20Registry(baseline, baseline)).toEqual([
      { kind: 'NO_CHANGE', key: '', requiresReview: false, detail: 'registry unchanged' },
    ]);
  });

  it('opens review for a rename rather than overwriting the symbol', () => {
    const renamed: B20RegistryEntry[] = baseline.map((e, i) =>
      i === 0 ? { ...e, onchainSymbol: 'RENAMEDc' } : e,
    );
    const changes = diffB20Registry(baseline, renamed);
    const change = changes.find((c) => c.kind === 'SYMBOL_CHANGED');
    expect(change?.requiresReview).toBe(true);
    expect(change?.detail).toContain('identity');
  });

  it('flags an asset leaving the official list', () => {
    const changes = diffB20Registry(baseline, baseline.slice(1));
    expect(changes.find((c) => c.kind === 'ASSET_REMOVED')?.requiresReview).toBe(true);
  });

  it('flags a new listing for review before it becomes usable', () => {
    const changes = diffB20Registry(baseline.slice(1), baseline);
    expect(changes.find((c) => c.kind === 'ASSET_ADDED')?.requiresReview).toBe(true);
  });

  it('does not demand review when a status recovers to VERIFIED', () => {
    // Review exists to catch degradation. Making an operator acknowledge a recovery trains
    // them to click through everything.
    const degraded = baseline.map((e, i) => (i === 0 ? { ...e, status: 'UNKNOWN' as const } : e));
    const recovered = diffB20Registry(degraded, baseline);
    expect(recovered.find((c) => c.kind === 'STATUS_CHANGED')?.requiresReview).toBe(false);
  });
});
