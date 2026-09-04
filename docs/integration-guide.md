# Integration guide

## What you get, and what you do not

You get a **refusal**. The guard answers ALLOW or BLOCK for one exact operation, and an
ALLOW carries a short-lived EIP-712 receipt bound to that operation. An on-chain adapter
re-verifies every bound field before funds move.

You do **not** get universal protection. Read the boundary section before you build on this.

## The 15-minute path

### 1. Install

```bash
pnpm add @cag/sdk
```

### 2. Check your wiring

```bash
export GUARD_API_URL=https://your-guard-host
export GUARD_API_KEY=cag_xxxxxxxx_...      # never as a CLI argument; see below
npx guard doctor
```

`doctor` distinguishes **reachable** from **ready**, because they are different diagnoses:

```text
ok   GUARD_API_URL                https://your-guard-host
ok   GUARD_API_KEY                set
ok   api reachable                responding
FAIL api ready                    a dependency is unhealthy (see below)
ok   dependency: database         reachable
FAIL dependency: receipt-signer   no signing key configured
```

An API that is answering perfectly well but has an unhealthy dependency is not "unreachable",
and reporting it that way sends you to look at the network instead of the signer.

### 3. Preflight before you submit

```ts
import { GuardClient, verifyReceiptLocally } from '@cag/sdk';

const guard = new GuardClient({
  baseUrl: process.env.GUARD_API_URL!,
  apiKey: process.env.GUARD_API_KEY!,
});

const operation = {
  chainId: 1952,
  assetId: 'AAPLx',
  target: vaultAddress,
  asset: tokenAddress,
  wrapper: wrapperAddress,
  actionType: 'DEPOSIT' as const,
  caller: userAddress,
  recipient: userAddress,
  amount: 1_000_000_000_000_000_000n, // base units, bigint
  expectedMultiplierNonce: currentNonce, // bigint
};

// Supply your OWN idempotency key if you might retry. The generated default is unique per
// call, which makes a retry a NEW request — correct for a fresh intent, wrong for a
// resubmission.
const decision = await guard.preflight(operation, { idempotencyKey: yourRequestId });

if (decision.decision === 'BLOCK') {
  for (const { code, explanation } of decision.reasonExplanations) {
    console.error(`${code}: ${explanation}`);
  }
  return;
}
```

### 4. Verify locally before you spend gas

```ts
const check = await verifyReceiptLocally({
  receipt: decision.receipt,
  operation, // YOUR fields, not the server's echo
  operationDigest: decision.operationDigest,
  expectedSigners: [knownSignerAddress],
  nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
});

if (!check.ok) throw new Error(`${check.code}: ${check.reason}`);
```

This re-derives the digest from _your_ fields. If anything changed between preflight and
submission, you get a local `DIGEST_MISMATCH` instead of a reverted transaction and a wasted
fee. The SDK's encoder is proven identical to the server's by a cross-package test over
every action type and edge amount.

### 5. Submit through the adapter

Call `ActionGuardAdapter.execute(receipt, signature)` from the `caller` address named in the
receipt. Any other sender is rejected with `CallerMismatch`.

## ALLOW is not a guarantee

**ALLOW authorizes a submission. It does not guarantee the transaction succeeds.**

The adapter independently re-verifies, at execution time: the multiplier nonce,
`wrapper.asset()`, the guard window, the receipt's validity bounds, and whether the receipt
has already been consumed. Any of these can change between issuance and submission — that
is the entire point of the product. A corporate action scheduled in the intervening seconds
advances the nonce and your receipt stops working, which is the guard doing its job.

Budget for a revert. Do not treat ALLOW as a completed operation.

## Exit codes

| Code | Meaning                                |
| ---: | -------------------------------------- |
|  `0` | ALLOW                                  |
| `10` | BLOCK, with reason codes               |
| `20` | The guard was unreachable or unhealthy |
| `30` | Invalid input                          |
| `40` | Internal failure                       |

ALLOW and BLOCK are **both successful evaluations**, and deliberately distinct from an
error. A script that treats a BLOCK as a retryable failure will hammer the API; a script
that treats it as success will proceed with an operation the guard refused.

## Retry semantics

- **Reads** (`listAssets`, `getAsset`, `health`) retry automatically with bounded backoff.
- **Preflight never retries automatically.** Supply a stable idempotency key. The server
  atomically stores the exact response with the receipt event, so a same-body retry returns
  that response and cannot mint a second receipt. Reusing the key for another body is `409`.

## API keys

**Never pass a key as a command-line argument.** It lands in your shell history and is
visible in `ps` output to every user on the machine. The CLI reads `GUARD_API_KEY` from the
environment and never prints it — `guard doctor` reports only that it is set.

Server-side, keys are stored as SHA-256 hashes, looked up by a short public prefix, and
compared in constant time. Every authentication failure returns an identical body, so
probing cannot reveal whether a key id exists.

Production rejects `DEV_API_KEYS`. Bootstrap hashes can be supplied with
`INTEGRATOR_API_KEY_HASH` (key id `integ001`) and `OPERATOR_API_KEY_HASH` (key id
`operator`); additional keys can be provisioned in the `api_keys` table. Only hashes are
persisted.

## Threat assumptions you are inheriting

Be explicit with yourself about these before depending on the guard:

1. **The adapter is optional, and therefore bypassable.** A holder can transfer the ERC-20
   directly and never touch it. The guard protects paths that route through it, and nothing
   else. This is asserted as a passing test in the repository, not merely documented.
2. **The signer can assert off-chain agreement the adapter cannot verify.** The adapter
   checks chain facts itself, but it cannot check that the xStocks API agreed at issuance.
   A compromised signer could claim agreement that never happened. Mitigated by short
   lifetimes, exact binding, single consumption, and an authorized-signer allowlist — not
   eliminated. See ADR 0002.
3. **X Layer mainnet is read-only in this build.** Enforcement runs on testnet (1952)
   against a labelled fixture. Production scheduling compatibility is **not** proven.
4. **`block.timestamp` is proposer-influenced.** The guard window is a margin measured in
   minutes, far wider than any plausible manipulation — not a precise instant.

## Testnet limitations

The testnet contracts are a `TESTNET FIXTURE`. They reproduce the verified _read_ surface
of the production xStocks token, so the same reader and adapter work against both. They do
**not** prove that production scheduling behaves identically, because that behaviour is not
published in a form this build could verify.

The checked-in deployment is implementation v1 and is intentionally refused by current
v2 clients. Do not submit transactions until `pnpm testnet:deploy` and
`pnpm testnet:prove` have produced a verified v2 artifact and fresh evidence.

## Removal and rollback

The guard is additive. To remove it:

1. Stop calling `preflight`.
2. Route protected actions directly at your target contract instead of through
   `ActionGuardAdapter`.
3. Revoke your API key.

No migration, no state to unwind, no data held on your behalf. That is deliberate: an
integration you cannot cleanly remove is one you cannot safely trial.
