# Evidence journal

## The rule

`evidence_events` is the source of truth. Every projection is a fold over it and can be
dropped and rebuilt at any moment. Nothing may `UPDATE` or `DELETE` a journal row through
the application role.

This is enforced by a `BEFORE UPDATE`/`BEFORE DELETE` trigger that raises
`restrict_violation`, not by convention. An ORM mistake, a stray migration, or a
well-meaning "just fix the data" query must fail loudly rather than quietly rewrite
history. Integration tests assert both statements are rejected and that the row survives
the attempt unchanged.

## Row anatomy

| Group              | Columns                                                               | Why                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity           | `id`, `aggregate_type`, `aggregate_id`, `event_type`, `event_version` | What happened, to what                                                                                                                                                    |
| Time               | `observed_at`, `source_time`, `ingested_at`                           | When _we_ saw it, when the _source_ says it was true, when it landed. `source_time` is `NULL` when the source does not say — never silently substituted by `observed_at`. |
| Chain provenance   | `chain_id`, `block_number`, `block_hash`, `tx_hash`, `log_index`      | Which block a read came from. Check constraints require these to be complete or wholly absent, so a half-provenanced row cannot exist.                                    |
| Source             | `source_kind`, `source_locator`                                       | An endpoint path or provider identifier. **Never a URL containing credentials.**                                                                                          |
| Content            | `payload`, `payload_hash`                                             | The fact, and a SHA-256 over its canonical encoding                                                                                                                       |
| Causality          | `correlation_id`, `causation_id`                                      | Which request, and which event caused this one                                                                                                                            |
| Provenance of code | `producer_version`                                                    | Which build wrote it, so a replay can report the logic that produced the row                                                                                              |

## Idempotency

A writer cannot distinguish a lost response from a lost write, so every append must be
safe to retry. Two unique indexes make that true:

- **Chain logs** — `(chain_id, tx_hash, log_index)`. A retry, a restart, or a provider
  fallback can deliver the same log more than once. It is the same fact and occupies one
  row. A different `log_index` on the same transaction is a different fact.
- **Source snapshots** — `(aggregate_type, aggregate_id, event_type, payload_hash,
payload->>'observationBucket')`. The bucket is supplied by the writer _inside the
  payload_, so the deduplication policy is visible in the evidence itself rather than
  hidden in an index expression.

`appendEvidence` returns `{ event, deduplicated }`. A duplicate is a **successful no-op**
returning the existing row, so the caller's causation chain still points at real evidence.

**Command idempotency** lives in `idempotency_keys`, keyed by `(actor_id, operation,
idempotency_key)` — scoped to the actor so one integrator cannot collide with or replay
another's key. `request_hash` is stored because reusing a key with a _different_ body is a
client error, not a cache hit.

## Canonical payload hashing

`JSON.stringify` preserves insertion order, so `{a,b}` and `{b,a}` would hash differently
despite being the same value — and idempotency would silently stop working. `canonicalize`
sorts object keys at every depth, preserves array order (in an array, order _is_ the
value), encodes `bigint` as a decimal string so exact integers survive a round trip that a
double would corrupt, and treats an omitted key and an `undefined` key as the same fact
while keeping `null` distinct. Non-finite numbers are rejected outright.

## Reorg behaviour

1. Retain the original observation. It was true of the chain we saw.
2. Append `REORG_DETECTED` with the block that diverged and the safe block to rewind to.
3. Rewind `indexed_chain_cursor` so the indexer re-reads.
4. Append compensating evidence from the re-read.
5. Rebuild affected projections deterministically.

History is never erased to make the UI look consistent. A user looking at an incident must
be able to see that we once believed something the chain later disagreed with.

## Privacy and redaction

`appendEvidence` walks the payload recursively and **rejects** — does not silently redact —
any object carrying a forbidden key: `privateKey`, `authorization`, `apiKey`, `cookie`,
`secret`, `password`, `mnemonic`, `seedPhrase`, and case variants. Redacting silently would
hide the bug that put the secret there.

The reasoning is that evidence is exported, replayed, screenshotted, and attached to
incident reports. A secret that reaches the journal reaches all of those.

Never journal: private keys, raw authorization headers, cookies, API keys, RPC URLs with
embedded credentials, or unbounded raw response bodies.

## Retention, backup, restore, replay

- **Retention.** The journal is append-only and grows monotonically. It is not pruned
  during the event build. A production deployment would partition `evidence_events` by
  `ingested_at` month and archive cold partitions to object storage; that is a documented
  gap, not an implemented feature.
- **Backup.** Standard PostgreSQL physical backup plus WAL archiving. The journal is the
  only table that must survive; every projection is reproducible from it.
- **Restore.** Restore the database, then run `rebuildProjections`. Projections are never
  restored independently of the journal — a projection row with no journal row behind it
  is a fabricated claim.
- **Replay.** `readAllEvents({ upToEventId })` reads immutable rows up to a cutoff. Replay
  never calls a live source; a "replay" that does is not a replay. The policy and code
  version used are reported with the result.

## Verified by integration test

| Property                                                             | Test                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `UPDATE` rejected by the application role                            | `rejects UPDATE through the application role`                      |
| `DELETE` rejected by the application role                            | `rejects DELETE through the application role`                      |
| Row unchanged after a rejected mutation                              | `leaves the row intact after a rejected mutation`                  |
| Duplicate API ingestion is idempotent                                | `duplicate API ingestion in the same bucket is a no-op`            |
| Hash stable across JSON key order                                    | `is stable across JSON key order`                                  |
| A new bucket is a new observation                                    | `a different observation bucket is a new observation`              |
| Duplicate chain log is idempotent                                    | `duplicate chain log ingestion is a no-op`                         |
| Same tx, different log index is distinct                             | `the same tx with a different log index is a different fact`       |
| Secrets rejected at top level, nested, in arrays, case-insensitively | four `secret containment` tests                                    |
| Rollback leaves neither event nor projection                         | `a rolled-back transaction leaves neither`                         |
| Commit leaves both                                                   | `a committed transaction leaves both`                              |
| Concurrent receipt consumption has one winner                        | `two concurrent consumers produce exactly one state change`        |
| A consumed receipt never becomes unconsumed                          | `a consumed receipt can never become unconsumed`                   |
| Incremental projections equal a full rebuild                         | `a rebuild from the journal alone reproduces every projection row` |
| Rebuild is deterministic                                             | `rebuilding twice gives the same result`                           |

Run with `pnpm test:integration` against a live PostgreSQL. Each test file gets its own
schema, so files cannot see each other's rows.
