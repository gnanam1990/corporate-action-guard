/**
 * The equity position ledger.
 *
 * This is a books-and-records engine, not a tax engine. It records what moved, in which
 * units, on whose authority, with which evidence behind it — and it is deliberately unable
 * to answer questions it has no evidence for.
 *
 * The dimension that makes it different from a normal token ledger: **a corporate action
 * changes what a holder owns without moving a single raw unit.** A 10:1 split multiplies
 * every share-equivalent by ten while `balanceOf` is untouched and no `Transfer` is emitted.
 * So raw quantity and share-equivalent quantity are separate posting dimensions that balance
 * independently, and a restatement posts to one without touching the other.
 *
 * Three rules follow, and each has a test:
 *
 * 1. **Raw units balance to zero across every entry.** Value need not — a fee leaves the
 *    system, a price moves — but tokens do not appear or vanish.
 * 2. **A multiplier transition never fabricates a raw Transfer.** The restatement is its own
 *    entry kind, and it posts zero raw on both sides.
 * 3. **A correction is a new entry, never a mutation.** History is what actually happened,
 *    including the part that was wrong.
 *
 * Pure. No database, no clock, no network.
 */

import type { RawAmount, ShareEquivalentAmount, TokenDecimals } from '@cag/domain';

/*
 * Accounts.
 */

