# Runbook — chain reorganisation

## Detection

A reorg is detected by comparing the block hash now reported at a height against the hash
recorded when that height was first observed. A differing hash at the same height **is** a
reorg; there is no ambiguity to interpret.

## What the system does

1. **Retains the original observation.** It was true of the chain we saw. History is never
   erased to make the console look consistent.
2. Appends `REORG_DETECTED` naming the divergent block and the safe block to rewind to.
3. Rewinds `indexed_chain_cursor` so the indexer re-reads.
4. Appends compensating evidence from the re-read.
5. Rebuilds affected projections.

Both the superseded observation and its replacement remain visible in the timeline. An
operator investigating an incident must be able to see that we once believed something the
chain later disagreed with — that belief is often the whole explanation.

## Confirmation depth is an assumption, and is labelled as one

X Layer's finality characteristics are not documented in a form this build could verify, so
the confirmation depth is **conservative and configurable**, default **32 blocks** (~32 s at
the measured 1 s block time). Every snapshot carries the depth that produced its `settled`
flag, so the assumption travels with the evidence rather than living only in a document.

A reorg deeper than the configured depth is a recorded residual risk (`docs/threat-model.md`).

## Diagnose

```sql
SELECT observed_at, payload->>'rewindToBlock' AS rewind_to, block_number, block_hash
FROM evidence_events
WHERE event_type = 'REORG_DETECTED'
ORDER BY ingested_at DESC LIMIT 10;

SELECT chain_id, last_indexed_block, safe_block, confirmation_depth, updated_at
FROM indexed_chain_cursor;
```

## Recover

The rewind is automatic. Confirm re-indexing has caught up, then rebuild projections
(`docs/runbooks/projection-rebuild.md`).

## Reproduce it deliberately

```bash
FAULTS=RPC_REORG node apps/worker/dist/index.js --once
```

The expectation is declared in `FAULT_EXPECTATIONS.RPC_REORG` and asserted by test:
`REORG_DETECTED` plus compensating evidence, and the original observation **NOT deleted**.

## The receipt question

**Can a reorg leave a stale receipt usable?** No.

The adapter re-reads `newMultiplierNonce()` at execution time. If a reorg changed the
multiplier epoch, the nonce read at execution differs from the one bound into the receipt
and the call reverts with `MultiplierNonceMismatch`. The receipt's validity never depends on
the indexer having kept up.
