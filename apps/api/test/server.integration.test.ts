import { randomUUID } from 'node:crypto';
import { appendEvidence, applyEventToProjections, migrate, withTransaction } from '@cag/db';
import { summarizeCanonicality, type SourceComparison } from '@cag/domain';
import { ReceiptSigner } from '@cag/receipts';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashApiKey, type ApiKeyRecord } from '../src/auth.js';
import { buildServer } from '../src/server.js';
import type { EvidenceBundle } from '../src/preflight-service.js';

const SCHEMA = 'cag_test_api';
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://guard:guard@localhost:55432/guard';
const KEY_SIGNER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADAPTER = '0x1111111111111111111111111111111111111111';
const NOW = 1_788_000_000_000;

const INTEGRATOR_KEY = 'cag_integ001_0123456789abcdef0123456789abcdef';
const OPERATOR_KEY = 'cag_operat01_0123456789abcdef0123456789abcdef';
const PUBLIC_KEY = 'cag_public01_0123456789abcdef0123456789abcdef';
const REVOKED_KEY = 'cag_revoke01_0123456789abcdef0123456789abcdef';

const KEYS: Record<string, ApiKeyRecord> = {
  integ001: {
    keyId: 'integ001',
    principal: 'integrator-a',
    hash: hashApiKey(INTEGRATOR_KEY),
    scopes: ['integrator:preflight'],
    revoked: false,
  },
  operat01: {
    keyId: 'operat01',
    principal: 'operator-a',
    hash: hashApiKey(OPERATOR_KEY),
    scopes: ['operator:review'],
    revoked: false,
  },
  public01: {
    keyId: 'public01',
    principal: 'public-a',
    hash: hashApiKey(PUBLIC_KEY),
    scopes: ['public:read'],
    revoked: false,
  },
  revoke01: {
    keyId: 'revoke01',
    principal: 'revoked-a',
    hash: hashApiKey(REVOKED_KEY),
    scopes: ['integrator:preflight'],
    revoked: true,
  },
};

let pool: Pool;
let app: FastifyInstance;
let evidenceOverride: Partial<EvidenceBundle> = {};

const matching: SourceComparison = {
  agreement: 'MATCH',
  fields: [
    {
      field: 'multiplier',
      agreement: 'MATCH',
      apiValue: '1.0',
      chainValue: '1.0',
      requiredForAgreement: true,
    },
  ],
};