export const ACCOUNT_KINDS = [
  /** A wallet or account the integration attributes to one owner. */
  'HOLDER',
  /** A protocol the tokens are sitting inside — a vault, a lending market, an AMM pool. */
  'PROTOCOL',
  /** The token contract's mint/burn boundary. Supply enters and leaves the system here. */
  'ISSUANCE',
  /** Fees and gas, kept out of position accounts so they cannot look like a balance change. */
  'EXPENSE',
  /**
   * Counterparty we cannot name. Explicit rather than assumed: two addresses are not one
   * owner just because the same integration reported both.
   */
  'UNKNOWN_COUNTERPARTY',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export interface LedgerAccount {
  readonly kind: AccountKind;
  /** Owner attribution, when the integration has established one. Never inferred here. */
  readonly ownerId?: string;
  readonly chainId: number;
  readonly address: string;
}

export const accountKey = (account: LedgerAccount): string =>
  [
    account.kind,
    String(account.chainId),
    account.address.toLowerCase(),
    account.ownerId ?? '-',
  ].join(':');

/*
 * Entries and postings.
 */

export const ENTRY_KINDS = [
  'RECEIVE',
  'SEND',
  /** Between two accounts the integration has established belong to the same owner. */
  'INTERNAL_TRANSFER',
  'SWAP',
  'PROTOCOL_DEPOSIT',
  'PROTOCOL_WITHDRAWAL',
  /**
   * A corporate action restating share-equivalents. Raw units do not move; that is the
   * defining property, and `assertBalanced` enforces it.
   */
  'CORPORATE_ACTION_RESTATEMENT',
  /** A name, symbol or metadata change. No position movement at all. */
  'METADATA_CHANGE',
  /** Reverses an earlier entry by posting its opposite. Never edits it. */
  'CORRECTION',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * One side of one entry.
 *
 * `rawDelta` and `shareDelta` are separate because a corporate action moves the second
 * without the first. Both are signed integers; a debit is positive into the account.
 *
 * `valueDelta` is optional and separately scaled: a movement with no safe price evidence is
 * still a real movement, and refusing to record it because the feed was stale would lose the
 * position. Value simply stays absent, and the projection says so.
 */
export interface Posting {
  readonly account: LedgerAccount;
  readonly rawDelta: bigint;
  readonly shareDelta: bigint;
  readonly valueDelta?: bigint;
  readonly valueScale?: number;
}

export const CLASSIFICATION_STATUSES = [
  /** Typed by structured issuer or reference evidence that passed validation. */
  'VERIFIED',
  /** The state change is reconciled; what it *means* is not established. See ADR 0008. */
  'UNKNOWN',
  /** Evidence disagrees. Recorded, never averaged. */
  'CONFLICT',
] as const;
export type ClassificationStatus = (typeof CLASSIFICATION_STATUSES)[number];

export interface LedgerEntry {
  readonly entryId: string;
  readonly kind: EntryKind;
  readonly chainId: number;
  readonly assetAddress: string;
  readonly tokenDecimals: TokenDecimals;
  readonly postings: readonly Posting[];
  /** Block timestamp the entry belongs to. Not a wall clock. */
  readonly atSeconds: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  /** Present for entries derived from a chain movement; absent for a lazy restatement. */
  readonly transactionHash?: string;
  readonly logIndex?: number;
  /** Journal event ids this entry was folded from. */
  readonly evidenceEventIds: readonly string[];
  readonly classification: ClassificationStatus;
  /** The entry this one corrects. Only set on CORRECTION. */
  readonly correctsEntryId?: string;
  /** The multiplier in force, so a restatement can be recomputed from its own record. */
  readonly multiplierWad?: bigint;
}

/*
 * Balance rules.
 */

export const LEDGER_VIOLATIONS = [
  'RAW_UNITS_NOT_BALANCED',
  'SHARES_NOT_BALANCED',
  'RESTATEMENT_MOVED_RAW_UNITS',
  'METADATA_CHANGE_MOVED_POSITION',
  'CORRECTION_WITHOUT_TARGET',
  'EMPTY_ENTRY',
  'MIXED_ASSET',
  'DUPLICATE_POSTING_IDENTITY',
] as const;
export type LedgerViolation = (typeof LEDGER_VIOLATIONS)[number];

export interface BalanceReport {
  readonly balanced: boolean;
  readonly violations: readonly LedgerViolation[];
  readonly rawSum: bigint;
  readonly shareSum: bigint;
}

/**
 * Check one entry's internal consistency.
 *
 * Raw units must sum to zero: tokens do not appear or vanish, and a fee is a posting to an
 * expense account rather than a shortfall. Share-equivalents must also sum to zero for
 * movements — but *not* for a restatement, which is precisely an event that creates or
 * destroys share-equivalents against no raw movement at all.
 */
export function assertBalanced(entry: LedgerEntry): BalanceReport {
  const violations: LedgerViolation[] = [];

  if (entry.postings.length === 0) violations.push('EMPTY_ENTRY');

  const rawSum = entry.postings.reduce((sum, p) => sum + p.rawDelta, 0n);
  const shareSum = entry.postings.reduce((sum, p) => sum + p.shareDelta, 0n);

  if (rawSum !== 0n) violations.push('RAW_UNITS_NOT_BALANCED');

  if (entry.kind === 'CORPORATE_ACTION_RESTATEMENT') {
    // The defining property. A restatement that moved raw units would mean the multiplier
    // change had somehow also transferred tokens, which no B20 corporate action does.
    if (entry.postings.some((p) => p.rawDelta !== 0n)) {
      violations.push('RESTATEMENT_MOVED_RAW_UNITS');
    }
  } else if (entry.kind === 'METADATA_CHANGE') {
    if (entry.postings.some((p) => p.rawDelta !== 0n || p.shareDelta !== 0n)) {
      violations.push('METADATA_CHANGE_MOVED_POSITION');
    }
  } else if (shareSum !== 0n) {
    violations.push('SHARES_NOT_BALANCED');
  }

  if (entry.kind === 'CORRECTION' && entry.correctsEntryId === undefined) {
    violations.push('CORRECTION_WITHOUT_TARGET');
  }

  // Two postings to the same account inside one entry are almost always a fold that lost a
  // dimension; keeping them separate makes the entry unreadable and the netting invisible.
  const keys = entry.postings.map((p) => accountKey(p.account));
  if (new Set(keys).size !== keys.length) violations.push('DUPLICATE_POSTING_IDENTITY');

  return { balanced: violations.length === 0, violations, rawSum, shareSum };
}

/*
 * Positions.
 */

export interface Position {
  readonly accountKey: string;
  readonly account: LedgerAccount;
  readonly chainId: number;
  readonly assetAddress: string;
  readonly rawAmount: bigint;
  readonly shareEquivalent: bigint;
  /** Absent when no entry contributing to this position carried safe price evidence. */
  readonly value?: bigint;
  readonly valueScale?: number;
  readonly asOfBlock: bigint;
  readonly asOfSeconds: bigint;
  readonly entryCount: number;
}

/**
 * Fold entries into positions at a point in time.
 *
 * `atSeconds` is inclusive and exclusive of anything later, so a query about block *n*
 * returns the same answer forever. Entries are ordered by block, transaction and log index
 * before folding, so the result cannot depend on how the caller paginated them.
 */
export function projectPositions(
  entries: readonly LedgerEntry[],
  atSeconds: bigint,
): readonly Position[] {
  const ordered = [...entries]
    .filter((e) => e.atSeconds <= atSeconds)
    .sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
      if ((a.logIndex ?? 0) !== (b.logIndex ?? 0)) return (a.logIndex ?? 0) - (b.logIndex ?? 0);
      return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
    });

  const positions = new Map<string, Position>();

  for (const entry of ordered) {
    for (const posting of entry.postings) {
      const key = `${accountKey(posting.account)}|${String(entry.chainId)}:${entry.assetAddress}`;
      const previous = positions.get(key);
      const hasValue = posting.valueDelta !== undefined;

      positions.set(key, {
        accountKey: key,
        account: posting.account,
        chainId: entry.chainId,
        assetAddress: entry.assetAddress,
        rawAmount: (previous?.rawAmount ?? 0n) + posting.rawDelta,
        shareEquivalent: (previous?.shareEquivalent ?? 0n) + posting.shareDelta,
        // Value is carried only while every contributing posting had it. One posting with no
        // safe price makes the running total meaningless, and a partial sum presented as a
        // position is worse than an absent one.
        ...(hasValue && (previous === undefined || previous.value !== undefined)
          ? {
              value: (previous?.value ?? 0n) + (posting.valueDelta ?? 0n),
              valueScale: posting.valueScale ?? previous?.valueScale ?? 0,
            }
          : {}),
        asOfBlock: entry.blockNumber,
        asOfSeconds: entry.atSeconds,
        entryCount: (previous?.entryCount ?? 0) + 1,
      });
    }
  }

  return [...positions.values()].sort((a, b) => a.accountKey.localeCompare(b.accountKey));
}

