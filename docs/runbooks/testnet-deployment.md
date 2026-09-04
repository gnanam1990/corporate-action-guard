# Runbook — testnet deployment and failure proofs

This is the main external step required to change the audit verdict. Implementation v1 ran
on a real chain, but the current safety-fixed contracts are implementation v2 and have not
been deployed or proven there.

Three commands, one of which needs a human.

## 0. What you are creating

Two **throwaway** keypairs for X Layer testnet (chain 1952) only. They are written to
`.env`, which is gitignored and mode `600`, and are never printed to a terminal or a log.

The deployer and the receipt signer are **deliberately separate identities**, so
compromising the one that broadcasts does not grant the one that authorizes. `testnet:status`
fails if they are ever the same key.

Never reuse these keys anywhere. Never fund them with anything real.

## 1. Check what is missing

```bash
pnpm testnet:status
```

```text
ok   deployer key                   configured, address 0x7668...591C
ok   receipt signer key             configured
ok   signer is a separate identity  deployer and signer are distinct
ok   testnet RPC                    https://testrpc.xlayer.tech serves chain 1952
FAIL deployer funded                0 OKB (need about 0.0002)
FAIL deployment artifact            existing artifact is obsolete; redeploy v2
```

It tells you exactly which of the four preconditions is missing, because "it didn't work" is
useless when a funded deployer, a reachable RPC, the right chain, and an artifact all have
to line up.

## 2. Fund the deployer — the only manual step

Paste the deployer address from step 1 into the X Layer testnet faucet:

> **https://www.okx.com/xlayer/faucet** — select **X Layer Testnet**

Deployment costs about **0.00012 OKB** at the measured testnet gas price of ~0.02 gwei. One
faucet drip is far more than enough.

Re-run `pnpm testnet:status` until `deployer funded` reports `ok`.

## 3. Deploy

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

## 4. Prove the failures

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

## 5. Update the audit

Once the proofs pass, edit `docs/modules.json` to move modules 15 and 22 from `PARTIAL` to
`IMPLEMENTED`, then:

```bash
pnpm docs:readiness
```

`docs/final-audit.md` should move only the v2 on-chain rows from NOT PROVEN to PROVEN,
citing the regenerated evidence file. The verdict can then be reconsidered; the missing
same-chain API fixture path, event indexer, signer hardening, and independent audit remain
separate gates.

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
