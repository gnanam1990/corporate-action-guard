/**
 * Read-only Base B20 reads.
 *
 * This package exports no signing API, no wallet client and no way to send a transaction.
 * That is the enforcement of ADR 0007 at the package level: a reader that *could* write
 * would eventually be asked to, and a chain-id guard is one deleted line away from a mainnet
 * broadcast.
 *
 * Two behaviours are worth reading the code for.
 *
 * **The chain is asserted once per session, before the first read.** Evidence labelled with a
 * chain it did not come from passes every downstream chain check while being about something
 * else entirely, which is worse than no evidence at all.
 *
 * **A capability answer comes from a call, never from a date or a version string.** A B20
 * token is precompile-backed, and a selector the current hardfork has not dialed reverts with
 * exactly its own four bytes. `uiMultiplier()` (0xa60bf13d) reverts with `0xa60bf13d` on Base
 * mainnet today. That gives an exact probe, and it is the difference between reporting
 * `UNSUPPORTED_CAPABILITY` and reporting the false negative "no update is scheduled".
 */

import type { Address, PublicClient } from 'viem';
import {
  B20_FACTORY_ABI,
  B20_FACTORY_ADDRESS,
  BERYL_READ_ABI,
  BERYL_SELECTORS,
  COBALT_READ_ABI,
  COBALT_SELECTORS,
  PAUSABLE_FEATURES,
  type PausableFeature,
} from './abi.js';
import { B20ReaderError, WrongChainError } from './errors.js';

export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Where and when an observation was made. Every returned value carries one. */
export interface ObservationContext {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestampSeconds: bigint;
  /** Host only. A committed or logged endpoint must never carry its API key. */
  readonly rpcEndpointId: string;
  readonly observedAt: string;
}

export type ReadOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: B20ReaderError };

export const CAPABILITY_OUTCOMES = ['LIVE', 'NOT_DIALED', 'REVERTED', 'UNAVAILABLE'] as const;
export type CapabilityOutcome = (typeof CAPABILITY_OUTCOMES)[number];

export interface CapabilityProbe {
  readonly name: string;
  readonly selector: string;
  readonly surface: 'BERYL' | 'COBALT_ERC8056';
  readonly outcome: CapabilityOutcome;
  readonly revertData?: string;
}

export interface B20Capabilities {
  readonly probes: readonly CapabilityProbe[];
  readonly berylLive: boolean;
  /** True only when the whole scheduling surface answers. Partial is not usable. */
  readonly scheduledUpdatesLive: boolean;
  readonly context: ObservationContext;
}

/** State readable through the Beryl surface, which is all Base mainnet offers today. */
export interface B20AssetState {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupplyRaw: bigint;
  readonly multiplierWad: bigint;
  readonly wadPrecision: bigint;
  readonly supplyCapRaw: bigint;
  readonly pausedFeatures: readonly PausableFeature[];
  readonly factoryInitialized: boolean;
  readonly context: ObservationContext;
}

/** The scheduling surface, when it is dialed. Absent is `undefined`, never `0`. */
export interface B20ScheduledUpdate {
  readonly pendingMultiplierWad: bigint;
  readonly effectiveAtSeconds: bigint;
  readonly context: ObservationContext;
}

export interface B20ReadSessionOptions {
  readonly client: PublicClient;
  readonly expectedChainId: number;
  readonly rpcEndpointId: string;
  /** Depth behind head at which observations are taken. Head can still be reorganized out. */
  readonly confirmations: number;
  /** Supplied so the package holds no clock; replay stays reproducible. */
  readonly now: () => string;
}

/**
 * Extract revert data from a viem error.
 *
 * Walks the cause chain and falls back to the message text, because providers differ in
 * where they put it and losing it would collapse `NOT_DIALED` into `RPC_UNAVAILABLE` — the
 * exact conflation this reader exists to avoid.
 */
