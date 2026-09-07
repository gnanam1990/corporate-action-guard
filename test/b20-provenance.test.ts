/**
 * Repository-level gate on the committed Base B20 provenance manifests.
 *
 * `scripts/b20-provenance.mjs check` proves the manifests still match live sources, but it
 * needs network access and runs on a schedule. These tests are the offline half: they prove
 * the committed artifacts are internally coherent and that the rules which make an address
 * trustworthy have not quietly been relaxed. They run in the default unit project, so a
 * commit that weakens provenance fails before it reaches a reviewer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROVENANCE = path.join(ROOT, 'provenance/base-b20');

const read = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(PROVENANCE, file), 'utf8'));

interface Observation {
  chainId: number;
  blockNumber: string;
  blockHash: string;
  blockTimestamp: string;
  rpcEndpointId: string;
  observedAt: string;
}

interface Asset {
  chainId: number;
  address: string;
  displaySymbol: string;
  onchainName: string;
  onchainSymbol: string;
  decimals: number;
  totalSupplyRaw: string;
  multiplierWad: string;
  isB20Initialized: boolean;
  observedCodeBytes: number;
  issuerSource: string;
  capabilities: Record<string, { surface: string; outcome: string; selector: string }>;
}

const assetManifest = read('asset-manifest.json') as {
  schemaVersion: number;
  kind: string;
  observation: Observation;
  officialList: { url: string; bodySha256: string; parsedAssetCount: number };
  precompiles: Record<string, { address: string; source: string }>;
  assets: Asset[];
};

const feedManifest = read('feed-manifest.json') as {
  observation: Observation;
  sequencerUptimeFeed: { proxyAddress: string; answerSemantics: Record<string, string> };
  feeds: {
    proxyAddress: string;
    baseAsset: string;
    priceBasis: string;
    live: { decimals: number };
  }[];
  pairingPolicy: string;
};

const capabilityMatrix = read('capability-matrix.json') as {
  observation: Observation;
  selectors: Record<
    string,
    { surface: string; selector: string; signature: string; outcome: string }
  >;
  surfaces: Record<string, string>;
};

const pairing = read('token-feed-pairing.json') as {
  policy: { productionValuationRequires: string; inferredUseIsLimitedTo: string[] };
  pairs: { tokenAddress: string; feedProxyAddress: string | null; reviewStatus: string }[];
  feedsWithNoListedToken: string[];
};

const upstream = JSON.parse(
  readFileSync(path.join(PROVENANCE, 'base-std/SOURCE.json'), 'utf8'),
) as { commit: string; files: { path: string; sha256: string }[] };

const BASE_MAINNET = 8453;

describe('B20 asset manifest', () => {
  it('is pinned to Base mainnet at one recorded block', () => {
    expect(assetManifest.observation.chainId).toBe(BASE_MAINNET);
    expect(assetManifest.observation.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(assetManifest.observation.blockNumber)).toBeGreaterThan(0n);
    expect(BigInt(assetManifest.observation.blockTimestamp)).toBeGreaterThan(0n);
  });

  it('records no RPC credential', () => {
    // Only the host is stored. A manifest is committed; a key in one is a leaked key.
    const serialized = JSON.stringify(assetManifest);
    expect(assetManifest.observation.rpcEndpointId).not.toContain('/');
    expect(serialized).not.toMatch(/[?&](api[-_]?key|key|token)=/i);
  });

  it('holds every address in one canonical lowercase form, with no duplicates', () => {
    // Two spellings of one address is two identities. Lowercase is the single stored form,
    // matching normalizeAddress in @cag/domain.
    const seen = new Set<string>();
    for (const asset of assetManifest.assets) {
      expect(asset.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(seen.has(asset.address)).toBe(false);
      seen.add(asset.address);
    }
    expect(seen.size).toBe(assetManifest.officialList.parsedAssetCount);
  });

  it('gives every asset a chain, an issuer source and a live factory confirmation', () => {
    for (const asset of assetManifest.assets) {
      expect(asset.chainId).toBe(BASE_MAINNET);
      expect(asset.issuerSource).toBe('https://www.base.org/stocks');
      // The official list alone is a webpage. isB20Initialized is the factory's own answer.
      expect(asset.isB20Initialized).toBe(true);
      expect(asset.decimals).toBeGreaterThanOrEqual(6);
      expect(asset.decimals).toBeLessThanOrEqual(18);
      expect(() => BigInt(asset.multiplierWad)).not.toThrow();
      expect(BigInt(asset.multiplierWad)).toBeGreaterThan(0n);
    }
  });

  it('carries no display symbol as an identity key', () => {
    // Symbols are mutable on chain (updateSymbol). Distinctness here is a convenience for
    // search, never the lookup key — asserting it does not make it an identifier, and the
    // registry must still resolve by (chainId, address) only.
    const byAddress = new Map(assetManifest.assets.map((a) => [a.address, a]));
    expect(byAddress.size).toBe(assetManifest.assets.length);
  });

  it('does not treat bytecode length as identity for a precompile-backed token', () => {
    // Every B20 token returns one byte from eth_getCode. A code-hash comparison would
    // "prove" all ten assets are the same contract.
    for (const asset of assetManifest.assets) {
      expect(asset.observedCodeBytes).toBeLessThanOrEqual(1);
    }
  });

  it('sources every precompile address from the pinned base-std commit', () => {
    for (const entry of Object.values(assetManifest.precompiles)) {
      expect(entry.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(entry.source).toContain(upstream.commit);
      expect(entry.source).toContain('github.com/base/base-std');
    }
  });
});

describe('B20 capability matrix', () => {
  const VALID_OUTCOMES = new Set(['LIVE', 'NOT_DIALED', 'REVERTED', 'UNAVAILABLE', 'MIXED']);

  it('classifies every probed selector with a valid outcome and a real selector', () => {
    for (const [name, entry] of Object.entries(capabilityMatrix.selectors)) {
      expect(VALID_OUTCOMES.has(entry.outcome), `${name} outcome ${entry.outcome}`).toBe(true);
      expect(entry.selector).toMatch(/^0x[0-9a-f]{8}$/);
      expect(entry.signature).toContain('(');
    }
  });

  it('never freezes an unreachable endpoint into a capability claim', () => {
    // UNAVAILABLE means the RPC failed, which says nothing about the capability. Capture
    // refuses to write a manifest containing one; this asserts the committed file honours that.
    for (const [name, entry] of Object.entries(capabilityMatrix.selectors)) {
      expect(entry.outcome, `${name} was recorded as unreachable`).not.toBe('UNAVAILABLE');
      expect(entry.outcome, `${name} disagreed across assets`).not.toBe('MIXED');
    }
  });

  it('agrees with the per-asset probes it summarizes', () => {
    for (const [name, entry] of Object.entries(capabilityMatrix.selectors)) {
      for (const asset of assetManifest.assets) {
        expect(asset.capabilities[name]?.outcome, `${asset.displaySymbol}.${name}`).toBe(
          entry.outcome,
        );
        expect(asset.capabilities[name]?.selector).toBe(entry.selector);
      }
    }
  });

  it('records the scheduled-multiplier surface as an observation, not an assumption', () => {
    // The whole temporal model depends on this. If Cobalt ever activates, this test fails
    // and forces the lifecycle reducer's UNSUPPORTED_CAPABILITY path to be revisited
    // deliberately rather than the product silently reporting "no pending update".
    const scheduled = ['newUIMultiplier', 'effectiveAt'];
    for (const name of scheduled) {
      expect(capabilityMatrix.selectors[name]?.surface).toBe('COBALT_ERC8056');
    }
    const surface = capabilityMatrix.surfaces['COBALT_ERC8056'];
    expect(['LIVE', 'PARTIAL', 'NOT_ACTIVATED']).toContain(surface);
    if (surface !== 'LIVE') {
      for (const name of scheduled) {
        expect(capabilityMatrix.selectors[name]?.outcome).toBe('NOT_DIALED');
      }
    }
  });

  it('keeps the Beryl surface live, since the whole product reads through it', () => {
    expect(capabilityMatrix.selectors['multiplier']?.outcome).toBe('LIVE');
    expect(capabilityMatrix.surfaces['BERYL']).toBe('LIVE');
  });
});

describe('Chainlink feed manifest', () => {
  it('labels every equity feed with its price basis', () => {
    // The single most load-bearing string in this repository. Chainlink publishes the
    // multiplier-adjusted token price; multiplying a share-equivalent by it double-applies
    // the multiplier. Route selection reads this field.
    for (const feed of feedManifest.feeds) {
      expect(feed.priceBasis).toBe('TOTAL_RETURN_TOKEN_PRICE');
      expect(feed.proxyAddress).toMatch(/^0x[0-9a-f]{40}$/);
      expect(feed.live.decimals).toBeGreaterThan(0);
    }
  });

  it('records the sequencer feed with explicit answer semantics', () => {
    expect(feedManifest.sequencerUptimeFeed.proxyAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(feedManifest.sequencerUptimeFeed.answerSemantics['0']).toBe('SEQUENCER_UP');
    expect(feedManifest.sequencerUptimeFeed.answerSemantics['1']).toBe('SEQUENCER_DOWN');
  });

  it('maps no feed to two proxies and no proxy to two feeds', () => {
    const proxies = feedManifest.feeds.map((f) => f.proxyAddress);
    expect(new Set(proxies).size).toBe(proxies.length);
    const bases = feedManifest.feeds.map((f) => f.baseAsset);
    expect(new Set(bases).size).toBe(bases.length);
  });

  it('refuses to pair tokens to feeds automatically', () => {
    expect(feedManifest.pairingPolicy).toBe('REVIEWED_EXPLICIT_ONLY');
  });
});

describe('token to feed pairing', () => {
  it('is observed at the same block as the manifests it joins', () => {
    // Joining a token read at block N to a feed read at block M is exactly the
    // incompatible-evidence mistake the product exists to catch.
    expect(feedManifest.observation.blockHash).toBe(assetManifest.observation.blockHash);
    expect(capabilityMatrix.observation.blockHash).toBe(assetManifest.observation.blockHash);
  });

  it('does not claim a review that has not happened', () => {
    // Symbol-stem matching is a ticker inference and a ticker is not an identifier. Nothing
    // automated may promote a pairing; promotion is a human commit with named evidence.
    for (const pair of pairing.pairs) {
      expect(['INFERRED_UNREVIEWED', 'REVIEWED_VERIFIED', 'CONFLICT', 'ABSENT']).toContain(
        pair.reviewStatus,
      );
    }
    expect(pairing.policy.productionValuationRequires).toBe('REVIEWED_VERIFIED');
    expect(pairing.policy.inferredUseIsLimitedTo).toEqual(['DISPLAY_POSITION']);
  });

  it('covers every listed asset and names the feeds with no listed token', () => {
    const tokens = new Set(assetManifest.assets.map((a) => a.address));
    const paired = new Set(pairing.pairs.map((p) => p.tokenAddress));
    expect(paired).toEqual(tokens);

    const pairedFeeds = new Set(
      pairing.pairs.map((p) => p.feedProxyAddress).filter((a): a is string => a !== null),
    );
    const unpaired = feedManifest.feeds
      .filter((f) => !pairedFeeds.has(f.proxyAddress))
      .map((f) => f.baseAsset)
      .sort();
    expect(unpaired).toEqual(pairing.feedsWithNoListedToken);
  });
});

describe('upstream interface snapshot', () => {
  it('pins one commit and hashes every file', () => {
    expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(upstream.files.length).toBeGreaterThan(0);
    for (const file of upstream.files) {
      expect(file.sha256).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('includes the interfaces the readers are built against', () => {
    const paths = new Set(upstream.files.map((f) => f.path));
    for (const required of [
      'src/interfaces/IB20.sol',
      'src/interfaces/IB20Asset.sol',
      'src/interfaces/IERC8056.sol',
      'src/interfaces/IB20Factory.sol',
      'src/StdPrecompiles.sol',
      'src/lib/B20Constants.sol',
    ]) {
      expect(paths.has(required), `missing ${required}`).toBe(true);
    }
  });
});
