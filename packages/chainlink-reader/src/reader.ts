/**
 * Chainlink reads for Coinbase B20 equity feeds on Base.
 *
 * Three separate reads, never one. An equity feed's `latestRoundData` knows nothing about
 * the sequencer and nothing about the token's pause state, so a verdict derived from it
 * alone would call unsafe data fresh. Each read carries its own block, and two reads taken
 * at incompatible blocks are reported as such rather than compared.
 *
 * The price returned here is always `TOTAL_RETURN_TOKEN_PRICE` — the multiplier-adjusted
 * token price, which is what every Coinbase equity feed on Base publishes. That basis
 * travels with the value into the domain package, where it decides which valuation route is
 * legal. Nothing in this reader multiplies a share-equivalent quantity by it, and nothing in
 * its examples does either.
 */

import type { Address, PublicClient } from 'viem';
import { AGGREGATOR_V3_ABI } from './abi.js';
import type { FeedRound, SequencerStatus } from './freshness.js';

export const BASE_MAINNET_CHAIN_ID = 8453;

/** Chainlink's L2 uptime feed answers 0 for up and 1 for down. */
export const SEQUENCER_UP = 0n;
export const SEQUENCER_DOWN = 1n;

export type ChainlinkErrorKind =
  | 'RPC_UNAVAILABLE'
  | 'WRONG_CHAIN'
  | 'FEED_UNAVAILABLE'
  | 'DECIMALS_MISMATCH'
  | 'PAIRING_UNREVIEWED'
  | 'EVIDENCE_BLOCK_MISMATCH';

export class ChainlinkReaderError extends Error {
  override readonly name = 'ChainlinkReaderError';
  constructor(
    readonly kind: ChainlinkErrorKind,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export type FeedOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ChainlinkReaderError };

/**
 * A token-to-feed pairing, carrying its review status.
 *
 * Nothing on chain links a B20 token to a Chainlink proxy: `IB20Asset` never references a
 * feed and the aggregator never references a token. The only available correspondence is
 * that the token's symbol stem matches the feed directory's `baseAsset`, which is a ticker
 * inference — and a ticker is not an identifier. So the status travels with the pairing and
 * the reader refuses to use an unreviewed one for anything but display.
 */
export interface TokenFeedPairing {
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly feedProxyAddress: string;
  readonly feedDecimals: number;
  readonly reviewStatus: 'REVIEWED_VERIFIED' | 'INFERRED_UNREVIEWED' | 'CONFLICT' | 'ABSENT';
}

export interface FeedObservation {
  readonly feedProxyAddress: string;
  readonly round: FeedRound;
  /** Always this basis on Base. Carried so the valuation engine can refuse route B. */
  readonly priceBasis: 'TOTAL_RETURN_TOKEN_PRICE';
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly observedAt: string;
}

export interface SequencerObservation {
  readonly feedProxyAddress: string;
  readonly status: SequencerStatus;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly observedAt: string;
}

export interface ChainlinkReadSessionOptions {
  readonly client: PublicClient;
  readonly expectedChainId: number;
  readonly rpcEndpointId: string;
  readonly confirmations: number;
  readonly now: () => string;
}

/**
 * A read-only session pinned to one chain and one block.
 *
 * Same discipline as the B20 reader: the chain is asserted before the first read, and every
 * observation records the block it came from so a later comparison can refuse to mix them.
 */
export class ChainlinkReadSession {
  private constructor(
    private readonly options: ChainlinkReadSessionOptions,
    readonly blockNumber: bigint,
    readonly blockHash: string,
    readonly blockTimestampSeconds: bigint,
  ) {}

  static async open(options: ChainlinkReadSessionOptions): Promise<ChainlinkReadSession> {
    const chainId = await options.client.getChainId();
    if (chainId !== options.expectedChainId) {
      throw new ChainlinkReaderError(
        'WRONG_CHAIN',
        `RPC reports chain ${String(chainId)}, expected ${String(options.expectedChainId)}`,
        { expected: options.expectedChainId, observed: chainId },
      );
    }
    const head = await options.client.getBlockNumber();
    const target = head - BigInt(options.confirmations);
    const blockNumber = target < 0n ? 0n : target;
    const block = await options.client.getBlock({ blockNumber });
    return new ChainlinkReadSession(options, blockNumber, block.hash ?? '', block.timestamp);
  }

