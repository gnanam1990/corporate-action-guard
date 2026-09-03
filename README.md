# Corporate Action Guard

**Status: implementation in progress.** This is not a production-ready corporate-action
safety layer, and nothing here has been audited or deployed. See
[`docs/build-readiness.md`](docs/build-readiness.md) for the honest module-by-module
inventory.

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

## Licence

MIT. See [`LICENSE`](LICENSE).
