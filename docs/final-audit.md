# Final audit

**Audited revision:** `7f7c0fb62829c1b41882d46fca22595daf3c3e05` (branch `build/corporate-action-guard`)
**Date:** 2026-09-03
**Auditor:** the implementing team. **This is not an independent audit.**

## Verdict

## **BLOCKED** — not ready for submission review.

Not because a defect was found, but because **the build is incomplete and its central claim
is unproven end to end.** The guard has never executed against a deployed contract on a
real chain. Everything below the "proven" line is real; everything above the "not proven"
line is honest about not existing.

The event's final rules were also unavailable when this was written, which independently
caps any verdict at CONDITIONAL.

## Claim-to-evidence matrix

| Claim                                                                       | Status               | Evidence                                                                                               |
| --------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| The asset catalog comes from the live xStocks API                           | **PROVEN**           | 4 live contract tests pass against `api.xstocks.fi/api/v2`, 2026-09-03                                 |
| Displayed X Layer state comes from live mainnet reads at recorded blocks    | **PROVEN**           | 11 live read-only tests against chain 196; every snapshot carries block number and hash                |
| The API and the chain agree, and that is checkable exactly                  | **PROVEN**           | Chain `1003269012539818700` @18dp equals API `1.0032690125398187`, verified the same day               |
| Mainnet is never written                                                    | **PROVEN**           | `XLayerReader` has no signing method; adapter constructor and deploy script both revert on 196; tested |
| Missing evidence never becomes an implicit match                            | **PROVEN**           | Property test over evidence subsets, 400 runs; three separate bugs of this exact shape found and fixed |
| Every guard in the safety predicate is one the tests would notice losing    | **PROVEN**           | 23/23 mutants killed                                                                                   |
| The receipt binds one exact operation                                       | **PROVEN**           | 10 bound fields, mutation-tested in both languages                                                     |
| TypeScript and Solidity agree on the digest                                 | **PROVEN**           | Shared golden vectors read by both suites; CI fails on drift                                           |
| A receipt is never returned for a BLOCK                                     | **PROVEN**           | Discriminated union makes it unrepresentable; 16 per-reason tests                                      |
| The journal cannot be rewritten by the application                          | **PROVEN**           | Trigger rejects UPDATE and DELETE; integration-tested                                                  |
| Projections are reproducible from the journal alone                         | **PROVEN**           | Incremental fold equals full rebuild; rebuild is deterministic                                         |
| A consumed receipt can never be reused                                      | **PROVEN**           | On chain and in the database; concurrent race gives one winner                                         |
| A scheduled corporate action invalidates an outstanding receipt             | **PROVEN (fixture)** | `test_ScheduleInvalidatesAnOutstandingReceipt`                                                         |
| Direct ERC-20 transfers bypass the guard                                    | **PROVEN**           | Asserted as a passing test, not merely documented                                                      |
| Secrets cannot reach logs or the browser bundle                             | **PROVEN**           | Canary tests; both scanners verified against planted material                                          |
| **The guard rejects a stale receipt in a real transaction on a real chain** | **NOT PROVEN**       | No deployment exists                                                                                   |
| **The guard accepts a valid receipt exactly once on a real chain**          | **NOT PROVEN**       | No deployment exists                                                                                   |
| **An operator can see all of this in a console**                            | **NOT PROVEN**       | Design system exists; live evidence routes do not                                                      |
| **An integrator can adopt this in 15 minutes**                              | **NOT PROVEN**       | SDK and CLI not implemented                                                                            |

## What exists

Derived from `docs/modules.json`, which also generates `docs/build-readiness.md`. This
section previously drifted out of date the same way the readiness table did, and for the
same reason: hand edits against a formatter-realigned table.

