import type { Queryable } from './journal.js';

/**
 * Read-side queries over the projections.
 *
 * Every query here is parameterised — no value is ever interpolated into SQL text, so a
 * search term or a cursor cannot become part of the statement. Cursors are opaque and
 * validated on the way back in.
 */

export interface AssetRow {
  readonly assetId: string;
  readonly symbol: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly wrapperAddress: string | null;
  readonly wrapperIsCurrent: boolean | null;
  readonly multiplierValue: string | null;
  readonly multiplierDecimals: number | null;
  readonly multiplierNonce: string | null;
  readonly scheduledActivation: Date | null;
  readonly lifecycleState: string;
  readonly canonicality: string;
  readonly apiObservedAt: Date | null;
  readonly chainObservedAt: Date | null;
  readonly chainBlockNumber: string | null;
  readonly chainBlockHash: string | null;
  /** NULL means never compared, which is distinct from INCOMPLETE. Both block. */
  readonly sourceAgreement: 'MATCH' | 'MISMATCH' | 'INCOMPLETE' | null;
  readonly comparisonFields: readonly ComparisonField[] | null;
  readonly comparedAt: Date | null;
  readonly updatedAt: Date;
}

export interface ComparisonField {
  readonly field: string;
  readonly agreement: 'MATCH' | 'MISMATCH' | 'INCOMPLETE';
  readonly apiValue: string | null;
  readonly chainValue: string | null;
  readonly requiredForAgreement: boolean;
}

export interface AssetFilter {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly lifecycleState?: string | undefined;
  readonly canonicality?: string | undefined;
  readonly search?: string | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque. Absent when there are no further pages. */
  readonly nextCursor: string | undefined;
}

/**
 * Keyset pagination on `(asset_id)`.
 *
 * Offset pagination would silently skip or repeat rows as the projection updates
 * underneath a paging client, which for an evidence console means an asset in a bad state
 * could scroll past unseen.
 */
export async function listAssets(db: Queryable, filter: AssetFilter): Promise<Page<AssetRow>> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.cursor !== undefined) {
    params.push(filter.cursor);
    conditions.push(`asset_id > $${params.length}`);
  }
  if (filter.lifecycleState !== undefined) {
    params.push(filter.lifecycleState);
    conditions.push(`lifecycle_state = $${params.length}::lifecycle_state`);
  }
  if (filter.canonicality !== undefined) {
    params.push(filter.canonicality);
    conditions.push(`canonicality = $${params.length}::check_outcome`);
  }
  if (filter.search !== undefined && filter.search !== '') {
    // Parameterised and escaped: a search term can never become SQL or a wildcard injection.
    params.push(`%${filter.search.replace(/[%_\\]/g, '\\$&')}%`);
    conditions.push(`(symbol ILIKE $${params.length} OR asset_id ILIKE $${params.length})`);
  }

  // Fetch one extra row to learn whether another page exists, without a second count query.
  params.push(filter.limit + 1);
  const limitParam = `$${params.length}`;

  const { rows } = await db.query(
    `SELECT asset_id, symbol, chain_id, token_address, wrapper_address, wrapper_is_current,
            multiplier_value, multiplier_decimals, multiplier_nonce, scheduled_activation,
            lifecycle_state, canonicality, api_observed_at, chain_observed_at,
            chain_block_number, chain_block_hash,
            source_agreement, comparison_fields, compared_at, updated_at
     FROM current_assets
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY asset_id ASC
     LIMIT ${limitParam}`,
    params,
  );

  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;

  return {
    items: page.map(toAssetRow),
    nextCursor: hasMore ? (page.at(-1) as { asset_id: string }).asset_id : undefined,
  };
}

function toAssetRow(row: Record<string, unknown>): AssetRow {
  return {
    assetId: row['asset_id'] as string,
    symbol: row['symbol'] as string,
    chainId: Number(row['chain_id']),
    tokenAddress: row['token_address'] as string,
    wrapperAddress: (row['wrapper_address'] as string | null) ?? null,
    wrapperIsCurrent: (row['wrapper_is_current'] as boolean | null) ?? null,
    multiplierValue: row['multiplier_value'] === null ? null : String(row['multiplier_value']),
    multiplierDecimals: (row['multiplier_decimals'] as number | null) ?? null,
    multiplierNonce: row['multiplier_nonce'] === null ? null : String(row['multiplier_nonce']),
    scheduledActivation: (row['scheduled_activation'] as Date | null) ?? null,
    lifecycleState: row['lifecycle_state'] as string,
    canonicality: row['canonicality'] as string,
    apiObservedAt: (row['api_observed_at'] as Date | null) ?? null,
    chainObservedAt: (row['chain_observed_at'] as Date | null) ?? null,
    chainBlockNumber: row['chain_block_number'] === null ? null : String(row['chain_block_number']),
    chainBlockHash: (row['chain_block_hash'] as string | null) ?? null,
    sourceAgreement: (row['source_agreement'] as AssetRow['sourceAgreement']) ?? null,
    comparisonFields: (row['comparison_fields'] as ComparisonField[] | null) ?? null,
    comparedAt: (row['compared_at'] as Date | null) ?? null,
    updatedAt: row['updated_at'] as Date,
  };
}

