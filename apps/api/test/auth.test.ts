import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authenticate,
  hashApiKey,
  hasScope,
  SCOPES,
  type ApiKeyRecord,
  type Scope,
} from '../src/auth.js';
import { problem } from '../src/problem.js';

const RAW = 'cag_abcd1234_0123456789abcdef0123456789abcdef';
const KEY_ID = 'abcd1234';

const record = (over: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  keyId: KEY_ID,
  principal: 'integrator-a',
  hash: hashApiKey(RAW),
  scopes: ['integrator:preflight'],
  revoked: false,
  ...over,
});

const lookup = (r: ApiKeyRecord | undefined) => (id: string) => (id === KEY_ID ? r : undefined);

describe('api key authentication', () => {
  it('accepts the exact key format produced by the repository generator', async () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const output = execFileSync(process.execPath, ['scripts/generate-api-key.mjs', 'integrator'], {
      cwd: root,
      encoding: 'utf8',
    });
    const lines = output.split('\n');
    const raw = lines[1];
    const hash = lines.find((line) => line.startsWith('INTEGRATOR_API_KEY_HASH='))?.split('=')[1];

    // Keep the generated secret out of assertion output while checking the full boundary.
    expect(typeof raw === 'string' && /^cag_integ001_[A-Za-z0-9]{32,}$/.test(raw)).toBe(true);
    expect(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)).toBe(true);
    if (raw === undefined || hash === undefined) throw new Error('generator output was incomplete');

    const generated = record({ keyId: 'integ001', hash });
    await expect(
      authenticate(raw, (keyId) => (keyId === generated.keyId ? generated : undefined)),
    ).resolves.toMatchObject({ ok: true, keyId: 'integ001' });
  });

  it('accepts a valid key and returns its principal and scopes', async () => {
    const result = await authenticate(RAW, lookup(record()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toBe('integrator-a');
      expect(result.scopes).toEqual(['integrator:preflight']);
    }
  });

  it('rejects a missing key', async () => {
    await expect(authenticate(undefined, lookup(record()))).resolves.toMatchObject({
      ok: false,
      reason: 'MISSING',
    });
  });

  it('rejects a malformed key', async () => {
    await expect(authenticate('not-a-key', lookup(record()))).resolves.toMatchObject({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects an unknown key id', async () => {
    await expect(authenticate(RAW, lookup(undefined))).resolves.toMatchObject({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('rejects a correct key id with a wrong secret', async () => {
    const wrong = 'cag_abcd1234_ffffffffffffffffffffffffffffffff';
    await expect(authenticate(wrong, lookup(record()))).resolves.toMatchObject({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('rejects a revoked key', async () => {
    await expect(authenticate(RAW, lookup(record({ revoked: true })))).resolves.toMatchObject({
      ok: false,
      reason: 'REVOKED',
    });
  });

  it('checks revocation only after the hash comparison', async () => {
    // So a revoked key and an unknown key are indistinguishable to someone probing for
    // valid key ids with a guessed secret.
    const wrongSecret = 'cag_abcd1234_ffffffffffffffffffffffffffffffff';
    await expect(
      authenticate(wrongSecret, lookup(record({ revoked: true }))),
    ).resolves.toMatchObject({
      reason: 'UNKNOWN_KEY',
    });
  });

  it('never stores or returns the raw key', async () => {
    const stored = record();
    expect(stored.hash).not.toContain(RAW);
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await authenticate(RAW, lookup(stored)))).not.toContain(RAW);
  });

  it('the key id is public and safe to log', async () => {
    const result = await authenticate(RAW, lookup(record()));
    if (result.ok) expect(result.keyId).toBe(KEY_ID);
  });

  it('hashing is stable and collision-distinct', () => {
    expect(hashApiKey(RAW)).toBe(hashApiKey(RAW));
    expect(hashApiKey(RAW)).not.toBe(hashApiKey(`${RAW}x`));
  });
});

describe('scope matrix', () => {
  const matrix: Array<[Scope, Scope, boolean]> = [
    ['public:read', 'public:read', true],
    ['integrator:preflight', 'integrator:preflight', true],
    ['integrator:preflight', 'operator:review', false],
    ['integrator:preflight', 'admin:reconcile', false],
    ['operator:review', 'admin:reconcile', false],
    ['operator:review', 'integrator:preflight', false],
    ['admin:reconcile', 'operator:review', false],
    ['public:read', 'integrator:preflight', false],
  ];

  for (const [held, required, expected] of matrix) {
    it(`holding ${held}, requiring ${required} -> ${expected}`, () => {
      expect(hasScope([held], required)).toBe(expected);
    });
  }

  it('scopes do not imply one another — there is no hierarchy to escalate through', () => {
    for (const scope of SCOPES) {
      const others = SCOPES.filter((s) => s !== scope);
      for (const other of others) {
        expect(hasScope([scope], other)).toBe(false);
      }
    }
  });
});

describe('problem details never leak internals', () => {
  it('a 500 carries a correlation id and nothing else useful to a prober', () => {
    const p = problem.internal('cid-123');
    expect(p.status).toBe(500);
    expect(p.correlationId).toBe('cid-123');
    const body = JSON.stringify(p);
    expect(body).not.toMatch(/postgres|stack|at .*\.ts:|node_modules/i);
  });

  it('every problem carries a stable type URI and a status', () => {
    const all = [
      problem.badRequest('x'),
      problem.unauthorized(),
      problem.forbidden('x'),
      problem.notFound('x'),
      problem.conflict('x'),
      problem.tooManyRequests('x'),
      problem.internal('c'),
      problem.serviceUnavailable('x'),
    ];
    for (const p of all) {
      expect(p.type).toMatch(/^https:\/\//);
      expect(p.status).toBeGreaterThanOrEqual(400);
      expect(p.title.length).toBeGreaterThan(0);
    }
  });
});
