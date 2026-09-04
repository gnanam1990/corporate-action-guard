# Demo script — 3 to 5 minutes

Centred on **failure evidence**, not a feature tour. Nobody needs to watch a form being
filled in; they need to see the thing refuse.

## 0:00 — 0:20 · The problem

> "A tokenized equity goes through a split. The on-chain multiplier changes at a scheduled
> activation time. An integration that formed its assumptions ten seconds earlier is now
> acting on stale state — and the transaction carrying that wrong balance still settles."

One sentence on who this is for: wallet, exchange, vault, and lending integration teams.

## 0:20 — 0:50 · This is live, not a mock

Run the worker on camera:

```
live xStocks API : 726 assets across 8 pages
observed on chain: 6 | canonical: 6 | sources agreed: 6
```

Then the asset detail comparison matrix, which is the whole design in one table:

| field                 | API          | chain                  |                                  |
| --------------------- | ------------ | ---------------------- | -------------------------------- |
| `multiplier`          | `1`          | `1.000000000000000000` | MATCH — cross-scale, exact       |
| `multiplierNonce`     | not supplied | `0`                    | chain-authoritative, not scored  |
| `scheduledActivation` | none         | none                   | MATCH — both-absent is agreement |

Say plainly: the API publishes no nonce. Requiring agreement on it would block every action
forever, so it is checked against the caller's operation and re-verified on chain instead.

## 0:50 — 1:35 · The binding

```
$ guard preflight check --asset-id AXTIx ...
ALLOW
  receipt  0x2c854591…
  digest   0xe917144c…
```

Then change one field and verify locally:

```
$ guard receipt verify --file tampered.json
INVALID — DIGEST_MISMATCH
  a field changed after preflight. Submitting this would revert on chain.
```

The point: caught **before gas**, and the on-chain adapter would have caught it too.

## 1:35 — 2:35 · The refusals

Four, in sequence, each with its reason code visible:

1. **Stale evidence** — age the observation, `STALE_API_EVIDENCE`. Re-observe, `ALLOW` returns.
2. **Corporate action** — a scheduled multiplier advances the nonce, `MULTIPLIER_NONCE_MISMATCH`.
3. **Guard window** — `ACTIVATION_WINDOW`, no receipt issued at all.
4. **Source outage** — `FAULTS=XSTOCKS_TIMEOUT`, `SOURCE_DEGRADED`, console banner.

## 2:35 — 3:20 · On-chain rejection

> **NOT CURRENTLY RECORDABLE.** `docs/evidence/release-candidate.md` contains real v1
> transactions, but the safety-fixed contracts are implementation v2. Redeploy and rerun
> `pnpm testnet:prove` before recording this segment.

With a current v2 deployment: a valid receipt succeeds once, the replay reverts with
`ReceiptAlreadyConsumed`, and a scheduled corporate action kills an outstanding receipt with
`MultiplierNonceMismatch` — each with an explorer link.

## 3:20 — 3:50 · Truthfulness under failure

Kill the API on camera. The console says _"Source health unknown… treat everything as
unverified"_ and shows **no metric values** — not zeros.

> "Zero and unknown are different answers. A console that looks fine when it cannot reach its
> own API is the worst possible failure for a product whose entire claim is about not trusting
> stale state."

## 3:50 — 4:10 · The honest boundary

Do not skip this. It is the most credible thing in the demo.

- Enforceable **only** for paths routing through `ActionGuardAdapter`. A direct ERC-20
  transfer bypasses it — and that is a **passing test** in the repository, not a footnote.
- X Layer mainnet is **read-only**. No signing path for chain 196 exists.
- The signer can assert off-chain agreement the adapter cannot verify. Production keeps the
  private key in AWS KMS, but least-privilege IAM, audit logs, and rotation remain critical.

## What must never be said

- "Audited." Nobody has audited this.
- "Production ready." The self-audit verdict is BLOCKED.
- "Protects X Layer." It protects integrations that opt in.
- Any traction, user, or partnership claim.
