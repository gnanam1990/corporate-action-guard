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

**Recorded at:** 2026-09-07.

The honest inventory. A module is `IMPLEMENTED` only when its code exists in this
repository and its own gates have been run. Being described in the prompt pack is not
evidence that anything exists.

**28 implemented · 1 partial · 0 blocked · 30 absent**, of 59 modules.

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
| 09 | Solidity TESTNET FIXTURE | **IMPLEMENTED** | Asset, wrapper, legacy wrapper; 21 tests including fuzz on nonce monotonicity; implementation v2 deployed and verified on X Layer testnet |
| 10 | ActionGuardAdapter and ProtectedVault | **IMPLEMENTED** | 35 adversarial tests; digest proven identical to TypeScript; v2 adapter and pause-safe vault deployed and exercised on X Layer testnet |
| 11 | Fastify API and OpenAPI contract | **IMPLEMENTED** | Thirteen routes, strict request/query validation, dedicated fixture-admin authorization, durable idempotency, metrics, and OpenAPI generated from runtime schemas |
| 12 | Web design system and shell | **IMPLEMENTED** | Semantic tokens, shell, status primitives; 28 WCAG pairs verified in CI |
| 13 | Coverage dashboard | **IMPLEMENTED** | Renders live evidence; verified against a running API and against a killed one |
| 14 | Asset detail and timeline | **IMPLEMENTED** | Detail page with canonicality, multiplier epoch, provenance, per-field source comparison, and a replayed evidence timeline |
| 15 | Preflight Lab and testnet execution | **IMPLEMENTED** | Preflight Lab builds the exact adapter transaction with wallet status feedback; compatible v2 deployment is embedded and end-to-end execution is proven |
| 16 | Incident replay and review console | **IMPLEMENTED** | Incident list ordered by deterministic severity, plus deterministic replay from immutable journal rows with a policy-version warning |
| 17 | AI incident explainer | **IMPLEMENTED** | Isolated explainer: citation validation, runbook allowlist, injection delimiting, and a deliberately-good deterministic fallback. No provider wired. Architecture test proves it cannot reach the money path |
| 18 | Integrator SDK and CLI | **IMPLEMENTED** | Typed client, local verifier, exact adapter-call encoder and wallet-ready transaction builder, plus a guard CLI with meaningful exit codes |
| 19 | Observability and fault injection | **PARTIAL** | Redaction, structured logging, Prometheus endpoint and alert rules, active signer readiness, and xStocks fault injection are implemented; several declared RPC/database scenarios are not wired end to end |
| 20 | Security hardening and threat model | **IMPLEMENTED** | Threat model with per-row test references and recorded residual risks |
| 21 | CI, containers, deployment | **IMPLEMENTED** | Seven-job CI, non-root multi-stage images, full compose stack, secret-boundary checks, and a checksummed backup plus disposable restore drill |
| 22 | End-to-end proof and submission package | **IMPLEMENTED** | Current v2 release evidence records 8/8 adversarial scenarios plus authenticated API-to-vault execution with public testnet transaction hashes |
| 23 | Final independent audit | ABSENT | The repository contains an internal review only. No independent security audit has been performed |
| b20-00 | B20 repository audit and gap map | **IMPLEMENTED** | docs/base-b20 baseline, reuse/gap map, risk register, sequence; no product source touched |
| b20-01 | B20 product contract and architecture freeze | **IMPLEMENTED** | Product contract, invariants, system context, component map, data flows, ADRs 0005-0008 |
| b20-02 | Official interface and capability provenance gate | **IMPLEMENTED** | base-std pinned at be6d0450; 10 official assets and 13 Chainlink feeds captured and live-verified at Base block 50993686; Cobalt/ERC-8056 measured NOT_DIALED |
| b20-03 | B20 domain quantities and lifecycle types | **IMPLEMENTED** | Branded raw/share/multiplier/price types with basis, floor arithmetic with reported remainder, 38 B20 reason codes, temporal lifecycle reducer; 4 mutants killed |
| b20-04 | Typed Base configuration and safety gates | **IMPLEMENTED** | Base env schema with no mainnet signer field, five-condition Sepolia write gate, dependency-aware feature flags; an X Layer deployment starts unchanged |
| b20-05 | Verified B20 asset registry | **IMPLEMENTED** | Identity is (chainId,address) confirmed by official list + isB20Initialized + live reads; prefix refused, rename opens review, manifest parsed strictly |
| b20-06 | Base B20 reader and reorg-safe indexer | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-07 | Chainlink tokenized-equity and sequencer reader | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-08 | Append-only Base evidence schema and projections | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-09 | Temporal B20 lifecycle reducer | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-10 | Corporate-action correlator and classification boundary | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-11 | Brokerage-grade equity position ledger | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-12 | Valuation engine and invariant proof surface | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-13 | B20 reconciliation state machine | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-14 | Integration Conformance Lab and mutation corpus | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-15 | B20 operation model and preflight service v2 | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-16 | Versioned B20 EIP-712 receipt and replay protection | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-17 | Base Sepolia B20 fixture and capability gate | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-18 | B20GuardAdapter and protected vault | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-19 | Fastify /v1/b20 API and OpenAPI contract | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-20 | Base worker ingestion, reconciliation, backfill | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-21 | SDK, CLI and authenticated webhooks for B20 | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-22 | Read-only MCP server for agent integrations | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-23 | Optional x402 access for premium artifacts | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-24 | B20 interface foundation and application shell | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-25 | B20 operations overview and source health | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-26 | Asset detail, quantity math, evidence inspector | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-27 | Operations, incidents and reconciliation workbench | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-28 | Conformance and fault-injection lab | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-29 | Evidence ledger, exports and integration onboarding | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-30 | B20 observability, SLOs and fault injection | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-31 | B20 security, privacy and adversarial review | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-32 | B20 CI, containers, migrations and release readiness | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-33 | B20 end-to-end proof and demo artifacts | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |
| b20-34 | Pilot packaging and final independent audit | ABSENT | Not started. Sequenced in docs/base-b20/implementation-sequence.md |

