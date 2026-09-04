# Corporate Action Guard

**Status: deployed to X Layer testnet. All eight on-chain failure scenarios pass. Not audited.**

The stack runs end to end against live sources, and the guard is deployed and proven on
chain: **8/8 failure scenarios pass reproducibly on X Layer testnet**, including a
scheduled corporate action killing an outstanding receipt.

The self-audit verdict is **CONDITIONAL** — it cannot go higher while the event's rules are
unpublished, enforcement is proven against a labelled `TESTNET FIXTURE` rather than
production scheduling semantics, and no external party has audited this.

- [`docs/build-readiness.md`](docs/build-readiness.md) — module-by-module inventory
- [`docs/final-audit.md`](docs/final-audit.md) — claim-to-evidence matrix, PROVEN vs NOT PROVEN

---

## The problem

When a tokenized equity goes through a corporate action — a split, a reverse split, a
dividend adjustment — the on-chain multiplier changes at a scheduled activation time. An
integration that formed its assumptions a few seconds earlier is now acting on stale
state. Balances, conversions, collateral values, and liquidation thresholds computed
against the old multiplier are wrong, and the transaction that carries them still settles.

Corporate Action Guard makes that failure _refuse to execute_ rather than settle quietly.

## What it does

An integrator asks the guard to preflight an exact operation. The guard answers `ALLOW` or
`BLOCK` from evidence, and an `ALLOW` comes with a short-lived EIP-712 receipt bound to
that one operation. An on-chain adapter re-verifies every bound field itself before the
action can touch funds.

```text
ALLOW(action) only if
  token and wrapper are canonical
  AND wrapper.asset() is the expected xStock
  AND the wrapper version is current
  AND action.multiplierNonce == onchain.multiplierNonce
  AND now is outside [activation - guardWindow, activation + guardWindow]
  AND required sources agree
  AND receipt.operationDigest binds chain, target, asset, amount, recipient
  AND the receipt is not expired or consumed
```

Anything missing, stale, unknown, or contradictory **fails closed**. Missing evidence never
becomes an implicit match.

```text
NORMAL -> PENDING -> GUARD_WINDOW -> APPLIED -> RECONCILED
                   \-> MISMATCH -> MANUAL_REVIEW -> RECOVERED
```

## Honest boundary — read this before believing anything else

- **This is not a universal X Layer firewall.** The guard is enforceable only for
  applications that route protected actions through `ActionGuardAdapter`. A holder can
  transfer an xStock ERC-20 directly and bypass an optional adapter entirely.
- **X Layer mainnet is read-only.** Chain `196` is observed, never written. No mainnet
  signing code path exists, and deployment scripts refuse chain 196.
- **The MVP receipt signer is not a production trust architecture.** The adapter verifies
  chain facts itself, but it cannot verify that the off-chain API agreed. A compromised
  signer could assert agreement that never happened. Production needs HSM/KMS or threshold
  signing plus auditable rotation. That gap is documented, not implemented.
- **A testnet fixture is used because real corporate actions cannot be scheduled on
  demand.** It is labelled `TESTNET FIXTURE` on chain, in metadata, and in the UI. It
  proves the guard rejects stale, mutated, replayed, expired, and unsafe-window
  operations. It does not prove production xStocks interface compatibility.
- **AI is never in the money path.** The optional explainer summarizes evidence for humans
  and is structurally excluded from the preflight decision, receipt issuance, and the
  contracts. An architecture test enforces that.

Full reasoning: [ADR 0002 — trust and enforcement boundary](docs/architecture/decisions/0002-trust-and-enforcement-boundary.md).

## Architecture

```text
apps/web      Next.js App Router operational console
apps/api      Fastify HTTP API
apps/worker   polling, indexing, reconciliation, projections

packages/config          typed environment and shared config
packages/domain          pure types, invariants, safety predicate, state machine
packages/db              SQL migrations, append-only journal, projections
packages/xstocks-client  xStocks production API boundary
packages/xlayer-reader   viem RPC reads and reorg-aware event indexing
packages/reconciler      canonicality, source comparison, transitions
packages/receipts        EIP-712 operation digest, signer, verifier
packages/sdk             integrator SDK and CLI
packages/observability   logs, metrics, health

contracts/    Foundry: TESTNET FIXTURE, ActionGuardAdapter, ProtectedVault
docs/         architecture, ADRs, runbooks, threat model, evidence
infra/        local compose
```

