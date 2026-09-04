import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireLease,
  assertLeaseHeld,
  LeaseLostError,
  releaseLease,
  renewLease,
  withLease,
} from '../src/index.js';
import { createTestPool, dropTestSchema } from './helpers.js';

const SCHEMA = 'cag_test_leases';
let pool: Pool;

beforeAll(async () => {
  pool = await createTestPool(SCHEMA);
}, 60_000);

afterAll(async () => {
  await dropTestSchema(pool, SCHEMA);
});

/**
 * Age a lease so it has already expired.
 *
 * Both timestamps move together: the schema forbids a lease whose expiry precedes its
 * acquisition, and this models the real situation — a lease taken a while ago whose TTL
 * has since elapsed because the worker holding it died.
 */
async function expireLease(p: Pool, key: string): Promise<void> {
  await p.query(
    `UPDATE work_leases
     SET acquired_at = now() - interval '2 minutes',
         heartbeat_at = now() - interval '2 minutes',
         expires_at = now() - interval '1 second'
     WHERE lease_key = $1`,
    [key],
  );
}

describe('work leases', () => {
  it('grants a free lease', async () => {
    const lease = await acquireLease(pool, 'reconcile:A', 'worker-1', 30);
    expect(lease?.ownerId).toBe('worker-1');
  });

  it('refuses a lease another worker holds', async () => {
    await acquireLease(pool, 'reconcile:B', 'worker-1', 30);
    const second = await acquireLease(pool, 'reconcile:B', 'worker-2', 30);
    expect(second).toBeUndefined();
  });

  it('is re-entrant for the same owner, so a retry does not deadlock itself', async () => {
    await acquireLease(pool, 'reconcile:C', 'worker-1', 30);
    const again = await acquireLease(pool, 'reconcile:C', 'worker-1', 30);
    expect(again?.ownerId).toBe('worker-1');
  });

  it('grants an expired lease to a new owner', async () => {
    // The previous holder died mid-cycle; its claim expires visibly rather than silently.
    await acquireLease(pool, 'reconcile:D', 'dead-worker', 1);
    await expireLease(pool, 'reconcile:D');
    const taken = await acquireLease(pool, 'reconcile:D', 'worker-2', 30);
    expect(taken?.ownerId).toBe('worker-2');
  });

  it('increments the fencing token on takeover so the stale owner can detect it', async () => {
    const first = await acquireLease(pool, 'reconcile:E', 'worker-1', 1);
    await expireLease(pool, 'reconcile:E');
    const second = await acquireLease(pool, 'reconcile:E', 'worker-2', 30);
    expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
  });

  it('a superseded worker cannot renew', async () => {
    const stale = await acquireLease(pool, 'reconcile:F', 'worker-1', 1);
    await expireLease(pool, 'reconcile:F');
    await acquireLease(pool, 'reconcile:F', 'worker-2', 30);
    // worker-1 wakes up believing it still owns the lease.
    await expect(renewLease(pool, stale!, 30)).resolves.toBe(false);
  });

  it('a superseded fencing token cannot pass the write-time assertion', async () => {
    const stale = await acquireLease(pool, 'reconcile:FENCE', 'worker-1', 1);
    await expireLease(pool, 'reconcile:FENCE');
    await acquireLease(pool, 'reconcile:FENCE', 'worker-2', 30);
    await expect(assertLeaseHeld(pool, stale!)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it('renews a lease the owner still holds', async () => {
    const lease = await acquireLease(pool, 'reconcile:G', 'worker-1', 30);
    await expect(renewLease(pool, lease!, 60)).resolves.toBe(true);
  });

  it('releases so another worker can take over immediately', async () => {
    const lease = await acquireLease(pool, 'reconcile:H', 'worker-1', 300);
    await releaseLease(pool, lease!);
    const taken = await acquireLease(pool, 'reconcile:H', 'worker-2', 30);
    expect(taken?.ownerId).toBe('worker-2');
  });

  it('releases the lease even when the work throws', async () => {
    await expect(
      withLease(pool, 'reconcile:I', 'worker-1', 300, async () => {
        throw new Error('cycle failed');
      }),
    ).rejects.toThrow('cycle failed');

    const taken = await acquireLease(pool, 'reconcile:I', 'worker-2', 30);
    expect(taken?.ownerId).toBe('worker-2');
  });

  it('withLease returns undefined rather than running when the lease is held', async () => {
    await acquireLease(pool, 'reconcile:J', 'worker-1', 300);
    let ran = false;
    const result = await withLease(pool, 'reconcile:J', 'worker-2', 30, async () => {
      ran = true;
      return 'done';
    });
    expect(result).toBeUndefined();
    expect(ran).toBe(false);
  });

  it('withLease heartbeats while a cycle runs longer than its original TTL', async () => {
    const result = await withLease(pool, 'reconcile:HEARTBEAT', 'worker-1', 1, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return acquireLease(pool, 'reconcile:HEARTBEAT', 'worker-2', 30);
    });
    expect(result).toBeUndefined();
  });

  it('two concurrent acquisitions produce exactly one winner', async () => {
    const attempts = await Promise.all([
      acquireLease(pool, 'reconcile:RACE', 'worker-1', 30),
      acquireLease(pool, 'reconcile:RACE', 'worker-2', 30),
      acquireLease(pool, 'reconcile:RACE', 'worker-3', 30),
    ]);
    expect(attempts.filter((a) => a !== undefined)).toHaveLength(1);
  });

  it('expiry uses the database clock, not a worker clock', async () => {
    // Two workers whose system clocks disagree must still agree on who holds the lease.
    const lease = await acquireLease(pool, 'reconcile:CLOCK', 'worker-1', 60);
    const { rows } = await pool.query<{ ahead: boolean }>(
      'SELECT expires_at > now() AS ahead FROM work_leases WHERE lease_key = $1',
      ['reconcile:CLOCK'],
    );
    expect(rows[0]?.ahead).toBe(true);
    expect(lease?.expiresAt).toBeInstanceOf(Date);
  });
});
