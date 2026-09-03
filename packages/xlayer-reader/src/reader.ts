import { createPublicClient, getAddress, http, type Chain, type PublicClient } from 'viem';
import { CORPORATE_ACTION_TOKEN_ABI, WRAPPER_ABI } from './abi.js';
import { XLAYER_LIMITS, XLAYER_MAINNET_CHAIN_ID, xLayerMainnet, xLayerTestnet } from './chains.js';
import { XLayerError } from './errors.js';

export interface ReaderOptions {
  readonly rpcUrl: string;
  readonly expectedChainId: number;
  /** Identifier written to evidence so a read can be attributed to a provider. Never a URL with credentials. */
  readonly providerName: string;
  readonly timeoutMs?: number;
  /**
   * Blocks below `head - confirmationDepth` are treated as settled.
   *
   * X Layer's finality characteristics are not documented in a form this build could
   * verify, so this is a **conservative configurable assumption**, labelled as such in
   * every snapshot it influences (docs/integrations/xlayer.md).
   */
  readonly confirmationDepth?: number;
}

export interface BlockStamp {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestampMs: number;
}

/** Raw observation of one asset's on-chain state, stamped with the block it was read at. */
export interface ChainSnapshot extends BlockStamp {
  readonly chainId: number;
  readonly providerName: string;
  readonly observedAtMs: number;
  readonly tokenAddress: string;
  readonly wrapperAddress: string;
  readonly tokenHasBytecode: boolean;
  readonly wrapperHasBytecode: boolean;
  /** What the wrapper says its underlying is. Undefined when the call failed. */
  readonly wrapperAsset: string | undefined;
  /** Fixed point at `multiplierDecimals`. Undefined when the call failed. */
  readonly currentMultiplier: bigint | undefined;
  readonly newMultiplier: bigint | undefined;
  readonly multiplierNonce: bigint | undefined;
  /** Epoch ms, or undefined when the chain reports the 0 "no schedule" sentinel. */
  readonly scheduledActivationMs: number | undefined;
  readonly tokenDecimals: number | undefined;
  /** Names of reads that failed, so a partial observation is never mistaken for a complete one. */
  readonly failedReads: readonly string[];
  /** True when every read succeeded. Only a complete snapshot may support an ALLOW. */
  readonly complete: boolean;
  readonly confirmationDepth: number;
  readonly settled: boolean;
}

const DEFAULT_CONFIRMATION_DEPTH = 32;

/**
 * Read-only X Layer client.
 *
 * There is no signing method on this class and no account is ever attached, so a mainnet
 * write is not merely forbidden by policy — it is not expressible with this object.
 */
export class XLayerReader {
  private readonly client: PublicClient;
  private readonly expectedChainId: number;
  private readonly providerName: string;
  private readonly confirmationDepth: number;
  private verifiedChainId: number | undefined;

  constructor(private readonly options: ReaderOptions) {
    const chain: Chain =
      options.expectedChainId === XLAYER_MAINNET_CHAIN_ID ? xLayerMainnet : xLayerTestnet;
    this.client = createPublicClient({
      chain,
      transport: http(options.rpcUrl, { timeout: options.timeoutMs ?? 10_000, retryCount: 2 }),
    }) as PublicClient;
    this.expectedChainId = options.expectedChainId;
    this.providerName = options.providerName;
    this.confirmationDepth = options.confirmationDepth ?? DEFAULT_CONFIRMATION_DEPTH;
  }

