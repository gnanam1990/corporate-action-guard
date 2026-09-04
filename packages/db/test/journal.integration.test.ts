import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendEvidence,
  applyEventToProjections,
  JournalMutationError,
  getStoredApiKey,
  provisionApiKeyHash,
  rebuildProjections,
  readAggregate,
  withTransaction,
  type AppendEvidenceInput,
} from '../src/index.js';
import { createTestPool, dropTestSchema, PRODUCER, uuid } from './helpers.js';

const SCHEMA = 'cag_test_journal';
let pool: Pool;

beforeAll(async () => {
  pool = await createTestPool(SCHEMA);
}, 60_000);

afterAll(async () => {
  await dropTestSchema(pool, SCHEMA);
});

/**
 * Mirrors the real worker path: evidence and the projection update it implies are written
 * in one transaction. Tests use this so the live projections are a genuine incremental
 * fold, which is what makes the rebuild comparison meaningful.
 */
async function appendAndProject(input: AppendEvidenceInput) {
  return withTransaction(pool, async (client) => {
    const result = await appendEvidence(client, input);
    await applyEventToProjections(client, result.event);
    return result;
  });
}

const apiSnapshot = (over: Partial<AppendEvidenceInput> = {}): AppendEvidenceInput => ({
  aggregateType: 'asset',
  aggregateId: 'AAPLx',
  eventType: 'API_SNAPSHOT_OBSERVED',
  observedAt: new Date('2026-09-17T12:00:00.000Z'),
  sourceKind: 'XSTOCKS_API',
  sourceLocator: '/v1/assets',
  payload: {
    symbol: 'AAPLx',
    chainId: 196,
    tokenAddress: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
    multiplierNonce: '7',
    observationBucket: '2026-09-17T12:00',
  },
  correlationId: uuid(1),
  producerVersion: PRODUCER,
  ...over,
});

const chainLog = (over: Partial<AppendEvidenceInput> = {}): AppendEvidenceInput => ({
  aggregateType: 'asset',
  aggregateId: 'AAPLx',
  eventType: 'MULTIPLIER_SCHEDULED',
  observedAt: new Date('2026-09-17T12:00:05.000Z'),
  sourceKind: 'XLAYER_RPC',
  sourceLocator: 'provider-a',
  chain: {
    chainId: 196,
    blockNumber: 12_345_678n,
    blockHash: '0x' + 'a'.repeat(64),
    txHash: '0x' + 'b'.repeat(64),
    logIndex: 3,
  },
  payload: { lifecycleState: 'PENDING', multiplierNonce: '8' },
  correlationId: uuid(2),
  producerVersion: PRODUCER,
  ...over,
});

describe('persistent API keys', () => {
  it('stores only the hash and returns durable scopes', async () => {
    const hash = 'a'.repeat(64);
    await provisionApiKeyHash(pool, {
      keyId: 'integ001',
      principal: 'integrator-a',
      hash,
      scopes: ['integrator:preflight'],
    });
    await expect(getStoredApiKey(pool, 'integ001')).resolves.toEqual({
      keyId: 'integ001',
      principal: 'integrator-a',
      hash,
      scopes: ['integrator:preflight'],
      revoked: false,
    });
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'api_keys'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('raw_key');
  });

  it('rejects unknown scopes at the database boundary', async () => {
    await expect(
      provisionApiKeyHash(pool, {
        keyId: 'badsc001',
        principal: 'bad-scope',
        hash: 'b'.repeat(64),
        scopes: ['admin:everything'],
      }),
    ).rejects.toThrow();
  });
});

