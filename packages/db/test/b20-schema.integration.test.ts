/**
 * The Base B20 schema, against real PostgreSQL.
 *
 * These are not shape assertions. Each one exercises a constraint that exists to stop a
 * specific wrong row from being written — a checksummed address becoming a second identity
 * for one asset, an unreachable RPC being recorded as a chain capability, an expected weekend
 * hold being marked actionable. A check constraint is the only place those rules survive a
 * refactor of the code above them.
 *
 * The migration is applied on top of the existing seven, in a fresh schema, so this also
 * proves the forward-only requirement: nothing here touches an existing table.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPool, dropTestSchema } from './helpers.js';

const SCHEMA = 'cag_test_b20_schema';
let pool: Pool;

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';
const BLOCK_HASH = '0xabf162b62c2a00469cf7e84b20c28749f5eaa926d5e3281cf7571a2d9c52425b';

beforeAll(async () => {
  pool = await createTestPool(SCHEMA);
}, 60_000);

afterAll(async () => {
  await dropTestSchema(pool, SCHEMA);
});

/** Run a statement and report whether a *check constraint* rejected it, and which one. */
async function attempt(sql: string, params: readonly unknown[] = []): Promise<string | undefined> {
  try {
    await pool.query(sql, [...params]);
    return undefined;
  } catch (error) {
    const message = String((error as Error).message);
    const match = /violates check constraint "([a-z0-9_]+)"/.exec(message);
    return match?.[1] ?? message;
  }
}

const insertAsset = (overrides: Partial<Record<string, unknown>> = {}) => {
  const row = {
    chain_id: 8453,
    address: AAPL,
    display_symbol: 'AAPLc',
    onchain_name: 'Apple Inc.',
    onchain_symbol: 'AAPLc',
    decimals: 8,
    status: 'VERIFIED',
    usable_for_action: true,
    issuer_source: 'https://www.base.org/stocks',
    multiplier_wad: '1000000000000000000',
    observed_block: '50993686',
    observed_block_hash: BLOCK_HASH,
    ...overrides,
  };
  return attempt(
    `INSERT INTO b20_assets (chain_id, address, display_symbol, onchain_name, onchain_symbol,
       decimals, status, usable_for_action, issuer_source, multiplier_wad, observed_block,
       observed_block_hash, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())`,
    Object.values(row),
  );
};

