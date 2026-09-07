# Implementation sequence and module ownership

Nine phases. Each phase owns a disjoint set of paths, merges as one reviewed pull request
into `main`, and leaves the repository green. No phase begins before its dependency merges.

The module numbering below is the B20 prompt-pack numbering (`b20-00` … `b20-34`), recorded
in `docs/modules.json` with a `b20-` prefix so it cannot collide with the X Layer modules
`00`–`23`.

| Phase | Modules         | Branch                                  | Owns                                                                                                                | Leaves green                                           |
| ----- | --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1     | b20-00 … b20-02 | `b20/01-provenance-freeze`              | `docs/base-b20/**`, `docs/architecture/decisions/0005-0008`, `provenance/base-b20/**`, `scripts/b20-provenance.mjs` | Docs and provenance only; no product source changes    |
| 2     | b20-03 … b20-05 | `b20/02-domain-config-registry`         | `packages/domain/src/b20/**`, `packages/config`, registry service                                                   | Domain, config and registry tests                      |
| 3     | b20-06 … b20-08 | `b20/03-readers-and-evidence`           | `packages/b20-reader`, `packages/chainlink-reader`, `packages/db` migrations `0008+`                                | Reader unit tests, migration and rebuild tests         |
| 4     | b20-09 … b20-13 | `b20/04-lifecycle-ledger-reconcile`     | lifecycle reducer, correlator, `packages/equity-ledger`, valuation, B20 state machine                               | Property, scenario and rebuild-equality tests          |
| 5     | b20-14 … b20-16 | `b20/05-conformance-preflight-receipts` | `packages/conformance`, B20 preflight service, B20 receipt schema and vectors                                       | Conformance corpus, mutation kills, receipt vectors    |
| 6     | b20-17, b20-18  | `b20/06-contracts`                      | `contracts/src/B20*`, Foundry tests, deploy scripts                                                                 | Foundry unit/fuzz/invariant, cross-language vectors    |
| 7     | b20-19 … b20-23 | `b20/07-api-worker-sdk`                 | `/v1/b20` routes, worker jobs, SDK/CLI, MCP server, optional x402                                                   | Route, RBAC, idempotency, SDK and MCP tests            |
| 8     | b20-24 … b20-29 | `b20/08-console`                        | `apps/web/src/app/b20/**` and its components                                                                        | Component and accessibility tests at 375/768/1024/1440 |
| 9     | b20-30 … b20-34 | `b20/09-release-readiness`              | observability, security review, CI, E2E proof, `B20_RELEASE_READINESS.md`                                           | Full `pnpm verify` plus the E2E evidence run           |

## Ordering constraints that are not negotiable

- **b20-02 before any product code.** No address, ABI or capability may be referenced before
  it exists in `provenance/base-b20/`.
- **b20-03 before b20-04.** Config cannot be typed before the quantities it configures exist.
- **b20-08 before b20-11.** The ledger writes through the journal; the journal's event
  versions have to be frozen first.
- **b20-15 before b20-16.** A receipt is issued only after a durable preflight intent exists
  and is re-verified. Signing from a caller-supplied `ALLOW` is the failure this ordering
  prevents.
- **b20-19 before b20-24.** The console consumes the generated API contract. It never imports
  server modules directly.
- **b20-17 gates b20-18 on mainnet.** If Base Sepolia B20 creation cannot be verified, the
  adapter and vault are exercised locally and Sepolia execution is recorded `BLOCKED`.

## Path ownership

No two phases write the same file. Where a shared file must change (`docs/modules.json`,
`scripts/check-layering.mjs`, `package.json` scripts, `.env.example`), the change is additive,
lands in the earliest phase that needs it, and is listed in that phase's pull request
description.

## Integration checkpoints

After phases 2, 3, 4, 5, 7 and 9 the full gate runs before merge:

```bash
pnpm verify          # format, lint, arch, types, contrast, compose, monitoring,
                     # deps, secrets, docs, unit tests, contract tests
pnpm test:integration   # requires PostgreSQL
```

## What "done" does not mean

A phase is not done because its files exist and its own tests pass. It is done when the X
Layer regression surface listed in [the gap map](reuse-and-gap-map.md#x-layer-regression-surface)
is still green, its acceptance gates are met, and its status in `docs/modules.json` reflects
what was actually proven — including `PARTIAL` and `BLOCKED` where that is the truth.