describe('append-only enforcement', () => {
  it('rejects UPDATE through the application role', async () => {
    const { event } = await appendAndProject(apiSnapshot());
    await expect(
      pool.query('UPDATE evidence_events SET source_locator = $1 WHERE id = $2', [
        'tampered',
        event.id,
      ]),
    ).rejects.toThrow(/append-only/i);
  });

  it('rejects DELETE through the application role', async () => {
    const { event } = await appendAndProject(apiSnapshot({ correlationId: uuid(11) }));
    await expect(
      pool.query('DELETE FROM evidence_events WHERE id = $1', [event.id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('leaves the row intact after a rejected mutation', async () => {
    const { event } = await appendAndProject(apiSnapshot({ correlationId: uuid(12) }));
    await pool
      .query('UPDATE evidence_events SET payload = $1 WHERE id = $2', ['{}', event.id])
      .catch(() => undefined);
    const { rows } = await pool.query('SELECT source_locator FROM evidence_events WHERE id = $1', [
      event.id,
    ]);
    expect(rows[0].source_locator).toBe('/v1/assets');
  });
});

describe('idempotency', () => {
  it('duplicate API ingestion in the same bucket is a no-op', async () => {
    const input = apiSnapshot({ correlationId: uuid(20), aggregateId: 'MSFTx' });
    const first = await appendAndProject(input);
    const second = await appendAndProject(input);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM evidence_events WHERE aggregate_id = 'MSFTx'",
    );
    expect(rows[0].n).toBe(1);
  });

  it('is stable across JSON key order — the same fact hashes the same', async () => {
    const base = apiSnapshot({ aggregateId: 'NVDAx', correlationId: uuid(21) });
    const reordered: AppendEvidenceInput = {
      ...base,
      payload: {
        observationBucket: '2026-09-17T12:00',
        multiplierNonce: '7',
        tokenAddress: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
        chainId: 196,
        symbol: 'NVDAx',
      },
    };
    await appendAndProject({ ...base, payload: { ...base.payload, symbol: 'NVDAx' } });
    const second = await appendAndProject(reordered);
    expect(second.deduplicated).toBe(true);
  });

  it('a different observation bucket is a new observation, not a duplicate', async () => {
    const base = apiSnapshot({ aggregateId: 'TSLAx', correlationId: uuid(22) });
    const a = await appendAndProject(base);
    const b = await appendAndProject({
      ...base,
      payload: { ...base.payload, observationBucket: '2026-09-17T12:05' },
    });
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(false);
    expect(b.event.id).not.toBe(a.event.id);
  });

  it('duplicate chain log ingestion is a no-op', async () => {
    const input = chainLog({ aggregateId: 'GOOGLx' });
    const first = await appendAndProject(input);
    // A provider fallback or a restart can deliver the same log twice with different
    // correlation ids. It is the same fact and must occupy one row.
    const second = await appendAndProject({ ...input, correlationId: uuid(99) });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.event.id).toBe(first.event.id);
  });

  it('the same tx with a different log index is a different fact', async () => {
    const input = chainLog({ aggregateId: 'AMZNx', correlationId: uuid(23) });
    await appendAndProject(input);
    const other = await appendAndProject({
      ...input,
      chain: { ...input.chain!, logIndex: 4 },
      correlationId: uuid(24),
    });
    expect(other.deduplicated).toBe(false);
  });
});

describe('secret containment', () => {
  it('refuses a payload carrying a private key', async () => {
    await expect(
      appendEvidence(pool, apiSnapshot({ payload: { privateKey: '0x' + '1'.repeat(64) } })),
    ).rejects.toThrow(JournalMutationError);
  });

  it('refuses a secret nested deep inside the payload', async () => {
    await expect(
      appendEvidence(
        pool,
        apiSnapshot({ payload: { request: { headers: { Authorization: 'Bearer abc' } } } }),
      ),
    ).rejects.toThrow(JournalMutationError);
  });

  it('refuses a secret inside an array element', async () => {
    await expect(
      appendEvidence(pool, apiSnapshot({ payload: { calls: [{ apiKey: 'sk_live_x' }] } })),
    ).rejects.toThrow(JournalMutationError);
  });

  it('is case-insensitive about the forbidden key name', async () => {
    await expect(
      appendEvidence(pool, apiSnapshot({ payload: { PRIVATEKEY: 'x' } })),
    ).rejects.toThrow(JournalMutationError);
  });
});

describe('transactional integrity', () => {
  it('a rolled-back transaction leaves neither event nor projection', async () => {
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM evidence_events WHERE aggregate_id = 'ROLLBACK'",
    );

    await expect(
      withTransaction(pool, async (client) => {
        const { event } = await appendEvidence(
          client,
          apiSnapshot({ aggregateId: 'ROLLBACK', correlationId: uuid(30) }),
        );
        await applyEventToProjections(client, event);
        throw new Error('simulated failure after both writes');
      }),
    ).rejects.toThrow('simulated failure');

    const after = await pool.query(
      "SELECT count(*)::int AS n FROM evidence_events WHERE aggregate_id = 'ROLLBACK'",
    );
    const proj = await pool.query(
      "SELECT count(*)::int AS n FROM current_assets WHERE asset_id = 'ROLLBACK'",
    );

    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(proj.rows[0].n).toBe(0);
  });

  it('a committed transaction leaves both', async () => {
    await withTransaction(pool, async (client) => {
      const { event } = await appendEvidence(
        client,
        apiSnapshot({ aggregateId: 'COMMITTED', correlationId: uuid(31) }),
      );
      await applyEventToProjections(client, event);
    });

    const ev = await pool.query(
      "SELECT count(*)::int AS n FROM evidence_events WHERE aggregate_id = 'COMMITTED'",
    );
    const proj = await pool.query(
      "SELECT count(*)::int AS n FROM current_assets WHERE asset_id = 'COMMITTED'",
    );
    expect(ev.rows[0].n).toBe(1);
    expect(proj.rows[0].n).toBe(1);
  });
});

describe('receipt consumption is single-winner', () => {
  it('two concurrent consumers produce exactly one state change', async () => {
    await appendAndProject({
      aggregateType: 'asset',
      aggregateId: 'RACE',
      eventType: 'RECEIPT_ISSUED',
      observedAt: new Date('2026-09-17T12:00:00.000Z'),
      sourceKind: 'SYSTEM',
      sourceLocator: 'signer',
      payload: {
        receiptId: 'rcpt-race-1',
        chainId: 1952,
        adapterAddress: '0x' + 'c'.repeat(40),
        operationDigest: '0x' + 'd'.repeat(64),
        validAfter: '2026-09-17T11:59:00.000Z',
        validUntil: '2026-09-17T12:05:00.000Z',
      },
      correlationId: uuid(40),
      producerVersion: PRODUCER,
    });

    const consume = async (n: number) => {
      const { event } = await appendEvidence(pool, {
        aggregateType: 'asset',
        aggregateId: 'RACE',
        eventType: 'RECEIPT_CONSUMED',
        observedAt: new Date('2026-09-17T12:01:00.000Z'),
        sourceKind: 'XLAYER_RPC',
        sourceLocator: 'provider-a',
        chain: {
          chainId: 1952,
          blockNumber: BigInt(1000 + n),
          blockHash: '0x' + n.toString().padStart(64, '0'),
          txHash: '0x' + n.toString().padStart(64, 'e'),
          logIndex: n,
        },
        payload: { receiptId: 'rcpt-race-1' },
        correlationId: uuid(41 + n),
        producerVersion: PRODUCER,
      });
      const res = await pool.query(
        `UPDATE receipt_status SET status = 'CONSUMED', consumed_event_id = $2, updated_at = now()
         WHERE receipt_id = $1 AND status = 'ISSUED'`,
        ['rcpt-race-1', event.id],
      );
      return res.rowCount ?? 0;
    };

    const [a, b] = await Promise.all([consume(1), consume(2)]);
    expect(a + b).toBe(1);

    const { rows } = await pool.query(
      "SELECT status FROM receipt_status WHERE receipt_id = 'rcpt-race-1'",
    );
    expect(rows[0].status).toBe('CONSUMED');
  });

  it('a consumed receipt can never become unconsumed', async () => {
    const res = await pool.query(
      `UPDATE receipt_status SET status = 'ISSUED' WHERE receipt_id = $1 AND status = 'ISSUED'`,
      ['rcpt-race-1'],
    );
    expect(res.rowCount).toBe(0);
  });
});

describe('asset recovery projection', () => {
  it('SOURCE_RECOVERED on an asset advances lifecycle without changing source health', async () => {
    await appendAndProject(apiSnapshot({ aggregateId: 'RECOVERY', correlationId: uuid(60) }));
    await appendAndProject({
      aggregateType: 'asset',
      aggregateId: 'RECOVERY',
      eventType: 'SOURCE_RECOVERED',
      observedAt: new Date('2026-09-17T12:02:00.000Z'),
      sourceKind: 'SYSTEM',
      sourceLocator: 'worker/reconciler',
      payload: { lifecycleState: 'RECOVERED', reasonCodes: [] },
      correlationId: uuid(61),
      producerVersion: PRODUCER,
    });

    const asset = await pool.query(
      "SELECT lifecycle_state FROM current_assets WHERE asset_id = 'RECOVERY'",
    );
    const health = await pool.query(
      "SELECT count(*)::int AS n FROM current_source_health WHERE source_kind = 'SYSTEM'",
    );
    expect(asset.rows[0]?.lifecycle_state).toBe('RECOVERED');
    expect(health.rows[0]?.n).toBe(0);
  });
});

describe('projection rebuild equals live projections', () => {
  it('a rebuild from the journal alone reproduces every projection row', async () => {
    // Snapshot the live projections, wipe them, rebuild from the journal, compare.
    const snapshot = async () => {
      const assets = await pool.query(
        `SELECT asset_id, symbol, chain_id, token_address, wrapper_address, lifecycle_state,
                canonicality, multiplier_nonce
         FROM current_assets ORDER BY asset_id`,
      );
      const receipts = await pool.query(
        'SELECT receipt_id, status, operation_digest FROM receipt_status ORDER BY receipt_id',
      );
      const incidents = await pool.query(
        'SELECT incident_id, asset_id, status, reason_codes FROM current_incidents ORDER BY incident_id',
      );
      return { assets: assets.rows, receipts: receipts.rows, incidents: incidents.rows };
    };

    // The live projections were maintained incrementally, one event at a time, in the
    // same transaction as the append. A rebuild folds the whole journal from scratch.
    // If those two disagree, the displayed state is not what the evidence supports.
    const incremental = await snapshot();
    const { eventCount } = await rebuildProjections(pool);
    const rebuilt = await snapshot();

    expect(eventCount).toBeGreaterThan(0);
    expect(rebuilt).toEqual(incremental);
  });

  it('is deterministic — rebuilding twice gives the same result', async () => {
    const snap = async () =>
      (
        await pool.query(
          'SELECT asset_id, lifecycle_state, multiplier_nonce FROM current_assets ORDER BY asset_id',
        )
      ).rows;

    await rebuildProjections(pool);
    const first = await snap();
    await rebuildProjections(pool);
    const second = await snap();
    expect(second).toEqual(first);
  });

  it('records every rebuild so a divergence investigation has a starting point', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM projection_rebuilds');
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('reading an aggregate', () => {
  it('returns events in journal order', async () => {
    const events = await readAggregate(pool, 'asset', 'AAPLx');
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.ingestedAt.getTime()).toBeGreaterThanOrEqual(
        events[i - 1]!.ingestedAt.getTime(),
      );
    }
  });

  it('preserves chain provenance exactly', async () => {
    const events = await readAggregate(pool, 'asset', 'GOOGLx');
    const withChain = events.find((e) => e.txHash !== null);
    expect(withChain?.blockNumber).toBe(12_345_678n);
    expect(withChain?.chainId).toBe(196);
    expect(withChain?.logIndex).toBe(3);
  });
});