Packages sit in strict layers and may import only downward; `pnpm arch:check` enforces it.
See [`docs/architecture/component-map.md`](docs/architecture/component-map.md).

## Getting started

```bash
git clone --recurse-submodules https://github.com/gnanam1990/corporate-action-guard.git
cd corporate-action-guard
pnpm install --frozen-lockfile
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm verify
```

Full instructions, ports, and toolchain notes: [`docs/development.md`](docs/development.md).

## Documentation

| Document                                                                     | What it covers                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [`docs/architecture/system-context.md`](docs/architecture/system-context.md) | Actors, trust zones, per-boundary timeout/retry/fail direction |
| [`docs/architecture/component-map.md`](docs/architecture/component-map.md)   | Layers, ownership, frozen contracts                            |
| [`docs/architecture/data-flow.md`](docs/architecture/data-flow.md)           | Six traced flows from discovery to replay                      |
| [`docs/architecture/decisions/`](docs/architecture/decisions/)               | ADRs 0001–0003                                                 |
| [`docs/build-readiness.md`](docs/build-readiness.md)                         | What exists, what is absent, what is blocked                   |
| [`docs/module-ownership.md`](docs/module-ownership.md)                       | Lane assignment and change control                             |

## What is actually verified

Every claim below is backed by a named, runnable check.

| Claim                                                        | Evidence                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| The catalog comes from the live xStocks API                  | 4 live contract tests against `api.xstocks.fi/api/v2`                                      |
| Chain state comes from live mainnet reads at recorded blocks | 11 live read-only tests against chain 196                                                  |
| The two sources agree, exactly                               | Chain `1003269012539818700` @18dp = API `1.0032690125398187`                               |
| Mainnet is never written                                     | No signing method exists on the reader; adapter and deploy script both revert on chain 196 |
| Missing evidence never becomes an implicit match             | 400-run property test; three bugs of this exact shape found and fixed during the build     |
| Every guard in the safety predicate is tested                | **23/23 mutation kills**                                                                   |
| TypeScript and Solidity agree on the operation digest        | Shared golden vectors read by both suites; CI fails on drift                               |
| A receipt is never issued for a BLOCK                        | Discriminated union makes it unrepresentable; 16 per-reason tests                          |
| The journal cannot be rewritten                              | Database trigger; integration-tested                                                       |
| Direct ERC-20 transfers bypass the guard                     | Asserted as a **passing test**, not just documented                                        |

```text
581 tests total — 447 unit, 69 integration, 65 Solidity
23/23 mutants killed on the safety predicate
28 WCAG contrast pairs verified in CI
```

## Try it

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate

# Observe the live catalog and live X Layer mainnet
XLAYER_MAINNET_RPC_URL=https://rpc.xlayer.tech WORKER_MAX_ASSETS=8 \
  node apps/worker/dist/index.js --once

node apps/api/dist/index.js &          # http://localhost:4000
pnpm --filter @cag/web dev             # http://localhost:3000

GUARD_API_URL=http://localhost:4000 node packages/sdk/dist/cli.js assets list
```

### Proven on chain — X Layer testnet, chain 1952

| Scenario                                                    | Result                                    |
| ----------------------------------------------------------- | ----------------------------------------- |
| Valid receipt accepted exactly once                         | executed, replay `ReceiptAlreadyConsumed` |
| Recipient changed after issuance                            | `OperationDigestMismatch`                 |
| Amount changed after issuance                               | `OperationDigestMismatch`                 |
| Receipt expired                                             | `ReceiptExpired`                          |
| **Scheduled corporate action kills an outstanding receipt** | `MultiplierNonceMismatch`                 |
| Inside the guard window                                     | `InsideGuardWindow`                       |
| Unauthorized signer                                         | `UnauthorizedSigner`                      |
| Direct ERC-20 transfer                                      | **succeeds** — the documented bypass      |

Adapter `0x5419941472c4a42FF0D68694c2A88F1b4716C337`. Transaction hashes and explorer links
in [`docs/evidence/release-candidate.md`](docs/evidence/release-candidate.md).

**Still not verified:** production xStocks scheduling compatibility, and any external
audit.

## Licence

MIT. See [`LICENSE`](LICENSE).
