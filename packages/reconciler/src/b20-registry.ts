/**
 * The verified B20 asset registry.
 *
 * This is the boundary where a reviewed provenance manifest and a set of live reads become
 * registry entries a protected action may rely on. Three rules shape it.
 *
 * A manifest is untrusted until it parses. It is a file on disk that a human committed, and
 * a malformed one must fail loudly at load rather than half-populate a registry — a registry
 * with nine of ten assets looks healthy and is wrong about the tenth.
 *
 * A refresh never overwrites. Every difference from the last accepted version becomes a
 * typed change, and a change that touches identity requires review before it becomes
 * canonical. The X Layer registry already works this way (`registry-diff.ts`); this follows
 * the same shape for the same reason.
 *
 * Nothing here resolves an asset by ticker. `resolve` takes `(chainId, address)`, and search
 * returns candidates a human picks from.
 */

import {
  b20AssetKey,
  unsafeB20,
  verifyB20Identity,
  type B20AssetStatus,
  type B20IdentityEvidence,
  type B20IdentityVerdict,
  type B20KnownIdentity,
  type ChainId,
  type MultiplierWad,
  type TokenDecimals,
} from '@cag/domain';

export const BASE_MAINNET_CHAIN_ID = 8453;

/** One asset as recorded in `provenance/base-b20/asset-manifest.json`. */
export interface B20ManifestAsset {
  readonly chainId: number;
  readonly address: string;
  readonly displaySymbol: string;
  readonly onchainName: string;
  readonly onchainSymbol: string;
  readonly decimals: number;
  readonly multiplierWad: string;
  readonly isB20Initialized: boolean;
  readonly issuerSource: string;
  readonly capabilities: Record<string, { surface: string; outcome: string; selector: string }>;
}

export interface B20AssetManifest {
  readonly schemaVersion: number;
  readonly observation: {
    readonly chainId: number;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly blockTimestamp: string;
    readonly observedAt: string;
  };
  readonly officialList: { readonly url: string; readonly bodySha256: string };
  readonly assets: readonly B20ManifestAsset[];
}

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
  }
}

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * Parse and validate a manifest, reporting every problem rather than the first.
 *
 * Deliberately strict about lowercase addresses and duplicate keys. A manifest containing
 * one address in two spellings, or one address twice, cannot be repaired by a reader — the
 * ambiguity has to be resolved by whoever produced it.
 */
export function parseB20AssetManifest(input: unknown): B20AssetManifest {
  const issues: string[] = [];
  const manifest = input as Partial<B20AssetManifest> | null;

  if (manifest === null || typeof manifest !== 'object') {
    throw new ManifestError('asset manifest is not an object');
  }
  if (manifest.schemaVersion !== 1) {
    // An unknown version stops the load. Guessing at an unrecognised shape is how a
    // projection quietly rebuilds from fields that no longer mean what they used to.
    issues.push(`unsupported schemaVersion ${String(manifest.schemaVersion)}; expected 1`);
  }

  const observation = manifest.observation;
  if (observation === undefined) {
    issues.push('observation block is missing');
  } else {
    if (observation.chainId !== BASE_MAINNET_CHAIN_ID) {
      issues.push(`observation is for chain ${String(observation.chainId)}, expected 8453`);
    }
    if (!HEX32.test(String(observation.blockHash))) {
      issues.push('observation.blockHash is not a 32-byte lowercase hash');
    }
    if (!/^\d+$/.test(String(observation.blockNumber))) {
      issues.push('observation.blockNumber is not an integer string');
    }
  }

  const assets = manifest.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    issues.push('manifest contains no assets');
    throw new ManifestError(`invalid asset manifest (${issues.length} problem(s))`, issues);
  }

  const seen = new Set<string>();
  assets.forEach((asset, index) => {
    const at = `assets[${String(index)}]`;
    if (!HEX_ADDRESS.test(asset.address)) {
      issues.push(`${at}.address must be a lowercase 0x address`);
      return;
    }
    if (asset.chainId !== BASE_MAINNET_CHAIN_ID) {
      issues.push(`${at} is for chain ${String(asset.chainId)}, expected 8453`);
    }
    const key = b20AssetKey(asset.chainId as ChainId, asset.address);
    if (seen.has(key)) issues.push(`${at} duplicates address ${asset.address}`);
    seen.add(key);

    if (!Number.isInteger(asset.decimals) || asset.decimals < 6 || asset.decimals > 18) {
      issues.push(`${at}.decimals must be an integer in 6..18`);
    }
    if (!/^\d+$/.test(String(asset.multiplierWad)) || BigInt(asset.multiplierWad) <= 0n) {
      issues.push(`${at}.multiplierWad must be a positive integer string`);
    }
    if (typeof asset.issuerSource !== 'string' || asset.issuerSource.length === 0) {
      issues.push(`${at}.issuerSource is required — an address with no provenance is a guess`);
    }
  });

  if (issues.length > 0) {
    throw new ManifestError(`invalid asset manifest (${issues.length} problem(s))`, issues);
  }
  return manifest as B20AssetManifest;
}