/**
 * Build the restatement entry for a corporate action.
 *
 * Both sides post zero raw units, which is what makes the "a split does not move tokens"
 * invariant structural rather than a convention. The share delta is the difference between
 * the share-equivalent before and after, against an issuance-side contra posting so the
 * entry still balances in the share dimension it changes.
 *
 * `classification` is passed in and defaults to UNKNOWN. This function will not infer that a
 * multiplier increase is a split — see ADR 0008.
 */
export function buildRestatement(input: {
  readonly entryId: string;
  readonly holder: LedgerAccount;
  readonly chainId: number;
  readonly assetAddress: string;
  readonly tokenDecimals: TokenDecimals;
  readonly rawAmount: RawAmount;
  readonly sharesBefore: ShareEquivalentAmount;
  readonly sharesAfter: ShareEquivalentAmount;
  readonly multiplierWad: bigint;
  readonly atSeconds: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly evidenceEventIds: readonly string[];
  readonly classification?: ClassificationStatus;
}): LedgerEntry {
  const delta = input.sharesAfter - input.sharesBefore;
  const issuance: LedgerAccount = {
    kind: 'ISSUANCE',
    chainId: input.chainId,
    address: input.assetAddress,
  };

  return {
    entryId: input.entryId,
    kind: 'CORPORATE_ACTION_RESTATEMENT',
    chainId: input.chainId,
    assetAddress: input.assetAddress,
    tokenDecimals: input.tokenDecimals,
    postings: [
      { account: input.holder, rawDelta: 0n, shareDelta: delta },
      { account: issuance, rawDelta: 0n, shareDelta: -delta },
    ],
    atSeconds: input.atSeconds,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    evidenceEventIds: input.evidenceEventIds,
    // A restatement has no transaction: lazy activation emits nothing at all. Fabricating one
    // would make the ledger claim a chain event that never happened.
    classification: input.classification ?? 'UNKNOWN',
    multiplierWad: input.multiplierWad,
  };
}

