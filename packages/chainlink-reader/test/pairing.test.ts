/**
 * The token-to-feed pairing gate, and the refusal to compare across blocks.
 *
 * Nothing on chain links a B20 token to a Chainlink proxy. The only correspondence available
 * is that the token's symbol stem matches the feed directory's `baseAsset` — a ticker
 * inference, and a ticker is not an identifier. These tests hold that line.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertComparable, ChainlinkReaderError, type TokenFeedPairing } from '../src/index.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PAIRING = JSON.parse(
  readFileSync(path.join(ROOT, 'provenance/base-b20/token-feed-pairing.json'), 'utf8'),
) as {
  policy: { productionValuationRequires: string; inferredUseIsLimitedTo: string[] };
  pairs: { tokenAddress: string; feedProxyAddress: string | null; reviewStatus: string }[];
};

describe('the committed pairing artifact', () => {
  it('claims no review that has not happened', () => {
    // Promotion to REVIEWED_VERIFIED is a human commit naming a published statement that
    // carries both addresses. No script may set it, and today none is set.
    const reviewed = PAIRING.pairs.filter((p) => p.reviewStatus === 'REVIEWED_VERIFIED');
    expect(reviewed).toEqual([]);
  });

  it('limits inferred pairings to display', () => {
    expect(PAIRING.policy.productionValuationRequires).toBe('REVIEWED_VERIFIED');
    expect(PAIRING.policy.inferredUseIsLimitedTo).toEqual(['DISPLAY_POSITION']);
  });
});

describe('block comparability', () => {
  const at = (blockNumber: bigint, blockHash: string) => ({ blockNumber, blockHash });

  it('accepts observations from the same block', () => {
    expect(
      assertComparable([at(100n, `0x${'aa'.repeat(32)}`), at(100n, `0x${'aa'.repeat(32)}`)]),
    ).toBeUndefined();
  });

  it('refuses observations from different heights', () => {
    // Two facts read at different heights describe two different worlds. Comparing them
    // yields an agreement or a conflict that is an artifact of timing — both answers wrong.
    const error = assertComparable([
      at(100n, `0x${'aa'.repeat(32)}`),
      at(101n, `0x${'bb'.repeat(32)}`),
    ]);
    expect(error).toBeInstanceOf(ChainlinkReaderError);
    expect(error?.kind).toBe('EVIDENCE_BLOCK_MISMATCH');
  });

  it('refuses the same height on two different branches', () => {
    // A reorg replaces blocks at the same height, so the number alone proves nothing.
    const error = assertComparable([
      at(100n, `0x${'aa'.repeat(32)}`),
      at(100n, `0x${'cc'.repeat(32)}`),
    ]);
    expect(error?.kind).toBe('EVIDENCE_BLOCK_MISMATCH');
  });

  it('has nothing to say about a single observation', () => {
    expect(assertComparable([at(100n, `0x${'aa'.repeat(32)}`)])).toBeUndefined();
    expect(assertComparable([])).toBeUndefined();
  });
});

describe('pairing shape', () => {
  it('carries the review status on the pairing itself, not beside it', () => {
    // A status kept somewhere else survives only as long as nobody forgets to look it up.
    const pairing: TokenFeedPairing = {
      chainId: 8453,
      tokenAddress: '0xb200000000000000000000c2e324d24d7eecd1fb',
      feedProxyAddress: '0x787f13dea48db0897cbcdd985de77809d837f988',
      feedDecimals: 8,
      reviewStatus: 'INFERRED_UNREVIEWED',
    };
    expect(pairing.reviewStatus).toBe('INFERRED_UNREVIEWED');
  });
});
