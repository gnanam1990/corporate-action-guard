import { randomUUID } from 'node:crypto';
import { appendEvidence, applyEventToProjections, migrate, withTransaction } from '@cag/db';
import { fixtureEvidenceMessage } from '@cag/domain';
import { createLogger } from '@cag/observability';
import type { XLayerReader } from '@cag/xlayer-reader';
import { Pool } from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runFixtureObservationCycle } from '../src/fixture-observer.js';

const SCHEMA = 'cag_test_fixture_observer';
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://guard:guard@localhost:55432/guard';
const TOKEN = `0x${'11'.repeat(20)}`;
const WRAPPER = `0x${'22'.repeat(20)}`;
const BLOCK_HASH = `0x${'33'.repeat(32)}`;
const SOURCE_TIME = new Date('2026-09-04T08:00:00.000Z');
const ADMIN_KEY = `0x${'44'.repeat(32)}` as const;
const ADMIN = privateKeyToAccount(ADMIN_KEY).address;

let pool: Pool;
let nowMs = SOURCE_TIME.getTime() + 30_000;
let chainNonce = 7n;
let complete = true;

const fakeReader = {
  getConfirmationDepth: () => 10,
  getHead: async () => ({
    blockNumber: 200n,
    blockHash: BLOCK_HASH,
    blockTimestampMs: nowMs,
  }),
  getBlockStamp: async (blockNumber: bigint) => ({
    blockNumber,
    blockHash: BLOCK_HASH,
    blockTimestampMs: nowMs,
  }),
  observeAsset: async () => ({
    chainId: 1952,
    providerName: 'xlayer-testnet-test',
    observedAtMs: nowMs,
    blockNumber: 190n,
    blockHash: BLOCK_HASH,
    blockTimestampMs: nowMs,
    tokenAddress: TOKEN,
    wrapperAddress: WRAPPER,
    tokenHasBytecode: true,
    wrapperHasBytecode: true,
    wrapperAsset: TOKEN,
    currentMultiplier: 1_000_000n,
    newMultiplier: 1_000_000n,
    multiplierNonce: chainNonce,
    scheduledActivationMs: undefined,
    tokenDecimals: 6,
    failedReads: complete ? [] : ['token.newMultiplierNonce()'],
    complete,
    confirmationDepth: 10,
    settled: true,
  }),
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
    const signedPayload = {
      assetId: 'CAG-FIXTURE',
      chainId: 1952 as const,
      tokenAddress: TOKEN,
      wrapperAddress: WRAPPER,
      multiplierValue: '1000000',
      multiplierDecimals: 6,
      multiplierNonce: '7',
      scheduledActivation: null,
      observedAt: SOURCE_TIME.toISOString(),
    };
    const adminSignature = await privateKeyToAccount(ADMIN_KEY).signMessage({
      message: fixtureEvidenceMessage(signedPayload),
    });
    const intent = await appendEvidence(client, {
      aggregateType: 'asset',
      aggregateId: 'CAG-FIXTURE',
      eventType: 'API_SNAPSHOT_OBSERVED',
      observedAt: new Date(SOURCE_TIME.getTime() + 1_000),
      sourceTime: SOURCE_TIME,
      sourceKind: 'FIXTURE_CONTROL_PLANE',
      sourceLocator: '/v1/testnet/fixture-evidence',
      payload: {
        symbol: 'CAG-FIXTURE',
        chainId: 1952,
        tokenAddress: TOKEN,
        wrapperAddress: WRAPPER,
        wrapperVersion: 2,
        wrapperIsCurrent: true,
        multiplierValue: '1000000',
        multiplierDecimals: 6,
        multiplierNonce: '7',
        scheduledActivation: null,
        adminAddress: ADMIN.toLowerCase(),
        adminSignature,
        sourceObservedAt: SOURCE_TIME.toISOString(),
        observationBucket: '2026-09-04T08:00',
      },
      correlationId: randomUUID(),
      producerVersion: 'test@0.1.0',
    });
    await applyEventToProjections(client, intent.event);
  });
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

const run = () =>
  runFixtureObservationCycle({
    pool,
    reader: fakeReader,
    assetId: 'CAG-FIXTURE',
    tokenAddress: TOKEN,
    wrapperAddress: WRAPPER,
    adminAddress: ADMIN,
    logger: createLogger({ service: 'fixture-observer-test', level: 'error' }),
    producerVersion: 'test@0.1.0',
    now: () => nowMs,
  });

describe('signed fixture evidence observer', () => {
  it('matches signed intent against an independent confirmation-safe chain read', async () => {
    await expect(run()).resolves.toMatchObject({
      observed: true,
      agreement: 'MATCH',
      canonicality: 'PASS',
      blockNumber: 190n,
    });

    const result = await pool.query(
      `SELECT source_agreement, canonicality, api_observed_at, chain_block_number::text
         FROM current_assets WHERE asset_id = 'CAG-FIXTURE'`,
    );
    expect(result.rows[0]).toMatchObject({
      source_agreement: 'MATCH',
      canonicality: 'PASS',
      chain_block_number: '190',
    });
    expect((result.rows[0]?.api_observed_at as Date).toISOString()).toBe(SOURCE_TIME.toISOString());
  });

  it('does not let a previous chain projection overwrite the signed intent', async () => {
    chainNonce = 8n;
    nowMs += 60_000;
    await expect(run()).resolves.toMatchObject({ observed: true, agreement: 'MISMATCH' });

    const latest = await pool.query(
      `SELECT payload FROM evidence_events
        WHERE aggregate_id = 'CAG-FIXTURE' AND event_type = 'CHAIN_SNAPSHOT_OBSERVED'
        ORDER BY ingested_at DESC, id DESC LIMIT 1`,
    );
    expect(latest.rows[0]?.payload).toMatchObject({
      sourceAgreement: 'MISMATCH',
      multiplierNonce: '8',
    });
  });

  it('marks a partial chain snapshot incomplete even when returned fields happen to match', async () => {
    chainNonce = 7n;
    complete = false;
    nowMs += 60_000;
    await expect(run()).resolves.toMatchObject({ observed: true, agreement: 'INCOMPLETE' });
  });
});
