/**
 * Indexer logic.
 *
 * Every case here is one that cannot be produced on demand from a real endpoint: a shallow
 * reorg, a deep one, a duplicate delivery, an out-of-order page, a provider that suddenly
 * narrows its range limit. That is why the logic is pure and the RPC is somewhere else.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  classifyProviderError,
  dedupeLogs,
  detectReorg,
  logIdentity,
  nextRange,
  orderLogs,
  planRanges,
  rewindCursor,
  safeHead,
  shrinkRange,
  type BlockRef,
  type IndexerCursor,
  type RawLog,
} from '../src/index.js';

const CHAIN = 8453;

function log(overrides: Partial<RawLog> = {}): RawLog {
  return {
    address: '0xb200000000000000000000c2e324d24d7eecd1fb',
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    data: '0x',
    blockNumber: 100n,
    blockHash: `0x${'11'.repeat(32)}`,
    transactionHash: `0x${'22'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    ...overrides,
  };
}

const ref = (number: bigint, hash: string, parentHash = `0x${'00'.repeat(32)}`): BlockRef => ({
  number,
  hash,
  parentHash,
});

describe('range planning', () => {
  it('covers a span exactly, inclusive on both ends', () => {
    // An off-by-one drops one block's logs per page, and the gap is invisible until a
    // corporate action lands in one of them.
    const ranges = planRanges(100n, 250n, 50);
    expect(ranges).toEqual([
      { fromBlock: 100n, toBlock: 149n },
      { fromBlock: 150n, toBlock: 199n },
      { fromBlock: 200n, toBlock: 249n },
      { fromBlock: 250n, toBlock: 250n },
    ]);
  });

  it('leaves no gap and no overlap, for any span and width', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 5_000n }),
        fc.integer({ min: 1, max: 500 }),
        (from, span, width) => {
          const to = from + span;
          const ranges = planRanges(from, to, width);
          if (ranges.length === 0) return false;
          if (ranges[0]!.fromBlock !== from) return false;
          if (ranges.at(-1)!.toBlock !== to) return false;
          for (let i = 1; i < ranges.length; i++) {
            if (ranges[i]!.fromBlock !== ranges[i - 1]!.toBlock + 1n) return false;
          }
          return ranges.every((r) => r.toBlock - r.fromBlock + 1n <= BigInt(width));
        },
      ),
    );
  });

  it('returns nothing when the cursor is ahead of the span', () => {
    expect(planRanges(200n, 100n, 50)).toEqual([]);
  });

  it('halves a rejected range, and gives up at one block', () => {
    // Providers advertise different caps, and some advertise none until you exceed one, so
    // the width is discovered rather than configured.
    expect(shrinkRange({ fromBlock: 100n, toBlock: 199n })).toEqual({
      fromBlock: 100n,
      toBlock: 149n,
    });
    // If a single block is too wide, retrying smaller cannot help and the caller must know.
    expect(shrinkRange({ fromBlock: 100n, toBlock: 100n })).toBeUndefined();
  });

  it('classifies a provider range rejection distinctly from an outage', () => {
    expect(classifyProviderError('eth_getLogs is limited to a 10,000 range')).toBe(
      'LOG_RANGE_TOO_WIDE',
    );
    expect(classifyProviderError('block range greater than 100 max')).toBe('LOG_RANGE_TOO_WIDE');
    expect(classifyProviderError('missing trie node, state pruned')).toBe('PRUNED_HISTORY');
    expect(classifyProviderError('socket hang up')).toBe('RPC_UNAVAILABLE');
  });
});

describe('log identity', () => {
  it('is structural, never semantic', () => {
    // Two logs carrying the same decoded values are two facts. Deduplicating on content
    // would merge a second corporate action that happened to repeat a multiplier.
    const a = log({ logIndex: 0 });
    const b = log({ logIndex: 1 });
    expect(logIdentity(CHAIN, a)).not.toBe(logIdentity(CHAIN, b));
  });

  it('includes the block hash, so a reorged-and-reincluded log is a new observation', () => {
    const original = log({ blockHash: `0x${'11'.repeat(32)}` });
    const reincluded = log({ blockHash: `0x${'99'.repeat(32)}` });
    expect(logIdentity(CHAIN, original)).not.toBe(logIdentity(CHAIN, reincluded));
  });

  it('separates the same log on two chains', () => {
    expect(logIdentity(8453, log())).not.toBe(logIdentity(84532, log()));
  });

  it('drops repeat deliveries and keeps every distinct log', () => {
    // At-least-once delivery is assumed, so an overlapping page is normal, not an error.
    const logs = [log(), log(), log({ logIndex: 1 })];
    expect(dedupeLogs(CHAIN, logs)).toHaveLength(2);
  });

  it('orders by block, transaction, then log index regardless of arrival order', () => {
    const shuffled = [
      log({ blockNumber: 101n, logIndex: 0 }),
      log({ blockNumber: 100n, transactionIndex: 1, logIndex: 0 }),
      log({ blockNumber: 100n, transactionIndex: 0, logIndex: 3 }),
    ];
    const ordered = orderLogs(shuffled);
    expect(ordered.map((l) => [l.blockNumber, l.transactionIndex, l.logIndex])).toEqual(
      [
        [100n, 0, 3],
        [100n, 1, 0],
        [101n, 0],
      ].map((x) => (x.length === 2 ? [x[0], x[1], 0] : x)),
    );
  });
});

describe('reorg detection', () => {
  const known = [ref(100n, '0xaa'), ref(101n, '0xbb'), ref(102n, '0xcc')];

  it('says nothing happened when the hashes still match', () => {
    expect(detectReorg(known, [ref(101n, '0xbb'), ref(102n, '0xcc')], 50n)).toEqual({
      kind: 'CONSISTENT',
    });
  });

  it('finds the fork by hash, not by height', () => {
    // A reorg replaces blocks at the same heights, so heights alone always look consistent.
    const outcome = detectReorg(known, [ref(101n, '0xbb'), ref(102n, '0xdd')], 50n);
    expect(outcome).toEqual({ kind: 'REORG', forkPoint: 102n, depth: 1n });
  });

  it('reports the earliest divergence, not the first one it happens to see', () => {
    const outcome = detectReorg(known, [ref(102n, '0xdd'), ref(101n, '0xee')], 50n);
    expect(outcome.kind === 'REORG' && outcome.forkPoint).toBe(101n);
  });

  it('refuses to reconstruct a reorg deeper than the retained window', () => {
    // Rewriting history from a guess is worse than stopping and asking for review.
    const outcome = detectReorg(known, [ref(100n, '0xzz')], 1n);
    expect(outcome.kind).toBe('BEYOND_LOOKBACK');
  });

  it('is consistent when there is nothing to compare against yet', () => {
    expect(detectReorg([], [ref(100n, '0xaa')], 50n)).toEqual({ kind: 'CONSISTENT' });
    expect(detectReorg(known, [], 50n)).toEqual({ kind: 'CONSISTENT' });
  });
});

describe('cursor', () => {
  const cursor: IndexerCursor = {
    lastIndexedBlock: 100n,
    recentBlocks: [ref(99n, '0x99'), ref(100n, '0xaa')],
    fence: 1n,
  };

  it('never moves backwards on an advance', () => {
    // A cursor going backwards silently re-indexes, and re-indexing without a reorg record
    // is how duplicate postings appear.
    expect(() => advanceCursor(cursor, 99n, [], 50n)).toThrow(RangeError);
  });

  it('keeps only the lookback window of hashes', () => {
    const advanced = advanceCursor(cursor, 200n, [ref(200n, '0xff')], 5n);
    expect(advanced.lastIndexedBlock).toBe(200n);
    expect(advanced.recentBlocks.every((b) => b.number > 195n)).toBe(true);
  });

  it('rewinds to before the fork and bumps the fence', () => {
    // The fence is what stops a stale worker, still mid-range, from writing over the replay.
    const rewound = rewindCursor(cursor, 100n);
    expect(rewound.lastIndexedBlock).toBe(99n);
    expect(rewound.recentBlocks.map((b) => b.number)).toEqual([99n]);
    expect(rewound.fence).toBe(2n);
  });

  it('stops requesting ranges once it reaches the confirmed head', () => {
    // The steady state, and not a condition worth logging about.
    expect(nextRange({ ...cursor, lastIndexedBlock: 500n }, 500n, 100)).toBeUndefined();
  });

  it('requests the block immediately after the cursor, never re-requesting one', () => {
    expect(nextRange(cursor, 400n, 100)).toEqual({ fromBlock: 101n, toBlock: 200n });
  });
});

describe('safe head', () => {
  it('stays behind head by the confirmation depth', () => {
    // Indexing at head records blocks a reorg can delete, generating avoidable incident
    // noise on every reorg the chain has anyway.
    expect(safeHead(1000n, 200)).toBe(800n);
  });

  it('never goes negative on a young chain', () => {
    expect(safeHead(10n, 200)).toBe(0n);
  });
});
