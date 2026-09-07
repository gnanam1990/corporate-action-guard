/**
 * Verified B20 asset identity.
 *
 * The question this answers is narrow and load-bearing: *may a protected action treat this
 * address as a Coinbase-issued tokenized stock?* Three independent facts have to agree, and
 * each of them alone is worth much less than it looks:
 *
 *   official list       Issuer provenance. A webpage — authoritative about intent, silent
 *                       about what the address actually does.
 *   isB20Initialized    The factory's own answer that it created this token. Says nothing
 *                       about who asked it to.
 *   live reads          What the address really is right now, at a recorded block.
 *
 * And one fact that is worth nothing at all: the `0xb2…` address prefix. `IB20Factory.isB20`
 * is documented as recovering its answer from the prefix, so anyone can produce an address
 * that satisfies it. Treating a prefix as issuance is the exact shape of the ticker mistake
 * this product exists to catch.
 *
 * Pure. Every input arrives as an argument; there is no fetch, no file, no clock here.
 */

import type { BlockHash, BlockNumber, ChainId } from '../brands.js';
import type { B20Reason } from './reasons.js';
import type { MultiplierWad, TokenDecimals } from './quantities.js';

export const B20_ASSET_STATUSES = [
  /** Every required fact agrees. The only status a production protected action accepts. */
  'VERIFIED',
  /** Previously verified; a mutable attribute moved. Identity is intact, review is owed. */
  'CHANGED',
  /** Two facts disagree. Never resolved by preferring one source. */
  'CONFLICT',
  /** Was on the official list, is no longer. Historical evidence stays readable. */
  'RETIRED',
  /** Not enough evidence to say anything. Never a synonym for "fine". */
  'UNKNOWN',
] as const;
export type B20AssetStatus = (typeof B20_ASSET_STATUSES)[number];

/** Where an asset's identity claim came from, kept separable so each can be weighed. */
export interface B20IdentityEvidence {
  readonly chainId: ChainId;
  /** Lowercase. Two spellings of one address would be two identities. */
  readonly address: string;
  /** True only if this exact address appears on the reviewed official manifest. */
  readonly onOfficialList: boolean;
  /** `IB20Factory.isB20Initialized`. Undefined means the probe did not answer. */
  readonly factoryInitialized: boolean | undefined;
  /**
   * `IB20Factory.isB20` — recovered from the address prefix. Recorded for completeness and
   * deliberately never sufficient. See `B20_PREFIX_ONLY_IDENTITY`.
   */
  readonly prefixMatches: boolean;
  readonly onchainName: string | undefined;
  readonly onchainSymbol: string | undefined;
  readonly decimals: TokenDecimals | undefined;
  readonly multiplierWad: MultiplierWad | undefined;
  readonly observedAtBlock: BlockNumber;
  readonly observedAtBlockHash: BlockHash;
  /** True for a labelled TESTNET FIXTURE. Must never reach a production route. */
  readonly isFixture: boolean;
}

/** What we believed last time, so a change is a change rather than a fresh observation. */
export interface B20KnownIdentity {
  readonly onchainName: string;
  readonly onchainSymbol: string;
  readonly decimals: TokenDecimals;
  readonly status: B20AssetStatus;
}

export interface B20IdentityVerdict {
  readonly status: B20AssetStatus;
  readonly reasons: readonly B20Reason[];
  /**
   * True only for `VERIFIED` on a non-fixture asset. Separate from the status so a caller
   * cannot accidentally accept `CHANGED` by string comparison.
   */
  readonly usableForProtectedAction: boolean;
  /** Mutable attributes that moved since the last accepted version, for the review record. */
  readonly changedAttributes: readonly string[];
}

/**
 * Decide an asset's registry status from its evidence.
 *
 * The ordering matters. Conflicts are decided before absences, because a source that
 * actively contradicts another is a different and worse problem than a source that is quiet.
 */
