import { loadEnv } from '@cag/config';
import { migrate, withLease } from '@cag/db';
import { createLogger, FaultInjector } from '@cag/observability';
import { XLayerReader } from '@cag/xlayer-reader';
import { XStocksClient } from '@cag/xstocks-client';
import { hostname } from 'node:os';
import { Pool } from 'pg';
import { runDiscoveryCycle } from './discovery.js';
import { runFixtureObservationCycle } from './fixture-observer.js';
import { runReceiptIndexCycle } from './receipt-indexer.js';

/**
 * Worker entry point.
 *
 * Runs the discovery and observation cycle under a durable lease, so two workers never
 * observe the same catalog concurrently and a worker that dies mid-cycle releases its claim
 * visibly rather than silently.
 */

const env = loadEnv();
const logger = createLogger({
  service: 'worker',
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
});

const POLL_INTERVAL_MS = Number(process.env['WORKER_POLL_INTERVAL_MS'] ?? 60_000);
const LEASE_TTL_SECONDS = Math.ceil((POLL_INTERVAL_MS * 3) / 1_000);
const ONCE = process.argv.includes('--once');

/** A worker identity that survives a restart but distinguishes two on one host. */
const OWNER_ID = `${hostname()}:${process.pid}`;

async function main(): Promise<void> {
  if (env.XLAYER_MAINNET_RPC_URL === undefined) {
    logger.error(
      'XLAYER_MAINNET_RPC_URL is required; the worker cannot observe chain state without it',
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  if (env.NODE_ENV !== 'production') await migrate(env.DATABASE_URL);

  /**
   * Fault injection, when explicitly requested.
   *
   * `FaultInjector` refuses to construct under NODE_ENV=production, so this is inert
   * there rather than merely unused. An unknown fault name throws, because a typo that
   * silently disabled a scenario would make the harness worse than useless — the run
   * would report success having tested nothing.
   */
  const faults = FaultInjector.fromEnv(process.env['FAULTS']);
  if (faults !== undefined) {
    logger.warn('FAULT INJECTION ACTIVE — this run is not a normal observation', {
      kinds: faults.activeKinds(),
    });
  }

  const deps = {
    pool,
    xstocks: new XStocksClient({
      baseUrl: env.XSTOCKS_API_BASE_URL,
      ...(faults === undefined ? {} : { faults }),
    }),
    reader: new XLayerReader({
      rpcUrl: env.XLAYER_MAINNET_RPC_URL,
      expectedChainId: env.XLAYER_MAINNET_CHAIN_ID,
      // Recorded on every observation, so a read can be attributed to a provider.
      providerName: new URL(env.XLAYER_MAINNET_RPC_URL).host,
    }),
    logger,
    producerVersion: `worker@${process.env['npm_package_version'] ?? '0.1.0'}`,
    now: () => Date.now(),
    ...(process.env['WORKER_MAX_ASSETS'] === undefined
      ? {}
      : { maxAssets: Number(process.env['WORKER_MAX_ASSETS']) }),
  };
  const testnetReader =
    env.XLAYER_TESTNET_RPC_URL === undefined
      ? undefined
      : new XLayerReader({
          rpcUrl: env.XLAYER_TESTNET_RPC_URL,
          expectedChainId: env.XLAYER_TESTNET_CHAIN_ID,
          providerName: new URL(env.XLAYER_TESTNET_RPC_URL).host,
        });
  const receiptIndexDeps =
    testnetReader !== undefined &&
    env.GUARD_ADAPTER_TESTNET_ADDRESS !== undefined &&
    env.GUARD_ADAPTER_DEPLOYED_AT_BLOCK !== undefined
      ? {
          pool,
          reader: testnetReader,
          adapterAddress: env.GUARD_ADAPTER_TESTNET_ADDRESS,
          deploymentBlock: BigInt(env.GUARD_ADAPTER_DEPLOYED_AT_BLOCK),
          logger,
          producerVersion: deps.producerVersion,
          now: deps.now,
        }
      : undefined;
  const fixtureObserverDeps =
    testnetReader !== undefined &&
    env.FIXTURE_ASSET_TESTNET_ADDRESS !== undefined &&
    env.FIXTURE_WRAPPER_TESTNET_ADDRESS !== undefined &&
    env.FIXTURE_ADMIN_ADDRESS !== undefined
      ? {
          pool,
          reader: testnetReader,
          assetId: env.FIXTURE_ASSET_ID,
          tokenAddress: env.FIXTURE_ASSET_TESTNET_ADDRESS,
          wrapperAddress: env.FIXTURE_WRAPPER_TESTNET_ADDRESS,
          adminAddress: env.FIXTURE_ADMIN_ADDRESS,
          logger,
          producerVersion: deps.producerVersion,
          now: deps.now,
        }
      : undefined;

  let running = true;
  const stop = (signal: string): void => {
    logger.info('shutdown requested; finishing the current cycle', { signal });
    running = false;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  do {
    const result = await withLease(
      pool,
      'discovery:xlayer',
      OWNER_ID,
      LEASE_TTL_SECONDS,
      async (lease) => runDiscoveryCycle({ ...deps, lease }),
    );

    if (result === undefined) {
      // Another worker holds the lease. Not an error: this is the mechanism working.
      logger.debug('discovery lease held elsewhere; skipping this cycle');
    }

    if (receiptIndexDeps !== undefined) {
      try {
        const indexed = await withLease(
          pool,
          'receipt-indexer:xlayer-testnet',
          OWNER_ID,
          LEASE_TTL_SECONDS,
          async (lease) => runReceiptIndexCycle({ ...receiptIndexDeps, lease }),
        );
        if (indexed === undefined) {
          logger.debug('receipt-indexer lease held elsewhere; skipping this cycle');
        }
      } catch (error) {
        // Monitoring mainnet evidence remains useful even if the optional testnet
        // deployment is unavailable. Its own cursor does not advance on failure.
        logger.error('receipt index cycle failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (fixtureObserverDeps !== undefined) {
      try {
        const observed = await withLease(
          pool,
          'fixture-observer:xlayer-testnet',
          OWNER_ID,
          LEASE_TTL_SECONDS,
          async (lease) => runFixtureObservationCycle({ ...fixtureObserverDeps, lease }),
        );
        if (observed === undefined) {
          logger.debug('fixture-observer lease held elsewhere; skipping this cycle');
        }
      } catch (error) {
        logger.error('fixture observation cycle failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (ONCE || !running) break;

    // Jitter, so a fleet restarted together does not converge into a synchronised burst
    // against the API and the RPC.
    const jitter = Math.floor(Math.random() * POLL_INTERVAL_MS * 0.2);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS + jitter));
  } while (running);

  await pool.end();
  logger.info('worker stopped');
}

await main();
