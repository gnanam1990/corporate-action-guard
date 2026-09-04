import type { PoolClient } from 'pg';
import type { Queryable } from './journal.js';

export type IdempotencyClaim<T> =
  | { readonly kind: 'CLAIMED' }
  | { readonly kind: 'COMPLETED'; readonly response: T }
  | { readonly kind: 'REQUEST_MISMATCH' }
  | { readonly kind: 'IN_FLIGHT' };

/**
 * Claim one command key while the caller holds a transaction.
 *
 * A concurrent insert blocks on the primary key until the first transaction commits. It
 * then observes the completed response, so response loss followed by retry cannot mint a
 * second receipt. The transaction must remain open until `completeIdempotentCommand`.
 */
export async function claimIdempotentCommand<T>(
  client: PoolClient,
  input: {
    readonly actorId: string;
    readonly operation: string;
    readonly key: string;
    readonly requestHash: string;
  },
): Promise<IdempotencyClaim<T>> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (
       actor_id, operation, idempotency_key, request_hash, status
     ) VALUES ($1,$2,$3,$4,'IN_FLIGHT')
     ON CONFLICT DO NOTHING
     RETURNING idempotency_key`,
    [input.actorId, input.operation, input.key, input.requestHash],
  );
  if ((inserted.rowCount ?? 0) === 1) return { kind: 'CLAIMED' };

  const { rows } = await client.query<{
    request_hash: string;
    response_body: T | null;
    status: 'IN_FLIGHT' | 'COMPLETED' | 'FAILED';
  }>(
    `SELECT request_hash, response_body, status
     FROM idempotency_keys
     WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
     FOR UPDATE`,
    [input.actorId, input.operation, input.key],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('idempotency row disappeared after a key conflict');
  if (row.request_hash !== input.requestHash) return { kind: 'REQUEST_MISMATCH' };
  if (row.status === 'COMPLETED' && row.response_body !== null) {
    return { kind: 'COMPLETED', response: row.response_body };
  }
  return { kind: 'IN_FLIGHT' };
}

export async function completeIdempotentCommand(
  client: PoolClient,
  input: {
    readonly actorId: string;
    readonly operation: string;
    readonly key: string;
    readonly requestHash: string;
    readonly response: unknown;
  },
): Promise<void> {
  const result = await client.query(
    `UPDATE idempotency_keys SET
       response_body = $5::jsonb, status = 'COMPLETED', completed_at = now()
     WHERE actor_id = $1 AND operation = $2 AND idempotency_key = $3
       AND request_hash = $4 AND status = 'IN_FLIGHT'`,
    [input.actorId, input.operation, input.key, input.requestHash, JSON.stringify(input.response)],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error('idempotent command completion lost its claim');
  }
}

export interface StoredApiKey {
  readonly keyId: string;
  readonly principal: string;
  readonly hash: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
}

export async function getStoredApiKey(
  db: Queryable,
  keyId: string,
): Promise<StoredApiKey | undefined> {
  const { rows } = await db.query<{
    key_id: string;
    principal: string;
    key_hash: string;
    scopes: string[];
    revoked: boolean;
  }>(
    `SELECT key_id, principal, key_hash, scopes, revoked_at IS NOT NULL AS revoked
     FROM api_keys WHERE key_id = $1`,
    [keyId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        keyId: row.key_id,
        principal: row.principal,
        hash: row.key_hash,
        scopes: row.scopes,
        revoked: row.revoked,
      };
}

export async function provisionApiKeyHash(
  db: Queryable,
  input: {
    readonly keyId: string;
    readonly principal: string;
    readonly hash: string;
    readonly scopes: readonly string[];
  },
): Promise<void> {
  await db.query(
    `INSERT INTO api_keys (key_id, principal, key_hash, scopes)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (key_id) DO UPDATE SET
       principal = EXCLUDED.principal,
       key_hash = EXCLUDED.key_hash,
       scopes = EXCLUDED.scopes,
       revoked_at = NULL,
       updated_at = now()`,
    [input.keyId, input.principal, input.hash, [...input.scopes]],
  );
}
