# X Layer integration

**Live verification date: 2026-09-03 (UTC)**, against `https://rpc.xlayer.tech`.
Every ABI element and every limit below was confirmed by a real call, not assumed.

## Networks

|              | Mainnet                                                | Testnet                             |
| ------------ | ------------------------------------------------------ | ----------------------------------- |
| Chain ID     | **196** (`0xc4`, verified)                             | **1952**                            |
| Public RPC   | `https://rpc.xlayer.tech`, `https://xlayerrpc.okx.com` | `https://testrpc.xlayer.tech`       |
| Explorer     | https://www.oklink.com/x-layer                         | https://www.oklink.com/x-layer-test |
| This product | **read only**                                          | read + the single write path        |

`https://rpc.ankr.com/xlayer` requires an API key and returns 403 without one.

**Mainnet is read-only by construction, not by policy.** `XLayerReader` has no signing
method and never attaches an account, so a mainnet write is not expressible with the
object. `contracts/foundry.toml` lists no mainnet RPC endpoint, and deploy scripts refuse
chain 196.

Every configured RPC is checked with `eth_chainId` before use. A URL pointing at the wrong
chain would otherwise return perfectly well-formed answers about the wrong world.

## The verified ABI — and the one thing everyone gets wrong

**The multiplier surface lives on the TOKEN, not the wrapper.**

Probing the AAPLx wrapper `0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f`:

```text
asset()                          -> 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a   OK
name()                           -> "Wrapped Apple xStock"                       OK
convertToAssets(1e18)            -> 1003269012539818700                          OK
convertToShares(1e18)            ->  996741639082878624                          OK
getCurrentMultiplier()           -> execution reverted                           NOT PRESENT
newMultiplierNonce()             -> execution reverted                           NOT PRESENT
newMultiplierActivationTime()    -> execution reverted                           NOT PRESENT
```

Probing the AAPLx token `0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a`:

```text
getCurrentMultiplier()           -> 1003269012539818700   (1.0032690125398187 at 18dp)
multiplier()                     -> 1003269012539818700
newMultiplier()                  -> 1003269012539818700
newMultiplierNonce()             -> 5
newMultiplierActivationTime()    -> 0        (the "no schedule" sentinel)
decimals()                       -> 18
```

Two consequences:

1. Reading the multiplier from the wrapper reverts. Any implementation that assumes
   otherwise fails at runtime, not at compile time.
2. **The chain multiplier `1003269012539818700` at 18 decimals is exactly
   `1.0032690125398187` — the identical value the xStocks API reported for the same asset
   on the same day.** The two sources agreed exactly, which is the observation the whole
   product is built to check. It also validates the exact-decimal handling in
   `@cag/xstocks-client`: had the API value gone through a double, this comparison could
   not be made confidently.

The nonce exists on chain (`newMultiplierNonce() = 5`) and is absent from the API. That is
precisely the asymmetry [ADR 0004](../architecture/decisions/0004-source-agreement-field-policy.md)
records: the nonce is chain-authoritative.

## What could NOT be verified

No corporate action occurred inside the observable log window, so **no multiplier schedule,
override, or activation event could be confirmed**. Only two event topics appear in recent
logs:

| topic0             | Event                                     |
| ------------------ | ----------------------------------------- |
| `0xddf252ad…3b3ef` | `Transfer(address,address,uint256)`       |
| `0x9d9c9092…5dcb`  | `TransferShares(address,address,uint256)` |

The X Layer explorer does not serve a verified ABI without an API key.

**These capabilities are therefore declared unsupported on mainnet rather than guessed:**
`MULTIPLIER_SCHEDULED_EVENT`, `MULTIPLIER_OVERRIDDEN_EVENT`, `MULTIPLIER_EFFECTIVE_EVENT`.
Using one raises `UnsupportedCapabilityError`. A decoded value from an invented signature
looks authoritative and means nothing.

**This costs the safety path nothing.** `newMultiplierNonce()` and
`newMultiplierActivationTime()` are verified reads that give schedule state directly, and
polling them is authoritative. Events would make detection cheaper, not more correct. The
testnet fixture defines its own schedule and override events with signatures known from its
own source, so event-driven replay is still proven end to end.

## Measured limits — these dictate the indexer design

| Property                    | Measured value                                      |
| --------------------------- | --------------------------------------------------- |
| `eth_getLogs` max span      | **100 blocks**, hard server-side cap                |
| Error beyond it             | `-32602 block range greater than 100 max`           |
| Block time                  | **1.00 s/block** (100 blocks spanned exactly 100 s) |
| Coverage of one full window | ~1.7 minutes                                        |
| Calls to backfill one day   | ~864                                                |

A 1000-block request fails outright. `getLogsChunked` splits every request to respect the
cap; tests assert the chunks cover the requested range with no gap and no overlap, and that
no span exceeds 100.

This is not a tunable preference. Without splitting, **every historical query fails.**

## Confirmation and reorg policy

X Layer's finality characteristics are not documented in a form this build could verify.
The confirmation depth is therefore a **conservative configurable assumption**, default
**32 blocks** (~32 s at the measured block time), and every snapshot carries the depth that
produced its `settled` flag so the assumption is visible in the evidence rather than
implied.

| Term        | Meaning here                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `OBSERVED`  | Read at a recorded block number and hash. `latest` is never used without recording what it resolved to. |
| `CONFIRMED` | The block is at least `confirmationDepth` below the head. Reported as `settled`.                        |
| `REORGED`   | The hash now reported at a recorded height differs from the hash stored.                                |

On a reorg: retain the original observation, append `REORG_DETECTED`, rewind the cursor to
a safe block, re-read, append compensating evidence, rebuild affected projections. History
is never erased (see `docs/evidence-journal.md`).

## Snapshot completeness

Every read in a snapshot is pinned to **one** block, so a snapshot cannot mix a multiplier
from one height with a nonce from the next; a test asserts a single block tag across all
calls.

Individual read failures are recorded by name in `failedReads` rather than thrown. A
partial observation is still evidence — it just must never be mistaken for a complete one.
Only `complete === true` may support an ALLOW.

`eth_getCode == 0x` blocks canonical verification. An EOA, a typo, or a self-destructed
contract is not a contract.

## Recovery procedure

| Symptom            | Action                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `WRONG_CHAIN`      | The RPC URL points elsewhere. Fix configuration; do not override the check.                                                                  |
| `RPC_UNAVAILABLE`  | Source health degrades, preflight fails closed with `RPC_UNAVAILABLE`. Failover is read-only and records which provider answered.            |
| `-32602` on logs   | The range cap changed. Lower `maxLogRangeBlocks`; re-measure and update this document.                                                       |
| Reorg detected     | Cursor rewinds automatically. Verify projections rebuilt; see `docs/runbooks/reorg.md`.                                                      |
| Indexer far behind | At 100 blocks/call and 1 s blocks the indexer needs ≥1 call/100 s just to keep up. Check provider rate limits before increasing concurrency. |

## Running the live smoke test

```bash
XLAYER_LIVE_SMOKE_TEST=1 pnpm test:integration
```

Read-only; performs no signing and submits no transaction. Last run 2026-09-03:
**11 passed**.
