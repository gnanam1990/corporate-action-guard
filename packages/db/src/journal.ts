import type { Pool, PoolClient } from 'pg';
import { payloadHash } from './canonical-json.js';
import {
  FORBIDDEN_PAYLOAD_KEYS,
  JournalMutationError,
  type AppendEvidenceInput,
  type AppendResult,
  type EvidenceEvent,
} from './types.js';

export type Queryable = Pool | PoolClient;

/**
 * A payload must never carry a key, a signature, or an authorization header.
 *
 * Evidence is exported, replayed, screenshotted, and attached to incident reports. A
 * secret that reaches the journal reaches all of those. Checked recursively at append
 * time and rejected outright — redacting silently would hide the bug that put it there.
 */
function assertNoSecrets(payload: unknown, path = 'payload'): void {
  if (payload === null || typeof payload !== 'object') return;

  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(payload)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_PAYLOAD_KEYS.some((f) => f.toLowerCase() === lowered)) {
      throw new JournalMutationError(
        `refusing to journal a secret-bearing key at ${path}.${key}. ` +
          'Evidence is exported and displayed; secrets must never enter it.',
      );
    }
    assertNoSecrets(value, `${path}.${key}`);
  }
}

function rowToEvent(row: Record<string, unknown>): EvidenceEvent {
  return {
    id: row['id'] as string,
    aggregateType: row['aggregate_type'] as string,
    aggregateId: row['aggregate_id'] as string,
    eventType: row['event_type'] as EvidenceEvent['eventType'],
    eventVersion: row['event_version'] as number,
    observedAt: row['observed_at'] as Date,
    sourceTime: (row['source_time'] as Date | null) ?? null,
    ingestedAt: row['ingested_at'] as Date,
    chainId: row['chain_id'] === null ? null : Number(row['chain_id']),
    blockNumber: row['block_number'] === null ? null : BigInt(String(row['block_number'])),
    blockHash: (row['block_hash'] as string | null) ?? null,
    txHash: (row['tx_hash'] as string | null) ?? null,
    logIndex: (row['log_index'] as number | null) ?? null,
    sourceKind: row['source_kind'] as EvidenceEvent['sourceKind'],
    sourceLocator: row['source_locator'] as string,
    payload: row['payload'] as Record<string, unknown>,
    payloadHash: row['payload_hash'] as string,
    correlationId: row['correlation_id'] as string,
    causationId: (row['causation_id'] as string | null) ?? null,
    producerVersion: row['producer_version'] as string,
  };
}

const SELECT_COLUMNS = `
  id, aggregate_type, aggregate_id, event_type, event_version,
  observed_at, source_time, ingested_at,
  chain_id, block_number, block_hash, tx_hash, log_index,
  source_kind, source_locator, payload, payload_hash,
  correlation_id, causation_id, producer_version`;

/**
 * Append one evidence event.
 *
 * Idempotent by construction: a duplicate chain log or an identical snapshot in the same
 * observation bucket conflicts on a unique index and returns the row that already exists,
 * marked `deduplicated`. A retry after a timeout is therefore safe, which matters because
 * the writer cannot tell a lost response from a lost write.
 */
export async function appendEvidence(
  db: Queryable,
  input: AppendEvidenceInput,
): Promise<AppendResult> {
  assertNoSecrets(input.payload);

  const hash = payloadHash(input.payload);
  const chain = input.chain;

  const inserted = await db.query(
    `INSERT INTO evidence_events (
       aggregate_type, aggregate_id, event_type, event_version,
       observed_at, source_time,
       chain_id, block_number, block_hash, tx_hash, log_index,
       source_kind, source_locator, payload, payload_hash,
       correlation_id, causation_id, producer_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.eventVersion ?? 1,
      input.observedAt,
      input.sourceTime ?? null,
      chain?.chainId ?? null,
      chain?.blockNumber?.toString() ?? null,
      chain?.blockHash?.toLowerCase() ?? null,
      chain?.txHash?.toLowerCase() ?? null,
      chain?.logIndex ?? null,
      input.sourceKind,
      input.sourceLocator,
      JSON.stringify(input.payload),
      hash,
      input.correlationId,
      input.causationId ?? null,
      input.producerVersion,
    ],
  );

  const row = inserted.rows[0];
  if (row !== undefined) {
    return { event: rowToEvent(row as Record<string, unknown>), deduplicated: false };
  }

  // A conflict means the same fact is already journaled. Return the existing row so the
  // caller's causation chain still points at real evidence.
  const existing = await findConflicting(db, input, hash);
  if (existing === undefined) {
    throw new JournalMutationError(
      'append conflicted but no conflicting row could be located; this indicates a constraint change',
    );
  }
  return { event: existing, deduplicated: true };
}

async function findConflicting(
  db: Queryable,
  input: AppendEvidenceInput,
  hash: string,
): Promise<EvidenceEvent | undefined> {
  if (input.chain?.txHash !== undefined && input.chain.logIndex !== undefined) {
    const { rows } = await db.query(
      `SELECT ${SELECT_COLUMNS} FROM evidence_events
       WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3`,
      [input.chain.chainId, input.chain.txHash.toLowerCase(), input.chain.logIndex],
    );
    return rows[0] === undefined ? undefined : rowToEvent(rows[0] as Record<string, unknown>);
  }

  const bucket = (input.payload as Record<string, unknown>)['observationBucket'] ?? null;
  const { rows } = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM evidence_events
     WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3
       AND payload_hash = $4 AND payload ->> 'observationBucket' IS NOT DISTINCT FROM $5`,
    [input.aggregateType, input.aggregateId, input.eventType, hash, bucket],
  );
  return rows[0] === undefined ? undefined : rowToEvent(rows[0] as Record<string, unknown>);
}

/** Read an aggregate's events in journal order. Used by replay and the timeline. */
export async function readAggregate(
  db: Queryable,
  aggregateType: string,
  aggregateId: string,
  options: { readonly upToEventId?: string; readonly limit?: number } = {},
): Promise<readonly EvidenceEvent[]> {
  const limit = Math.min(options.limit ?? 1000, 5000);
  const { rows } = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM evidence_events
     WHERE aggregate_type = $1 AND aggregate_id = $2
       AND ($3::uuid IS NULL OR ingested_at <= (SELECT ingested_at FROM evidence_events WHERE id = $3))
     ORDER BY ingested_at ASC, id ASC
     LIMIT $4`,
    [aggregateType, aggregateId, options.upToEventId ?? null, limit],
  );
  return rows.map((r) => rowToEvent(r as Record<string, unknown>));
}

/** Read the whole journal in order. Used by projection rebuild. */
export async function readAllEvents(
  db: Queryable,
  options: { readonly upToEventId?: string } = {},
): Promise<readonly EvidenceEvent[]> {
  const { rows } = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM evidence_events
     WHERE ($1::uuid IS NULL OR ingested_at <= (SELECT ingested_at FROM evidence_events WHERE id = $1))
     ORDER BY ingested_at ASC, id ASC`,
    [options.upToEventId ?? null],
  );
  return rows.map((r) => rowToEvent(r as Record<string, unknown>));
}

/**
 * Run a unit of work in a transaction.
 *
 * Evidence and the projection update it implies are written together or not at all. A
 * projection row with no journal row behind it is a fabricated claim; a journal row whose
 * projection never updated is a silently stale UI.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
