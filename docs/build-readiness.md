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

**17 implemented · 3 partial · 4 absent**, of 24 modules.

## Status

| #   | Module | Status | Note |
| --- | ------ | ------ | ---- |
| 00 | Architecture freeze | **IMPLEMENTED** | System context, component map, data flow, ADRs 0001-0004, ownership |
| 01 | Monorepo foundation | **IMPLEMENTED** | pnpm workspace, TS strict, Foundry, compose, config package, layering and bundle-scan gates |
| 02 | Domain, predicate, state machine | **IMPLEMENTED** | Safety predicate, state machine, 18 reason codes; 23/23 mutants killed |
| 03 | Evidence journal and projections | **IMPLEMENTED** | Append-only journal with trigger enforcement, canonical hashing, rebuildable projections |
| 04 | xStocks API client | **IMPLEMENTED** | Built against the verified live OpenAPI v2 contract; 4 live contract tests |
| 05 | X Layer reader and indexer | **IMPLEMENTED** | Reads verified live on chain 196; worker observation cycle journals block-stamped evidence |
| 06 | Canonical asset/wrapper registry | **IMPLEMENTED** | Six-check matrix with PASS/FAIL/UNKNOWN per row, registry diffing |
| 07 | Reconciler and recovery | **IMPLEMENTED** | Deterministic reconciler, durable leases, incident dedup, and a leased polling worker that records the API/chain comparison per asset |
| 08 | Operation digest and EIP-712 receipt | **IMPLEMENTED** | Ten bound fields, mutation-tested; golden vectors shared with Solidity and the SDK |
| 09 | Solidity TESTNET FIXTURE | **IMPLEMENTED** | Asset, wrapper, legacy wrapper; 21 tests including fuzz on nonce monotonicity. Not deployed |
| 10 | ActionGuardAdapter and ProtectedVault | **IMPLEMENTED** | 34 adversarial tests; digest proven identical to TypeScript. Not deployed |
| 11 | Fastify API and OpenAPI contract | **IMPLEMENTED** | Nine routes, OpenAPI generated from the runtime schemas, 36 HTTP integration tests |
| 12 | Web design system and shell | **IMPLEMENTED** | Semantic tokens, shell, status primitives; 28 WCAG pairs verified in CI |
| 13 | Coverage dashboard | **IMPLEMENTED** | Renders live evidence; verified against a running API and against a killed one |
| 14 | Asset detail and timeline | **PARTIAL** | Detail page with canonicality, multiplier epoch, provenance, readiness summary. The event timeline needs a journal endpoint |
| 15 | Preflight Lab and testnet execution | ABSENT | Blocked on a testnet deployment |
| 16 | Incident replay and review console | ABSENT | API route exists; the console view does not |
| 17 | AI incident explainer | ABSENT | Optional. Correctly deferred until the deterministic product is complete |
| 18 | Integrator SDK and CLI | **IMPLEMENTED** | Typed client, local verifier pinned to the shared golden vectors, guard CLI with meaningful exit codes |
| 19 | Observability and fault injection | **PARTIAL** | Redaction, structured logging, bounded-cardinality metrics. Fault-injection harness absent |
| 20 | Security hardening and threat model | **IMPLEMENTED** | Threat model with per-row test references and recorded residual risks |
| 21 | CI, containers, deployment | **PARTIAL** | Six-job CI enforcing every gate. Containers and deployment manifests absent |
| 22 | End-to-end proof and submission package | ABSENT | Blocked on a testnet deployment |
| 23 | Final independent audit | **IMPLEMENTED** | docs/final-audit.md. Verdict BLOCKED |

## Blocked items

These cannot be completed from this environment as configured, and are recorded as blocked
rather than quietly skipped.

| Item | Blocker | Effect |
| --- | --- | --- |
| X Layer testnet deployment | Requires a funded chain-1952 broadcaster key | Contracts are built and tested locally; no deployment artifact is written and no address is claimed anywhere |
| Real testnet failure-proof transactions | Depends on the deployment above | Recorded as **NOT PROVEN** in `docs/final-audit.md` |
| Preflight Lab (15) | Depends on the deployment above | The on-chain rejection path has no operator-facing demonstration |
| End-to-end proof package (22) | Depends on the deployment above | Scenarios B–H cannot be executed |
| Deployed environment URLs | No hosting target configured | No live URL may be claimed |
| Verified production xStocks scheduling ABI | The explorer serves no verified ABI without an API key, and no corporate action occurred in the observable log window | Read selectors are confirmed and implemented. The three multiplier **event** signatures are declared `UNSUPPORTED_CAPABILITY` rather than invented. Costs the safety path nothing: the verified reads give schedule state directly |
| ESLint on TypeScript 7 | `typescript-eslint@8` refuses to load against the TypeScript 7 API | TypeScript pinned to 6.0.3 so lint can run |

## Resolved blockers

| Item | Resolved |
| --- | --- |
| Live xStocks API verification | 2026-09-03 — contract downloaded and verified against production; 4 live contract tests pass |
| Live X Layer mainnet smoke read | 2026-09-03 — 11 live read-only tests pass against chain 196 |
| Live end-to-end pipeline | 2026-09-04 — worker discovered 726 assets over 8 pages, observed mainnet at block 69713901, and the console and CLI rendered that evidence |

## Hackathon eligibility uncertainty

- The OKX Dev Day 2026 build window is stated as 17–25 September 2026. The exact submission
  clock time and timezone were not published when researched and must be verified before
  scheduling final work.
- Whether pre-window implementation is permitted is **UNKNOWN**. This repository is being
  built before 17 September 2026; if OKX requires all implementation to occur inside the
  window, this work counts as preparation only and the submission must say so. Every commit
  carries its authored date, so the record is auditable either way.
- Selected-team technical requirements are not yet published and must be rechecked.