## Blocked items

These cannot be completed from this environment as configured, and are recorded as blocked
rather than quietly skipped.

| Item | Blocker | Effect |
| --- | --- | --- |
| Deployed environment URLs | No hosting target configured | No live URL may be claimed |
| Production signer and operations | No production AWS KMS/IAM, hosted monitoring, alert delivery, retention, or operating history | Testnet proof is application evidence, not a production-readiness claim |
| Independent security audit | No external reviewer has audited the service or contracts | The repository's internal review cannot be called an audit |
| Verified production xStocks scheduling ABI | The explorer serves no verified ABI without an API key, and no corporate action occurred in the observable log window | Read selectors are confirmed and implemented. The three multiplier **event** signatures are declared `UNSUPPORTED_CAPABILITY` rather than invented. Costs the safety path nothing: the verified reads give schedule state directly |
| ESLint on TypeScript 7 | `typescript-eslint@8` refuses to load against the TypeScript 7 API | TypeScript pinned to 6.0.3 so lint can run |

## Resolved blockers

| Item | Resolved |
| --- | --- |
| Live xStocks API verification | 2026-09-03 — contract downloaded and verified against production; 4 live contract tests pass |
| Live X Layer mainnet smoke read | 2026-09-03 — 11 live read-only tests pass against chain 196 |
| Live monitoring pipeline | 2026-09-04 — worker discovered 726 assets over 8 pages, observed mainnet at block 69713901, and the console and CLI rendered that evidence. Chain binding intentionally prevents this mainnet evidence from authorizing a testnet receipt |
| Historical v1 testnet proof | 2026-09-04 — 8/8 scenarios recorded with real chain-1952 transaction hashes. Superseded by implementation v2 and retained only as historical evidence |
| Current v2 testnet proof | 2026-09-05 — implementation v2 deployed at block 40163577; 8/8 adversarial scenarios passed and authenticated API-to-vault execution succeeded |

## Hackathon eligibility uncertainty

- The OKX Dev Day 2026 build window is stated as 17–25 September 2026, with project
  submission listed for 25 September. The application deadline is 11 September at 23:59 UTC.
- Whether pre-window implementation is permitted is **UNKNOWN**. This repository is being
  built before 17 September 2026; if OKX requires all implementation to occur inside the
  window, this work counts as preparation only and the submission must say so. Every commit
  carries its authored date, so the record is auditable either way.
- Selected-team technical requirements are not yet published and must be rechecked.
