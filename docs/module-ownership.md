# Module ownership

Each path has exactly one owning lane. Two sessions must never run against the same
checkout; parallel work uses a branch or worktree per lane with non-overlapping paths.

| Path                      | Owner   | Responsibility                                    |
| ------------------------- | ------- | ------------------------------------------------- |
| `packages/domain`         | Gnanam  | Safety predicate, state machine, reason codes     |
| `packages/xstocks-client` | Gnanam  | xStocks API boundary                              |
| `packages/xlayer-reader`  | Gnanam  | Chain reads, indexing, reorg detection            |
| `packages/reconciler`     | Gnanam  | Canonicality, source comparison, transitions      |
| `packages/receipts`       | Gnanam  | EIP-712 digest, signer, verifier                  |
| `contracts/`              | Gnanam  | Fixture, adapter, vault                           |
| `apps/api`                | Gnanam  | HTTP surface, OpenAPI contract                    |
| `packages/db`             | Anandan | Journal, projections, migrations                  |
| `apps/worker`             | Anandan | Polling, indexing, reconciliation runtime         |
| `packages/observability`  | Anandan | Logs, metrics, health, fault injection            |
| `packages/sdk`            | Anandan | Integrator SDK and CLI                            |
| `infra/`, `.github/`      | Anandan | Containers, CI, deployment                        |
| `apps/web`                | Vasanth | Design system, console routes, accessibility      |
| `docs/`                   | Shared  | Owned by whoever owns the module being documented |

## Phase order

| Phase                | Modules | Lane             | Unblocked by                     |
| -------------------- | ------- | ---------------- | -------------------------------- |
| Rules and foundation | 00–02   | Gnanam           | sequential                       |
| Evidence plane       | 03–07   | Gnanam + Anandan | 02                               |
| Enforcement plane    | 08–10   | Gnanam           | 02, shared ABI/typed-data freeze |
| Product UI           | 11–15   | Vasanth          | 10, frozen API contract          |
| DX and reliability   | 16–19   | Anandan          | core modules available           |
| Proof and release    | 20–23   | all              | every prior required module      |

## Change control

No lane may unilaterally rename a shared type or change the safety predicate. Changes to
any of the five frozen contracts in `docs/architecture/component-map.md` require an ADR
and a coordinated update across the API, the contracts, the SDK, and the UI.

## Integration checkpoint

Every module completion reports:

```text
Module:
Branch/worktree:
Base SHA:
Head SHA or uncommitted diff:
Files changed:
Public interfaces changed:
Database/ABI/OpenAPI migration impact:
Commands run and exact results:
Negative-path evidence:
Live/testnet activity actually performed:
Secrets/deployments created:
Known blockers:
Safe next module:
```
