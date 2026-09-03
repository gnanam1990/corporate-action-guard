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
  it('accepts a valid key and returns its principal and scopes', () => {
    const result = authenticate(RAW, lookup(record()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal).toBe('integrator-a');
      expect(result.scopes).toEqual(['integrator:preflight']);
    }
  });

  it('rejects a missing key', () => {
    expect(authenticate(undefined, lookup(record()))).toMatchObject({
      ok: false,
      reason: 'MISSING',
    });
  });

  it('rejects a malformed key', () => {
    expect(authenticate('not-a-key', lookup(record()))).toMatchObject({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  it('rejects an unknown key id', () => {
    expect(authenticate(RAW, lookup(undefined))).toMatchObject({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('rejects a correct key id with a wrong secret', () => {
    const wrong = 'cag_abcd1234_ffffffffffffffffffffffffffffffff';
    expect(authenticate(wrong, lookup(record()))).toMatchObject({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('rejects a revoked key', () => {
    expect(authenticate(RAW, lookup(record({ revoked: true })))).toMatchObject({
      ok: false,
      reason: 'REVOKED',
    });
  });

  it('checks revocation only after the hash comparison', () => {
    // So a revoked key and an unknown key are indistinguishable to someone probing for
    // valid key ids with a guessed secret.
    const wrongSecret = 'cag_abcd1234_ffffffffffffffffffffffffffffffff';
    expect(authenticate(wrongSecret, lookup(record({ revoked: true })))).toMatchObject({
      reason: 'UNKNOWN_KEY',
    });
  });

  it('never stores or returns the raw key', () => {
    const stored = record();
    expect(stored.hash).not.toContain(RAW);
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(authenticate(RAW, lookup(stored)))).not.toContain(RAW);
  });

  it('the key id is public and safe to log', () => {
    const result = authenticate(RAW, lookup(record()));
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