  /**
   * Read one equity feed.
   *
   * `pairing.reviewStatus` is checked before the call, not after. Reading first and refusing
   * afterwards would put an unreviewed price into memory next to a reviewed one, and the
   * distinction survives only as long as nobody forgets to check it.
   */
  async readEquityFeed(
    pairing: TokenFeedPairing,
    allowUnreviewed: boolean,
  ): Promise<FeedOutcome<FeedObservation>> {
    if (pairing.reviewStatus === 'ABSENT' || pairing.reviewStatus === 'CONFLICT') {
      return {
        ok: false,
        error: new ChainlinkReaderError(
          'PAIRING_UNREVIEWED',
          `no usable feed pairing for ${pairing.tokenAddress} (${pairing.reviewStatus})`,
          { tokenAddress: pairing.tokenAddress, reviewStatus: pairing.reviewStatus },
        ),
      };
    }
    if (pairing.reviewStatus === 'INFERRED_UNREVIEWED' && !allowUnreviewed) {
      return {
        ok: false,
        error: new ChainlinkReaderError(
          'PAIRING_UNREVIEWED',
          `the pairing for ${pairing.tokenAddress} is a ticker inference, not a reviewed ` +
            'statement naming both addresses; permitted for display only',
          { tokenAddress: pairing.tokenAddress, feedProxyAddress: pairing.feedProxyAddress },
        ),
      };
    }

    try {
      const read = async <T>(functionName: string): Promise<T> =>
        (await (
          this.options.client.readContract as unknown as (
            input: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          address: pairing.feedProxyAddress as Address,
          abi: AGGREGATOR_V3_ABI,
          functionName,
          blockNumber: this.blockNumber,
        })) as T;

      const decimals = await read<number>('decimals');
      const data = await read<readonly [bigint, bigint, bigint, bigint, bigint]>('latestRoundData');

      // The manifest records what a human reviewed. A live feed reporting different decimals
      // is not a newer truth, it is a mismatch: silently adopting it would rescale every
      // value computed from this feed by orders of magnitude.
      if (decimals !== pairing.feedDecimals) {
        return {
          ok: false,
          error: new ChainlinkReaderError(
            'DECIMALS_MISMATCH',
            `feed reports ${String(decimals)} decimals, the reviewed manifest records ` +
              `${String(pairing.feedDecimals)}`,
            { feedProxyAddress: pairing.feedProxyAddress },
          ),
        };
      }

      return {
        ok: true,
        value: {
          feedProxyAddress: pairing.feedProxyAddress.toLowerCase(),
          round: {
            roundId: data[0],
            answer: data[1],
            startedAt: data[2],
            updatedAt: data[3],
            answeredInRound: data[4],
            decimals,
          },
          priceBasis: 'TOTAL_RETURN_TOKEN_PRICE',
          blockNumber: this.blockNumber,
          blockHash: this.blockHash,
          observedAt: this.options.now(),
        },
      };
    } catch (error) {
      return { ok: false, error: toChainlinkError(error) };
    }
  }

  /** Read the L2 sequencer uptime feed. A separate feed, and a separate read. */
  async readSequencer(proxyAddress: string): Promise<FeedOutcome<SequencerObservation>> {
    try {
      const data = (await (
        this.options.client.readContract as unknown as (
          input: Record<string, unknown>,
        ) => Promise<unknown>
      )({
        address: proxyAddress as Address,
        abi: AGGREGATOR_V3_ABI,
        functionName: 'latestRoundData',
        blockNumber: this.blockNumber,
      })) as readonly [bigint, bigint, bigint, bigint, bigint];

      return {
        ok: true,
        value: {
          feedProxyAddress: proxyAddress.toLowerCase(),
          status: { answer: data[1], startedAt: data[2] },
          blockNumber: this.blockNumber,
          blockHash: this.blockHash,
          observedAt: this.options.now(),
        },
      };
    } catch (error) {
      // A sequencer read that fails is not "the sequencer is up". Every caller must treat
      // this as unavailable and fail closed for value-sensitive actions.
      return { ok: false, error: toChainlinkError(error) };
    }
  }
}

/**
 * Refuse to compare observations from different blocks.
 *
 * Two facts read at different heights describe two different worlds. Comparing them produces
 * an agreement or a conflict that is an artifact of timing, and both answers are wrong.
 */
export function assertComparable(
  observations: readonly { blockNumber: bigint; blockHash: string }[],
): ChainlinkReaderError | undefined {
  if (observations.length < 2) return undefined;
  const [first] = observations;
  if (first === undefined) return undefined;
  for (const observation of observations) {
    if (
      observation.blockNumber !== first.blockNumber ||
      observation.blockHash !== first.blockHash
    ) {
      return new ChainlinkReaderError(
        'EVIDENCE_BLOCK_MISMATCH',
        'observations were read at different blocks and cannot be compared',
        {
          blocks: observations.map((o) => `${String(o.blockNumber)}@${o.blockHash.slice(0, 10)}`),
        },
      );
    }
  }
  return undefined;
}

export function toChainlinkError(error: unknown): ChainlinkReaderError {
  if (error instanceof ChainlinkReaderError) return error;
  const message = String(
    (error as { shortMessage?: string })?.shortMessage ?? (error as Error)?.message ?? error,
  );
  return new ChainlinkReaderError('RPC_UNAVAILABLE', message.slice(0, 300));
}

export const openChainlinkReadSession = ChainlinkReadSession.open.bind(ChainlinkReadSession);
