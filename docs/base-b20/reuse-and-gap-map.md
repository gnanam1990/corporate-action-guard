# Reuse and gap map

What the B20 Equity Integrity Layer needs, against what
[the baseline](repository-baseline.md) already proves. Status vocabulary:

- **IMPLEMENTED** — exists, tested, reusable unchanged. Cites a file and a test.
- **REUSABLE_WITH_CHANGE** — the mechanism is right; it needs additive extension.
- **ABSENT** — nothing exists.
- **BLOCKED** — cannot be built until an external unknown resolves. Names the verification.
- **UNKNOWN** — not yet inspected. Must not stay in this column.

## Evidence and persistence

| Capability                                        | Status               | Evidence / what changes                                                                                                                                                                                  |
| ------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Append-only journal with DB-enforced immutability | IMPLEMENTED          | `packages/db/src/journal.ts`, `migrations/0002_evidence_journal.sql`, `test/journal.integration.test.ts`. Reused as the single source of truth.                                                          |
| Canonical JSON hashing                            | IMPLEMENTED          | `packages/db/src/canonical-json.ts` + unit test. B20 payloads hash through the same function.                                                                                                            |
| Rebuildable projections                           | REUSABLE_WITH_CHANGE | `packages/db/src/projections.ts`. Migration `0008` adds the Base assets, capability, epoch, pending-schedule and feed projections with their check constraints; cases, positions and conformance remain. |
| Fenced worker leases                              | IMPLEMENTED          | `packages/db/src/leases.ts`, `leases.integration.test.ts`. Base ingest partitions use the same primitive.                                                                                                |
| Durable idempotency under concurrency             | REUSABLE_WITH_CHANGE | Command safety exists (`migrations/0005_command_safety.sql`). Re-checked, not copied from a stale audit: it is sound, and B20 preflight needs tenant + route + normalized-hash scoping on top.           |
| Replay from journal                               | IMPLEMENTED          | `packages/db/src/replay.ts`. Base events must serialize through the same versioned envelope.                                                                                                             |
| Reorg compensation as append-only records         | IMPLEMENTED          | `migrations/0006_chain_indexer.sql` and the X Layer indexer. Base reuses the shape; the lookback depth is Base-specific config.                                                                          |

## Decision core

| Capability                                           | Status               | Evidence / what changes                                                                                                                                                               |
| ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branded types, parse-don't-throw                     | IMPLEMENTED          | `packages/domain/src/brands.ts`. Base adds `AssetAddress`, `FeedAddress`, `RawAmount`, `ShareEquivalentAmount`, price types.                                                          |
| Fixed-point multiplier arithmetic                    | REUSABLE_WITH_CHANGE | `packages/domain/src/multiplier.ts` is exact and float-free but models a ratio with free decimals. B20 fixes WAD (1e18) and adds floor conversions with an explicit remainder.        |
| Stable reason codes with severity order              | REUSABLE_WITH_CHANGE | `packages/domain/src/reasons.ts`. Base codes are appended; no existing code is renamed or reordered.                                                                                  |
| Lifecycle state machine                              | REUSABLE_WITH_CHANGE | `packages/domain/src/lifecycle.ts` models the xStocks wrapper lifecycle. B20 needs its own states (scheduled/lazy/cancelled/override/unsupported). Separate reducer, same discipline. |
| Preflight evaluation as a pure function              | REUSABLE_WITH_CHANGE | `packages/domain/src/preflight.ts`. B20 needs a per-action-class evidence matrix; the X Layer contract stays byte-compatible.                                                         |
| Source comparison / agreement policy                 | REUSABLE_WITH_CHANGE | `packages/domain/src/sources.ts` + ADR 0004. The same "absent is not agreement" rule applies to RPC vs feed vs registry.                                                              |
| **Raw / share-equivalent / value as distinct types** | **ABSENT**           | The single largest domain gap. ADR 0006.                                                                                                                                              |
| **Price basis as part of a price's type**            | **ABSENT**           | Nothing today distinguishes a total-return price from an underlying price.                                                                                                            |
| **Double-multiplier rejection**                      | **ABSENT**           | Must be unrepresentable at the type level and rejected by code at runtime boundaries.                                                                                                 |

## Readers

| Capability                                     | Status                | Evidence / what changes                                                                                                                                                                    |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Block-stamped reads, reorg-safe indexing shape | IMPLEMENTED (X Layer) | `packages/xlayer-reader`. The _pattern_ is reused; the code is not, per ADR 0005.                                                                                                          |
| **`packages/b20-reader`**                      | ABSENT                | Base RPC, chain-8453 assertion, B20 metadata/multiplier reads, capability probing, reorg-safe log indexing.                                                                                |
| **`packages/chainlink-reader`**                | ABSENT                | Aggregator reads with round validation, sequencer uptime + grace, per-action freshness policy.                                                                                             |
| **Capability probing (provenance)**            | IMPLEMENTED           | `scripts/b20-provenance.mjs`, `provenance/base-b20/capability-matrix.json`, `test/b20-provenance.test.ts`. The mechanism is settled: an undialed selector reverts with its own four bytes. |
| **Capability detection (runtime reader)**      | ABSENT                | The reader must re-probe per session and per block; a capture is a snapshot, not a runtime answer.                                                                                         |

