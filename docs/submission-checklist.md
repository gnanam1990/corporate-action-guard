# Submission checklist

Every row is **VERIFIED**, **NOT PROVEN**, or **UNKNOWN**. Nothing is marked verified without
a named artifact.

## Technical

| Requirement                    | Status               | Evidence                                              |
| ------------------------------ | -------------------- | ----------------------------------------------------- |
| Public repository              | **VERIFIED**         | github.com/gnanam1990/corporate-action-guard          |
| Builds from a clean clone      | **VERIFIED**         | CI installs from the lockfile on every PR             |
| Automated tests                | **VERIFIED**         | 538 unit, 92 integration, 66 Solidity                 |
| CI green                       | **VERIFIED**         | 7 required jobs on `main`                             |
| Uses live X Layer              | **VERIFIED**         | 11 read-only mainnet tests, chain 196                 |
| Uses the live xStocks API      | **VERIFIED**         | 4 live contract tests, `api.xstocks.fi/api/v2`        |
| Smart contracts                | **VERIFIED (built)** | 66 Foundry tests incl. fuzz and invariants            |
| **Current contracts deployed** | **VERIFIED**         | v2 artifact, X Layer testnet block 40163577           |
| **Current on-chain evidence**  | **VERIFIED**         | 8/8 proofs plus signed API-to-vault transaction       |
| Deployed public URL            | **NOT PROVEN**       | No hosting target configured                          |
| Demo video                     | **NOT PROVEN**       | Current script and evidence exist; video not recorded |
| Architecture documentation     | **VERIFIED**         | `docs/architecture/`, ADRs 0001–0004                  |
| Threat model                   | **VERIFIED**         | `docs/threat-model.md`                                |
| Integration guide              | **VERIFIED**         | `docs/integration-guide.md`                           |

## Eligibility — genuinely unknown

| Question                                | Status                                     |
| --------------------------------------- | ------------------------------------------ |
| Exact application deadline and timezone | **VERIFIED** — 11 September 2026 23:59 UTC |
| Project submission date                 | **VERIFIED** — 25 September 2026           |
| Is pre-window implementation permitted? | **UNKNOWN** — current rules do not say     |
| Selected-team technical requirements    | **UNKNOWN** — sent only to selected teams  |

**Pre-window risk:** this repository was built before 17 September 2026. If OKX requires all
implementation inside the window, this counts as preparation only and the submission must say
so. Every commit carries its authored date, so the record is auditable either way.

## Claims that must NOT be made

| Claim                              | Why it is false                                                        |
| ---------------------------------- | ---------------------------------------------------------------------- |
| "Audited"                          | No external party has reviewed this                                    |
| "Production ready"                 | Production KMS, hosted operations, and an independent audit are absent |
| "Protects X Layer"                 | Protects integrations that route through the adapter                   |
| "Prevents corporate action losses" | Prevents _authorizing_ an action on stale state, for opted-in paths    |
| Any traction or partnership        | There is none                                                          |

## Before submitting

1. Record the three-to-five-minute demo from `docs/demo-script.md`.
2. Re-run the live probes immediately before recording if source timestamps are stale.
3. Keep testnet claims separate from production-readiness claims in every answer.
4. Check for selected-team requirements delivered after application approval.

## Initial builder application

The live application requires team/contact details and two short narrative answers. A
truthful, copy-ready draft is maintained in `docs/application-draft.md`. The primary track
is **X Layer: Tokenized stocks and RWA**.
