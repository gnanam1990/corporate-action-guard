# Runbook — reconciliation

## What the reconciler is

A pure function. It takes immutable observations plus a caller-supplied `now` and returns
the state those facts imply, the reasons an action would be blocked, and the evidence to
journal. It does not write projections, does not sign receipts, does not call a source, and
does not read a clock.

That purity is what makes replay meaningful: `reconcileAsset(input, policy, now)` produces
a byte-identical decision every time, so a historical incident can be re-decided exactly.

## Outcomes, and why there are four

| Outcome               | Means                                                  | Do not confuse with   |
| --------------------- | ------------------------------------------------------ | --------------------- |
| `MATCHED`             | Both sources reported, agreed, and canonicality passed | —                     |
| `MISMATCHED`          | Both sources reported and **disagreed**                | `INCOMPLETE_EVIDENCE` |
| `INCOMPLETE_EVIDENCE` | A source answered only partially                       | `MISMATCHED`          |
| `SOURCE_UNAVAILABLE`  | A source could not be reached at all                   | `MISMATCHED`          |

"We could not look" and "they disagree" need different operator responses and different
alerts. A partial chain read is an **absence**, already reported as such, and is never
counted as a disagreement.

## Absence semantics — the subtle one

Both sources reporting _no_ scheduled activation is **agreement**, not incompleteness.

The resting state of every asset is "no corporate action pending", which both sources state
affirmatively: the API sends `activationDateTime: 0` and the chain returns
`newMultiplierActivationTime() == 0`, and both clients normalize that sentinel to
`undefined`. Scoring that as `INCOMPLETE` would block every asset in its ordinary state —
the same failure mode [ADR 0004](../architecture/decisions/0004-source-agreement-field-policy.md)
was written about.

One-sided absence is still `INCOMPLETE`: one source has an opinion and the other does not,
so agreement cannot be established. A value that could not be _read_ is caught separately
by snapshot completeness and freshness.

## Recovery cannot be asserted by an operator

`canRecover` returns true **only** when a complete observation shows the sources agreeing
and no block reason remains. An operator resolution records actor, reason, evidence, and
policy version — it does not manufacture agreement.

If evidence still disagrees after a resolution, the UI must say **resolution recorded,
protected actions remain blocked**.

## Incident deduplication

Every decision carries a `reasonSignature`: the ordered, deduplicated reason list joined
into a stable string, independent of the order the reasons were discovered.

A repeating identical mismatch updates `last_observed_at` on the existing incident instead
of appending a new one — enforced by a partial unique index on
`(asset_id, reason_signature) WHERE status IN ('OPEN','IN_REVIEW')`. Without this, a
30-second poll on a persistent mismatch produces 2,880 incidents a day.

## Concurrency — leases, not advisory locks

An advisory lock vanishes the moment its connection drops, which is exactly when a worker
has died mid-cycle and its claim most needs to stay visible. `work_leases` gives each claim
an owner, an expiry, a heartbeat, and a **fencing token**.

- Expiry uses `now()` — the **database's** clock — so two workers whose system clocks
  disagree still agree on who holds the lease.
- The fencing token increments on every takeover, so a worker that stalled past its expiry
  and then wakes up can detect it was superseded rather than writing over the worker that
  legitimately took over. `renewLease` returns `false` for a superseded owner.
- Acquisition is re-entrant for the same owner, so a retry does not deadlock against
  itself.
- `withLease` releases even when the work throws.

Verified by integration test, including three concurrent acquisitions producing exactly one
winner.

## Diagnosing

| Symptom                                     | Check                                   | Action                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An asset is stuck in `MISMATCH`             | `current_incidents.reason_codes`        | Compare API and chain values in the incident's side-by-side evidence. Disagreement never auto-resolves; wait for a later complete observation that agrees. |
| Everything is blocked at once               | `current_source_health`                 | Almost certainly a source outage, not 300 simultaneous corporate actions. Expect `SOURCE_UNAVAILABLE`, not `MISMATCHED`.                                   |
| An asset is never reconciled                | `work_leases` for `reconcile:<assetId>` | A dead worker's lease expires on its own. If `expires_at` is far in the future with no heartbeat, the TTL is set too long.                                 |
| Incidents multiplying                       | `reason_signature` values               | If signatures differ each cycle, a reason is being derived non-deterministically. That is a bug, not noise.                                                |
| Replay disagrees with the recorded decision | `policy_version` on both                | A policy change between the recorded decision and the replay is expected and must be displayed, not hidden.                                                |

## Safe recovery commands

```bash
# What does the journal actually say about this asset?
psql "$DATABASE_URL" -c "SELECT event_type, observed_at, source_kind, block_number
  FROM evidence_events WHERE aggregate_id = 'AAPLx'
  ORDER BY ingested_at DESC LIMIT 20;"

# Who holds the lease, and until when?
psql "$DATABASE_URL" -c "SELECT lease_key, owner_id, heartbeat_at, expires_at, fencing_token
  FROM work_leases ORDER BY expires_at;"

# Rebuild projections from the journal. Safe: the journal is untouched.
pnpm --filter @cag/db exec node dist/rebuild.js
```

**Never** attempt to fix a mismatch by editing the journal. `UPDATE` and `DELETE` are
rejected by trigger, and the attempt is the wrong instinct — the journal recording that we
once believed something the chain disagreed with is the evidence, not the problem.
