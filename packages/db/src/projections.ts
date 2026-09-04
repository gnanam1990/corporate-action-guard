import type { Pool, PoolClient } from 'pg';
import { readAllEvents, type Queryable } from './journal.js';
import type { EvidenceEvent } from './types.js';

/**
 * Projections are a fold over the journal.
 *
 * They are a cache, never the source of truth. `rebuildProjections` drops and recomputes
 * them from the journal alone, and an integration test asserts that a rebuild from an
 * empty schema reproduces the live projections exactly. If that ever fails, the live
 * projections have drifted and the journal is the one to believe.
 */

export const PROJECTION_TABLES = [
  'current_assets',
  'current_source_health',
  'current_incidents',
  'receipt_status',
  'indexed_chain_cursor',
] as const;

export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): string | null =>
  typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' ? String(v) : null;
const date = (v: unknown): Date | null => (typeof v === 'string' ? new Date(v) : null);

/**
 * Apply one event to the projections.
 *
 * Deliberately total and deliberately dull: every branch is a direct consequence of one
 * event type, so a rebuild is a plain replay of this function over the journal.
 */
export async function applyEventToProjections(db: Queryable, event: EvidenceEvent): Promise<void> {
  const p = event.payload;

  switch (event.eventType) {
    case 'ASSET_DISCOVERED':
    case 'API_SNAPSHOT_OBSERVED': {
      await db.query(
        `INSERT INTO current_assets (
           asset_id, symbol, chain_id, token_address, wrapper_address, wrapper_version,
           wrapper_is_current, multiplier_value, multiplier_decimals, multiplier_nonce,
           scheduled_activation, api_observed_at, last_event_id, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (asset_id) DO UPDATE SET
           symbol = EXCLUDED.symbol,
           wrapper_address = COALESCE(EXCLUDED.wrapper_address, current_assets.wrapper_address),
           wrapper_version = COALESCE(EXCLUDED.wrapper_version, current_assets.wrapper_version),
           wrapper_is_current = COALESCE(EXCLUDED.wrapper_is_current, current_assets.wrapper_is_current),
           multiplier_value = COALESCE(EXCLUDED.multiplier_value, current_assets.multiplier_value),
           multiplier_decimals = COALESCE(EXCLUDED.multiplier_decimals, current_assets.multiplier_decimals),
           multiplier_nonce = COALESCE(EXCLUDED.multiplier_nonce, current_assets.multiplier_nonce),
           scheduled_activation = EXCLUDED.scheduled_activation,
           api_observed_at = EXCLUDED.api_observed_at,
           last_event_id = EXCLUDED.last_event_id,
           updated_at = now()`,
        [
          event.aggregateId,
          str(p['symbol']) ?? event.aggregateId,
          Number(p['chainId'] ?? event.chainId ?? 0),
          String(p['tokenAddress'] ?? '').toLowerCase(),
          str(p['wrapperAddress'])?.toLowerCase() ?? null,
          p['wrapperVersion'] ?? null,
          p['wrapperIsCurrent'] ?? null,
          num(p['multiplierValue']),
          p['multiplierDecimals'] ?? null,
          num(p['multiplierNonce']),
          date(p['scheduledActivation']),
          event.sourceTime ?? event.observedAt,
          event.id,
        ],
      );
      return;
    }

    case 'CHAIN_SNAPSHOT_OBSERVED': {
      // The comparison is written here rather than as its own event: it is a property OF
      // this observation, derived from the same two snapshots, and separating them would
      // let a projection show an agreement verdict from one block beside chain values from
      // another.
      const hasComparison = p['sourceAgreement'] !== undefined;
      await db.query(
        `UPDATE current_assets SET
           chain_observed_at = $2,
           chain_block_number = $3,
           chain_block_hash = $4,
           canonicality = COALESCE($5::check_outcome, canonicality),
           multiplier_nonce = COALESCE($6, multiplier_nonce),
           scheduled_activation = $10,
           source_agreement = COALESCE($8::source_agreement, source_agreement),
           comparison_fields = COALESCE($9::jsonb, comparison_fields),
           compared_at = CASE WHEN $8 IS NULL THEN compared_at ELSE $2 END,
           last_event_id = $7,
           updated_at = now()
         WHERE asset_id = $1`,
        [
          event.aggregateId,
          event.observedAt,
          event.blockNumber?.toString() ?? null,
          event.blockHash,
          str(p['canonicality']),
          num(p['multiplierNonce']),
          event.id,
          str(p['sourceAgreement']),
          hasComparison ? JSON.stringify(p['comparisonFields'] ?? []) : null,
          date(p['scheduledActivation']),
        ],
      );
      return;
    }

    case 'MULTIPLIER_SCHEDULED':
    case 'MULTIPLIER_OVERRIDDEN':
    case 'GUARD_WINDOW_ENTERED':
    case 'MULTIPLIER_EFFECTIVE':
    case 'RECONCILIATION_MATCHED':
    case 'RECONCILIATION_MISMATCHED': {
      await db.query(
        `UPDATE current_assets SET
           lifecycle_state = COALESCE($2::lifecycle_state, lifecycle_state),
           scheduled_activation = COALESCE($3, scheduled_activation),
           multiplier_nonce = COALESCE($4, multiplier_nonce),
           last_event_id = $5,
           updated_at = now()
         WHERE asset_id = $1`,
        [
          event.aggregateId,
          str(p['lifecycleState']),
          date(p['scheduledActivation']),
          num(p['multiplierNonce']),
          event.id,
        ],
      );
      return;
    }

    case 'MANUAL_REVIEW_OPENED': {
      await db.query(
        `INSERT INTO current_incidents (
           incident_id, asset_id, severity, status, reason_codes, reason_signature,
           first_detected_at, last_observed_at, opened_by_event_id, last_event_id, updated_at
         ) VALUES ($1,$2,$3,'OPEN',$4,$5,$6,$6,$7,$7, now())
         ON CONFLICT (asset_id, reason_signature) WHERE status IN ('OPEN', 'IN_REVIEW')
         DO UPDATE SET
           -- A repeating identical mismatch refreshes the incident rather than creating an
           -- unbounded stream of duplicates.
           last_observed_at = EXCLUDED.last_observed_at,
           last_event_id = EXCLUDED.last_event_id,
           updated_at = now()`,
        [
          str(p['incidentId']),
          event.aggregateId,
          str(p['severity']) ?? 'SAFETY_CRITICAL',
          (p['reasonCodes'] as string[] | undefined) ?? [],
          str(p['reasonSignature']) ?? '',
          event.observedAt,
          event.id,
        ],
      );
      await db.query(
        `UPDATE current_assets SET lifecycle_state = 'MANUAL_REVIEW', last_event_id = $2, updated_at = now()
         WHERE asset_id = $1`,
        [event.aggregateId, event.id],
      );
      return;
    }

    case 'MANUAL_REVIEW_RESOLVED': {
      await db.query(
        `UPDATE current_incidents SET
           status = 'RESOLVED', resolved_at = $2, last_event_id = $3, updated_at = now()
         WHERE incident_id = $1`,
        [str(p['incidentId']), event.observedAt, event.id],
      );
      return;
    }

    case 'RECEIPT_ISSUED': {
      await db.query(
        `INSERT INTO receipt_status (
           receipt_id, asset_id, chain_id, adapter_address, operation_digest,
           valid_after, valid_until, status, issued_event_id, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ISSUED',$8, now())
         ON CONFLICT (receipt_id) DO NOTHING`,
        [
          str(p['receiptId']),
          event.aggregateId,
          Number(p['chainId'] ?? 0),
          String(p['adapterAddress'] ?? '').toLowerCase(),
          str(p['operationDigest']),
          date(p['validAfter']),
          date(p['validUntil']),
          event.id,
        ],
      );
      return;
    }

    case 'RECEIPT_CONSUMED': {
      // A consumed receipt can never become unconsumed: the guard restricts the update to
      // rows still in ISSUED, so a replayed consumption changes nothing.
      await db.query(
        `UPDATE receipt_status SET
           status = 'CONSUMED', consumed_event_id = $2, consumed_tx_hash = $3, updated_at = now()
         WHERE receipt_id = $1 AND status = 'ISSUED'`,
        [str(p['receiptId']), event.id, event.txHash],
      );
      return;
    }

    case 'SOURCE_DEGRADED':
    case 'SOURCE_RECOVERED': {
      if (event.aggregateType === 'asset') {
        await db.query(
          `UPDATE current_assets SET
             lifecycle_state = 'RECOVERED', last_event_id = $2, updated_at = now()
           WHERE asset_id = $1`,
          [event.aggregateId, event.id],
        );
        return;
      }
      const healthy = event.eventType === 'SOURCE_RECOVERED';
      await db.query(
        `INSERT INTO current_source_health (
           source_kind, healthy, last_success_at, last_failure_at, detail, last_event_id, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (source_kind) DO UPDATE SET
           healthy = EXCLUDED.healthy,
           last_success_at = COALESCE(EXCLUDED.last_success_at, current_source_health.last_success_at),
           last_failure_at = COALESCE(EXCLUDED.last_failure_at, current_source_health.last_failure_at),
           detail = EXCLUDED.detail,
           last_event_id = EXCLUDED.last_event_id,
           updated_at = now()`,
        [
          event.sourceKind,
          healthy,
          healthy ? event.observedAt : null,
          healthy ? null : event.observedAt,
          str(p['detail']) ?? '',
          event.id,
        ],
      );
      return;
    }

    case 'REORG_DETECTED': {
      // Rewind the cursor to a safe block. The original observation is retained; only the
      // cursor moves, so the indexer re-reads and appends compensating evidence.
      await db.query(
        `UPDATE indexed_chain_cursor SET
           last_indexed_block = $2, last_indexed_hash = $3, safe_block = $2, updated_at = now()
         WHERE chain_id = $1`,
        [
          Number(p['chainId'] ?? event.chainId ?? 0),
          num(p['rewindToBlock']) ?? '0',
          String(p['rewindToHash'] ?? '').toLowerCase(),
        ],
      );
      return;
    }

    case 'CHAIN_CURSOR_ADVANCED': {
      await db.query(
        `INSERT INTO indexed_chain_cursor (
           chain_id, last_indexed_block, last_indexed_hash, safe_block,
           confirmation_depth, updated_at
         ) VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (chain_id) DO UPDATE SET
           last_indexed_block = EXCLUDED.last_indexed_block,
           last_indexed_hash = EXCLUDED.last_indexed_hash,
           safe_block = EXCLUDED.safe_block,
           confirmation_depth = EXCLUDED.confirmation_depth,
           updated_at = now()`,
        [
          Number(p['chainId'] ?? event.chainId ?? 0),
          num(p['lastIndexedBlock']) ?? event.blockNumber?.toString() ?? '0',
          String(p['lastIndexedHash'] ?? event.blockHash ?? '').toLowerCase(),
          num(p['safeBlock']) ?? event.blockNumber?.toString() ?? '0',
          Number(p['confirmationDepth'] ?? 0),
        ],
      );
      return;
    }

    case 'CHAIN_EVENTS_REVERTED': {
      const eventIds = Array.isArray(p['eventIds'])
        ? p['eventIds'].filter((id): id is string => typeof id === 'string')
        : [];
      if (eventIds.length === 0) return;
      await db.query(
        `UPDATE receipt_status SET
           status = 'ISSUED', consumed_event_id = NULL, consumed_tx_hash = NULL, updated_at = now()
         WHERE consumed_event_id = ANY($1::uuid[])`,
        [eventIds],
      );
      return;
    }

    case 'ACTION_REJECTED':
    case 'ACTION_EXECUTED':
    case 'PROJECTION_REBUILT':
      // Journal-only events. They carry decision evidence but imply no projection change.
      return;

    default: {
      // Exhaustive: a new event type is a compile error rather than a silently ignored fact.
      const exhaustive: never = event.eventType;
      throw new Error(`unhandled evidence event type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Drop and rebuild every projection from the journal.
 *
 * Runs in one transaction: the projections are never observably empty or half-built.
 */
export async function rebuildProjections(
  pool: Pool,
  options: { readonly upToEventId?: string } = {},
): Promise<{ readonly eventCount: number }> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Order matters: children before parents for the foreign keys back to the journal.
    await client.query('DELETE FROM current_incidents');
    await client.query('DELETE FROM receipt_status');
    await client.query('DELETE FROM current_assets');
    await client.query('DELETE FROM current_source_health');

    const events = await readAllEvents(client, options);
    for (const event of events) {
      await applyEventToProjections(client, event);
    }

    await client.query(
      `INSERT INTO projection_rebuilds (projection, up_to_event_id, event_count, completed_at)
       VALUES ('ALL', $1, $2, now())`,
      [options.upToEventId ?? null, events.length],
    );

    await client.query('COMMIT');
    return { eventCount: events.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
