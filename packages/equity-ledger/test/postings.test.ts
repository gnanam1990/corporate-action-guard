/**
 * The equity ledger.
 *
 * The defining case is the one that looks like nothing happened: a 10:1 split changes what
 * every holder owns while `balanceOf` is untouched and no `Transfer` is emitted. A ledger
 * that models a corporate action as a token movement is wrong in a way that reconciles
 * against itself, so raw units and share-equivalents balance independently here, and a test
 * asserts a restatement cannot move a raw unit.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unsafeB20 } from '@cag/domain';
import {
  assertBalanced,
  buildCorrection,
  buildRestatement,
  checkConservation,
  dedupeEntries,
  movementIdentity,
  projectPositions,
  type LedgerAccount,
  type LedgerEntry,
} from '../src/index.js';

const CHAIN = 8453;
const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const DECIMALS = unsafeB20.tokenDecimals(8);
const ONE_WAD = 1_000_000_000_000_000_000n;

const holder = (address: string, ownerId?: string): LedgerAccount => ({
  kind: 'HOLDER',
  chainId: CHAIN,
  address,
  ...(ownerId !== undefined ? { ownerId } : {}),
});

const ALICE = holder('0xaaa0000000000000000000000000000000000001', 'alice');
const BOB = holder('0xbbb0000000000000000000000000000000000002', 'bob');
const UNKNOWN: LedgerAccount = {
  kind: 'UNKNOWN_COUNTERPARTY',
  chainId: CHAIN,
  address: '0xccc0000000000000000000000000000000000003',
};

function transfer(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    entryId: 'entry-1',
    kind: 'SEND',
    chainId: CHAIN,
    assetAddress: AAPL,
    tokenDecimals: DECIMALS,
    postings: [
      { account: ALICE, rawDelta: -100_000_000n, shareDelta: -100_000_000n },
      { account: BOB, rawDelta: 100_000_000n, shareDelta: 100_000_000n },
    ],
    atSeconds: 1_788_000_000n,
    blockNumber: 1000n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    logIndex: 0,
    evidenceEventIds: ['event-1'],
    classification: 'UNKNOWN',
    ...overrides,
  };
}

describe('balance rules', () => {
  it('accepts a transfer that conserves raw units and shares', () => {
    expect(assertBalanced(transfer()).balanced).toBe(true);
  });

  it('rejects an entry where raw units appear from nowhere', () => {
    const report = assertBalanced(
      transfer({
        postings: [
          { account: ALICE, rawDelta: -100n, shareDelta: -100n },
          { account: BOB, rawDelta: 200n, shareDelta: 200n },
        ],
      }),
    );
    expect(report.balanced).toBe(false);
    expect(report.violations).toContain('RAW_UNITS_NOT_BALANCED');
    expect(report.rawSum).toBe(100n);
  });

  it('rejects two postings to the same account in one entry', () => {
    // Almost always a fold that lost a dimension. Keeping them separate makes the entry
    // unreadable and the netting invisible.
    const report = assertBalanced(
      transfer({
        postings: [
          { account: ALICE, rawDelta: -100n, shareDelta: -100n },
          { account: ALICE, rawDelta: 100n, shareDelta: 100n },
        ],
      }),
    );
    expect(report.violations).toContain('DUPLICATE_POSTING_IDENTITY');
  });

  it('rejects an empty entry', () => {
    expect(assertBalanced(transfer({ postings: [] })).violations).toContain('EMPTY_ENTRY');
  });

  it('rejects a correction with nothing to correct', () => {
    expect(assertBalanced(transfer({ kind: 'CORRECTION' })).violations).toContain(
      'CORRECTION_WITHOUT_TARGET',
    );
  });
});

describe('a corporate action does not move tokens', () => {
  const restatement = buildRestatement({
    entryId: 'restate-1',
    holder: ALICE,
    chainId: CHAIN,
    assetAddress: AAPL,
    tokenDecimals: DECIMALS,
    rawAmount: unsafeB20.rawAmount(100_000_000n),
    sharesBefore: unsafeB20.shares(100_000_000n),
    sharesAfter: unsafeB20.shares(1_000_000_000n),
    multiplierWad: ONE_WAD * 10n,
    atSeconds: 1_788_000_100n,
    blockNumber: 1100n,
    blockHash: `0x${'33'.repeat(32)}`,
    evidenceEventIds: ['event-multiplier'],
  });

  it('posts zero raw units on both sides', () => {
    // The defining property. A restatement that moved raw units would claim the multiplier
    // change had also transferred tokens, which no B20 corporate action does.
    expect(restatement.postings.every((p) => p.rawDelta === 0n)).toBe(true);
    expect(assertBalanced(restatement).balanced).toBe(true);
  });

  it('is rejected outright if it ever moves a raw unit', () => {
    const broken: LedgerEntry = {
      ...restatement,
      postings: [
        { account: ALICE, rawDelta: 1n, shareDelta: 900_000_000n },
        { account: restatement.postings[1]!.account, rawDelta: -1n, shareDelta: -900_000_000n },
      ],
    };
    expect(assertBalanced(broken).violations).toContain('RESTATEMENT_MOVED_RAW_UNITS');
  });

  it('carries no transaction hash, because lazy activation emits nothing', () => {
    // Fabricating one would make the ledger claim a chain event that never happened.
    expect(restatement.transactionHash).toBeUndefined();
  });

  it('stays UNKNOWN unless a classification is supplied', () => {
    // ADR 0008. A 10x multiplier increase does not become a forward split because it is 10x.
    expect(restatement.classification).toBe('UNKNOWN');
  });

  it('records the multiplier so the restatement can be recomputed from its own record', () => {
    expect(restatement.multiplierWad).toBe(ONE_WAD * 10n);
  });

  it('changes the position in shares and leaves raw units untouched', () => {
    const open: LedgerEntry = transfer({
      entryId: 'open-1',
      kind: 'RECEIVE',
      postings: [
        { account: ALICE, rawDelta: 100_000_000n, shareDelta: 100_000_000n },
        { account: UNKNOWN, rawDelta: -100_000_000n, shareDelta: -100_000_000n },
      ],
    });
    const positions = projectPositions([open, restatement], 1_788_000_200n);
    const alice = positions.find((p) => p.account.ownerId === 'alice');
    expect(alice?.rawAmount).toBe(100_000_000n);
    expect(alice?.shareEquivalent).toBe(1_000_000_000n);
  });
});

describe('metadata changes move nothing', () => {
  it('rejects a metadata entry that touches a position', () => {
    const report = assertBalanced(
      transfer({
        kind: 'METADATA_CHANGE',
        postings: [
          { account: ALICE, rawDelta: 1n, shareDelta: 0n },
          { account: BOB, rawDelta: -1n, shareDelta: 0n },
        ],
      }),
    );
    expect(report.violations).toContain('METADATA_CHANGE_MOVED_POSITION');
  });
});

describe('corrections are new entries', () => {
  it('reverses the original and leaves it in place', () => {
    // History is what actually happened, including the part that was wrong. An auditor asking
    // "what did you believe on the 3rd" needs the wrong answer to still be there.
    const original = transfer();
    const correction = buildCorrection(original, 'entry-2', ['event-correction']);
    expect(correction.correctsEntryId).toBe(original.entryId);
    expect(correction.postings[0]?.rawDelta).toBe(-(original.postings[0]?.rawDelta ?? 0n));
    expect(assertBalanced(correction).balanced).toBe(true);

    const net = projectPositions([original, correction], 1_788_000_000n);
    expect(net.every((p) => p.rawAmount === 0n)).toBe(true);
  });
});

describe('idempotency', () => {
  it('keys a movement by the chain fact, not by the entry id', () => {
    // A re-index produces a new entry id for the same movement, and posting it twice is
    // exactly the failure this guards.
    const first = transfer({ entryId: 'entry-a' });
    const reindexed = transfer({ entryId: 'entry-b' });
    expect(movementIdentity(first)).toBe(movementIdentity(reindexed));
    expect(dedupeEntries([first, reindexed])).toHaveLength(1);
  });

  it('keeps two genuinely different movements', () => {
    expect(dedupeEntries([transfer(), transfer({ logIndex: 1, entryId: 'entry-c' })])).toHaveLength(
      2,
    );
  });

  it('treats a reorged-and-reincluded movement as a new observation', () => {
    // Same transaction, different block. The block hash is in the identity for this reason.
    const original = transfer();
    const reincluded = transfer({ blockHash: `0x${'99'.repeat(32)}`, entryId: 'entry-d' });
    expect(movementIdentity(original)).not.toBe(movementIdentity(reincluded));
  });

  it('keys a restatement on its block and multiplier, since it has no transaction', () => {
    const base = {
      holder: ALICE,
      chainId: CHAIN,
      assetAddress: AAPL,
      tokenDecimals: DECIMALS,
      rawAmount: unsafeB20.rawAmount(1n),
      sharesBefore: unsafeB20.shares(1n),
      sharesAfter: unsafeB20.shares(10n),
      multiplierWad: ONE_WAD * 10n,
      atSeconds: 1n,
      blockNumber: 5n,
      blockHash: `0x${'44'.repeat(32)}`,
      evidenceEventIds: [],
    };
    const a = buildRestatement({ ...base, entryId: 'r-1' });
    const b = buildRestatement({ ...base, entryId: 'r-2' });
    expect(movementIdentity(a)).toBe(movementIdentity(b));
    expect(dedupeEntries([a, b])).toHaveLength(1);
  });
});

describe('positions', () => {
  it('answers about a past block the same way forever', () => {
    const early = transfer({ entryId: 'e1', atSeconds: 100n, blockNumber: 10n });
    const late = transfer({
      entryId: 'e2',
      atSeconds: 200n,
      blockNumber: 20n,
      logIndex: 1,
      postings: [
        { account: ALICE, rawDelta: -50n, shareDelta: -50n },
        { account: BOB, rawDelta: 50n, shareDelta: 50n },
      ],
    });
    const atEarly = projectPositions([early, late], 150n);
    const atEarlyAgain = projectPositions([late, early], 150n);
    expect(JSON.stringify(atEarly, replacer)).toBe(JSON.stringify(atEarlyAgain, replacer));
    expect(atEarly.find((p) => p.account.ownerId === 'alice')?.rawAmount).toBe(-100_000_000n);
  });

  it('drops value entirely when any contributing posting had no safe price', () => {
    // A partial sum presented as a position is worse than an absent one.
    const priced = transfer({
      entryId: 'p1',
      postings: [
        { account: ALICE, rawDelta: -10n, shareDelta: -10n, valueDelta: -100n, valueScale: 8 },
        { account: BOB, rawDelta: 10n, shareDelta: 10n, valueDelta: 100n, valueScale: 8 },
      ],
    });
    const unpriced = transfer({
      entryId: 'p2',
      logIndex: 1,
      postings: [
        { account: ALICE, rawDelta: -5n, shareDelta: -5n },
        { account: BOB, rawDelta: 5n, shareDelta: 5n },
      ],
    });
    const positions = projectPositions([priced, unpriced], 1_788_000_000n);
    expect(positions.find((p) => p.account.ownerId === 'bob')?.value).toBeUndefined();
    expect(positions.find((p) => p.account.ownerId === 'bob')?.rawAmount).toBe(15n);
  });

  it('does not merge two addresses into one owner without an established mapping', () => {
    // Two addresses are not one owner just because the same integration reported both.
    const positions = projectPositions([transfer()], 1_788_000_000n);
    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((p) => p.account.ownerId)).size).toBe(2);
  });
});

describe('conservation across the whole ledger', () => {
  it('holds for any sequence of balanced transfers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 40 }),
        (amounts) => {
          const entries = amounts.map((amount, i) =>
            transfer({
              entryId: `bulk-${String(i)}`,
              logIndex: i,
              postings: [
                { account: ALICE, rawDelta: -amount, shareDelta: -amount },
                { account: BOB, rawDelta: amount, shareDelta: amount },
              ],
            }),
          );
          const report = checkConservation(entries);
          const positions = projectPositions(entries, 1_788_000_000n);
          const totalRaw = positions.reduce((sum, p) => sum + p.rawAmount, 0n);
          return report.rawConserved && totalRaw === 0n;
        },
      ),
    );
  });

  it('names the entry that broke conservation', () => {
    const bad = transfer({
      entryId: 'bad-1',
      postings: [
        { account: ALICE, rawDelta: -1n, shareDelta: -1n },
        { account: BOB, rawDelta: 2n, shareDelta: 2n },
      ],
    });
    const report = checkConservation([transfer(), bad]);
    expect(report.rawConserved).toBe(false);
    expect(report.unbalancedEntryIds).toEqual(['bad-1']);
  });
});

const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;
