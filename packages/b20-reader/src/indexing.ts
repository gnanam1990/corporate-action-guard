/**
 * Indexer logic, with the chain taken out.
 *
 * Range planning, log identity, reorg detection and cursor advancement are all pure
 * functions here. That is not tidiness — it is the only way to test a shallow reorg, a deep
 * reorg, a duplicate delivery and an out-of-order page exhaustively, because none of those
 * can be produced on demand from a real endpoint.
 *
 * The I/O adapter in `indexer.ts` does nothing but fetch and hand the results to these.
 */

import type { B20ReaderErrorKind } from './errors.js';

/*
 * Block ranges.
 */

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/**
 * Split a span into ranges no wider than the provider allows.
 *
 * Inclusive on both ends, which is how `eth_getLogs` treats them — an off-by-one here drops
 * exactly one block's logs per page, and the gap is invisible until a corporate action lands
 * in one of them.
 */
export function planRanges(from: bigint, to: bigint, maxWidth: number): readonly BlockRange[] {
  if (to < from) return [];
  if (maxWidth < 1) throw new RangeError('maxWidth must be at least 1');
  const width = BigInt(maxWidth);
  const ranges: BlockRange[] = [];
  for (let start = from; start <= to; start += width) {
    const end = start + width - 1n;
    ranges.push({ fromBlock: start, toBlock: end > to ? to : end });
  }
  return ranges;
}

/**
 * Halve a range that the provider rejected.
 *
 * Providers advertise different caps and some advertise none until you exceed one, so the
 * width is discovered rather than configured. Never shrinks below a single block: if one
 * block is too wide, retrying smaller will not help and the caller needs to know that.
 */
export function shrinkRange(range: BlockRange): BlockRange | undefined {
  const span = range.toBlock - range.fromBlock + 1n;
  if (span <= 1n) return undefined;
  return { fromBlock: range.fromBlock, toBlock: range.fromBlock + span / 2n - 1n };
}

/*
 * Log identity.
 */

/** A raw log, preserved exactly as the provider returned it. */
export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly transactionIndex: number;
  readonly logIndex: number;
  /** Some providers mark a log removed by a reorg instead of omitting it. */
  readonly removed: boolean;
}

/**
 * Chain-unique identity of a log.
 *
 * Deliberately structural — chain, block hash, transaction hash, log index — and never
 * semantic. Two logs carrying the same values are two facts; two deliveries of the same log
 * are one. Deduplicating on decoded content would silently merge a second corporate action
 * that happened to repeat a multiplier.
 *
 * The block hash is in the key on purpose: after a reorg the same transaction can reappear
 * in a different block, and that is a different observation, not a duplicate.
 */
export function logIdentity(chainId: number, log: RawLog): string {
  return [
    String(chainId),
    log.blockHash.toLowerCase(),
    log.transactionHash.toLowerCase(),
    String(log.logIndex),
  ].join(':');
}

/**
 * Drop repeat deliveries while preserving every distinct log.
 *
 * At-least-once delivery is assumed everywhere in this system, so a page that overlaps its
 * predecessor is normal, not an error.
 */
export function dedupeLogs(chainId: number, logs: readonly RawLog[]): readonly RawLog[] {
  const seen = new Set<string>();
  const out: RawLog[] = [];
  for (const log of logs) {
    const id = logIdentity(chainId, log);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(log);
  }
  return out;
}

/**
 * Total order over logs.
 *
 * Block number, then transaction index, then log index. A provider may return pages in any
 * order and may interleave them; the canonical projection must not depend on that.
 */
export function orderLogs(logs: readonly RawLog[]): readonly RawLog[] {
  return [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
    return a.logIndex - b.logIndex;
  });
}

/*
 * Reorg detection.
 */

/** One entry in the chain of block hashes the indexer has already accepted. */
export interface BlockRef {
  readonly number: bigint;
  readonly hash: string;
  readonly parentHash: string;
}

export type ReorgOutcome =
  | { readonly kind: 'CONSISTENT' }
  /** The chain diverged at a block still inside the lookback. Rewind and replay from there. */
  | { readonly kind: 'REORG'; readonly forkPoint: bigint; readonly depth: bigint }
  /** The divergence is older than the lookback. Automatic replay would be a guess. */
  | { readonly kind: 'BEYOND_LOOKBACK'; readonly oldestKnown: bigint };

/**
 * Compare freshly observed blocks against what was accepted before.
 *
 * The check is parent-hash linkage, not block number: a reorg replaces blocks at the same
 * heights, so heights alone always look consistent. The first height where the hash differs
 * is the fork point, and everything derived from it is invalid.
 */