  /**
   * Confirm the RPC really serves the chain we think it does.
   *
   * A misconfigured URL pointing at a different chain would otherwise return perfectly
   * well-formed answers about the wrong world. Cached after the first success, because the
   * chain id of an endpoint does not change under us.
   */
  async assertChainId(): Promise<number> {
    if (this.verifiedChainId !== undefined) return this.verifiedChainId;
    let actual: number;
    try {
      actual = await this.client.getChainId();
    } catch (err) {
      throw new XLayerError('RPC_UNAVAILABLE', 'could not read eth_chainId', {
        provider: this.providerName,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    if (actual !== this.expectedChainId) {
      throw new XLayerError('WRONG_CHAIN', 'RPC serves a different chain than configured', {
        provider: this.providerName,
        expected: this.expectedChainId,
        actual,
      });
    }
    this.verifiedChainId = actual;
    return actual;
  }

  /** The current head, recorded by number and hash. `latest` is never used without recording what it resolved to. */
  async getHead(): Promise<BlockStamp> {
    await this.assertChainId();
    const block = await this.client.getBlock({ blockTag: 'latest' });
    return {
      blockNumber: block.number,
      blockHash: block.hash,
      blockTimestampMs: Number(block.timestamp) * 1_000,
    };
  }

  /**
   * Does an address hold bytecode at the given block?
   *
   * `eth_getCode == 0x` means there is no contract there. An EOA, a typo, or a
   * self-destructed contract must never pass canonical verification.
   */
  async hasBytecode(address: string, blockNumber: bigint): Promise<boolean> {
    const code = await this.client.getCode({
      address: getAddress(address),
      blockNumber,
    });
    return code !== undefined && code !== '0x' && code.length > 2;
  }

  /**
   * Observe one asset at a single, recorded block.
   *
   * Every read is pinned to the same `blockNumber`, so the snapshot is internally
   * consistent: it cannot mix a multiplier from one block with a nonce from the next.
   * Individual read failures are recorded by name rather than thrown, because a partial
   * observation is still evidence — it just must never be mistaken for a complete one.
   */
  async observeAsset(params: {
    readonly tokenAddress: string;
    readonly wrapperAddress: string;
    readonly at?: BlockStamp;
    readonly nowMs: number;
  }): Promise<ChainSnapshot> {
    await this.assertChainId();
    const at = params.at ?? (await this.getHead());
    const token = getAddress(params.tokenAddress);
    const wrapper = getAddress(params.wrapperAddress);
    const failedReads: string[] = [];

    const [tokenHasBytecode, wrapperHasBytecode] = await Promise.all([
      this.hasBytecode(token, at.blockNumber).catch(() => {
        failedReads.push('eth_getCode(token)');
        return false;
      }),
      this.hasBytecode(wrapper, at.blockNumber).catch(() => {
        failedReads.push('eth_getCode(wrapper)');
        return false;
      }),
    ]);

    const read = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch {
        failedReads.push(name);
        return undefined;
      }
    };

    const call = <const A extends readonly unknown[]>(
      address: `0x${string}`,
      abi: A,
      functionName: string,
    ) =>
      this.client.readContract({
        address,
        abi: abi as never,
        functionName,
        blockNumber: at.blockNumber,
      }) as Promise<unknown>;

    // The multiplier surface is on the TOKEN. Calling it on the wrapper reverts —
    // verified live on 2026-09-03.
    const [wrapperAsset, currentMultiplier, newMultiplier, nonce, activation, decimals] =
      await Promise.all([
        read('wrapper.asset()', () => call(wrapper, WRAPPER_ABI, 'asset') as Promise<string>),
        read(
          'token.getCurrentMultiplier()',
          () => call(token, CORPORATE_ACTION_TOKEN_ABI, 'getCurrentMultiplier') as Promise<bigint>,
        ),
        read(
          'token.newMultiplier()',
          () => call(token, CORPORATE_ACTION_TOKEN_ABI, 'newMultiplier') as Promise<bigint>,
        ),
        read(
          'token.newMultiplierNonce()',
          () => call(token, CORPORATE_ACTION_TOKEN_ABI, 'newMultiplierNonce') as Promise<bigint>,
        ),
        read(
          'token.newMultiplierActivationTime()',
          () =>
            call(
              token,
              CORPORATE_ACTION_TOKEN_ABI,
              'newMultiplierActivationTime',
            ) as Promise<bigint>,
        ),
        read(
          'token.decimals()',
          () => call(token, CORPORATE_ACTION_TOKEN_ABI, 'decimals') as Promise<number>,
        ),
      ]);

    // 0 is the chain's "no scheduled activation" sentinel, matching the API. Reading it as
    // an instant would place every asset permanently inside a guard window around 1970.
    const scheduledActivationMs =
      activation !== undefined && activation > 0n ? Number(activation) * 1_000 : undefined;

    const head = params.at === undefined ? at : await this.getHead().catch(() => at);
    const settled = head.blockNumber - at.blockNumber >= BigInt(this.confirmationDepth);

    return {
      chainId: this.expectedChainId,
      providerName: this.providerName,
      observedAtMs: params.nowMs,
      blockNumber: at.blockNumber,
      blockHash: at.blockHash,
      blockTimestampMs: at.blockTimestampMs,
      tokenAddress: token.toLowerCase(),
      wrapperAddress: wrapper.toLowerCase(),
      tokenHasBytecode,
      wrapperHasBytecode,
      wrapperAsset: typeof wrapperAsset === 'string' ? wrapperAsset.toLowerCase() : undefined,
      currentMultiplier,
      newMultiplier,
      multiplierNonce: nonce,
      scheduledActivationMs,
      tokenDecimals: decimals,
      failedReads,
      complete: failedReads.length === 0,
      confirmationDepth: this.confirmationDepth,
      settled,
    };
  }

  /**
   * Fetch logs, splitting the request to respect the server's hard range cap.
   *
   * X Layer's public RPC rejects any span wider than 100 blocks
   * (`-32602 block range greater than 100 max`), measured 2026-09-03. At ~1 s per block a
   * full window covers roughly 1.7 minutes, so a day of backfill is about 864 calls. The
   * splitting here is not an optimization; without it every historical query fails.
   */
  async getLogsChunked(params: {
    readonly address: string;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly maxRange?: number;
    readonly onChunk?: (from: bigint, to: bigint, count: number) => void;
  }): Promise<
    readonly {
      blockNumber: bigint;
      blockHash: string;
      transactionHash: string;
      logIndex: number;
      topics: readonly string[];
      data: string;
    }[]
  > {
    await this.assertChainId();
    const maxRange = BigInt(params.maxRange ?? XLAYER_LIMITS.maxLogRangeBlocks);
    if (params.toBlock < params.fromBlock) {
      throw new XLayerError('LOG_RANGE_TOO_WIDE', 'toBlock is before fromBlock', {
        fromBlock: params.fromBlock.toString(),
        toBlock: params.toBlock.toString(),
      });
    }

    const out: {
      blockNumber: bigint;
      blockHash: string;
      transactionHash: string;
      logIndex: number;
      topics: readonly string[];
      data: string;
    }[] = [];
    let from = params.fromBlock;

    while (from <= params.toBlock) {
      // Inclusive range: a span of exactly maxRange blocks is [from, from + maxRange - 1].
      const to = from + maxRange - 1n > params.toBlock ? params.toBlock : from + maxRange - 1n;
      const logs = await this.client.getLogs({
        address: getAddress(params.address),
        fromBlock: from,
        toBlock: to,
      });
      params.onChunk?.(from, to, logs.length);
      for (const log of logs) {
        if (
          log.blockNumber === null ||
          log.blockHash === null ||
          log.transactionHash === null ||
          log.logIndex === null
        ) {
          continue;
        }
        out.push({
          blockNumber: log.blockNumber,
          blockHash: log.blockHash.toLowerCase(),
          transactionHash: log.transactionHash.toLowerCase(),
          logIndex: log.logIndex,
          topics: log.topics,
          data: log.data,
        });
      }
      from = to + 1n;
    }
    return out;
  }

  /**
   * Has the chain reorganized under a block we already recorded?
   *
   * Compares the hash now reported at a height against the hash we stored. A differing
   * hash at the same height is a reorg, full stop.
   */
  async detectReorg(recorded: {
    blockNumber: bigint;
    blockHash: string;
  }): Promise<{ reorged: false } | { reorged: true; currentHash: string }> {
    await this.assertChainId();
    try {
      const block = await this.client.getBlock({ blockNumber: recorded.blockNumber });
      const current = block.hash.toLowerCase();
      if (current === recorded.blockHash.toLowerCase()) return { reorged: false };
      return { reorged: true, currentHash: current };
    } catch (err) {
      throw new XLayerError('RPC_UNAVAILABLE', 'could not re-read a recorded block', {
        blockNumber: recorded.blockNumber.toString(),
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
