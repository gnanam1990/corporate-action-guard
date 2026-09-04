import { randomUUID } from 'node:crypto';
import { appendEvidence, applyEventToProjections, withTransaction } from '@cag/db';
import type { Logger } from '@cag/observability';
import {
  compareSources,
  DEFAULT_REQUIRED_AGREEMENT_FIELDS,
  EXACT_TOLERANCE,
  instant,
  unsafe,
  type ApiObservation,
  type ChainObservation,
  type SourceComparison,
} from '@cag/domain';
import { verifyCanonicality } from '@cag/reconciler';
import { XLayerError, type XLayerReader } from '@cag/xlayer-reader';
import type { XStocksClient } from '@cag/xstocks-client';
import { XStocksError, xLayerDeployment, type XStocksAsset } from '@cag/xstocks-client';
import type { Pool } from 'pg';

/**
 * Discovery and observation cycle.
 *
 * Walks the live xStocks catalog, observes each X Layer deployment on chain, derives
 * canonicality, and journals the result. Everything it writes carries the provenance it
 * came from — the API path, the RPC provider, and the block number and hash.
 *
 * Failure is recorded, not swallowed. A source that could not be reached produces a
 * `SOURCE_DEGRADED` event, so the console shows degraded rather than showing yesterday's
 * numbers as though they were current.
 */

export interface DiscoveryDeps {
  readonly pool: Pool;
  readonly xstocks: XStocksClient;
  readonly reader: XLayerReader;
  readonly logger: Logger;
  readonly producerVersion: string;
  /** Supplied by the caller; the cycle reads no clock of its own. */
  readonly now: () => number;
  /** Cap on assets observed per cycle, so one run cannot exhaust an RPC budget. */
  readonly maxAssets?: number;
}

export interface CycleResult {
  readonly discovered: number;
  readonly observed: number;
  readonly canonical: number;
  /** Assets where the API and the chain agreed on every required field. */
  readonly agreed: number;
  readonly failed: number;
  readonly durationMs: number;
}

/** Bucket observations to the minute, so a retry inside the same minute deduplicates. */
function observationBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 16);
}

async function recordSourceHealth(
  deps: DiscoveryDeps,
  sourceKind: 'XSTOCKS_API' | 'XLAYER_RPC',
  healthy: boolean,
  detail: string,
  correlationId: string,
): Promise<void> {
  await withTransaction(deps.pool, async (client) => {
    const { event } = await appendEvidence(client, {
      aggregateType: 'source',
      aggregateId: sourceKind,
      eventType: healthy ? 'SOURCE_RECOVERED' : 'SOURCE_DEGRADED',
      observedAt: new Date(deps.now()),
      sourceKind,
      sourceLocator: sourceKind === 'XSTOCKS_API' ? '/public/assets' : 'rpc',
      payload: { detail, observationBucket: observationBucket(deps.now()) },
      correlationId,
      producerVersion: deps.producerVersion,
    });
    await applyEventToProjections(client, event);
  });
}

