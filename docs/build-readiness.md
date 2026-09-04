<!--
  GENERATED FILE — do not edit by hand.

  Source of truth: docs/modules.json
  Regenerate:      node scripts/generate-readiness.mjs
  CI check:        node scripts/generate-readiness.mjs --check

  This file was previously hand-maintained. A formatter realigned its columns, the string
  edits that updated it silently stopped matching, and for eleven commits it claimed nothing
  had been built. Generating it is the fix.
-->

# Build readiness

**Recorded at:** 2026-09-04.

The honest inventory. A module is `IMPLEMENTED` only when its code exists in this
repository and its own gates have been run. Being described in the prompt pack is not
evidence that anything exists.

**20 implemented · 3 partial · 1 absent**, of 24 modules.

## Status

| #   | Module | Status | Note |
| --- | ------ | ------ | ---- |
| 00 | Architecture freeze | **IMPLEMENTED** | System context, component map, data flow, ADRs 0001-0004, ownership |
| 01 | Monorepo foundation | **IMPLEMENTED** | pnpm workspace, TS strict, Foundry, compose, config package, layering and bundle-scan gates |
| 02 | Domain, predicate, state machine | **IMPLEMENTED** | Safety predicate, state machine, 22 reason codes; 27/27 mutants killed |
| 03 | Evidence journal and projections | **IMPLEMENTED** | Append-only journal with trigger enforcement, canonical hashing, rebuildable projections |
| 04 | xStocks API client | **IMPLEMENTED** | Built against the verified live OpenAPI v2 contract; 4 live contract tests |
| 05 | X Layer reader and indexer | **IMPLEMENTED** | Block-stamped reads plus a finalized adapter-event indexer with durable cursors, fenced writes, reorg detection, append-only compensation, and replay tests |
| 06 | Canonical asset/wrapper registry | **IMPLEMENTED** | Six-check matrix with PASS/FAIL/UNKNOWN per row, registry diffing |
| 07 | Reconciler and recovery | **IMPLEMENTED** | Deterministic reconciler, fenced auto-renewing leases, incident dedup, lifecycle recovery, and a polling worker that records API/chain comparison per asset |
| 08 | Operation digest and EIP-712 receipt | **IMPLEMENTED** | Ten bound fields, mutation-tested; golden vectors shared with Solidity and the SDK |
| 09 | Solidity TESTNET FIXTURE | **IMPLEMENTED** | Asset, wrapper, legacy wrapper; 21 tests including fuzz on nonce monotonicity. The current v2 implementation is not deployed |
| 10 | ActionGuardAdapter and ProtectedVault | **IMPLEMENTED** | 35 adversarial tests; digest proven identical to TypeScript. The current v2 adapter and pause-safe vault are not deployed |
| 11 | Fastify API and OpenAPI contract | **IMPLEMENTED** | Thirteen routes, strict request/query validation, dedicated fixture-admin authorization, durable idempotency, metrics, and OpenAPI generated from runtime schemas |
| 12 | Web design system and shell | **IMPLEMENTED** | Semantic tokens, shell, status primitives; 28 WCAG pairs verified in CI |
| 13 | Coverage dashboard | **IMPLEMENTED** | Renders live evidence; verified against a running API and against a killed one |
| 14 | Asset detail and timeline | **IMPLEMENTED** | Detail page with canonicality, multiplier epoch, provenance, per-field source comparison, and a replayed evidence timeline |
| 15 | Preflight Lab and testnet execution | **PARTIAL** | Preflight Lab now builds and submits the exact adapter transaction with wallet status feedback; it is intentionally disabled until a compatible v2 deployment exists |
| 16 | Incident replay and review console | **IMPLEMENTED** | Incident list ordered by deterministic severity, plus deterministic replay from immutable journal rows with a policy-version warning |
| 17 | AI incident explainer | **IMPLEMENTED** | Isolated explainer: citation validation, runbook allowlist, injection delimiting, and a deliberately-good deterministic fallback. No provider wired. Architecture test proves it cannot reach the money path |
| 18 | Integrator SDK and CLI | **IMPLEMENTED** | Typed client, local verifier, exact adapter-call encoder and wallet-ready transaction builder, plus a guard CLI with meaningful exit codes |
| 19 | Observability and fault injection | **PARTIAL** | Redaction, structured logging, Prometheus endpoint and alert rules, active signer readiness, and xStocks fault injection are implemented; several declared RPC/database scenarios are not wired end to end |
| 20 | Security hardening and threat model | **IMPLEMENTED** | Threat model with per-row test references and recorded residual risks |
| 21 | CI, containers, deployment | **IMPLEMENTED** | Seven-job CI, non-root multi-stage images, full compose stack, secret-boundary checks, and a checksummed backup plus disposable restore drill |
| 22 | End-to-end proof and submission package | **PARTIAL** | Historical v1 release evidence has real transaction hashes for 8/8 scenarios; the changed v2 contracts require a fresh deployment and proof run |
| 23 | Final independent audit | ABSENT | The repository contains an internal review only. No independent security audit has been performed |

## Blocked items

These cannot be completed from this environment as configured, and are recorded as blocked
rather than quietly skipped.

| Item | Blocker | Effect |
| --- | --- | --- |
| Current X Layer testnet deployment | Requires authorization plus a funded chain-1952 broadcaster key | The checked-in artifact is implementation v1; the safety-fixed adapter is v2 and deliberately rejects that obsolete artifact |
| Current testnet failure-proof transactions | Depends on a verified v2 deployment | Existing scenario B-H transaction evidence remains historical v1 evidence and is not proof of the changed contracts |
| Preflight Lab execution (15) | Depends on a verified v2 deployment and same-chain fixture evidence | The UI refuses to call an obsolete or missing adapter |
| End-to-end proof package (22) | Depends on the v2 deployment above | The historical v1 package must be regenerated against v2 |
| Deployed environment URLs | No hosting target configured | No live URL may be claimed |
| Verified production xStocks scheduling ABI | The explorer serves no verified ABI without an API key, and no corporate action occurred in the observable log window | Read selectors are confirmed and implemented. The three multiplier **event** signatures are declared `UNSUPPORTED_CAPABILITY` rather than invented. Costs the safety path nothing: the verified reads give schedule state directly |
| ESLint on TypeScript 7 | `typescript-eslint@8` refuses to load against the TypeScript 7 API | TypeScript pinned to 6.0.3 so lint can run |

## Resolved blockers

| Item | Resolved |
| --- | --- |
| Live xStocks API verification | 2026-09-03 — contract downloaded and verified against production; 4 live contract tests pass |
| Live X Layer mainnet smoke read | 2026-09-03 — 11 live read-only tests pass against chain 196 |
| Live monitoring pipeline | 2026-09-04 — worker discovered 726 assets over 8 pages, observed mainnet at block 69713901, and the console and CLI rendered that evidence. Chain binding intentionally prevents this mainnet evidence from authorizing a testnet receipt |
| Historical v1 testnet proof | 2026-09-04 — 8/8 scenarios recorded with real chain-1952 transaction hashes. Superseded by implementation v2 and retained only as historical evidence |

## Hackathon eligibility uncertainty

- The OKX Dev Day 2026 build window is stated as 17–25 September 2026. The exact submission
  clock time and timezone were not published when researched and must be verified before
  scheduling final work.
- Whether pre-window implementation is permitted is **UNKNOWN**. This repository is being
  built before 17 September 2026; if OKX requires all implementation to occur inside the
  window, this work counts as preparation only and the submission must say so. Every commit
  carries its authored date, so the record is auditable either way.
- Selected-team technical requirements are not yet published and must be rechecked.
