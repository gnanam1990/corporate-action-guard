import { randomUUID } from 'node:crypto';
import { appendEvidence, applyEventToProjections, withTransaction } from '@cag/db';
import type { Logger } from '@cag/observability';
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
      failed: 1,
      durationMs: deps.now() - startedAt,
    };
  }

  const limit = deps.maxAssets ?? assets.length;
  let observed = 0;
  let canonical = 0;
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

      await journalAsset(
        deps,
        asset,
        deployment.address,
        wrapper,
        record.outcome,
        snapshot,
        correlationId,
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
    failed,
    durationMs: deps.now() - startedAt,
  };
  log.info('discovery cycle complete', { ...result });
  return result;
}

async function journalAsset(
  deps: DiscoveryDeps,
  asset: XStocksAsset,
  tokenAddress: string,
  wrapperAddress: string | null,
  canonicality: 'PASS' | 'FAIL' | 'UNKNOWN',
  snapshot: Awaited<ReturnType<XLayerReader['observeAsset']>> | undefined,
  correlationId: string,
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
        observationBucket: bucket,
      },
      correlationId,
      causationId: apiEvent.event.id,
      producerVersion: deps.producerVersion,
    });
    await applyEventToProjections(client, chainEvent.event);
  });
}