export function extractRevertData(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 12; depth++) {
    const candidate = current as {
      data?: unknown;
      raw?: unknown;
      details?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    for (const value of [candidate.data, candidate.raw]) {
      if (typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)) return value.toLowerCase();
    }
    const text = String(candidate.details ?? candidate.message ?? '');
    const match = /data:\s*"?(0x[0-9a-fA-F]+)"?/.exec(text);
    if (match?.[1] !== undefined) return match[1].toLowerCase();
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Classify one probe from what came back.
 *
 * `NOT_DIALED` requires the revert data to equal the called selector exactly. A revert with
 * any other payload is a real answer about state and is reported as `REVERTED`; a transport
 * failure is `UNAVAILABLE` and says nothing at all.
 */
export function classifyProbe(selector: string, error: unknown): CapabilityOutcome {
  const data = extractRevertData(error);
  if (data === undefined) return 'UNAVAILABLE';
  if (data === selector.toLowerCase()) return 'NOT_DIALED';
  return 'REVERTED';
}

/**
 * A read-only session against one chain at one block.
 *
 * Construct with `openB20ReadSession`, which asserts the chain first. There is no way to
 * obtain one without that assertion having passed.
 */
export class B20ReadSession {
  private constructor(
    private readonly options: B20ReadSessionOptions,
    readonly context: ObservationContext,
  ) {}

  /**
   * Open a session, asserting the chain and pinning the observation block.
   *
   * Throws rather than returning a result: a session against the wrong chain has no safe
   * degraded mode, and every read taken through it would be mislabelled.
   */
  static async open(options: B20ReadSessionOptions): Promise<B20ReadSession> {
    const chainId = await options.client.getChainId();
    if (chainId !== options.expectedChainId) {
      throw new WrongChainError(options.expectedChainId, chainId);
    }
    const head = await options.client.getBlockNumber();
    const target = head - BigInt(options.confirmations);
    const blockNumber = target < 0n ? 0n : target;
    const block = await options.client.getBlock({ blockNumber });
    return new B20ReadSession(options, {
      chainId,
      blockNumber,
      blockHash: block.hash ?? '',
      blockTimestampSeconds: block.timestamp,
      rpcEndpointId: options.rpcEndpointId,
      observedAt: options.now(),
    });
  }

  /**
   * Probe the capability surface at this session's block.
   *
   * Every selector is probed even when an earlier one failed, because a partial surface is a
   * real and reportable state — and because assuming uniformity is how a per-asset difference
   * becomes an unnoticed wrong answer.
   */
  async probeCapabilities(address: string): Promise<B20Capabilities> {
    const probes: CapabilityProbe[] = [];

    const probe = async (
      name: string,
      selector: string,
      surface: 'BERYL' | 'COBALT_ERC8056',
      data: string,
    ): Promise<void> => {
      try {
        await this.options.client.call({
          to: address as Address,
          data: data as `0x${string}`,
          blockNumber: this.context.blockNumber,
        });
        probes.push({ name, selector, surface, outcome: 'LIVE' });
      } catch (error) {
        const outcome = classifyProbe(selector, error);
        const revertData = extractRevertData(error);
        probes.push({
          name,
          selector,
          surface,
          outcome,
          ...(revertData !== undefined ? { revertData } : {}),
        });
      }
    };

    // Zero-argument selectors are probed bare; the argument-taking ones get a zero word,
    // which is a valid encoding for every parameter type probed here.
    const ZERO_WORD = '0'.repeat(64);
    await probe('multiplier', BERYL_SELECTORS.multiplier, 'BERYL', BERYL_SELECTORS.multiplier);
    await probe(
      'toScaledBalance',
      BERYL_SELECTORS.toScaledBalance,
      'BERYL',
      `${BERYL_SELECTORS.toScaledBalance}${ZERO_WORD}`,
    );
    await probe(
      'isPaused',
      BERYL_SELECTORS.isPaused,
      'BERYL',
      `${BERYL_SELECTORS.isPaused}${ZERO_WORD}`,
    );
    await probe(
      'uiMultiplier',
      COBALT_SELECTORS.uiMultiplier,
      'COBALT_ERC8056',
      COBALT_SELECTORS.uiMultiplier,
    );
    await probe(
      'newUIMultiplier',
      COBALT_SELECTORS.newUIMultiplier,
      'COBALT_ERC8056',
      COBALT_SELECTORS.newUIMultiplier,
    );
    await probe(
      'effectiveAt',
      COBALT_SELECTORS.effectiveAt,
      'COBALT_ERC8056',
      COBALT_SELECTORS.effectiveAt,
    );

    return summarizeCapabilities(probes, this.context);
  }

  /** Read the Beryl state surface at this session's block. */
  async readAssetState(address: string): Promise<ReadOutcome<B20AssetState>> {
    try {
      // viem infers the argument tuple from the ABI literal; the reads here are dynamic by
      // name, so the call is widened once, here, rather than at every call site.
      const read = async <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
        (await (
          this.options.client.readContract as unknown as (
            input: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          address: address as Address,
          abi: BERYL_READ_ABI,
          functionName,
          args,
          blockNumber: this.context.blockNumber,
        })) as T;

      const name = await read<string>('name');
      const symbol = await read<string>('symbol');
      const decimals = await read<number>('decimals');
      const totalSupplyRaw = await read<bigint>('totalSupply');
      const multiplierWad = await read<bigint>('multiplier');
      const wadPrecision = await read<bigint>('WAD_PRECISION');
      const supplyCapRaw = await read<bigint>('supplyCap');

      const pausedFeatures: PausableFeature[] = [];
      for (const [index, feature] of PAUSABLE_FEATURES.entries()) {
        if (await read<boolean>('isPaused', [index])) pausedFeatures.push(feature);
      }

      const factoryInitialized = (await this.options.client.readContract({
        address: B20_FACTORY_ADDRESS as Address,
        abi: B20_FACTORY_ABI,
        functionName: 'isB20Initialized',
        args: [address as Address],
        blockNumber: this.context.blockNumber,
      })) as boolean;

      // A token whose own WAD_PRECISION is not 1e18 would silently break every conversion
      // in the domain package, which hard-codes the scale the interface documents.
      if (wadPrecision !== 1_000_000_000_000_000_000n) {
        return {
          ok: false,
          error: new B20ReaderError(
            'MALFORMED_RESPONSE',
            `token reports WAD_PRECISION ${String(wadPrecision)}, expected 1e18`,
            { address, wadPrecision: String(wadPrecision) },
          ),
        };
      }

      return {
        ok: true,
        value: {
          address: address.toLowerCase(),
          name,
          symbol,
          decimals,
          totalSupplyRaw,
          multiplierWad,
          wadPrecision,
          supplyCapRaw,
          pausedFeatures,
          factoryInitialized,
          context: this.context,
        },
      };
    } catch (error) {
      return { ok: false, error: toReaderError(error) };
    }
  }

  /** Read a raw balance. Raw units only — conversion to shares happens in the domain. */
  async readRawBalance(address: string, account: string): Promise<ReadOutcome<bigint>> {
    try {
      const value = (await this.options.client.readContract({
        address: address as Address,
        abi: BERYL_READ_ABI,
        functionName: 'balanceOf',
        args: [account as Address],
        blockNumber: this.context.blockNumber,
      })) as bigint;
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: toReaderError(error) };
    }
  }

  /**
   * Read the pending scheduled update, when the surface is dialed.
   *
   * Returns `NOT_DIALED` rather than "nothing pending" when it is not. The caller must
   * surface that as `UNSUPPORTED_CAPABILITY`; treating it as an absence would be the single
   * most dangerous false negative this product can produce.
   */
  async readScheduledUpdate(
    address: string,
    capabilities: B20Capabilities,
  ): Promise<ReadOutcome<B20ScheduledUpdate | undefined>> {
    if (!capabilities.scheduledUpdatesLive) {
      return {
        ok: false,
        error: new B20ReaderError(
          'NOT_DIALED',
          'the scheduled-multiplier surface is not dialed on this chain; ' +
            'this is not the same as "no update is scheduled"',
          { address, chainId: this.context.chainId, blockNumber: String(this.context.blockNumber) },
        ),
      };
    }
    try {
      const read = async (functionName: string): Promise<bigint> =>
        (await (
          this.options.client.readContract as unknown as (
            input: Record<string, unknown>,
          ) => Promise<unknown>
        )({
          address: address as Address,
          abi: COBALT_READ_ABI,
          functionName,
          blockNumber: this.context.blockNumber,
        })) as bigint;

      const pendingMultiplierWad = await read('newUIMultiplier');
      const effectiveAtSeconds = await read('effectiveAt');
      // ERC-8056 uses a zero effectiveAt for the no-pending-update state.
      if (effectiveAtSeconds === 0n) return { ok: true, value: undefined };
      return {
        ok: true,
        value: { pendingMultiplierWad, effectiveAtSeconds, context: this.context },
      };
    } catch (error) {
      return { ok: false, error: toReaderError(error) };
    }
  }
}