export function verifyB20Identity(
  evidence: B20IdentityEvidence,
  known?: B20KnownIdentity,
): B20IdentityVerdict {
  const reasons: B20Reason[] = [];

  const verdict = (
    status: B20AssetStatus,
    changedAttributes: readonly string[] = [],
  ): B20IdentityVerdict => ({
    status,
    reasons,
    usableForProtectedAction: status === 'VERIFIED' && !evidence.isFixture,
    changedAttributes,
  });

  if (evidence.isFixture) {
    // A fixture is excluded structurally, not by a filter somewhere downstream that can be
    // forgotten. It carries its own label all the way through evidence and UI.
    reasons.push('B20_FIXTURE_NOT_PRODUCTION');
    return verdict('UNKNOWN');
  }

  if (evidence.address !== evidence.address.toLowerCase()) {
    // Mixed case is an EIP-55 checksum, not an identity. Storing both spellings would let one
    // asset occupy two registry rows and disagree with itself.
    reasons.push('B20_IDENTITY_DRIFT');
    return verdict('CONFLICT');
  }

  // The factory says this address is not an initialized B20 while the official list says it
  // is a tokenized stock. Two primary sources contradicting each other is never resolved by
  // preferring the more convenient one.
  if (evidence.onOfficialList && evidence.factoryInitialized === false) {
    reasons.push('B20_NOT_FACTORY_INITIALIZED');
    return verdict('CONFLICT');
  }

  if (!evidence.onOfficialList) {
    // The prefix alone is the trap. Calling it out by name means an operator reading the
    // incident sees why a plausible-looking address was refused.
    if (evidence.prefixMatches) reasons.push('B20_PREFIX_ONLY_IDENTITY');
    reasons.push('B20_NOT_ON_OFFICIAL_LIST');
    return verdict(known?.status === 'VERIFIED' ? 'RETIRED' : 'UNKNOWN');
  }

  if (evidence.factoryInitialized === undefined) {
    // The probe did not answer. Absence of an answer is not an answer.
    reasons.push('B20_RPC_UNAVAILABLE');
    return verdict('UNKNOWN');
  }

  if (
    evidence.decimals === undefined ||
    evidence.multiplierWad === undefined ||
    evidence.onchainSymbol === undefined ||
    evidence.onchainName === undefined
  ) {
    reasons.push('B20_RPC_UNAVAILABLE');
    return verdict('UNKNOWN');
  }

  if (known === undefined) {
    return verdict('VERIFIED');
  }

  // Decimals are immutable in practice — the factory fixes them at creation and no setter
  // exists — so a change means we are looking at a different contract than we recorded.
  if (known.decimals !== evidence.decimals) {
    reasons.push('B20_DECIMAL_MISMATCH');
    return verdict('CONFLICT');
  }

  // Name and symbol are mutable by design (`updateName`, `updateSymbol`). A rename does not
  // change identity, which stays (chainId, address) — but it does owe a review, because a
  // symbol that suddenly reads like another asset's is exactly how a display-layer confusion
  // starts.
  const changed: string[] = [];
  if (known.onchainSymbol !== evidence.onchainSymbol) changed.push('symbol');
  if (known.onchainName !== evidence.onchainName) changed.push('name');
  if (changed.length > 0) {
    reasons.push('B20_IDENTITY_DRIFT');
    return verdict('CHANGED', changed);
  }

  return verdict('VERIFIED');
}

/**
 * Resolve an asset by identity.
 *
 * Deliberately takes `(chainId, address)` and nothing else. There is no overload that
 * accepts a symbol, because the moment one exists something will call it.
 */
export function b20AssetKey(chainId: ChainId, address: string): string {
  return `${String(chainId)}:${address.toLowerCase()}`;
}

/**
 * Display search results.
 *
 * A symbol match returns *candidates* for a human to choose between. It never resolves an
 * identity, and the return type says so: a list, with the key each candidate would resolve
 * to, so a caller has to make the choice explicit.
 */
export interface B20SearchCandidate {
  readonly key: string;
  readonly chainId: ChainId;
  readonly address: string;
  readonly displaySymbol: string;
  readonly onchainName: string;
  readonly status: B20AssetStatus;
}

export function searchB20Candidates(
  entries: readonly B20SearchCandidate[],
  query: string,
): readonly B20SearchCandidate[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return entries.filter(
    (e) =>
      e.displaySymbol.toLowerCase().includes(needle) ||
      e.onchainName.toLowerCase().includes(needle) ||
      e.address.includes(needle),
  );
}
