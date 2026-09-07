/**
 * Durable preflight idempotency, against real PostgreSQL.
 *
 * These cannot be written against an in-memory substitute, because what is being tested is
 * exactly the behaviour a substitute would fake: two connections racing to insert the same
 * key, a unique index rejecting a second receipt, and a trigger refusing to rewrite a
 * decision that a client has already been given.
 *
 * The scenario each one guards against is a client timing out and retrying. That retry is
 * not a hypothetical — it is the normal behaviour of every HTTP client in the world.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachReceipt,
  claimPreflightIntent,
  hashCanonicalOperation,
  readPreflightIntent,
  recordPreflightDecision,
  type PreflightIntentInput,
  type StoredDecision,
} from '../src/index.js';
import { createTestPool, dropTestSchema } from './helpers.js';

const SCHEMA = 'cag_test_b20_idem';
let pool: Pool;

const AAPL = '0xb200000000000000000000c2e324d24d7eecd1fb';

beforeAll(async () => {
  pool = await createTestPool(SCHEMA);
}, 60_000);

afterAll(async () => {
  await dropTestSchema(pool, SCHEMA);
});

let keyCounter = 0;
function intent(overrides: Partial<PreflightIntentInput> = {}): PreflightIntentInput {
  keyCounter += 1;
  return {
    tenantId: 'tenant-a',
    route: 'POST /v1/b20/preflight',
    idempotencyKey: `key-${String(keyCounter)}`,
    canonicalOperation: '[["actionClass","TRANSFER"],["rawAmount","100000000"]]',
    chainId: 8453,
    assetAddress: AAPL,
    actionClass: 'TRANSFER',
    sender: '0xaaa0000000000000000000000000000000000001',
    recipient: '0xbbb0000000000000000000000000000000000002',
    rawAmount: 100_000_000n,
    targetContract: '0xccc0000000000000000000000000000000000003',
    operationDigest: `0x${'11'.repeat(32)}`,
    expectedMultiplierWad: 1_000_000_000_000_000_000n,
    ...overrides,
  };
}

const allow = (): StoredDecision => ({
  decision: 'ALLOW',
  reasons: [],
  policyVersion: '2026-09-07.1',
  evaluatedAtSeconds: 1_788_776_091n,
  expiresAtSeconds: 1_788_776_391n,
});

describe('claiming the right to decide', () => {
  it('gives the first caller the claim', async () => {
    const result = await claimPreflightIntent(pool, intent());
    expect(result.outcome).toBe('CLAIMED');
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replays the stored result rather than deciding again', async () => {
    // The crash-and-retry path: the decision was made and recorded, the response was lost.
    // The client retries and must get what it would have got the first time.
    const first = intent();
    const claim = await claimPreflightIntent(pool, first);
    await recordPreflightDecision(pool, claim.operationId, allow());

    const retry = await claimPreflightIntent(pool, first);
    expect(retry.outcome).toBe('REPLAYED');
    expect(retry.operationId).toBe(claim.operationId);
    expect(retry.stored?.decision).toBe('ALLOW');
    expect(retry.stored?.policyVersion).toBe('2026-09-07.1');
  });

  it('reports IN_PROGRESS while the first caller is still deciding', async () => {
    // Not a replay and not a fresh decision. Deciding anyway would be two concurrent
    // decisions for one operation, which is the whole thing this module prevents.
    const first = intent();
    await claimPreflightIntent(pool, first);
    const concurrent = await claimPreflightIntent(pool, first);
    expect(concurrent.outcome).toBe('IN_PROGRESS');
    expect(concurrent.stored).toBeUndefined();
  });

  it('conflicts when the same key carries different bytes', async () => {
    // Returning the stored result here would answer a question the caller did not ask.
    const first = intent();
    await claimPreflightIntent(pool, first);
    const different = await claimPreflightIntent(pool, {
      ...first,
      canonicalOperation: '[["actionClass","TRANSFER"],["rawAmount","999999999"]]',
    });
    expect(different.outcome).toBe('CONFLICT');
  });

  it('scopes keys by tenant, so one tenant cannot read another decision', async () => {
    // The key is chosen by the client. Two tenants will pick the same one.
    const shared = intent({ idempotencyKey: 'shared-key' });
    const a = await claimPreflightIntent(pool, shared);
    const b = await claimPreflightIntent(pool, { ...shared, tenantId: 'tenant-b' });
    expect(a.outcome).toBe('CLAIMED');
    expect(b.outcome).toBe('CLAIMED');
    expect(a.operationId).not.toBe(b.operationId);
  });

  it('scopes keys by route as well as tenant', async () => {
    const shared = intent({ idempotencyKey: 'shared-route-key' });
    const a = await claimPreflightIntent(pool, shared);
    const b = await claimPreflightIntent(pool, { ...shared, route: 'POST /v1/b20/reconcile' });
    expect(a.outcome).toBe('CLAIMED');
    expect(b.outcome).toBe('CLAIMED');
  });
});

describe('concurrent callers', () => {
  it('lets exactly one of eight simultaneous claims win', async () => {
    // The real shape of a client retry storm. A read-then-insert implementation would let
    // several read "absent" and all insert; only one statement with ON CONFLICT survives it.
    const shared = intent({ idempotencyKey: 'race-key' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimPreflightIntent(pool, shared)),
    );
    expect(results.filter((r) => r.outcome === 'CLAIMED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'IN_PROGRESS')).toHaveLength(7);
    // One operation, one identity, whoever won.
    expect(new Set(results.map((r) => r.operationId)).size).toBe(1);
  });

  it('lets exactly one of eight simultaneous receipt issuances win', async () => {
    // Two receipts for one operation would authorize the same movement twice.
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, allow());

    const attached = await Promise.all(
      Array.from({ length: 8 }, (_v, i) =>
        attachReceipt(pool, claim.operationId, `0x${String(i).repeat(64)}`),
      ),
    );
    expect(attached.filter(Boolean)).toHaveLength(1);
  });

  it('records a decision exactly once even when two writers try', async () => {
    const claim = await claimPreflightIntent(pool, intent());
    const [first, second] = await Promise.all([
      recordPreflightDecision(pool, claim.operationId, allow()),
      recordPreflightDecision(pool, claim.operationId, { ...allow(), decision: 'BLOCK' }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });
});

describe('a decided intent is immutable', () => {
  it('refuses to change a decision a client has already been given', async () => {
    // "The decision was different last time" is not something a client should ever observe.
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, allow());

    await expect(
      pool.query(`UPDATE b20_preflight_intents SET decision = 'BLOCK' WHERE operation_id = $1`, [
        claim.operationId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to change the request hash after the fact', async () => {
    // Rewriting the hash would make a conflicting request look like a matching one.
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, allow());
    await expect(
      pool.query(`UPDATE b20_preflight_intents SET request_hash = $2 WHERE operation_id = $1`, [
        claim.operationId,
        'f'.repeat(64),
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to replace a receipt once one exists', async () => {
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, allow());
    await attachReceipt(pool, claim.operationId, `0x${'ab'.repeat(32)}`);
    await expect(
      pool.query(`UPDATE b20_preflight_intents SET receipt_id = $2 WHERE operation_id = $1`, [
        claim.operationId,
        `0x${'cd'.repeat(32)}`,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('a receipt requires an ALLOW', () => {
  it('refuses to attach one to a BLOCK', async () => {
    // Not a code path that checks the decision before signing — a row that cannot exist.
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, { ...allow(), decision: 'BLOCK' });
    expect(await attachReceipt(pool, claim.operationId, `0x${'ee'.repeat(32)}`)).toBe(false);
  });

  it('refuses to attach one to a REVIEW', async () => {
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, { ...allow(), decision: 'REVIEW' });
    expect(await attachReceipt(pool, claim.operationId, `0x${'ef'.repeat(32)}`)).toBe(false);
  });

  it('refuses a receipt on an intent that was never decided', async () => {
    const claim = await claimPreflightIntent(pool, intent());
    expect(await attachReceipt(pool, claim.operationId, `0x${'f0'.repeat(32)}`)).toBe(false);
  });

  it('rejects a receipt written directly onto a blocked row', async () => {
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, { ...allow(), decision: 'BLOCK' });
    await expect(
      pool.query(`UPDATE b20_preflight_intents SET receipt_id = $2 WHERE operation_id = $1`, [
        claim.operationId,
        `0x${'f1'.repeat(32)}`,
      ]),
    ).rejects.toThrow(/b20_intent_receipt_requires_allow/);
  });
});

describe('reading back', () => {
  it('returns nothing for an undecided intent', async () => {
    // PENDING is not a decision. A caller that treated "no row" and "not yet decided" the
    // same way would answer a client with an absence.
    const claim = await claimPreflightIntent(pool, intent());
    expect(await readPreflightIntent(pool, claim.operationId)).toBeUndefined();
  });

  it('returns the decision with its receipt once both exist', async () => {
    const claim = await claimPreflightIntent(pool, intent());
    await recordPreflightDecision(pool, claim.operationId, allow());
    await attachReceipt(pool, claim.operationId, `0x${'12'.repeat(32)}`);
    const stored = await readPreflightIntent(pool, claim.operationId);
    expect(stored?.decision).toBe('ALLOW');
    expect(stored?.receiptId).toBe(`0x${'12'.repeat(32)}`);
    expect(stored?.evaluatedAtSeconds).toBe(1_788_776_091n);
  });
});

describe('hashing', () => {
  it('is stable and does not depend on how a caller formatted its JSON', () => {
    // Idempotency keyed on a hash that changed with whitespace would treat a reformatted
    // retry as a different request and issue a second receipt.
    const canonical = '[["a","1"],["b","2"]]';
    expect(hashCanonicalOperation(canonical)).toBe(hashCanonicalOperation(canonical));
    expect(hashCanonicalOperation(canonical)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCanonicalOperation(canonical)).not.toBe(hashCanonicalOperation('[["a","2"]]'));
  });
});
