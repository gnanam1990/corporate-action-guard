import type { Pool } from 'pg';

/**
 * Durable work leases.
 *
 * A PostgreSQL advisory lock would be simpler, but it vanishes the moment the connection
 * drops — which is precisely when a worker has died mid-cycle and its claim most needs to
 * stay visible. A row-backed lease has an expiry, an owner, a heartbeat, and a fencing
 * token, all inspectable by an operator, and it survives a lost connection.
 */

export interface Lease {
  readonly key: string;
  readonly ownerId: string;
  readonly expiresAt: Date;
  /**
   * Monotonic per key. A worker that stalled past its expiry and then wakes up can compare
   * its token against the current one and discover it was superseded, instead of writing
   * on top of the worker that legitimately took over.
   */
  readonly fencingToken: bigint;
}

/**
 * Take the lease if it is free or expired.
 *
 * `now()` is the database's clock throughout, so lease expiry does not depend on worker
 * clocks agreeing with each other.
 */
export async function acquireLease(
  pool: Pool,
  key: string,
  ownerId: string,
  ttlSeconds: number,
): Promise<Lease | undefined> {
  const { rows } = await pool.query<{
    lease_key: string;
    owner_id: string;
    expires_at: Date;
    fencing_token: string;
  }>(
    `INSERT INTO work_leases (lease_key, owner_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (lease_key) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       acquired_at = now(),
       heartbeat_at = now(),
       expires_at = EXCLUDED.expires_at,
       fencing_token = work_leases.fencing_token + 1
     WHERE work_leases.expires_at <= now()
        OR work_leases.owner_id = EXCLUDED.owner_id
     RETURNING lease_key, owner_id, expires_at, fencing_token`,
    [key, ownerId, ttlSeconds],
  );

  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    key: row.lease_key,
    ownerId: row.owner_id,
    expiresAt: row.expires_at,
    fencingToken: BigInt(row.fencing_token),
  };
}

/** Extend a lease we still hold. Returns false if it expired and someone else took it. */
export async function renewLease(pool: Pool, lease: Lease, ttlSeconds: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE work_leases
     SET heartbeat_at = now(), expires_at = now() + make_interval(secs => $3)
     WHERE lease_key = $1 AND owner_id = $2 AND fencing_token = $4 AND expires_at > now()`,
    [lease.key, lease.ownerId, ttlSeconds, lease.fencingToken.toString()],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Release a lease we hold. Releasing one we no longer own is a no-op, never an error. */
export async function releaseLease(pool: Pool, lease: Lease): Promise<void> {
  await pool.query(
    'DELETE FROM work_leases WHERE lease_key = $1 AND owner_id = $2 AND fencing_token = $3',
    [lease.key, lease.ownerId, lease.fencingToken.toString()],
  );
}

/** Run work under a lease, releasing it even if the work throws. */
export async function withLease<T>(
  pool: Pool,
  key: string,
  ownerId: string,
  ttlSeconds: number,
  work: (lease: Lease) => Promise<T>,
): Promise<T | undefined> {
  const lease = await acquireLease(pool, key, ownerId, ttlSeconds);
  if (lease === undefined) return undefined;
  try {
    return await work(lease);
  } finally {
    await releaseLease(pool, lease).catch(() => undefined);
  }
}
