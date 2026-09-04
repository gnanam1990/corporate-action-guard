import { randomUUID } from 'node:crypto';
import {
  appendEvidence,
  applyEventToProjections,
  assertLeaseHeld,
  withTransaction,
  type Lease,
} from '@cag/db';
import type { Logger } from '@cag/observability';
import { decodeAdapterEvent, type XLayerReader } from '@cag/xlayer-reader';
import type { Pool } from 'pg';

export interface ReceiptIndexerDeps {
  readonly pool: Pool;
  readonly reader: XLayerReader;
  readonly adapterAddress: string;
  readonly deploymentBlock: bigint;
  readonly logger: Logger;
  readonly producerVersion: string;
  readonly now: () => number;
  readonly lease?: Lease;
}

export interface ReceiptIndexResult {
  readonly fromBlock: bigint | undefined;
  readonly toBlock: bigint;
  readonly indexedEvents: number;
  readonly ignoredLogs: number;
  readonly reorgDetected: boolean;
}

type CursorRow = {
  last_indexed_block: string;
  last_indexed_hash: string;
  safe_block: string;
};

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Index finalized adapter events and advance the cursor in the same transaction.
 *
 * On a deep reorg, immutable original events remain in the journal. A compensating event
 * names the superseded rows and reverses only their derived receipt-consumption state;
 * canonical logs are then re-read from the rewind point.
 */
