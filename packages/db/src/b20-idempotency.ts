/**
 * Durable preflight idempotency.
 *
 * The contract, in the order it has to happen:
 *
 *  1. Persist the intent, **before** deciding anything.
 *  2. Decide.
 *  3. Record the decision on that same row.
 *
 * Doing 2 before 1 leaves a window where a crash loses the fact that we ever answered, and
 * the client's retry gets a second decision — and, for an ALLOW, potentially a second
 * receipt for one operation. The window is small and it is exactly the window a timeout
 * retry lands in.
 *
 * Three outcomes a caller must handle, and they are different:
 *
 *  - `CLAIMED`   this call owns the decision and must make it.
 *  - `REPLAYED`  a decision already exists; return it verbatim, do not decide again.
 *  - `CONFLICT`  the key was used with different bytes. HTTP 409, never a fresh decision.
 *
 * `IN_PROGRESS` is a fourth: another caller claimed it and has not finished. Waiting is the
 * caller's choice; deciding anyway is not, because two concurrent decisions is the thing
 * this whole module prevents.
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const CLAIM_OUTCOMES = ['CLAIMED', 'REPLAYED', 'CONFLICT', 'IN_PROGRESS'] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

export interface PreflightIntentInput {
  readonly tenantId: string;
  readonly route: string;
  readonly idempotencyKey: string;
  /** Canonical bytes of the operation. Hashed here so callers cannot disagree on the hash. */
  readonly canonicalOperation: string;
  readonly chainId: number;
  readonly assetAddress: string;
  readonly actionClass: string;
  readonly sender: string;
  readonly recipient: string;
  readonly rawAmount: bigint;
  readonly targetContract: string;
  readonly operationDigest: string;
  readonly expectedMultiplierWad: bigint;
}

export interface StoredDecision {
  readonly decision: 'ALLOW' | 'BLOCK' | 'REVIEW';
  readonly reasons: readonly string[];
  readonly policyVersion: string;
  readonly evaluatedAtSeconds: bigint;
  readonly expiresAtSeconds: bigint;
  readonly receiptId?: string;
}

export interface ClaimResult {
  readonly outcome: ClaimOutcome;
  readonly operationId: string;
  /** Present only on REPLAYED. The result the first caller was given, verbatim. */
  readonly stored?: StoredDecision;
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
  constructor(
    readonly tenantId: string,
    readonly idempotencyKey: string,
  ) {
    super(
      `idempotency key ${idempotencyKey} was already used with a different request body; ` +
        'returning the original result would answer a question that was not asked',
    );
  }
}

