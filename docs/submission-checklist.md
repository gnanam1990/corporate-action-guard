# Submission checklist

Every row is **VERIFIED**, **NOT PROVEN**, or **UNKNOWN**. Nothing is marked verified without
a named artifact.

## Technical

| Requirement                       | Status               | Evidence                                       |
| --------------------------------- | -------------------- | ---------------------------------------------- |
| Public repository                 | **VERIFIED**         | github.com/gnanam1990/corporate-action-guard   |
| Builds from a clean clone         | **VERIFIED**         | CI installs from the lockfile on every PR      |
| Automated tests                   | **VERIFIED**         | 502 unit, 69 integration, 65 Solidity          |
| CI green                          | **VERIFIED**         | 7 required jobs on `main`                      |
| Uses live X Layer                 | **VERIFIED**         | 11 read-only mainnet tests, chain 196          |
| Uses the live xStocks API         | **VERIFIED**         | 4 live contract tests, `api.xstocks.fi/api/v2` |
| Smart contracts                   | **VERIFIED (built)** | 65 Foundry tests incl. fuzz and invariants     |
| **Contracts deployed**            | **NOT PROVEN**       | No artifact in `contracts/deployments/`        |
| **On-chain transaction evidence** | **NOT PROVEN**       | Requires a funded chain-1952 broadcaster       |
| Deployed public URL               | **NOT PROVEN**       | No hosting target configured                   |
| Demo video                        | **NOT PROVEN**       | Script exists; segment 2:35 needs a deployment |
| Architecture documentation        | **VERIFIED**         | `docs/architecture/`, ADRs 0001–0004           |
| Threat model                      | **VERIFIED**         | `docs/threat-model.md`                         |
| Integration guide                 | **VERIFIED**         | `docs/integration-guide.md`                    |

## Eligibility — genuinely unknown

| Question                                | Status                                      |
| --------------------------------------- | ------------------------------------------- |
| Exact submission deadline and timezone  | **UNKNOWN** — not published when researched |
| Is pre-window implementation permitted? | **UNKNOWN**                                 |
| Selected-team technical requirements    | **UNKNOWN** — not yet published             |

**Pre-window risk:** this repository was built before 17 September 2026. If OKX requires all
implementation inside the window, this counts as preparation only and the submission must say
so. Every commit carries its authored date, so the record is auditable either way.

## Claims that must NOT be made

| Claim                              | Why it is false                                                     |
| ---------------------------------- | ------------------------------------------------------------------- |
| "Audited"                          | No external party has reviewed this                                 |
| "Production ready"                 | Self-audit verdict is BLOCKED                                       |
| "Protects X Layer"                 | Protects integrations that route through the adapter                |
| "Prevents corporate action losses" | Prevents _authorizing_ an action on stale state, for opted-in paths |
| Any traction or partnership        | There is none                                                       |

## Before submitting

1. Deploy to testnet and run `pnpm testnet:prove`.
2. Regenerate `docs/evidence/release-candidate.md` and confirm every scenario passed.
3. Re-run the live probes and update the verification date in the integration docs.
4. Re-read `docs/final-audit.md`. If the verdict is still BLOCKED, say so in the submission.
5. Verify the deadline and the selected-team requirements when OKX publishes them.