describe('the migration applies on top of the existing schema', () => {
  it('creates the Base tables without touching the journal', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_name LIKE 'b20_%' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [SCHEMA],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'b20_asset_metadata_history',
      'b20_assets',
      'b20_capabilities',
      'b20_feed_observations',
      'b20_ingest_cursors',
      'b20_multiplier_epochs',
      'b20_pending_schedules',
    ]);
  });

  it('leaves the journal append-only trigger in place', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'evidence_events' AND NOT t.tgisinternal`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('lists exactly the projections a rebuild may truncate', async () => {
    // b20_ingest_cursors is deliberately excluded: it is worker state, and truncating it
    // would silently re-ingest history under a stale fence.
    const { rows } = await pool.query<{ table_name: string }>(
      'SELECT table_name FROM b20_projection_tables ORDER BY table_name',
    );
    expect(rows.map((r) => r.table_name)).not.toContain('b20_ingest_cursors');
    expect(rows).toHaveLength(6);
  });
});

describe('asset identity', () => {
  it('accepts a well-formed verified asset', async () => {
    expect(await insertAsset()).toBeUndefined();
  });

  it('rejects a checksummed address, which would be a second identity for one asset', async () => {
    expect(await insertAsset({ address: AAPL.toUpperCase().replace('0X', '0x') })).toBe(
      'b20_assets_address_lowercase',
    );
  });

  it('refuses to mark a non-VERIFIED asset usable for a protected action', async () => {
    // The strongest form of the rule: not a code path that checks the status, but a row that
    // cannot exist. A refactor above this cannot reintroduce the bug.
    expect(
      await insertAsset({
        address: '0x1111111111111111111111111111111111111111',
        status: 'UNKNOWN',
        usable_for_action: true,
      }),
    ).toBe('b20_assets_action_requires_verified');
    expect(
      await insertAsset({
        address: '0x1111111111111111111111111111111111111111',
        status: 'CHANGED',
        usable_for_action: true,
      }),
    ).toBe('b20_assets_action_requires_verified');
  });

  it('rejects a zero multiplier, which would zero every holder', async () => {
    expect(
      await insertAsset({
        address: '0x2222222222222222222222222222222222222222',
        multiplier_wad: '0',
      }),
    ).toBe('b20_assets_multiplier_positive');
  });

  it('rejects decimals outside the range the B20 factory accepts', async () => {
    expect(
      await insertAsset({ address: '0x3333333333333333333333333333333333333333', decimals: 2 }),
    ).toBe('b20_assets_decimals_range');
  });

  it('allows two assets to share a display symbol', async () => {
    // Symbols are mutable on chain. A uniqueness constraint would turn a legitimate rename
    // into a write failure at exactly the moment an operator needs the record.
    expect(
      await insertAsset({
        address: '0x4444444444444444444444444444444444444444',
        display_symbol: 'AAPLc',
      }),
    ).toBeUndefined();
  });
});

describe('capability observations', () => {
  const insertCapability = (outcome: string, address = AAPL, selector = '0xa60bf13d') =>
    attempt(
      `INSERT INTO b20_capabilities (chain_id, address, selector, capability, surface, outcome,
         revert_data, observed_block, observed_at)
       VALUES (8453, $1, $2, 'uiMultiplier', 'COBALT_ERC8056', $3, null, 50993686, now())`,
      [address, selector, outcome],
    );

  it('stores NOT_DIALED, which is the live Base mainnet answer', async () => {
    expect(await insertCapability('NOT_DIALED')).toBeUndefined();
  });

  it('stores UNAVAILABLE as its own outcome, never folded into NOT_DIALED', async () => {
    // Collapsing them would turn an RPC outage into a permanent claim that the chain does
    // not support a feature.
    expect(
      await insertCapability('UNAVAILABLE', '0x5555555555555555555555555555555555555555'),
    ).toBeUndefined();
  });

  it('rejects an outcome outside the vocabulary', async () => {
    expect(await insertCapability('MAYBE', '0x6666666666666666666666666666666666666666')).toBe(
      'b20_capabilities_outcome',
    );
  });

  it('rejects a malformed selector', async () => {
    expect(
      await insertCapability('LIVE', '0x7777777777777777777777777777777777777777', '0xabc'),
    ).toBe('b20_capabilities_selector_shape');
  });
});

describe('pending schedules distinguish absence from inability to ask', () => {
  const insertPending = (
    address: string,
    multiplier: string | null,
    effectiveAt: number | null,
    capability: string,
  ) =>
    attempt(
      `INSERT INTO b20_pending_schedules (chain_id, address, pending_multiplier_wad,
         effective_at_seconds, capability_outcome, observed_block, observed_at)
       VALUES (8453, $1, $2, $3, $4, 50993686, now())`,
      [address, multiplier, effectiveAt, capability],
    );

  it('lets a LIVE capability assert that nothing is scheduled', async () => {
    expect(await insertPending(AAPL, null, null, 'LIVE')).toBeUndefined();
  });

  it('refuses to record "nothing scheduled" when the chain could not be asked', async () => {
    // This is the schema-level form of the product's most important refusal. On Base mainnet
    // today the scheduling surface is NOT_DIALED, so an empty pending row would be a false
    // negative on the most safety-critical question the product answers.
    expect(
      await insertPending('0x8888888888888888888888888888888888888888', null, null, 'NOT_DIALED'),
    ).toBe('b20_pending_absence_requires_live');
    expect(
      await insertPending('0x9999999999999999999999999999999999999999', null, null, 'UNAVAILABLE'),
    ).toBe('b20_pending_absence_requires_live');
  });

  it('rejects half a schedule', async () => {
    // A pending multiplier with no effectiveAt cannot be evaluated, and the reverse cannot
    // either.
    expect(
      await insertPending('0xaaaa000000000000000000000000000000000000', '2000', null, 'LIVE'),
    ).toBe('b20_pending_pair_complete');
    expect(
      await insertPending('0xbbbb000000000000000000000000000000000000', null, 1788776091, 'LIVE'),
    ).toBe('b20_pending_pair_complete');
  });
});

describe('feed observations', () => {
  const insertFeed = async (verdict: string, actionable: boolean, roundId = '1') => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evidence_events (aggregate_type, aggregate_id, event_type, observed_at,
         source_kind, source_locator, payload, payload_hash, correlation_id, producer_version)
       VALUES ('b20-feed', 'test', 'SOURCE_DEGRADED', now(), 'SYSTEM', 'test', '{}'::jsonb,
               repeat('a', 64), gen_random_uuid(), 'test@0.1.0')
       RETURNING id`,
    );
    return attempt(
      `INSERT INTO b20_feed_observations (chain_id, feed_proxy_address, price_basis, round_id,
         answer, started_at_seconds, updated_at_seconds, answered_in_round, decimals, verdict,
         actionable, policy_version, observed_block, observed_block_hash, observed_at, evidence_id)
       VALUES (8453, '0x787f13dea48db0897cbcdd985de77809d837f988', 'TOTAL_RETURN_TOKEN_PRICE',
               $1, 32008000000, 1788551901, 1788551901, $1, 8, $2, $3, 'v1', 50993686, $4, now(), $5)`,
      [roundId, verdict, actionable, BLOCK_HASH, rows[0]?.id],
    );
  };

  it('accepts a fresh, actionable round', async () => {
    expect(await insertFeed('FRESH', true, '1')).toBeUndefined();
  });

  it('refuses to mark an expected weekend hold actionable', async () => {
    // A hold is a correct price and an unacceptable input. This constraint is what stops that
    // distinction eroding under pressure to make a dashboard look complete.
    expect(await insertFeed('EXPECTED_HOLD', true, '2')).toBe('b20_feed_actionable_only_fresh');
    expect(await insertFeed('STALE', true, '3')).toBe('b20_feed_actionable_only_fresh');
    expect(await insertFeed('SEQUENCER_UNAVAILABLE', true, '4')).toBe(
      'b20_feed_actionable_only_fresh',
    );
  });

  it('records a non-actionable hold without objection', async () => {
    expect(await insertFeed('EXPECTED_HOLD', false, '5')).toBeUndefined();
  });

  it('rejects a price basis outside the two the product understands', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO evidence_events (aggregate_type, aggregate_id, event_type, observed_at,
         source_kind, source_locator, payload, payload_hash, correlation_id, producer_version)
       VALUES ('b20-feed', 'test', 'SOURCE_DEGRADED', now(), 'SYSTEM', 'test', '{}'::jsonb,
               repeat('b', 64), gen_random_uuid(), 'test@0.1.0')
       RETURNING id`,
    );
    const outcome = await attempt(
      `INSERT INTO b20_feed_observations (chain_id, feed_proxy_address, price_basis, round_id,
         answer, started_at_seconds, updated_at_seconds, answered_in_round, decimals, verdict,
         actionable, policy_version, observed_block, observed_block_hash, observed_at, evidence_id)
       VALUES (8453, '0x787f', 'SPOT_PRICE', 9, 1, 1, 1, 9, 8, 'FRESH', true, 'v1', 1, $1, now(), $2)`,
      [BLOCK_HASH, rows[0]?.id],
    );
    expect(outcome).toBe('b20_feed_price_basis');
  });
});

describe('ingest cursors', () => {
  it('starts at a fence and stores its retained block hashes', async () => {
    await pool.query(
      `INSERT INTO b20_ingest_cursors (chain_id, address, last_indexed_block, recent_blocks)
       VALUES (8453, $1, 50993686, $2::jsonb)`,
      [AAPL, JSON.stringify([{ number: '50993686', hash: BLOCK_HASH }])],
    );
    const { rows } = await pool.query<{ fence: string; last_indexed_block: string }>(
      'SELECT fence::text, last_indexed_block::text FROM b20_ingest_cursors WHERE address = $1',
      [AAPL],
    );
    expect(rows[0]?.fence).toBe('1');
    expect(rows[0]?.last_indexed_block).toBe('50993686');
  });

  it('rejects a negative block, which no cursor state can justify', async () => {
    expect(
      await attempt(
        `INSERT INTO b20_ingest_cursors (chain_id, address, last_indexed_block)
         VALUES (8453, '0xcccc000000000000000000000000000000000000', -1)`,
      ),
    ).toBe('b20_cursor_block_nonnegative');
  });
});
