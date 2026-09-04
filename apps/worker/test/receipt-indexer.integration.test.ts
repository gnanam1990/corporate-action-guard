import { randomUUID } from 'node:crypto';
import {
  appendEvidence,
  applyEventToProjections,
  migrate,
  rebuildProjections,
  withTransaction,
} from '@cag/db';
import { createLogger } from '@cag/observability';
import { ACTION_GUARD_ADAPTER_EVENTS, type XLayerReader } from '@cag/xlayer-reader';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runReceiptIndexCycle } from '../src/receipt-indexer.js';

const SCHEMA = 'cag_test_receipt_indexer';
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://guard:guard@localhost:55432/guard';
const RECEIPT_ID = `0x${'12'.repeat(32)}`;
const ADAPTER = `0x${'ab'.repeat(20)}`;
const blockHash = (block: bigint): string => `0x${block.toString(16).padStart(64, '0')}`;

let pool: Pool;
let reorged = false;
let includeLog = true;

const receiptLog = (() => {
  const caller = `0x${'34'.repeat(20)}` as const;
  const target = `0x${'56'.repeat(20)}` as const;
  return {
    blockNumber: 185n,
    blockHash: blockHash(185n),
    transactionHash: `0x${'78'.repeat(32)}`,
    logIndex: 0,
    topics: encodeEventTopics({
      abi: ACTION_GUARD_ADAPTER_EVENTS,
      eventName: 'ReceiptConsumed',
      args: { receiptId: RECEIPT_ID as `0x${string}`, caller, target },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [1_000n]),
  };
})();

const fakeReader = {
  getConfirmationDepth: () => 10,
  getHead: async () => ({
    blockNumber: reorged ? 220n : 200n,
    blockHash: blockHash(reorged ? 220n : 200n),
    blockTimestampMs: 1_788_000_000_000,
  }),
  getBlockStamp: async (blockNumber: bigint) => ({
    blockNumber,
    blockHash: blockHash(blockNumber),
    blockTimestampMs: 1_788_000_000_000,
  }),
  detectReorg: async () => (reorged ? { reorged: true as const } : { reorged: false as const }),
  getLogsChunked: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
    includeLog && receiptLog.blockNumber >= fromBlock && receiptLog.blockNumber <= toBlock
      ? [receiptLog]
      : [],
} as unknown as XLayerReader;

beforeAll(async () => {
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  const url = new URL(DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  await migrate(url.toString());
  pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });

  await withTransaction(pool, async (client) => {
    const issued = await appendEvidence(client, {
      aggregateType: 'asset',
      aggregateId: 'GFIX',
      eventType: 'RECEIPT_ISSUED',
      observedAt: new Date('2026-09-04T00:00:00.000Z'),
      sourceKind: 'SYSTEM',
      sourceLocator: '/v1/preflight',
      payload: {
        receiptId: RECEIPT_ID,
        chainId: 1952,
        adapterAddress: ADAPTER,
        operationDigest: `0x${'cd'.repeat(32)}`,
        validAfter: '2026-09-04T00:00:00.000Z',
        validUntil: '2026-09-04T00:05:00.000Z',
      },
      correlationId: randomUUID(),
      producerVersion: 'test@0.1.0',
    });
    await applyEventToProjections(client, issued.event);
  });
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

const run = () =>
  runReceiptIndexCycle({
    pool,
    reader: fakeReader,
    adapterAddress: ADAPTER,
    deploymentBlock: 100n,
    logger: createLogger({ service: 'receipt-indexer-test', level: 'error' }),
    producerVersion: 'test@0.1.0',
    now: () => 1_788_000_000_000,
  });

describe('receipt event indexer', () => {
  it('consumes a receipt and advances only to the confirmation-safe head', async () => {
    const result = await run();
    expect(result).toMatchObject({ fromBlock: 100n, toBlock: 190n, indexedEvents: 1 });
    const receipt = await pool.query(
      'SELECT status, consumed_tx_hash FROM receipt_status WHERE receipt_id = $1',
      [RECEIPT_ID],
    );
    expect(receipt.rows[0]).toMatchObject({
      status: 'CONSUMED',
      consumed_tx_hash: receiptLog.transactionHash,
    });
    const cursor = await pool.query(
      'SELECT last_indexed_block::text FROM indexed_chain_cursor WHERE chain_id = 1952',
    );
    expect(cursor.rows[0]?.last_indexed_block).toBe('190');
  });

  it('appends compensation and restores ISSUED before re-reading after a reorg', async () => {
    reorged = true;
    includeLog = false;
    const result = await run();
    expect(result.reorgDetected).toBe(true);
    expect(result.fromBlock).toBe(181n);
    const receipt = await pool.query('SELECT status FROM receipt_status WHERE receipt_id = $1', [
      RECEIPT_ID,
    ]);
    expect(receipt.rows[0]?.status).toBe('ISSUED');
    const events = await pool.query(
      `SELECT event_type FROM evidence_events
       WHERE event_type IN ('CHAIN_EVENTS_REVERTED','REORG_DETECTED') ORDER BY ingested_at`,
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'CHAIN_EVENTS_REVERTED',
      'REORG_DETECTED',
    ]);

    await rebuildProjections(pool);
    const rebuilt = await pool.query('SELECT status FROM receipt_status WHERE receipt_id = $1', [
      RECEIPT_ID,
    ]);
    expect(rebuilt.rows[0]?.status).toBe('ISSUED');
  });
});