## Contracts

| Capability                          | Status               | Evidence / what changes                                                                                             |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Receipt-verifying adapter           | REUSABLE_WITH_CHANGE | `contracts/src/ActionGuardAdapter.sol` is deployed on X Layer testnet. `B20GuardAdapter` is a sibling, not an edit. |
| Protected vault                     | REUSABLE_WITH_CHANGE | `contracts/src/ProtectedVault.sol`. Same shape for a B20 test asset.                                                |
| TESTNET FIXTURE asset               | REUSABLE_WITH_CHANGE | `contracts/src/fixtures/FixtureAsset.sol`. A B20 fixture must expose the _B20_ surface.                             |
| Golden vectors shared TS/Solidity   | IMPLEMENTED          | `packages/receipts/vectors`, `contracts/test/GoldenVectors.t.sol`. B20 receipts get their own set.                  |
| **Native Base Sepolia B20 fixture** | BLOCKED              | Verified by probing chain 84532's factory and activation registry. Unprobed as of this map.                         |

## Runtime, SDK and UI

| Capability                     | Status               | Evidence / what changes                                                                            |
| ------------------------------ | -------------------- | -------------------------------------------------------------------------------------------------- |
| Fastify server, auth, errors   | REUSABLE_WITH_CHANGE | `apps/api/src/server.ts`. Add a `/v1/b20` namespace; do not create a second server.                |
| Generated OpenAPI + drift test | IMPLEMENTED          | `apps/api/src/openapi.ts`. New routes must generate, not hand-write, their schemas.                |
| Worker with leases and cursors | REUSABLE_WITH_CHANGE | `apps/worker/src/index.ts`. Add Base head tracking, ingest, sampling, reduction, reconciliation.   |
| Fault injection harness        | REUSABLE_WITH_CHANGE | `packages/observability/src/faults.ts`. Base scenarios plug in; production refusal already exists. |
| SDK + CLI                      | REUSABLE_WITH_CHANGE | `packages/sdk`. Add typed B20 methods; preserve the non-boolean outcome union.                     |
| Design system, contrast gate   | IMPLEMENTED          | `docs/design-system.md`, `scripts/check-contrast.mjs`. The `/b20` surface inherits both.           |
| **`packages/equity-ledger`**   | ABSENT               | Double-entry postings over raw units, share-equivalents and value.                                 |
| **`packages/conformance`**     | ABSENT               | Scenario engine, adapter contract, mutation corpus, JSON/JUnit/SARIF output.                       |
| **MCP server**                 | ABSENT               | Read-only, thin client of the HTTP API.                                                            |
| **x402 middleware**            | ABSENT               | Optional, flag-off by default, never gating a safety decision.                                     |

## X Layer regression surface

These must stay green, unchanged, in every Base pull request. This is the explicit list:

- `packages/domain/test/*` — 22 existing reason codes, their severity ordering and explanation
  strings; the existing lifecycle transitions; `evaluatePreflight` behaviour.
- `packages/receipts/test/receipts.test.ts` and `packages/receipts/vectors` — the deployed X
  Layer receipt schema and its golden vectors are frozen.
- `contracts/test/GoldenVectors.t.sol`, `ActionGuardAdapter.t.sol`, `DeployGuards.t.sol` —
  the deployed adapter's behaviour and its cross-language digest parity.
- `packages/xstocks-client/test/*`, `packages/xlayer-reader/test/reader.test.ts`.
- `apps/api/test/*` — existing route contracts and the OpenAPI drift test.
- `packages/db/test/*` — journal immutability and lease fencing.
- `pnpm arch:check` — with the new packages added to the layer table, not exempted from it.

## External unknowns and how each resolves

| Unknown                                             | Verification (a command or a named source, never a guess)                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Is the Cobalt/ERC-8056 surface live on mainnet?     | `node scripts/b20-provenance.mjs check` — **resolved: NOT_DIALED at block 50993686**               |
| Which token maps to which Chainlink feed?           | An issuer- or Chainlink-published statement naming both addresses. **Unresolved; inference only.** |
| Can Base Sepolia create a B20 asset?                | `capture` against chain 84532 plus `IActivationRegistry.isActivated` for the asset variant feature |
| Do any listed assets have corporate-action history? | Historical log scan over the ten token addresses (module 06 backfill)                              |
| Does any listed asset expose ISIN/CUSIP?            | `extraMetadata(key)` probe over a candidate key set; absent for the keys probed so far             |
| Current x402 specification and middleware           | The official x402 specification and SDK, recorded with version and retrieval date (module 23)      |
