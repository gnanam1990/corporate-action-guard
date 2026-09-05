# Runbook — testnet deployment and failure proofs

Implementation v2 is deployed and proven on X Layer testnet. This runbook makes that proof
reproducible with isolated testnet-only identities.

Four commands, one of which needs a human.

## 0. What you are creating

Two **throwaway** keypairs for X Layer testnet (chain 1952) proof only. They are written to
`.env`, which is gitignored and mode `600`, and are never printed to a terminal or a log.
This local proof signer is not the production AWS KMS signer; production startup rejects
the local-key mode.

The deployer and the receipt signer are **deliberately separate identities**, so
compromising the one that broadcasts does not grant the one that authorizes. `testnet:status`
fails if they are ever the same key.

Never reuse these keys anywhere. Never fund them with anything real.

## 1. Create isolated proof identities

```bash
pnpm testnet:init
```

This creates or updates the gitignored `.env` with mode `600`. It generates separate
deployer and receipt-signer identities plus fixture-admin and integrator API credential
pairs, preserves valid existing values, rotates malformed generated values, and never prints
secret material. It is safe to run again.

## 2. Check what is missing

```bash
pnpm testnet:status
```

```text
ok   deployer key                   configured, address 0x7668...591C
ok   receipt signer key             configured
ok   signer address matches key     configured address 0x7099...79C8
ok   signer is a separate identity  deployer and signer are distinct
ok   testnet RPC                    https://testrpc.xlayer.tech serves chain 1952
FAIL deployer funded                0 OKB (need about 0.0002)
FAIL deployment artifact            existing artifact is obsolete; redeploy v2
```

It tells you exactly which of the four preconditions is missing, because "it didn't work" is
useless when a funded deployer, a reachable RPC, the right chain, and an artifact all have
to line up.

## 3. Fund the deployer — the only manual step

Paste the deployer address from step 1 into the X Layer testnet faucet:

> **https://www.okx.com/xlayer/faucet** — select **X Layer Testnet**

Deployment costs about **0.00012 OKB** at the measured testnet gas price of ~0.02 gwei. One
faucet drip is far more than enough.

Re-run `pnpm testnet:status` until `deployer funded` reports `ok`.

## 4. Deploy

```bash
pnpm testnet:deploy
```

The wrapper refuses to run unless every precondition holds. The Solidity script then applies
its own guards independently:

1. Rejects chain **196** explicitly, then rejects any chain that is not **1952**.
2. Reads the broadcaster from the environment — **no private key exists in source**.
3. Prints every planned address and the chain before broadcasting.
4. Verifies bytecode exists at each address **after** broadcast. A transaction receipt is
   not proof a contract exists.
5. Writes `contracts/deployments/xlayer-testnet.json` only once all of that passed.

Addresses are then copied into `.env` **from the artifact**, never typed by hand — a typo in
a contract address is a silent, total failure.

## 5. Prove the failures

```bash
pnpm testnet:prove
```

Eight scenarios, each a real transaction or a simulated call against a real chain:

| #   | Scenario                                   | Expected                                     |
| --- | ------------------------------------------ | -------------------------------------------- |
| B   | A valid receipt is accepted, then replayed | succeeds once, then `ReceiptAlreadyConsumed` |
| C1  | Recipient changed after issuance           | reverts                                      |
| C2  | Amount changed after issuance              | reverts                                      |
| D   | Receipt expired                            | `ReceiptExpired`                             |
| E   | A corporate action is scheduled            | `MultiplierNonceMismatch`                    |
| F   | Inside the guard window                    | `InsideGuardWindow`                          |
| G   | Unauthorized signer                        | `UnauthorizedSigner`                         |
| H   | Direct ERC-20 transfer                     | **succeeds** — the documented bypass         |

**A scenario that reverts for the wrong reason is recorded as a FAILURE, not a pass.** Each
expected revert names the custom error it must produce, so a guard that refuses for an
unrelated reason cannot masquerade as working.

Scenario H is included deliberately because it must **succeed**. A direct transfer bypasses
the guard, and the product's honesty depends on demonstrating that rather than glossing over
it.

Evidence is written to `docs/evidence/release-candidate.md` with transaction hashes and
explorer links.

## 6. Prove independent same-chain evidence

Commit a future fixture schedule and record the administrator's intended values locally:

```bash
pnpm fixture:intent:prepare
```

Then start the migrated API and worker with the deployed addresses, provision the dedicated
`FIXTURE_API_KEY_HASH`, and publish the signed intended fixture state with:

```bash
pnpm fixture:evidence:publish
```

Wait for the worker to observe a confirmation-safe block and verify the asset projection
reports `sourceAgreement=MATCH`, `canonicality=PASS`, and fresh API/chain timestamps. The
publisher values are signed intent; do not auto-copy the worker's RPC result into them.

## 7. Update the audit

Once the proofs pass, update `docs/modules.json` with the current evidence, then:

```bash
pnpm docs:readiness
```

`docs/final-audit.md` may move only the demonstrated testnet rows to PROVEN, citing the
regenerated evidence file and signed fixture event ids. Production KMS provisioning, hosted
operations, and the independent audit remain separate gates.

## 8. Prove the whole signed path

With the API and worker running from the same `.env`, refresh fixture evidence and execute:

```bash
pnpm fixture:evidence:publish
pnpm demo:testnet
```

The second command authenticates with the local integrator credential, requires an ALLOW
from fresh evidence, encodes the returned receipt with the SDK, and broadcasts the exact
zero-value adapter call on chain 1952. Public evidence is written to
`docs/evidence/end-to-end-preflight.md`; secrets and the receipt signature are omitted.

## If something goes wrong

| Symptom                                           | Cause                                                            | Action                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `deployer funded` stays FAIL after a faucet drip  | Faucets can take a minute, or rate-limit per address per day     | Re-run status; check the address on the explorer                   |
| Deploy reverts with `WrongChain`                  | The RPC URL points elsewhere                                     | Fix `XLAYER_TESTNET_RPC_URL`; do not override the check            |
| `NoBytecodeAfterDeploy`                           | A transaction was mined but deployed nothing                     | Do not write an artifact by hand; re-deploy                        |
| A proof scenario reverts with an unexpected error | The guard refused for a different reason than the scenario tests | Read the recorded error name — this is a real finding, not a flake |
| Scenario H fails                                  | A direct transfer was blocked                                    | The bypass claim in the README and threat model needs re-checking  |

## What this still does not prove

- Compatibility with production xStocks **scheduling** semantics. The deployed contracts are
  a `TESTNET FIXTURE` reproducing the verified _read_ surface only.
- Anything about X Layer mainnet, which this build never writes to.
- That the off-chain signer is trustworthy. The adapter verifies chain facts itself but
  cannot verify the xStocks API agreed at issuance (ADR 0002).