const baseEvidence = (): EvidenceBundle => ({
  assetKnown: true,
  registryTokenAddress: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  registryWrapperAddress: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
  registryWrapperIsCurrent: true,
  observedWrapperAsset: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  canonicality: summarizeCanonicality([
    { name: 'TOKEN_MATCHES_REGISTRY', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_MATCHES_REGISTRY', outcome: 'PASS', detail: 'ok' },
    { name: 'TOKEN_HAS_BYTECODE', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_HAS_BYTECODE', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_ASSET_RELATION', outcome: 'PASS', detail: 'ok' },
    { name: 'WRAPPER_VERSION_CURRENT', outcome: 'PASS', detail: 'ok' },
  ]),
  sourceComparison: matching,
  onChainMultiplierNonce: 5n,
  apiObservedAtMs: NOW - 5_000,
  chainObservedAtMs: NOW - 3_000,
  manualReviewOpen: false,
  evidenceIds: ['evt-1'],
  blockNumber: 69_686_711n,
  blockHash: `0x${'ab'.repeat(32)}`,
  ...evidenceOverride,
});

const preflightBody = () => ({
  chainId: 1952,
  assetId: 'AAPLx',
  target: '0x3333333333333333333333333333333333333333',
  asset: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
  wrapper: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
  actionType: 'DEPOSIT' as const,
  caller: '0x2222222222222222222222222222222222222222',
  recipient: '0x4444444444444444444444444444444444444444',
  amount: '1000000000000000000',
  expectedMultiplierNonce: '5',
});

beforeAll(async () => {
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();

  const url = new URL(DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${SCHEMA}`);
  await migrate(url.toString());

  pool = new Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });

  // Seed through the real journal path, so the projections under test are a genuine fold.
  await withTransaction(pool, async (client) => {
    const { event } = await appendEvidence(client, {
      aggregateType: 'asset',
      aggregateId: 'AAPLx',
      eventType: 'ASSET_DISCOVERED',
      observedAt: new Date(NOW - 5_000),
      sourceKind: 'XSTOCKS_API',
      sourceLocator: '/public/assets/AAPLx',
      payload: {
        symbol: 'AAPLx',
        chainId: 196,
        tokenAddress: '0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a',
        wrapperAddress: '0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',
        multiplierNonce: '5',
        observationBucket: 'b1',
      },
      correlationId: randomUUID(),
      producerVersion: 'test@0.1.0',
    });
    await applyEventToProjections(client, event);
  });

  app = await buildServer({
    db: pool,
    databaseUrl: DATABASE_URL,
    signer: new ReceiptSigner(() => KEY_SIGNER, 1952, ADAPTER),
    policy: {
      supportedChainIds: [1952],
      guardBeforeMs: 900_000,
      guardAfterMs: 900_000,
      apiMaxAgeMs: 300_000,
      chainMaxAgeMs: 120_000,
      receiptLifetimeMs: 300_000,
      verifyingContract: ADAPTER,
    },
    lookupApiKey: (keyId) => KEYS[keyId],
    loadEvidence: async () => baseEvidence(),
    corsOrigins: ['http://localhost:3000'],
    now: () => NOW,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  const admin = new Pool({ connectionString: DATABASE_URL });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: body, headers });

describe('health', () => {
  it('liveness does not depend on the database', async () => {
    const res = await get('/v1/health/live');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('live');
  });

  it('readiness reports real dependency state', async () => {
    const res = await get('/v1/health/ready');
    expect(res.statusCode).toBe(200);
    const components = res.json().components as { name: string; ok: boolean }[];
    expect(components.find((c) => c.name === 'database')?.ok).toBe(true);
  });

  it('readiness never leaks the signing key, only the public address', async () => {
    const body = (await get('/v1/health/ready')).body;
    expect(body).not.toContain(KEY_SIGNER);
    expect(body).toContain('0x70997970');
  });
});

describe('public evidence reads', () => {
  it('lists assets with freshness travelling alongside', async () => {
    const res = await get('/v1/assets');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].symbol).toBe('AAPLx');
    // A client cannot render this as current without also having the means to see it is not.
    expect(body.servedAt).toBe(new Date(NOW).toISOString());
  });

  it('returns one asset by id', async () => {
    const res = await get('/v1/assets/AAPLx');
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenAddress).toBe('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a');
  });

  it('404s an unknown asset rather than returning an empty shell', async () => {
    expect((await get('/v1/assets/NOPE')).statusCode).toBe(404);
  });

  it('rejects an out-of-range page size', async () => {
    const res = await get('/v1/assets?limit=5000');
    expect(res.statusCode).toBe(400);
    expect(res.json().type).toContain('bad-request');
  });

  it('rejects an unknown lifecycle filter rather than ignoring it', async () => {
    // Silently ignoring an unrecognised filter would show the operator more than they asked
    // for while appearing to have filtered.
    expect((await get('/v1/assets?lifecycleState=TOTALLY_FINE')).statusCode).toBe(400);
  });

  it('a SQL-injection-shaped search term is data, not SQL', async () => {
    const res = await get(
      `/v1/assets?search=${encodeURIComponent("'; DROP TABLE current_assets; --")}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    // The table is still there.
    expect((await get('/v1/assets')).json().items).toHaveLength(1);
  });

  it('a LIKE wildcard in the search term is escaped, not honoured', async () => {
    const res = await get('/v1/assets?search=%25');
    expect(res.json().items).toHaveLength(0);
  });

  it('serves the coverage summary', async () => {
    const res = await get('/v1/system/coverage');
    expect(res.statusCode).toBe(200);
    expect(res.json().discovered).toBe(1);
  });

  it('serves source health', async () => {
    expect((await get('/v1/system/source-health')).statusCode).toBe(200);
  });

  it('serves incidents', async () => {
    const res = await get('/v1/incidents');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('sets a correlation id on every response', async () => {
    expect((await get('/v1/assets')).headers['x-correlation-id']).toBeDefined();
  });

  it('echoes a caller-supplied correlation id', async () => {
    const res = await get('/v1/assets', { 'x-correlation-id': 'trace-abc-123' });
    expect(res.headers['x-correlation-id']).toBe('trace-abc-123');
  });

  it('refuses a malformed correlation id rather than reflecting it into logs', async () => {
    // Log injection: a newline in a reflected header would forge log entries.
    const res = await get('/v1/assets', { 'x-correlation-id': 'bad\nvalue' });
    expect(res.headers['x-correlation-id']).not.toContain('\n');
  });
});

describe('authentication and scopes', () => {
  it('rejects preflight with no key', async () => {
    const res = await post('/v1/preflight', preflightBody(), {
      'idempotency-key': 'idem-00000001',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked key', async () => {
    const res = await post('/v1/preflight', preflightBody(), {
      'x-api-key': REVOKED_KEY,
      'idempotency-key': 'idem-00000002',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns an identical body for every authentication failure', async () => {
    // Distinguishing them would tell an attacker whether a key id exists.
    const missing = await post('/v1/preflight', preflightBody(), {
      'idempotency-key': 'idem-00000003',
    });
    const revoked = await post('/v1/preflight', preflightBody(), {
      'x-api-key': REVOKED_KEY,
      'idempotency-key': 'idem-00000004',
    });
    const unknown = await post('/v1/preflight', preflightBody(), {
      'x-api-key': 'cag_zzzzzzzz_0123456789abcdef0123456789abcdef',
      'idempotency-key': 'idem-00000005',
    });
    expect(revoked.json()).toEqual(missing.json());
    expect(unknown.json()).toEqual(missing.json());
  });

  it('rejects a key with the wrong scope', async () => {
    const res = await post('/v1/preflight', preflightBody(), {
      'x-api-key': PUBLIC_KEY,
      'idempotency-key': 'idem-00000006',
    });
    expect(res.statusCode).toBe(403);
  });

  it('an operator key cannot call preflight', async () => {
    const res = await post('/v1/preflight', preflightBody(), {
      'x-api-key': OPERATOR_KEY,
      'idempotency-key': 'idem-00000007',
    });
    expect(res.statusCode).toBe(403);
  });

  it('an integrator key cannot resolve a review', async () => {
    const res = await post(
      '/v1/incidents/abc/review-resolution',
      { reason: 'x'.repeat(40), evidenceIds: ['e'], actor: 'a' },
      { 'x-api-key': INTEGRATOR_KEY },
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('preflight over HTTP', () => {
  const headers = (idem: string) => ({ 'x-api-key': INTEGRATOR_KEY, 'idempotency-key': idem });

  it('requires an idempotency key', async () => {
    // A retried preflight must not mint a second receipt for the same intent.
    const res = await post('/v1/preflight', preflightBody(), { 'x-api-key': INTEGRATOR_KEY });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/idempotency/i);
  });

  it('rejects a malformed idempotency key', async () => {
    const res = await post('/v1/preflight', preflightBody(), headers('short'));
    expect(res.statusCode).toBe(400);
  });

  it('ALLOWs and returns a receipt when the evidence supports it', async () => {
    const res = await post('/v1/preflight', preflightBody(), headers('idem-allow-0001'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision).toBe('ALLOW');
    expect(body.receipt.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('BLOCKs with no receipt when evidence disagrees', async () => {
    evidenceOverride = { sourceComparison: { ...matching, agreement: 'MISMATCH' } };
    const res = await post('/v1/preflight', preflightBody(), headers('idem-block-0001'));
    evidenceOverride = {};

    const body = res.json();
    expect(body.decision).toBe('BLOCK');
    expect(body.reasonCodes).toContain('SOURCE_MISMATCH');
    expect(body.receipt).toBeUndefined();
    expect(res.body).not.toContain('signature');
  });

  it('rejects a malformed address in the body', async () => {
    const res = await post(
      '/v1/preflight',
      { ...preflightBody(), recipient: '0xnope' },
      headers('idem-bad-00001'),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().errors?.[0]?.path).toBe('recipient');
  });

  it('rejects a floating-point amount', async () => {
    const res = await post(
      '/v1/preflight',
      { ...preflightBody(), amount: '1.5' },
      headers('idem-bad-00002'),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unsupported chain at the schema or the predicate', async () => {
    const res = await post(
      '/v1/preflight',
      { ...preflightBody(), chainId: 196 },
      headers('idem-bad-00003'),
    );
    expect(res.json().decision).toBe('BLOCK');
    expect(res.json().reasonCodes).toContain('UNSUPPORTED_CHAIN');
  });
});

describe('operator review', () => {
  it('rejects a one-click mark-safe', async () => {
    const res = await post(
      '/v1/incidents/inc-1/review-resolution',
      { reason: 'ok', evidenceIds: ['e'], actor: 'operator-a' },
      { 'x-api-key': OPERATOR_KEY },
    );
    expect(res.statusCode).toBe(400);
  });

  it('records a resolution but does not resume protected actions', async () => {
    const res = await post(
      '/v1/incidents/inc-1/review-resolution',
      {
        reason: 'Provider outage resolved; API and chain agree again at block 69686711.',
        evidenceIds: ['evt-1'],
        actor: 'operator-a',
      },
      { 'x-api-key': OPERATOR_KEY },
    );
    expect(res.statusCode).toBe(202);
    // An operator records a decision. They do not assert that the sources now agree.
    expect(res.json().protectedActionsResumed).toBe(false);
  });
});

describe('error bodies never leak internals', () => {
  it('a 404 carries no stack trace or connection string', async () => {
    const body = (await get('/v1/definitely-not-a-route')).body;
    expect(body).not.toMatch(/postgres|at .*\.ts:|node_modules/i);
  });

  it('problem responses use the problem+json content type', async () => {
    const res = await get('/v1/assets?limit=99999');
    expect(res.headers['content-type']).toContain('application/problem+json');
  });
});

describe('security headers and CORS', () => {
  it('sets strict security headers', async () => {
    const headers = (await get('/v1/assets')).headers;
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('does not reflect an arbitrary origin', async () => {
    const res = await get('/v1/assets', { origin: 'https://evil.example.com' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows a configured origin', async () => {
    const res = await get('/v1/assets', { origin: 'http://localhost:3000' });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
});