export function hashCanonicalOperation(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Claim the right to decide, or discover that someone already did.
 *
 * One statement. `ON CONFLICT DO NOTHING` plus a follow-up read is the only shape that is
 * safe under concurrency without a lock: two callers race to insert, exactly one wins, and
 * the loser reads what the winner wrote. A read-then-insert would let both read "absent" and
 * both insert.
 */
export async function claimPreflightIntent(
  db: Pool | PoolClient,
  input: PreflightIntentInput,
): Promise<ClaimResult> {
  const requestHash = hashCanonicalOperation(input.canonicalOperation);

  const inserted = await db.query<{ operation_id: string }>(
    `INSERT INTO b20_preflight_intents (
       tenant_id, route, idempotency_key, request_hash, chain_id, asset_address, action_class,
       sender, recipient, raw_amount, target_contract, operation_digest, expected_multiplier_wad
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, route, idempotency_key) DO NOTHING
     RETURNING operation_id`,
    [
      input.tenantId,
      input.route,
      input.idempotencyKey,
      requestHash,
      input.chainId,
      input.assetAddress.toLowerCase(),
      input.actionClass,
      input.sender.toLowerCase(),
      input.recipient.toLowerCase(),
      input.rawAmount.toString(),
      input.targetContract.toLowerCase(),
      input.operationDigest.toLowerCase(),
      input.expectedMultiplierWad.toString(),
    ],
  );

  const claimed = inserted.rows[0];
  if (claimed !== undefined) {
    return { outcome: 'CLAIMED', operationId: claimed.operation_id };
  }

  const existing = await db.query<{
    operation_id: string;
    request_hash: string;
    status: string;
    decision: string | null;
    reasons: string[] | null;
    policy_version: string | null;
    evaluated_at_seconds: string | null;
    expires_at_seconds: string | null;
    receipt_id: string | null;
  }>(
    `SELECT operation_id, request_hash, status, decision, reasons, policy_version,
            evaluated_at_seconds::text, expires_at_seconds::text, receipt_id
       FROM b20_preflight_intents
      WHERE tenant_id = $1 AND route = $2 AND idempotency_key = $3`,
    [input.tenantId, input.route, input.idempotencyKey],
  );

  const row = existing.rows[0];
  if (row === undefined) {
    // The row vanished between the insert and the read, which means it was deleted — and
    // nothing in this system deletes one. Refusing beats guessing.
    throw new Error('preflight intent disappeared between insert and read');
  }

  // Same key, different bytes. Returning the stored result would answer a question the caller
  // did not ask, which is worse than refusing.
  if (row.request_hash !== requestHash) {
    return { outcome: 'CONFLICT', operationId: row.operation_id };
  }

  if (row.status !== 'DECIDED' || row.decision === null) {
    return { outcome: 'IN_PROGRESS', operationId: row.operation_id };
  }

  return {
    outcome: 'REPLAYED',
    operationId: row.operation_id,
    stored: {
      decision: row.decision as StoredDecision['decision'],
      reasons: row.reasons ?? [],
      policyVersion: row.policy_version ?? '',
      evaluatedAtSeconds: BigInt(row.evaluated_at_seconds ?? '0'),
      expiresAtSeconds: BigInt(row.expires_at_seconds ?? '0'),
      ...(row.receipt_id !== null ? { receiptId: row.receipt_id } : {}),
    },
  };
}

/**
 * Record the decision on a claimed intent.
 *
 * Guarded on `status = 'PENDING'` so a second writer cannot overwrite a decision that is
 * already recorded, even if it somehow believes it holds the claim. The database trigger
 * rejects the rewrite too; this makes the refusal visible to the caller rather than an
 * exception from a layer below.
 */
export async function recordPreflightDecision(
  db: Pool | PoolClient,
  operationId: string,
  decision: StoredDecision,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE b20_preflight_intents
        SET status = 'DECIDED', decision = $2, reasons = $3, policy_version = $4,
            evaluated_at_seconds = $5, expires_at_seconds = $6
      WHERE operation_id = $1 AND status = 'PENDING'`,
    [
      operationId,
      decision.decision,
      [...decision.reasons],
      decision.policyVersion,
      decision.evaluatedAtSeconds.toString(),
      decision.expiresAtSeconds.toString(),
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Attach a receipt to a decided ALLOW.
 *
 * Two constraints do the work rather than this function: the row-level check that a receipt
 * requires `decision = 'ALLOW'`, and the unique index on `receipt_id`. Returning false rather
 * than throwing lets the caller distinguish "someone else already issued one" — which is a
 * correct outcome under concurrency — from a real failure.
 */
export async function attachReceipt(
  db: Pool | PoolClient,
  operationId: string,
  receiptId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE b20_preflight_intents
        SET receipt_id = $2
      WHERE operation_id = $1 AND decision = 'ALLOW' AND receipt_id IS NULL`,
    [operationId, receiptId],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Read a stored decision by operation id, for a status endpoint or a replay. */
export async function readPreflightIntent(
  db: Pool | PoolClient,
  operationId: string,
): Promise<StoredDecision | undefined> {
  const { rows } = await db.query<{
    decision: string | null;
    reasons: string[] | null;
    policy_version: string | null;
    evaluated_at_seconds: string | null;
    expires_at_seconds: string | null;
    receipt_id: string | null;
  }>(
    `SELECT decision, reasons, policy_version, evaluated_at_seconds::text,
            expires_at_seconds::text, receipt_id
       FROM b20_preflight_intents WHERE operation_id = $1 AND status = 'DECIDED'`,
    [operationId],
  );
  const row = rows[0];
  if (row === undefined || row.decision === null) return undefined;
  return {
    decision: row.decision as StoredDecision['decision'],
    reasons: row.reasons ?? [],
    policyVersion: row.policy_version ?? '',
    evaluatedAtSeconds: BigInt(row.evaluated_at_seconds ?? '0'),
    expiresAtSeconds: BigInt(row.expires_at_seconds ?? '0'),
    ...(row.receipt_id !== null ? { receiptId: row.receipt_id } : {}),
  };
}
