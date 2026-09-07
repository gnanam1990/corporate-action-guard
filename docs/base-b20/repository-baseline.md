# Repository baseline before the B20 extension

What was actually here on 2026-09-07, measured rather than remembered. Every later claim of
"we reused X" is checkable against this page.

## Exact state

| Fact        | Value                                                           |
| ----------- | --------------------------------------------------------------- |
| Commit      | `a23a8f4` — `ci: make gas snapshot portable`                    |
| Branch      | `main`, in sync with `origin/main`                              |
| Worktree    | clean at the start of this work                                 |
| Remote      | `https://github.com/gnanam1990/corporate-action-guard` (public) |
| Node / pnpm | 22.23.1 / 11.10.0 (`packageManager` pins pnpm 11.10.0)          |
| Foundry     | 1.7.1, pinned in CI so gas snapshots stay comparable            |
| Merged PRs  | 9, all squashed into `main`                                     |

## Baseline verification run

```
pnpm install --frozen-lockfile   lockfile passes supply-chain policy, 317 entries
pnpm typecheck                   clean (tsc --build across 12 projects)
pnpm test                        24 files, 538 tests, all passing, 1.04 s
```

Integration tests (`pnpm test:integration`) require PostgreSQL and were not part of this
baseline capture; the Base work must not change that requirement.

## Workspace shape

Twelve workspace packages plus three apps, governed by a mechanical layering rule
(`scripts/check-layering.mjs`) that reads both declared dependencies and actual import
specifiers, so a direct path import cannot bypass it.

```text
L0  @cag/config
L1  @cag/domain                   (isolated: may import no workspace package)
L2  @cag/db  @cag/observability
L3  @cag/xstocks-client  @cag/xlayer-reader  @cag/receipts
L4  @cag/reconciler
L5  @cag/api  @cag/worker         (nothing may import an app)
L6  @cag/web  @cag/sdk  @cag/explainer   (all isolated)
```

`@cag/explainer` is isolated deliberately: the AI boundary is enforced by the architecture
check, not by a review convention.

## What already exists and works

**Decision core (`@cag/domain`).** Branded types with parse-don't-throw constructors;
fixed-point `Multiplier` with exact cross-scale comparison and a string parser that never
touches a float; 22 stable `BLOCK_REASONS` with a fixed severity ordering and a
deterministic explanation string per code; a lifecycle state machine with legal-transition
enumeration; `evaluatePreflight` as a pure function of its inputs. No clock, no I/O — every
input arrives as an argument, which is what makes replay byte-reproducible.

**Evidence plane (`@cag/db`).** Append-only journal with a database trigger that rejects
`UPDATE` and `DELETE` on journal rows, canonical JSON hashing, rebuildable projections,
fenced auto-renewing worker leases, replay, and a command-safety layer. Seven forward-only
migrations, `0001`–`0007`.

**Receipts (`@cag/receipts`).** EIP-712 typed data over ten bound fields, a KMS signer
boundary, and golden vectors shared with Solidity and the SDK. Mutation-tested: changing any
bound field fails verification.

**Readers.** `@cag/xstocks-client` (built against the verified live OpenAPI v2 contract, with
live contract tests) and `@cag/xlayer-reader` (block-stamped reads plus a finalized event
indexer with durable cursors, fenced writes, reorg detection and append-only compensation).

**Runtime.** One Fastify API with generated OpenAPI, one worker with discovery, a receipt
indexer and a fault harness, a Next.js console, an SDK with a CLI, containers, a compose
stack, backup/restore drill scripts and a monitoring configuration check.

**Gates already in CI.** Prettier, `forge fmt`, ESLint, the layering rule, a runtime-import
check that catches a production import declared dev-only, a monitoring-config check, a WCAG
contrast assertion on the design tokens, a generated build-readiness table that fails when it
drifts, secret scanning, a web bundle scan, dependency audit, unit tests, Foundry tests with a
pinned toolchain and portable gas snapshots.

## What the repository says about itself

`docs/modules.json` is the single source of truth for module status and generates
`docs/build-readiness.md`; CI fails if they disagree. Its 24 modules record 22 `IMPLEMENTED`,
one `PARTIAL` (19, observability and fault injection) and one `ABSENT` (23, final independent
audit). Those two remain open for the X Layer product and are not silently closed by Base work.

## Honest gaps in the baseline

- **Integration and contract tests are not in the default `pnpm test`.** They require
  PostgreSQL and Foundry respectively. Anyone reading "538 tests pass" should know that is the
  unit project only.
- **Module 19 is `PARTIAL`.** The fault harness is wired into the worker but the observability
  surface is incomplete. Base work adds signals; it does not close module 19.
- **Module 23 is `ABSENT`.** No independent audit has been run against the X Layer product.
- **Live probes are deliberately not required checks.** A third-party outage must not block a
  merge, so `live-probes.yml` runs on a schedule instead. The same discipline applies to the
  Base provenance check.
- **No Base code of any kind existed at this commit.** Every Base claim in this repository
  dates from after `a23a8f4`.
