# Component map

One owner, one responsibility per component. A component may only import from a lower
layer. The dependency rule is enforced mechanically (see `docs/development.md`).

## Layers

```text
L0  packages/config          typed environment, no product logic
L1  packages/domain          pure types, invariants, safety predicate, state machine
L2  packages/db              journal + projections
    packages/observability   logs, metrics, health helpers
L3  packages/xstocks-client  xStocks API boundary
    packages/xlayer-reader   viem reads + event indexing
    packages/receipts        EIP-712 digest, signer, verifier
L4  packages/reconciler      canonicality + source comparison + transitions
L5  apps/api  apps/worker    runtime composition
L6  apps/web                 console (talks only to apps/api over HTTP)
    packages/sdk             external client (talks only to apps/api over HTTP)
```

**Rule:** `L(n)` may import `L(<n)` only. Nothing imports `apps/*`. `packages/domain`
imports nothing but its own types. `apps/web` and `packages/sdk` never import server
packages — they consume the generated OpenAPI client.

## Responsibilities

| Component                 | Single responsibility                                       | Owner lane | Must not                                            |
| ------------------------- | ----------------------------------------------------------- | ---------- | --------------------------------------------------- |
| `packages/config`         | Parse and validate process environment once at startup      | Anandan    | Expose server secrets to `apps/web` client code     |
| `packages/domain`         | Decide ALLOW/BLOCK and lifecycle state, purely              | Gnanam     | Read clock, network, disk, or env                   |
| `packages/db`             | Append evidence; rebuild projections                        | Anandan    | Let projections become the source of truth          |
| `packages/xstocks-client` | Validated access to the xStocks production API              | Gnanam     | Substitute bundled sample data on failure           |
| `packages/xlayer-reader`  | Chain observation with block provenance and reorg detection | Gnanam     | Contain any mainnet signing code path               |
| `packages/receipts`       | Bind one authorization to one exact operation               | Gnanam     | Sign anything but a re-verified ALLOW               |
| `packages/reconciler`     | Turn evidence into deterministic state                      | Gnanam     | Write UI projections directly or sign receipts      |
| `packages/observability`  | Structured logs, metrics, health                            | Anandan    | Log secrets or unbounded payloads                   |
| `packages/sdk`            | Typed integrator client and CLI                             | Anandan    | Duplicate the server safety predicate               |
| `apps/api`                | Thin HTTP surface over the packages                         | Gnanam     | Make business decisions in route handlers           |
| `apps/worker`             | Poll, index, reconcile, project                             | Anandan    | Reconcile an aggregate without a durable lease      |
| `apps/web`                | Explain evidence to humans                                  | Vasanth    | Hold hard-coded assets, balances, health, or hashes |
| `contracts/`              | On-chain enforcement + TESTNET FIXTURE                      | Gnanam     | Deploy to or configure chain 196                    |

## Cross-cutting frozen contracts

Changing any of these requires an ADR plus a coordinated update across API, contract,
SDK, and UI. No single lane may change them alone.

1. The safety predicate in `packages/domain`.
2. The block reason-code enumeration.
3. The EIP-712 receipt typed-data schema (`packages/receipts` ↔ `contracts/`).
4. The evidence event-type enumeration (`packages/db`).
5. The versioned OpenAPI contract (`apps/api` ↔ `apps/web` ↔ `packages/sdk`).
