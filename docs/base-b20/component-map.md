# Base B20 component map

One reason to exist, one dependency layer, per package. The layer numbers are enforced by
`scripts/check-layering.mjs`, which reads both declared dependencies and actual import
specifiers.

| Layer | Package                                     | Reason to exist                                                    | May import |
| ----- | ------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| L0    | `@cag/config`                               | Parse and validate the environment once, at the composition root   | nothing    |
| L1    | `@cag/domain`                               | Pure quantities, invariants, outcomes, reason codes, reducers      | nothing    |
| L2    | `@cag/db`                                   | Append-only journal, rebuildable projections, leases, idempotency  | L0–L1      |
| L2    | `@cag/observability`                        | Metrics, traces, redaction, fault harness                          | L0–L1      |
| L3    | `@cag/b20-reader`                           | Base RPC reads and reorg-safe B20 log indexing. **No signing API** | L0–L2      |
| L3    | `@cag/chainlink-reader`                     | Feed, registry, pause, sequencer and freshness reads               | L0–L2      |
| L3    | `@cag/receipts`                             | EIP-712 typed data and the signer boundary                         | L0–L2      |
| L3    | `@cag/xstocks-client`, `@cag/xlayer-reader` | Existing X Layer sources, preserved unchanged                      | L0–L2      |
| L4    | `@cag/equity-ledger`                        | Double-entry postings over raw units, share-equivalents and value  | L0–L3      |
| L4    | `@cag/reconciler`                           | Deterministic evidence correlation and the state machine           | L0–L3      |
| L4    | `@cag/conformance`                          | Scenario engine, mutation corpus, CI-neutral result format         | L0–L3      |
| L5    | `@cag/api`, `@cag/worker`                   | Composition roots. Nothing may import an app                       | L0–L4      |
| L6    | `@cag/sdk`, `@cag/web`, `@cag/explainer`    | Client surfaces. `sdk`, `web` and `explainer` are isolated         | see note   |

`@cag/explainer` may import **nothing**. That is how the AI boundary is enforced: no model
output can reach a decision, because the package that talks to a model cannot import the
package that decides.

## Why these are separate packages

**`b20-reader` and `chainlink-reader` are not one "sources" package.** They fail differently.
An RPC that cannot be reached is a transport problem; a feed round that regressed is a
correctness problem. Merging them would produce one health signal where operators need two.

**`equity-ledger` is not part of `db`.** The ledger is pure accounting logic over evidence;
`db` is storage. Keeping them apart is what lets the ledger be property-tested without a
database and lets a projection rebuild be verified by hash equality.

**`conformance` is not part of `api`.** It has to run offline, in a customer's CI, against a
customer's adapter, with no server.

**`b20-reader` is a new package rather than a generalization of `xlayer-reader`.** Refactoring
working, deployed, tested code to serve a chain whose capability surface is still moving buys
nothing and risks the shipped product. See ADR 0005.
