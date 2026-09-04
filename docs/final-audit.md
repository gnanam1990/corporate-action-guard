# Internal release audit

**Review basis:** working tree based on `1d265d25c0e4ee7e6dbad7f37b89842fbb7d358b`
**Date:** 2026-09-04
**Reviewer:** implementing team. This is **not** an independent security audit.

## Verdict

## **BLOCKED for deployment; locally verified**

The core fail-closed design is implemented and passes the repository's deterministic
checks. The current contracts are implementation v2, however, while the checked-in X Layer
testnet artifact and release-candidate transactions are implementation v1. The UI, status
check, deployment recorder, and proof runner deliberately reject that obsolete artifact.

Release readiness remains blocked until an explicitly authorized, funded v2 testnet
deployment is followed by a fresh proof run. Production readiness also requires an
independent audit, a deployed monitoring/retention environment, and operating history.

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
| The web app can encode and submit the exact ALLOW receipt                                                         | **PROVEN locally**      | Production TypeScript build and SDK calldata test; execution stays disabled for an obsolete deployment   |
| The current v2 adapter works on X Layer testnet                                                                   | **NOT PROVEN**          | No v2 deployment or v2 transaction evidence exists                                                       |
| Live chain-196 evidence authorizes testnet execution                                                              | **INTENTIONALLY FALSE** | Evidence-chain binding returns `EVIDENCE_CHAIN_MISMATCH`; mainnet is monitoring-only                     |
| Receipt consumption and reorg recovery update projections from finalized adapter logs                             | **PROVEN locally**      | Database-backed index, rewind, compensation, and full-rebuild regression                                 |
| Production mode keeps a raw receipt key out of the process                                                        | **PROVEN locally**      | Production config rejects local keys; AWS KMS DER recovery and active public-key/address readiness tests |
| A database backup can be parsed and restored into a disposable database                                           | **PROVEN locally**      | Checksummed custom archive and schema/journal restore drill; repeated in CI                              |
| Signed chain-1952 intent is independently compared with finalized chain state                                     | **PROVEN locally**      | Dedicated scope, EIP-191 verification, append-only source time, match/mismatch/partial worker tests      |
| The system is production ready or externally audited                                                              | **NOT PROVEN**          | No external audit, public deployment, deployed alerting/retention, or operating history                  |

## Historical evidence boundary

`docs/evidence/release-candidate.md` records real implementation-v1 chain-1952
transactions for eight scenarios. Those hashes remain authentic historical evidence, but
they do not prove the changed v2 contracts. They must not be presented as current release
evidence.

## Residual risks and missing work

1. Deploy implementation v2 to X Layer testnet and regenerate all on-chain failure proofs.
2. Run the signed same-chain fixture intent publisher and worker against that deployment;
   live mainnet evidence must remain unable to cross-authorize.
3. Provision the documented AWS KMS key/IAM policy, authorize its derived address on the
   adapter, and exercise the two-step rotation procedure.
4. Deploy WAL/object-store retention, the supplied Prometheus alerts, and a public service;
   schedule recurring restore drills rather than relying only on CI.
5. Obtain an independent smart-contract and service security audit.

## Claims that remain forbidden

- “Audited” or “production ready.”
- “The current version is deployed” until the artifact says implementation v2 and the
  proof runner succeeds against it.
- “Protects X Layer.” It protects only integrations that route through the adapter; direct
  token transfers and the explicitly documented vault escape path bypass guarded entry.
- “Production xStocks scheduling compatibility.” Only the read surface was verified.