/** One entry in the projected registry. */
export interface B20RegistryEntry {
  readonly key: string;
  readonly chainId: ChainId;
  readonly address: string;
  readonly displaySymbol: string;
  readonly onchainName: string;
  readonly onchainSymbol: string;
  readonly decimals: TokenDecimals;
  readonly multiplierWad: MultiplierWad;
  readonly status: B20AssetStatus;
  readonly usableForProtectedAction: boolean;
  readonly verdict: B20IdentityVerdict;
  readonly observedAtBlock: string;
  readonly observedAtBlockHash: string;
  readonly issuerSource: string;
}

export const B20_REGISTRY_CHANGE_KINDS = [
  'ASSET_ADDED',
  'ASSET_REMOVED',
  'SYMBOL_CHANGED',
  'NAME_CHANGED',
  'DECIMALS_CHANGED',
  'STATUS_CHANGED',
  'NO_CHANGE',
] as const;
export type B20RegistryChangeKind = (typeof B20_REGISTRY_CHANGE_KINDS)[number];

export interface B20RegistryChange {
  readonly kind: B20RegistryChangeKind;
  readonly key: string;
  readonly previous?: string;
  readonly current?: string;
  /** True when the change must open a review record rather than update a projection. */
  readonly requiresReview: boolean;
  readonly detail: string;
}

/**
 * Project a reviewed manifest plus live evidence into registry entries.
 *
 * `liveEvidence` is keyed by `(chainId, address)` and supplied by the caller, because this
 * package performs no RPC. An asset present in the manifest but missing from the live
 * evidence is `UNKNOWN`, never carried forward from the manifest alone — the manifest says
 * what was true at capture time, not what is true now.
 */
export function projectB20Registry(
  manifest: B20AssetManifest,
  liveEvidence: ReadonlyMap<string, B20IdentityEvidence>,
  known: ReadonlyMap<string, B20KnownIdentity> = new Map(),
): readonly B20RegistryEntry[] {
  return manifest.assets.map((asset) => {
    const chainId = asset.chainId as ChainId;
    const key = b20AssetKey(chainId, asset.address);
    const evidence: B20IdentityEvidence = liveEvidence.get(key) ?? {
      chainId,
      address: asset.address,
      onOfficialList: true,
      // Undefined, not false: no live read happened, and a missing read must not read as a
      // negative answer from the factory.
      factoryInitialized: undefined,
      prefixMatches: asset.address.startsWith('0xb2'),
      onchainName: undefined,
      onchainSymbol: undefined,
      decimals: undefined,
      multiplierWad: undefined,
      observedAtBlock: BigInt(manifest.observation.blockNumber) as never,
      observedAtBlockHash: manifest.observation.blockHash as never,
      isFixture: false,
    };

    const verdict = verifyB20Identity(evidence, known.get(key));

    return {
      key,
      chainId,
      address: asset.address,
      displaySymbol: asset.displaySymbol,
      onchainName: evidence.onchainName ?? asset.onchainName,
      onchainSymbol: evidence.onchainSymbol ?? asset.onchainSymbol,
      decimals: unsafeB20.tokenDecimals(asset.decimals),
      multiplierWad: unsafeB20.multiplierWad(BigInt(asset.multiplierWad)),
      status: verdict.status,
      usableForProtectedAction: verdict.usableForProtectedAction,
      verdict,
      observedAtBlock: String(evidence.observedAtBlock),
      observedAtBlockHash: String(evidence.observedAtBlockHash),
      issuerSource: asset.issuerSource,
    };
  });
}