| #   | Module                                  | Status                                                                                                                                                                       |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | Architecture freeze                     | Complete — System context, component map, data flow, ADRs 0001-0004, ownership                                                                                               |
| 01  | Monorepo foundation                     | Complete — pnpm workspace, TS strict, Foundry, compose, config package, layering and bundle-scan gates                                                                       |
| 02  | Domain, predicate, state machine        | Complete — Safety predicate, state machine, 18 reason codes; 23/23 mutants killed                                                                                            |
| 03  | Evidence journal and projections        | Complete — Append-only journal with trigger enforcement, canonical hashing, rebuildable projections                                                                          |
| 04  | xStocks API client                      | Complete — Built against the verified live OpenAPI v2 contract; 4 live contract tests                                                                                        |
| 05  | X Layer reader and indexer              | Complete — Reads verified live on chain 196; worker observation cycle journals block-stamped evidence                                                                        |
| 06  | Canonical asset/wrapper registry        | Complete — Six-check matrix with PASS/FAIL/UNKNOWN per row, registry diffing                                                                                                 |
| 07  | Reconciler and recovery                 | Partial — Deterministic reconciler, leases, dedup, leased polling worker. The worker does not yet record a source comparison, so agreement reports INCOMPLETE — which blocks |
| 08  | Operation digest and EIP-712 receipt    | Complete — Ten bound fields, mutation-tested; golden vectors shared with Solidity and the SDK                                                                                |
| 09  | Solidity TESTNET FIXTURE                | Complete — Asset, wrapper, legacy wrapper; 21 tests including fuzz on nonce monotonicity. Not deployed                                                                       |
| 10  | ActionGuardAdapter and ProtectedVault   | Complete — 34 adversarial tests; digest proven identical to TypeScript. Not deployed                                                                                         |
| 11  | Fastify API and OpenAPI contract        | Complete — Nine routes, OpenAPI generated from the runtime schemas, 36 HTTP integration tests                                                                                |
| 12  | Web design system and shell             | Complete — Semantic tokens, shell, status primitives; 28 WCAG pairs verified in CI                                                                                           |
| 13  | Coverage dashboard                      | Complete — Renders live evidence; verified against a running API and against a killed one                                                                                    |
| 14  | Asset detail and timeline               | Partial — Detail page with canonicality, multiplier epoch, provenance, readiness summary. The event timeline needs a journal endpoint                                        |
| 15  | Preflight Lab and testnet execution     | Absent — Blocked on a testnet deployment                                                                                                                                     |
| 16  | Incident replay and review console      | Absent — API route exists; the console view does not                                                                                                                         |
| 17  | AI incident explainer                   | Absent — Optional. Correctly deferred until the deterministic product is complete                                                                                            |
| 18  | Integrator SDK and CLI                  | Complete — Typed client, local verifier pinned to the shared golden vectors, guard CLI with meaningful exit codes                                                            |
| 19  | Observability and fault injection       | Partial — Redaction, structured logging, bounded-cardinality metrics. Fault-injection harness absent                                                                         |
| 20  | Security hardening and threat model     | Complete — Threat model with per-row test references and recorded residual risks                                                                                             |
| 21  | CI, containers, deployment              | Partial — Six-job CI enforcing every gate. Containers and deployment manifests absent                                                                                        |
| 22  | End-to-end proof and submission package | Absent — Blocked on a testnet deployment                                                                                                                                     |
| 23  | Final independent audit                 | Complete — docs/final-audit.md. Verdict BLOCKED                                                                                                                              |

## Answers to the ten audit questions

1. **Can any path authorize when evidence is missing, stale, mismatched, or unknown?**
   Not in the code that exists. Proven by property test and by 23/23 mutation kills. Three
   real bugs of exactly this shape were found _during_ the build and fixed with regression
   tests.
2. **Can a receipt be changed, replayed, cross-used, or double-consumed?** No. Every bound
   field is mutation-tested in both languages; consumption is single-winner on chain and in
   the database.
3. **Can arbitrary calls bypass the adapter inside a protected path?** No — target
   allowlist, and the vault refuses any caller but the adapter. Outside a protected path,
   yes, and that is asserted as a test.
4. **Can disagreement be hidden by cache, projection, or UI copy?** Not by design: the
   journal is authoritative, projections are a reproducible fold, and the shell renders
   unknown health as unknown. **Unverifiable in the UI, because the UI does not exist yet.**
5. **Can a reorg or override leave a stale receipt usable?** No. The nonce advances at
   schedule time and the adapter re-reads it on every execution.
6. **Can a secret reach source, logs, bundles, or error responses?** Not through any path
   tested. Both scanners were verified against planted material rather than trusted.
7. **Can journal or projection divergence rewrite history?** No. Trigger-enforced
   append-only, and rebuild equality is asserted.
8. **Does every displayed live claim have provenance?** In the data layer, yes. **Not
   assessable at the display layer, which does not exist.**
9. **Does the product work at 390/768/1280/1440, keyboard-only, 200% zoom, API-down?**
   The shell and primitives are built for it and contrast is machine-verified, but with no
   feature pages there is nothing substantive to test. **NOT PROVEN.**
10. **Do README, UI, and docs stay inside the boundary?** Yes. The README leads with the
    limitation, the footer repeats it, the contract NatSpec states what it cannot verify,
    and the bypass is a passing test.

## Blocking items

1. No testnet deployment, so scenarios B–H of the proof package cannot be executed.
2. No Preflight Lab, so the on-chain rejection path has no operator-facing demonstration.
3. Event rules unpublished, capping the verdict independently.

## What would change the verdict

A funded chain-1952 broadcaster and an RPC URL would allow deployment and the real
failure-proof transactions. That is the single highest-value next step: every remaining
"NOT PROVEN" on the safety path depends on it, and the contracts and receipts are already
built and tested to support it.