export async function runReceiptIndexCycle(deps: ReceiptIndexerDeps): Promise<ReceiptIndexResult> {
  const chainId = 1952;
  const correlationId = randomUUID();
  const depth = deps.reader.getConfirmationDepth();
  const head = await deps.reader.getHead();
  const toBlock = max(0n, head.blockNumber - BigInt(depth));
  const cursorResult = await deps.pool.query<CursorRow>(
    `SELECT last_indexed_block::text, last_indexed_hash, safe_block::text
     FROM indexed_chain_cursor WHERE chain_id = $1`,
    [chainId],
  );
  const cursor = cursorResult.rows[0];

  let fromBlock = deps.deploymentBlock;
  let reorgDetected = false;
  let rewind:
    | { readonly blockNumber: bigint; readonly blockHash: string; readonly eventIds: string[] }
    | undefined;

  if (cursor !== undefined) {
    const last = BigInt(cursor.last_indexed_block);
    const chainShrank = last > toBlock;
    const reorg = chainShrank
      ? { reorged: true as const }
      : await deps.reader.detectReorg({ blockNumber: last, blockHash: cursor.last_indexed_hash });
    if (reorg.reorged) {
      reorgDetected = true;
      const floor = deps.deploymentBlock === 0n ? 0n : deps.deploymentBlock - 1n;
      const rewindBlock = max(floor, min(BigInt(cursor.safe_block), toBlock) - BigInt(depth));
      const stamp = await deps.reader.getBlockStamp(max(0n, rewindBlock));
      const superseded = await deps.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM evidence_events
         WHERE chain_id = $1 AND block_number > $2
           AND event_type IN ('RECEIPT_CONSUMED','ACTION_EXECUTED')
         ORDER BY block_number, log_index`,
        [chainId, stamp.blockNumber.toString()],
      );
      rewind = {
        blockNumber: stamp.blockNumber,
        blockHash: stamp.blockHash,
        eventIds: superseded.rows.map((row) => row.id),
      };
      fromBlock = stamp.blockNumber + 1n;
    } else {
      fromBlock = last + 1n;
    }
  }

  if (fromBlock > toBlock) {
    return { fromBlock: undefined, toBlock, indexedEvents: 0, ignoredLogs: 0, reorgDetected };
  }

  const logs = await deps.reader.getLogsChunked({
    address: deps.adapterAddress,
    fromBlock,
    toBlock,
  });
  const decoded = logs.map((log) => ({ log, event: decodeAdapterEvent(log) }));
  const toStamp = await deps.reader.getBlockStamp(toBlock);

  let indexedEvents = 0;
  await withTransaction(deps.pool, async (client) => {
    if (deps.lease !== undefined) await assertLeaseHeld(client, deps.lease, true);

    if (rewind !== undefined) {
      const reverted = await appendEvidence(client, {
        aggregateType: 'chain',
        aggregateId: String(chainId),
        eventType: 'CHAIN_EVENTS_REVERTED',
        observedAt: new Date(deps.now()),
        sourceKind: 'SYSTEM',
        sourceLocator: 'worker/receipt-indexer',
        payload: {
          chainId,
          eventIds: rewind.eventIds,
          rewindToBlock: rewind.blockNumber.toString(),
        },
        correlationId,
        producerVersion: deps.producerVersion,
      });
      await applyEventToProjections(client, reverted.event);

      const reorg = await appendEvidence(client, {
        aggregateType: 'chain',
        aggregateId: String(chainId),
        eventType: 'REORG_DETECTED',
        observedAt: new Date(deps.now()),
        sourceKind: 'XLAYER_RPC',
        sourceLocator: 'worker/receipt-indexer',
        chain: {
          chainId,
          blockNumber: rewind.blockNumber,
          blockHash: rewind.blockHash,
        },
        payload: {
          chainId,
          rewindToBlock: rewind.blockNumber.toString(),
          rewindToHash: rewind.blockHash,
          supersededEventIds: rewind.eventIds,
        },
        correlationId,
        causationId: reverted.event.id,
        producerVersion: deps.producerVersion,
      });
      await applyEventToProjections(client, reorg.event);
    }

    for (const item of decoded) {
      if (item.event === undefined) continue;
      const eventType =
        item.event.name === 'ReceiptConsumed' ? 'RECEIPT_CONSUMED' : 'ACTION_EXECUTED';
      const appended = await appendEvidence(client, {
        aggregateType: 'receipt',
        aggregateId: item.event.receiptId,
        eventType,
        observedAt: new Date(deps.now()),
        sourceKind: 'XLAYER_RPC',
        sourceLocator: 'worker/receipt-indexer',
        chain: {
          chainId,
          blockNumber: item.log.blockNumber,
          blockHash: item.log.blockHash,
          txHash: item.log.transactionHash,
          logIndex: item.log.logIndex,
        },
        payload:
          item.event.name === 'ReceiptConsumed'
            ? {
                receiptId: item.event.receiptId,
                caller: item.event.caller,
                target: item.event.target,
                amount: item.event.amount.toString(),
              }
            : {
                receiptId: item.event.receiptId,
                actionType: item.event.actionType,
                recipient: item.event.recipient,
                amount: item.event.amount.toString(),
              },
        correlationId,
        producerVersion: deps.producerVersion,
      });
      await applyEventToProjections(client, appended.event);
      if (!appended.deduplicated) indexedEvents++;
    }

    const cursorEvent = await appendEvidence(client, {
      aggregateType: 'chain',
      aggregateId: String(chainId),
      eventType: 'CHAIN_CURSOR_ADVANCED',
      observedAt: new Date(deps.now()),
      sourceKind: 'XLAYER_RPC',
      sourceLocator: 'worker/receipt-indexer',
      chain: { chainId, blockNumber: toStamp.blockNumber, blockHash: toStamp.blockHash },
      payload: {
        chainId,
        lastIndexedBlock: toStamp.blockNumber.toString(),
        lastIndexedHash: toStamp.blockHash,
        safeBlock: toStamp.blockNumber.toString(),
        confirmationDepth: depth,
      },
      correlationId,
      producerVersion: deps.producerVersion,
    });
    await applyEventToProjections(client, cursorEvent.event);
  });

  const ignoredLogs = decoded.filter((item) => item.event === undefined).length;
  deps.logger.info('receipt index cycle complete', {
    chainId,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    indexedEvents,
    ignoredLogs,
    reorgDetected,
  });
  return { fromBlock, toBlock, indexedEvents, ignoredLogs, reorgDetected };
}