/**
 * Diff two registry projections.
 *
 * A refresh produces changes, not an overwrite. Anything that touches identity — a symbol,
 * a name, decimals, or an asset appearing or disappearing — requires review before it
 * becomes canonical, because each of those is evidence that something happened on chain or
 * on the official list that a human should see.
 */
export function diffB20Registry(
  previous: readonly B20RegistryEntry[],
  current: readonly B20RegistryEntry[],
): readonly B20RegistryChange[] {
  const before = new Map(previous.map((e) => [e.key, e]));
  const after = new Map(current.map((e) => [e.key, e]));
  const changes: B20RegistryChange[] = [];

  for (const [key, entry] of after) {
    const old = before.get(key);
    if (old === undefined) {
      changes.push({
        kind: 'ASSET_ADDED',
        key,
        current: entry.displaySymbol,
        requiresReview: true,
        detail: `${entry.displaySymbol} (${entry.address}) appeared on the official list`,
      });
      continue;
    }
    if (old.onchainSymbol !== entry.onchainSymbol) {
      changes.push({
        kind: 'SYMBOL_CHANGED',
        key,
        previous: old.onchainSymbol,
        current: entry.onchainSymbol,
        requiresReview: true,
        detail: `symbol changed; identity ${entry.address} is unchanged`,
      });
    }
    if (old.onchainName !== entry.onchainName) {
      changes.push({
        kind: 'NAME_CHANGED',
        key,
        previous: old.onchainName,
        current: entry.onchainName,
        requiresReview: true,
        detail: `name changed; identity ${entry.address} is unchanged`,
      });
    }
    if (old.decimals !== entry.decimals) {
      // No setter exists for decimals. A change means this is not the contract we recorded.
      changes.push({
        kind: 'DECIMALS_CHANGED',
        key,
        previous: String(old.decimals),
        current: String(entry.decimals),
        requiresReview: true,
        detail: 'decimals are immutable on chain; a change means a different contract',
      });
    }
    if (old.status !== entry.status) {
      changes.push({
        kind: 'STATUS_CHANGED',
        key,
        previous: old.status,
        current: entry.status,
        requiresReview: entry.status !== 'VERIFIED',
        detail: `registry status moved from ${old.status} to ${entry.status}`,
      });
    }
  }

  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    changes.push({
      kind: 'ASSET_REMOVED',
      key,
      previous: entry.displaySymbol,
      requiresReview: true,
      detail: `${entry.displaySymbol} (${entry.address}) is no longer on the official list`,
    });
  }

  if (changes.length === 0) {
    return [{ kind: 'NO_CHANGE', key: '', requiresReview: false, detail: 'registry unchanged' }];
  }
  return changes;
}

/** Resolve by identity. There is no symbol overload, on purpose. */
export function resolveB20Asset(
  entries: readonly B20RegistryEntry[],
  chainId: ChainId,
  address: string,
): B20RegistryEntry | undefined {
  const key = b20AssetKey(chainId, address);
  return entries.find((e) => e.key === key);
}
