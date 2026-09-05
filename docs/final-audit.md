# Internal release audit

**Review basis:** implementation v2 deployed from source equivalent to `2287207e3b02f697bd5356b72d3ad2d8e8a165bd`, plus the current application-readiness changes
**Date:** 2026-09-05
**Reviewer:** implementing team. This is **not** an independent security audit.

## Verdict

## **APPLICATION-READY PROTOTYPE; NOT PRODUCTION-READY**

The core fail-closed design is implemented, passes the repository's deterministic checks,
and is deployed as implementation v2 on X Layer testnet. Eight adversarial scenarios passed
against the real chain, and a separate proof traversed authenticated preflight, fresh signed
same-chain evidence, EIP-712 issuance, SDK encoding, adapter verification, and the protected
vault.

That is enough for a truthful hackathon application and live testnet demo. Production
readiness remains blocked on production AWS KMS/IAM, hosted monitoring/retention and alert
delivery, operating history, verified production scheduling semantics, and an independent
security audit.

## Current evidence

| Claim                                                                                                             | Status                  | Evidence                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Missing, stale, mismatched, unknown, cross-chain, unsupported-target, or unsupported-action evidence cannot ALLOW | **PROVEN locally**      | Unit/property tests and 27/27 safety-predicate mutation kills                                            |
| A retry with the same actor, key, and body returns the exact response without minting another receipt             | **PROVEN locally**      | PostgreSQL-backed HTTP integration test; command result and journal event commit atomically              |
| Reusing an idempotency key for another body is rejected                                                           | **PROVEN locally**      | HTTP integration test returns conflict                                                                   |
| Production authentication stores hashes and durable scopes, not raw keys                                          | **PROVEN locally**      | `api_keys` constraints and database integration tests; production rejects `DEV_API_KEYS`                 |
| Operator identity comes from authentication rather than the request body                                          | **PROVEN locally**      | Strict schema and journal assertion in HTTP integration tests                                            |
| Scheduled actions remain blocked after the nominal guard window until applied                                     | **PROVEN locally**      | Domain regression, mutation kill, and Solidity regression                                                |
| Adapter pause cannot trap an account's existing vault balance                                                     | **PROVEN locally**      | Direct owner-balance withdrawal regression in Foundry                                                    |
| Worker lease loss prevents a stale worker from committing                                                         | **PROVEN locally**      | Fencing assertion plus renewal/takeover integration tests                                                |
| Worker observations drive reconciliation, incidents, and recovery states                                          | **PROVEN locally**      | Reconciler and projection regressions; worker composition is wired                                       |
| The web app can encode and submit the exact ALLOW receipt                                                         | **PROVEN**              | Production TypeScript build, SDK calldata test, embedded v2 artifact, and API-to-vault execution proof   |
| The current v2 adapter works on X Layer testnet                                                                   | **PROVEN**              | Deployment block 40163577 and 8/8 current scenario evidence in `docs/evidence/release-candidate.md`      |
| Live chain-196 evidence authorizes testnet execution                                                              | **INTENTIONALLY FALSE** | Evidence-chain binding returns `EVIDENCE_CHAIN_MISMATCH`; mainnet is monitoring-only                     |
| Receipt consumption and reorg recovery update projections from finalized adapter logs                             | **PROVEN locally**      | Database-backed index, rewind, compensation, and full-rebuild regression                                 |
| Production mode keeps a raw receipt key out of the process                                                        | **PROVEN locally**      | Production config rejects local keys; AWS KMS DER recovery and active public-key/address readiness tests |
| A database backup can be parsed and restored into a disposable database                                           | **PROVEN locally**      | Checksummed custom archive and schema/journal restore drill; repeated in CI                              |
| Signed chain-1952 intent is independently compared with finalized chain state                                     | **PROVEN locally**      | Dedicated scope, EIP-191 verification, append-only source time, match/mismatch/partial worker tests      |
| An authenticated API ALLOW executes the protected operation on X Layer testnet                                    | **PROVEN**              | `docs/evidence/end-to-end-preflight.md`, transaction mined successfully in block 40164673                |
| The system is production ready or externally audited                                                              | **NOT PROVEN**          | No external audit, public deployment, deployed alerting/retention, or operating history                  |

## Evidence boundary

`docs/evidence/release-candidate.md` is current implementation-v2 chain-1952 evidence.
`docs/evidence/end-to-end-preflight.md` covers the off-chain-to-on-chain happy path. Both use
a labelled testnet fixture and do not establish production xStocks scheduling compatibility.

## Residual risks and missing work

1. Provision the documented AWS KMS key/IAM policy, authorize its derived address on the
   adapter, and exercise the two-step rotation procedure.
2. Deploy WAL/object-store retention, the supplied Prometheus alerts, and a public service;
   schedule recurring restore drills rather than relying only on CI.
3. Verify production xStocks scheduling semantics when an authoritative interface is
   published; do not infer it from the testnet fixture.
4. Obtain an independent smart-contract and service security audit.

## Claims that remain forbidden

- “Audited” or “production ready.”
- “The current version is deployed to production.” The current deployment is testnet only.
- “Protects X Layer.” It protects only integrations that route through the adapter; direct
  token transfers and the explicitly documented vault escape path bypass guarded entry.
- “Production xStocks scheduling compatibility.” Only the read surface was verified.
