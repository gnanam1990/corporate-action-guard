# ADR 0001 — Stack and repository layout

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Gnanam, Anandan, Vasanth

## Context

Corporate Action Guard needs a pure decision core, several distrusted I/O boundaries, a
durable evidence store, an on-chain enforcement point, and an operator console. The team
is three people working in parallel lanes on a fixed event deadline. The repository was
empty before this decision, so nothing is being migrated.

## Decision

A pnpm workspace monorepo, TypeScript in strict mode, with Foundry for Solidity.

```text
apps/web  apps/api  apps/worker
packages/config domain db xstocks-client xlayer-reader reconciler receipts sdk observability
contracts/   docs/   infra/
```

- **pnpm workspaces** — one package manager, one committed lockfile.
- **TypeScript strict** — no implicit `any`, no suppressed type errors.
- **PostgreSQL + hand-written SQL migrations** — the journal's append-only and idempotency
  constraints are the product's integrity story; they must be readable, not generated.
- **viem** for RPC, **Zod** for ingress validation, **Fastify** for the API,
  **Next.js App Router** for the console, **Tailwind with semantic tokens** for styling.
- **Foundry** for contracts: fuzz and invariant testing are required by the threat model.
- Compatible current versions are detected at initialization time and pinned in the
  lockfile. Version numbers are not copied from planning documents.

## Consequences

- Three lanes can work on non-overlapping paths, integrating only at frozen contracts
  (see `docs/architecture/component-map.md`).
- The layer rule keeps `packages/domain` pure, which is what makes replay and property
  testing possible.
- A monorepo means a slower cold CI run than three small repos. Accepted: contract drift
  between the API, the SDK, the console, and the Solidity typed data is the larger risk.
- No Redis, Kafka, or cloud emulator until a measured need appears. PostgreSQL advisory
  locks provide the worker leases.

## Alternatives rejected

- **Polyrepo** — rejected; the EIP-712 schema and OpenAPI contract span four artifacts and
  would drift.
- **An ORM with generated migrations** — rejected; the append-only triggers and partial
  unique indexes are the point, and generated DDL obscures them.
- **Hardhat** — rejected; Foundry's invariant and fuzz testing is required by ADR 0002.