export function detectReorg(
  known: readonly BlockRef[],
  observed: readonly BlockRef[],
  lookbackBlocks: bigint,
): ReorgOutcome {
  if (known.length === 0 || observed.length === 0) return { kind: 'CONSISTENT' };

  const knownByNumber = new Map(known.map((b) => [b.number, b]));
  const oldestKnown = known.reduce((min, b) => (b.number < min ? b.number : min), known[0]!.number);
  const newestKnown = known.reduce((max, b) => (b.number > max ? b.number : max), known[0]!.number);

  let forkPoint: bigint | undefined;
  for (const block of [...observed].sort((a, b) => (a.number < b.number ? -1 : 1))) {
    const previous = knownByNumber.get(block.number);
    if (previous === undefined) continue;
    if (previous.hash.toLowerCase() !== block.hash.toLowerCase()) {
      forkPoint = block.number;
      break;
    }
  }

  if (forkPoint === undefined) return { kind: 'CONSISTENT' };

  // Deeper than the window we retained hashes for: we cannot prove what the canonical chain
  // was, and rewriting history from a guess is worse than stopping.
  if (newestKnown - forkPoint > lookbackBlocks || forkPoint < oldestKnown) {
    return { kind: 'BEYOND_LOOKBACK', oldestKnown };
  }
  return { kind: 'REORG', forkPoint, depth: newestKnown - forkPoint + 1n };
}

/*
 * Cursor advancement.
 */

export interface IndexerCursor {
  /** The last block whose logs are durably journaled. Never advanced before that commit. */
  readonly lastIndexedBlock: bigint;
  /** Retained block hashes, newest last, bounded by the lookback. */
  readonly recentBlocks: readonly BlockRef[];
  /** Monotonic fence token, so a resumed worker cannot be overtaken by a stale one. */
  readonly fence: bigint;
}

/**
 * Advance the cursor after a durable commit.
 *
 * The order is the whole point: the caller journals, then calls this. Advancing first and
 * writing second means a crash between them silently skips a range — the failure mode where
 * a corporate action is never observed and nothing reports an error.
 */
export function advanceCursor(
  cursor: IndexerCursor,
  through: bigint,
  observed: readonly BlockRef[],
  lookbackBlocks: bigint,
): IndexerCursor {
  if (through < cursor.lastIndexedBlock) {
    throw new RangeError('a cursor never moves backwards; a reorg rewinds it explicitly');
  }
  const merged = [...cursor.recentBlocks, ...observed]
    .filter((b, i, all) => all.findIndex((o) => o.number === b.number) === i)
    .sort((a, b) => (a.number < b.number ? -1 : 1))
    .filter((b) => b.number > through - lookbackBlocks);
  return { lastIndexedBlock: through, recentBlocks: merged, fence: cursor.fence };
}

/**
 * Rewind after a reorg.
 *
 * Only the cursor and the retained hashes move. Raw observations are never deleted: the
 * journal is append-only, and a compensation record is written instead. What was observed
 * was observed, even if the chain later disagreed.
 */
export function rewindCursor(cursor: IndexerCursor, forkPoint: bigint): IndexerCursor {
  return {
    lastIndexedBlock: forkPoint - 1n,
    recentBlocks: cursor.recentBlocks.filter((b) => b.number < forkPoint),
    fence: cursor.fence + 1n,
  };
}

/**
 * The next range to fetch, given a cursor and a safe head.
 *
 * Returns nothing when the cursor has caught up to the confirmed head, which is the normal
 * steady state and not a condition to log about.
 */
export function nextRange(
  cursor: IndexerCursor,
  safeHead: bigint,
  maxWidth: number,
): BlockRange | undefined {
  const from = cursor.lastIndexedBlock + 1n;
  if (from > safeHead) return undefined;
  const [first] = planRanges(from, safeHead, maxWidth);
  return first;
}

/**
 * The deepest block it is safe to index.
 *
 * Head minus the confirmation depth. Indexing at head means recording blocks that a reorg
 * can delete, and then having to compensate them — which works, but generates avoidable
 * incident noise on every reorg the chain has anyway.
 */
export function safeHead(head: bigint, confirmations: number): bigint {
  const safe = head - BigInt(confirmations);
  return safe < 0n ? 0n : safe;
}

/** Classify a provider error message into a kind the indexer can act on. */
export function classifyProviderError(message: string): B20ReaderErrorKind {
  const text = message.toLowerCase();
  if (/range|too many blocks|block range|limited to|exceed/.test(text)) return 'LOG_RANGE_TOO_WIDE';
  if (/pruned|missing trie|state not available|older than/.test(text)) return 'PRUNED_HISTORY';
  return 'RPC_UNAVAILABLE';
}