/**
 * Reverse an entry by posting its opposite.
 *
 * The original stays. History is what actually happened, including the part that was wrong,
 * and an auditor asking "what did you believe on the 3rd" needs the wrong answer to still be
 * there.
 */
export function buildCorrection(
  original: LedgerEntry,
  entryId: string,
  evidenceEventIds: readonly string[],
): LedgerEntry {
  return {
    ...original,
    entryId,
    kind: 'CORRECTION',
    correctsEntryId: original.entryId,
    postings: original.postings.map((p) => ({
      account: p.account,
      rawDelta: -p.rawDelta,
      shareDelta: -p.shareDelta,
      ...(p.valueDelta !== undefined
        ? { valueDelta: -p.valueDelta, valueScale: p.valueScale ?? 0 }
        : {}),
    })),
    evidenceEventIds,
  };
}

/*
 * Conservation.
 */

export interface ConservationReport {
  readonly rawConserved: boolean;
  readonly rawImbalance: bigint;
  readonly unbalancedEntryIds: readonly string[];
  readonly entryCount: number;
}

/**
 * Check the whole ledger, not just one entry.
 *
 * Every entry balancing individually does not prove the set does: a duplicated entry
 * balances perfectly and still doubles a position. The caller pairs this with the
 * idempotency identity check, which is where duplicates are actually caught.
 */
export function checkConservation(entries: readonly LedgerEntry[]): ConservationReport {
  const unbalanced: string[] = [];
  let imbalance = 0n;
  for (const entry of entries) {
    const report = assertBalanced(entry);
    if (!report.balanced) unbalanced.push(entry.entryId);
    imbalance += report.rawSum;
  }
  return {
    rawConserved: imbalance === 0n && unbalanced.length === 0,
    rawImbalance: imbalance,
    unbalancedEntryIds: unbalanced,
    entryCount: entries.length,
  };
}

/**
 * Canonical identity of a movement, for idempotency.
 *
 * Derived from the chain fact, not from the entry id: a re-index produces a new entry id for
 * the same movement, and posting it twice is exactly the failure this guards. A restatement
 * has no transaction, so it keys on the block and multiplier instead — the same lazy
 * activation re-derived at the same block is the same fact.
 */
export function movementIdentity(entry: LedgerEntry): string {
  if (entry.transactionHash !== undefined) {
    return [
      String(entry.chainId),
      entry.blockHash.toLowerCase(),
      entry.transactionHash.toLowerCase(),
      String(entry.logIndex ?? 0),
      entry.assetAddress.toLowerCase(),
    ].join(':');
  }
  return [
    String(entry.chainId),
    entry.assetAddress.toLowerCase(),
    entry.kind,
    String(entry.blockNumber),
    String(entry.multiplierWad ?? 0n),
    ...entry.postings.map((p) => accountKey(p.account)),
  ].join(':');
}

/** Drop repeat deliveries of the same movement while keeping every distinct one. */
export function dedupeEntries(entries: readonly LedgerEntry[]): readonly LedgerEntry[] {
  const seen = new Set<string>();
  const out: LedgerEntry[] = [];
  for (const entry of entries) {
    const identity = movementIdentity(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push(entry);
  }
  return out;
}