export async function getAsset(db: Queryable, assetId: string): Promise<AssetRow | undefined> {
  const { rows } = await db.query(
    `SELECT asset_id, symbol, chain_id, token_address, wrapper_address, wrapper_is_current,
            multiplier_value, multiplier_decimals, multiplier_nonce, scheduled_activation,
            lifecycle_state, canonicality, api_observed_at, chain_observed_at,
            chain_block_number, chain_block_hash,
            source_agreement, comparison_fields, compared_at, updated_at
     FROM current_assets WHERE asset_id = $1`,
    [assetId],
  );
  return rows[0] === undefined ? undefined : toAssetRow(rows[0] as Record<string, unknown>);
}

export interface CoverageSummary {
  readonly discovered: number;
  readonly canonicallyVerified: number;
  readonly pendingOrGuardWindow: number;
  readonly mismatchedOrReview: number;
  /** Assets where the API and the chain agreed on every required field. */
  readonly sourcesAgree: number;
}

/**
 * The four dashboard metrics, computed in one pass.
 *
 * Counted from the projection rather than estimated, and returned together so the four
 * numbers on screen are always from the same instant — four separate queries could show a
 * total that does not equal the sum of its parts.
 */
export async function coverageSummary(db: Queryable): Promise<CoverageSummary> {
  const { rows } = await db.query(
    `SELECT
       count(*)::int AS discovered,
       count(*) FILTER (WHERE canonicality = 'PASS')::int AS canonically_verified,
       count(*) FILTER (WHERE lifecycle_state IN ('PENDING','GUARD_WINDOW'))::int AS pending_or_guard,
       count(*) FILTER (WHERE lifecycle_state IN ('MISMATCH','MANUAL_REVIEW'))::int AS mismatched,
       count(*) FILTER (WHERE source_agreement = 'MATCH')::int AS sources_agree
     FROM current_assets`,
  );
  const row = (rows[0] ?? {}) as Record<string, number>;
  return {
    discovered: row['discovered'] ?? 0,
    canonicallyVerified: row['canonically_verified'] ?? 0,
    pendingOrGuardWindow: row['pending_or_guard'] ?? 0,
    mismatchedOrReview: row['mismatched'] ?? 0,
    sourcesAgree: row['sources_agree'] ?? 0,
  };
}

export interface SourceHealthRow {
  readonly sourceKind: string;
  readonly healthy: boolean;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly detail: string;
}

export async function sourceHealth(db: Queryable): Promise<readonly SourceHealthRow[]> {
  const { rows } = await db.query(
    `SELECT source_kind, healthy, last_success_at, last_failure_at, detail
     FROM current_source_health ORDER BY source_kind`,
  );
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      sourceKind: row['source_kind'] as string,
      healthy: row['healthy'] as boolean,
      lastSuccessAt: (row['last_success_at'] as Date | null) ?? null,
      lastFailureAt: (row['last_failure_at'] as Date | null) ?? null,
      detail: row['detail'] as string,
    };
  });
}

export interface IncidentRow {
  readonly incidentId: string;
  readonly assetId: string;
  readonly severity: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly firstDetectedAt: Date;
  readonly lastObservedAt: Date;
  readonly resolvedAt: Date | null;
}

export async function listIncidents(
  db: Queryable,
  filter: {
    readonly status?: string | undefined;
    readonly assetId?: string | undefined;
    readonly limit: number;
  },
): Promise<readonly IncidentRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.assetId !== undefined) {
    params.push(filter.assetId);
    conditions.push(`asset_id = $${params.length}`);
  }
  params.push(filter.limit);

  const { rows } = await db.query(
    `SELECT incident_id, asset_id, severity, status, reason_codes,
            first_detected_at, last_observed_at, resolved_at
     FROM current_incidents
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     -- Safety severity first, then most recently observed. An operator opening this list
     -- must see the most dangerous open incident at the top, not the newest.
     ORDER BY
       CASE severity WHEN 'SAFETY_CRITICAL' THEN 0 WHEN 'EVIDENCE_DEGRADED' THEN 1 ELSE 2 END,
       last_observed_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      incidentId: row['incident_id'] as string,
      assetId: row['asset_id'] as string,
      severity: row['severity'] as string,
      status: row['status'] as string,
      reasonCodes: (row['reason_codes'] as string[]) ?? [],
      firstDetectedAt: row['first_detected_at'] as Date,
      lastObservedAt: row['last_observed_at'] as Date,
      resolvedAt: (row['resolved_at'] as Date | null) ?? null,
    };
  });
}