export async function runDiscoveryCycle(deps: DiscoveryDeps): Promise<CycleResult> {
  const startedAt = deps.now();
  const correlationId = randomUUID();
  const log = deps.logger.child({ correlationId, cycle: 'discovery' });

  let assets: readonly XStocksAsset[];
  try {
    const result = await deps.xstocks.listAssets({ network: 'XLayer', correlationId });
    assets = result.assets;
    await recordSourceHealth(
      deps,
      'XSTOCKS_API',
      true,
      `${assets.length} assets discovered`,
      correlationId,
    );
    log.info('catalog discovered', { count: assets.length, pagesWalked: result.pagesWalked });
  } catch (err) {
    const detail = err instanceof XStocksError ? `${err.kind}: ${err.message}` : String(err);
    // Degraded, not empty. An empty catalog and an unreachable API are different facts.
    await recordSourceHealth(deps, 'XSTOCKS_API', false, detail, correlationId);
    log.error('catalog discovery failed', { detail });
    return {
      discovered: 0,
      observed: 0,
      canonical: 0,
      agreed: 0,
      failed: 1,
      durationMs: deps.now() - startedAt,
    };
  }

  let head;
  try {
    head = await deps.reader.getHead();
    await recordSourceHealth(deps, 'XLAYER_RPC', true, `head ${head.blockNumber}`, correlationId);
  } catch (err) {
    const detail = err instanceof XLayerError ? `${err.kind}: ${err.message}` : String(err);
    await recordSourceHealth(deps, 'XLAYER_RPC', false, detail, correlationId);
    log.error('chain head unavailable', { detail });
    return {
      discovered: assets.length,
      observed: 0,
      canonical: 0,
      agreed: 0,
      failed: 1,
      durationMs: deps.now() - startedAt,
    };
  }

  const limit = deps.maxAssets ?? assets.length;
  let observed = 0;
  let canonical = 0;
  let agreed = 0;
  let failed = 0;

  for (const asset of assets.slice(0, limit)) {
    const deployment = xLayerDeployment(asset);
    if (deployment === undefined) continue;

    const wrapper = deployment.wrapperAddressV2;
    if (wrapper === undefined) {
      // No current wrapper declared. Journalled as discovered, but canonicality stays
      // UNKNOWN rather than being quietly skipped.
      await journalAsset(
        deps,
        asset,
        deployment.address,
        null,
        'UNKNOWN',
        undefined,
        correlationId,
      );
      continue;
    }

    try {
      const snapshot = await deps.reader.observeAsset({
        tokenAddress: deployment.address,
        wrapperAddress: wrapper,
        at: head,
        nowMs: deps.now(),
      });

      const record = verifyCanonicality({ asset, deployment, snapshot });
      observed++;
      if (record.outcome === 'PASS') canonical++;

      // Compare the two sources. Without this the agreement verdict stays unknown and
      // every protected action blocks — the correct direction to be wrong in, but a guard
      // that refuses everything is an outage, not a guard.
      const comparison = await compareForAsset(
        deps,
        asset.symbol,
        deployment,
        snapshot,
        correlationId,
      );
      if (comparison.agreement === 'MATCH') agreed++;

      await journalAsset(
        deps,
        asset,
        deployment.address,
        wrapper,
        record.outcome,
        snapshot,
        correlationId,
        comparison,
      );
    } catch (err) {
      failed++;
      log.warn('asset observation failed', {
        assetId: asset.id,
        symbol: asset.symbol,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = {
    discovered: assets.length,
    observed,
    canonical,
    agreed,
    failed,
    durationMs: deps.now() - startedAt,
  };
  log.info('discovery cycle complete', { ...result });
  return result;
}

/**
 * Build the two observations and compare them.
 *
 * The subtle part is the multiplier. The API sends a decimal string and the chain returns
 * a uint256 scaled by 1e18. `1.0032690125398187` and `1003269012539818700` are the SAME
 * value at different scales, and `compareSources` rescales exactly — but only if each side
 * is handed to it as fixed point rather than a float. Converting either through a double
 * first would reintroduce the loss the whole design avoids.
 *
 * A field the API cannot supply is left ABSENT, never filled in from the chain value. That
 * would be inventing agreement, which is precisely the failure mode the product exists to
 * prevent.
 */
async function compareForAsset(
  deps: DiscoveryDeps,
  symbol: string,
  deployment: { readonly address: string; readonly wrapperAddressV2?: string | undefined },
  snapshot: Awaited<ReturnType<XLayerReader['observeAsset']>>,
  correlationId: string,
): Promise<SourceComparison> {
  const nowInstant = instant(deps.now());

  // The multiplier endpoint is per symbol and per network, so it is a second call. A
  // failure here means the API could not supply the field — reported as absent, which
  // yields INCOMPLETE, which blocks.
  // Fixed point, carried straight from the exact literal in the raw body. Never a float.
  let apiMultiplier: { readonly value: bigint; readonly decimals: number } | undefined;
  let apiActivationMs: number | undefined;

  try {
    const result = await deps.xstocks.getMultiplier(symbol, 'XLayer', correlationId);
    // The exact literal from the raw body, not the parsed double.
    if (result.exactCurrentMultiplier !== undefined) {
      apiMultiplier = {
        value: result.exactCurrentMultiplier.value,
        decimals: result.exactCurrentMultiplier.decimals,
      };
    }
    apiActivationMs = result.scheduledActivationMs;
  } catch {
    // Absent, not assumed. The comparison will report INCOMPLETE.
    apiMultiplier = undefined;
  }

  const api: ApiObservation = {
    provenance: {
      sourceKind: 'XSTOCKS_API',
      sourceLocator: `/public/assets/${symbol}/multiplier?network=XLayer`,
      observedAt: nowInstant,
    },
    symbol: unsafe.symbol(symbol),
    tokenAddress: unsafe.address(deployment.address),
    ...(deployment.wrapperAddressV2 === undefined
      ? {}
      : { wrapperAddress: unsafe.address(deployment.wrapperAddressV2) }),
    ...(apiMultiplier === undefined ? {} : { multiplier: apiMultiplier }),
    ...(apiActivationMs === undefined ? {} : { scheduledActivation: instant(apiActivationMs) }),
  };

  const chain: ChainObservation = {
    provenance: {
      sourceKind: 'XLAYER_RPC',
      sourceLocator: snapshot.providerName,
      observedAt: nowInstant,
    },
    chainId: unsafe.chainId(snapshot.chainId),
    blockNumber: unsafe.blockNumber(snapshot.blockNumber),
    blockHash: unsafe.blockHash(snapshot.blockHash),
    tokenAddress: unsafe.address(snapshot.tokenAddress),
    wrapperAddress: unsafe.address(snapshot.wrapperAddress),
    tokenHasBytecode: snapshot.tokenHasBytecode,
    wrapperHasBytecode: snapshot.wrapperHasBytecode,
    ...(snapshot.wrapperAsset === undefined
      ? {}
      : { wrapperAsset: unsafe.address(snapshot.wrapperAsset) }),
    // The chain multiplier is a uint256 scaled by the token's own decimals.
    ...(snapshot.currentMultiplier === undefined || snapshot.tokenDecimals === undefined
      ? {}
      : { multiplier: { value: snapshot.currentMultiplier, decimals: snapshot.tokenDecimals } }),
    ...(snapshot.multiplierNonce === undefined
      ? {}
      : { multiplierNonce: snapshot.multiplierNonce }),
    ...(snapshot.scheduledActivationMs === undefined
      ? {}
      : { scheduledActivation: instant(snapshot.scheduledActivationMs) }),
  };

  return compareSources(api, chain, {
    // Exact for enforcement. A tolerance here would be a licence to disagree.
    multiplierTolerance: EXACT_TOLERANCE,
    activationToleranceMs: 0,
    requiredAgreementFields: DEFAULT_REQUIRED_AGREEMENT_FIELDS,
  });
}

async function journalAsset(
  deps: DiscoveryDeps,
  asset: XStocksAsset,
  tokenAddress: string,
  wrapperAddress: string | null,
  canonicality: 'PASS' | 'FAIL' | 'UNKNOWN',
  snapshot: Awaited<ReturnType<XLayerReader['observeAsset']>> | undefined,
  correlationId: string,
  comparison?: SourceComparison,
): Promise<void> {
  const bucket = observationBucket(deps.now());

  await withTransaction(deps.pool, async (client) => {
    // The API observation.
    const apiEvent = await appendEvidence(client, {
      aggregateType: 'asset',
      aggregateId: asset.symbol,
      eventType: 'API_SNAPSHOT_OBSERVED',
      observedAt: new Date(deps.now()),
      sourceKind: 'XSTOCKS_API',
      sourceLocator: `/public/assets?network=XLayer`,
      payload: {
        symbol: asset.symbol,
        chainId: 196,
        tokenAddress: tokenAddress.toLowerCase(),
        ...(wrapperAddress === null ? {} : { wrapperAddress: wrapperAddress.toLowerCase() }),
        wrapperIsCurrent: wrapperAddress !== null,
        observationBucket: bucket,
      },
      correlationId,
      producerVersion: deps.producerVersion,
    });
    await applyEventToProjections(client, apiEvent.event);

    if (snapshot === undefined) return;

    // The chain observation, stamped with the exact block it was read at.
    const chainEvent = await appendEvidence(client, {
      aggregateType: 'asset',
      aggregateId: asset.symbol,
      eventType: 'CHAIN_SNAPSHOT_OBSERVED',
      observedAt: new Date(deps.now()),
      sourceKind: 'XLAYER_RPC',
      sourceLocator: snapshot.providerName,
      chain: {
        chainId: snapshot.chainId,
        blockNumber: snapshot.blockNumber,
        blockHash: snapshot.blockHash,
      },
      payload: {
        canonicality,
        ...(snapshot.multiplierNonce === undefined
          ? {}
          : { multiplierNonce: snapshot.multiplierNonce.toString() }),
        ...(snapshot.currentMultiplier === undefined
          ? {}
          : { currentMultiplier: snapshot.currentMultiplier.toString() }),
        tokenHasBytecode: snapshot.tokenHasBytecode,
        wrapperHasBytecode: snapshot.wrapperHasBytecode,
        ...(snapshot.wrapperAsset === undefined ? {} : { wrapperAsset: snapshot.wrapperAsset }),
        complete: snapshot.complete,
        failedReads: snapshot.failedReads,
        confirmationDepth: snapshot.confirmationDepth,
        settled: snapshot.settled,
        ...(comparison === undefined
          ? {}
          : {
              sourceAgreement: comparison.agreement,
              // Per-field values, so an operator can see WHICH field disagrees rather than
              // only that something did.
              comparisonFields: comparison.fields.map((f) => ({
                field: f.field,
                agreement: f.agreement,
                apiValue: f.apiValue ?? null,
                chainValue: f.chainValue ?? null,
                requiredForAgreement: f.requiredForAgreement,
              })),
            }),
        observationBucket: bucket,
      },
      correlationId,
      causationId: apiEvent.event.id,
      producerVersion: deps.producerVersion,
    });
    await applyEventToProjections(client, chainEvent.event);
  });
}
