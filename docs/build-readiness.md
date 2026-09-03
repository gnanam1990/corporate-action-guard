# Build readiness

**Recorded at:** Module 03 completion, 2026-09-03.
**Repository state at this point:** monorepo foundation. Toolchain, workspace, database
migration ledger, health-only service skeletons, and the two secret-boundary checks exist.
No product behaviour, no deployments.

This table is the honest inventory. A module is `IMPLEMENTED` only when its code exists in
this repository and its own gates have been run. Being described in the prompt pack is not
evidence that anything exists.

## Status

| #   | Module                                  | Status          | Note                                                          |
| --- | --------------------------------------- | --------------- | ------------------------------------------------------------- |
| 00  | Architecture freeze                     | **IMPLEMENTED** | This document set                                             |
| 01  | Monorepo foundation                     | ABSENT          | Next                                                          |
| 02  | Domain, predicate, state machine        | ABSENT          | Proposed                                                      |
| 03  | Evidence journal and projections        | ABSENT          | Proposed                                                      |
| 04  | xStocks API client                      | ABSENT          | Proposed                                                      |
| 05  | X Layer reader and indexer              | ABSENT          | Proposed                                                      |
| 06  | Canonical asset/wrapper registry        | ABSENT          | Proposed                                                      |
| 07  | Reconciler and recovery                 | ABSENT          | Proposed                                                      |
| 08  | Operation digest and EIP-712 receipt    | ABSENT          | Proposed                                                      |
| 09  | Solidity TESTNET FIXTURE                | ABSENT          | Proposed                                                      |
| 10  | ActionGuardAdapter and ProtectedVault   | ABSENT          | Proposed                                                      |
| 11  | Fastify API and OpenAPI contract        | ABSENT          | Proposed                                                      |
| 12  | Web design system and shell             | ABSENT          | Proposed                                                      |
| 13  | Coverage dashboard                      | ABSENT          | Proposed                                                      |
| 14  | Asset detail and timeline               | ABSENT          | Proposed                                                      |
| 15  | Preflight Lab and testnet execution     | ABSENT          | Proposed                                                      |
| 16  | Incident replay and review console      | ABSENT          | Proposed                                                      |
| 17  | AI incident explainer                   | ABSENT          | Optional; deferred until the deterministic product is healthy |
| 18  | Integrator SDK and CLI                  | ABSENT          | Proposed                                                      |
| 19  | Observability and fault injection       | ABSENT          | Proposed                                                      |
| 20  | Security hardening                      | ABSENT          | Proposed                                                      |
| 21  | CI, containers, deployment              | ABSENT          | Proposed                                                      |
| 22  | End-to-end proof and submission package | ABSENT          | Proposed                                                      |
| 23  | Final independent audit                 | ABSENT          | Proposed                                                      |

## Blocked items

These cannot be completed from this environment as configured and are recorded as blocked
rather than quietly skipped.

| Item                                                    | Blocker                                                | Effect                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live xStocks API verification                           | Requires outbound network access and a dated live call | `docs/integrations/xstocks-api.md` cannot record a verified UTC verification date; schemas are written against the published OpenAPI contract and must be re-verified before release |
| Live X Layer mainnet smoke read                         | Requires a configured `XLAYER_MAINNET_RPC_URL`         | Opt-in live smoke tests stay skipped; deterministic mocked-transport tests still run                                                                                                 |
| Verified production xStocks ABI                         | Requires explorer/official-doc retrieval               | Only confirmed selectors are implemented; dependent features stop with a typed unsupported error rather than an invented signature                                                   |
| X Layer testnet deployment                              | Requires a funded chain-1952 broadcaster key           | Contracts are built and tested locally; no deployment artifact is written and no address is claimed                                                                                  |
| Real testnet failure-proof transactions (scenarios B–F) | Depends on the deployment above                        | Recorded as **NOT PROVEN** in release evidence until executed                                                                                                                        |
| Deployed environment URLs                               | No hosting target configured                           | No live URL may be claimed                                                                                                                                                           |

## Hackathon eligibility uncertainty

- The OKX Dev Day 2026 build window is stated as 17–25 September 2026. The exact
  submission clock time and timezone were not published on the event page when researched
  and must be verified before scheduling final work.
- Whether pre-window implementation is permitted is **UNKNOWN**. Work produced before the
  window opens must not be represented as hackathon-period work. Every commit carries its
  authored date, so the record is auditable either way.
- Selected-team technical requirements are not yet published and must be rechecked when
  OKX sends them.

**Pre-window implementation risk:** this repository is being built before 17 September 2026. If OKX requires that all implementation occur inside the window, this work counts as
preparation only and the submission must say so.