/** Fold probes into a surface verdict. Partial availability is never rounded up to live. */
export function summarizeCapabilities(
  probes: readonly CapabilityProbe[],
  context: ObservationContext,
): B20Capabilities {
  const bySurface = (surface: string) => probes.filter((p) => p.surface === surface);
  const allLive = (surface: string) => {
    const set = bySurface(surface);
    return set.length > 0 && set.every((p) => p.outcome === 'LIVE');
  };
  const scheduled = probes.filter((p) => p.name === 'newUIMultiplier' || p.name === 'effectiveAt');
  return {
    probes,
    berylLive: allLive('BERYL'),
    // Both halves of the pair are required: a pending multiplier with no effectiveAt cannot
    // be evaluated, and an effectiveAt with no multiplier cannot either.
    scheduledUpdatesLive: scheduled.length === 2 && scheduled.every((p) => p.outcome === 'LIVE'),
    context,
  };
}

export function toReaderError(error: unknown): B20ReaderError {
  if (error instanceof B20ReaderError) return error;
  const message = String(
    (error as { shortMessage?: string })?.shortMessage ?? (error as Error)?.message ?? error,
  );
  const data = extractRevertData(error);
  if (data !== undefined) {
    return new B20ReaderError('CONTRACT_REVERT', message.slice(0, 300), { revertData: data });
  }
  return new B20ReaderError('RPC_UNAVAILABLE', message.slice(0, 300));
}

export const openB20ReadSession = B20ReadSession.open.bind(B20ReadSession);
