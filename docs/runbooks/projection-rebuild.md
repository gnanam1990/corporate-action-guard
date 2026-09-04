# Runbook — projection rebuild

## When

- A projection disagrees with the journal.
- After restoring from backup.
- After a reorg, once re-indexing has completed.
- When you simply want to prove the displayed state is derivable from evidence.

## The rule

The journal is the source of truth. Every projection is a fold over it, and dropping one
loses nothing.

**Never restore a projection independently of the journal.** A projection row with no
journal row behind it is a fabricated claim, and it will be believed by everything
downstream.

## Rebuild

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM evidence_events;"     # before
node -e "
  import('@cag/db').then(async ({ rebuildProjections }) => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    console.log(await rebuildProjections(pool));
    await pool.end();
  });
"
```

The rebuild runs in **one transaction**: projections are never observably empty or
half-built, so a reader during a rebuild sees the old state or the new one, never a
partial one.

Every rebuild is recorded in `projection_rebuilds` with its event count, so a later
divergence investigation has a starting point.

## Verify

```sql
-- Does the projection agree with the journal about the newest observation?
SELECT a.asset_id, a.chain_observed_at, e.observed_at AS journal_observed_at
FROM current_assets a
LEFT JOIN LATERAL (
  SELECT observed_at FROM evidence_events
  WHERE aggregate_id = a.asset_id AND event_type = 'CHAIN_SNAPSHOT_OBSERVED'
  ORDER BY ingested_at DESC LIMIT 1
) e ON true
WHERE a.chain_observed_at IS DISTINCT FROM e.observed_at;
```

An empty result means they agree. The integration suite asserts the stronger property: a
rebuild from the journal alone reproduces the incrementally-maintained projections exactly,
and rebuilding twice is deterministic.

## If they disagree

That is a **finding, not a nuisance**. It means the incremental fold and the full fold
differ, which is a bug in `applyEventToProjections`.

1. Do not "fix" the projection by hand. It will drift again, and you will have destroyed
   the evidence of why.
2. Capture the divergence: the asset, both values, and the journal rows involved.
3. Rebuild — this restores correct display immediately.
4. Then find the fold bug. The rebuild is the mitigation, not the fix.

## What a rebuild cannot do

- It cannot recover evidence that was never journalled. If the worker was down, the gap is
  real, and a rebuild reproduces the gap faithfully.
- It cannot change history. `UPDATE` and `DELETE` on `evidence_events` are rejected by
  trigger, so a rebuild can only ever re-derive what is already recorded.
- It cannot make a mismatch go away. If the sources disagreed, the rebuilt projection says
  so, exactly as it did before.
