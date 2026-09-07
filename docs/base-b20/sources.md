# Base B20 source provenance

Every external fact this product depends on — an interface, an address, a decimals value, a
capability — is listed here with where it came from, when it was retrieved, and how to
re-check it. Nothing on this page was taken from a search snippet, a tweet, a third-party
SDK constant, or the research report. If a fact is not on this page, no production route may
depend on it.

The machine-readable form of this page is `provenance/base-b20/`. This page explains it; the
JSON is what the code and CI read.

## How to re-verify

```bash
node scripts/b20-provenance.mjs check     # re-read every source, diff, exit non-zero on drift
node scripts/b20-provenance.mjs capture   # re-read every source and rewrite the manifests
```

`check` never writes. `capture` writes but never commits. Promoting a changed address, a
changed code observation, or a changed capability is a human reading the diff and committing
it deliberately — see [ADR 0005](../architecture/decisions/0005-base-b20-extension.md).

If a source is unreachable, `check` prints `SKIPPED` with the reason and exits 0. A green
build that proved nothing is worse than a red one; saying so out loud is the difference.

## Sources

| Source                                                                                                                    | Publisher       | What it establishes                                                             | Retrieval                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`base/base-std`](https://github.com/base/base-std)                                                                       | Base (Coinbase) | B20 interfaces, events, errors, role and policy constants, precompile addresses | `git clone --depth 1`, pinned commit, per-file sha256                |
| [base.org/stocks](https://www.base.org/stocks)                                                                            | Base (Coinbase) | Which token contracts are officially issued tokenized stocks                    | HTTPS GET, addresses parsed from the labelled per-row BaseScan links |
| [Chainlink feed directory (Base mainnet)](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json) | Chainlink       | Coinbase equity feed proxy addresses, decimals, heartbeat, deviation threshold  | HTTPS GET of the machine-readable directory                          |
| Base mainnet RPC (chain 8453)                                                                                             | —               | That each address above actually behaves as claimed, at a recorded block        | `eth_call` / `eth_getCode` at a block 200 confirmations behind head  |

The upstream snapshot lives in `provenance/base-b20/base-std/`, with the exact commit,
commit date, per-file `upstreamPath`, and per-file sha256 in its `SOURCE.json`. Those files
are verbatim copies under the upstream MIT licence and must not be edited in place; refresh
them by re-cloning at a new commit and re-recording every hash.

## What the chain actually said

Recorded at Base mainnet block `50993686`, hash
`0xabf162b62c2a00469cf7e84b20c28749f5eaa926d5e3281cf7571a2d9c52425b`. Re-run the check to
observe a newer block; the numbers below are a snapshot, not a constant.

### Ten officially listed assets, all reads live

All ten addresses on the official list return `isB20Initialized() == true` from the B20
factory precompile at `0xb20f000000000000000000000000000000000000`, all report
`decimals() == 8`, and all report `multiplier() == 1e18` (no corporate action has moved any
of them yet).

| Display symbol | Address                                      | On-chain name                        |
| -------------- | -------------------------------------------- | ------------------------------------ |
| `TSLAc`        | `0xb2000000000000000000001e800a7f5189430cd0` | Tesla Inc.                           |
| `GOOGLc`       | `0xb2000000000000000000002d0ba3164cc74f58b7` | Alphabet Inc.                        |
| `SNDKc`        | `0xb200000000000000000000397293cb8cda9a10c5` | Sandisk Corporation                  |
| `MSTRc`        | `0xb2000000000000000000004884b426556b92883d` | Strategy Inc.                        |
| `NVDAc`        | `0xb20000000000000000000078ee7ce2fe4908108c` | NVIDIA Corporation                   |
| `SPCXc`        | `0xb2000000000000000000007b9fcbd005511acbd5` | Space Exploration Technologies Corp. |
| `METAc`        | `0xb2000000000000000000008bc8786b856e61707c` | Meta Platforms Inc.                  |
| `MSFTc`        | `0xb200000000000000000000ab99cfa739e253872b` | Microsoft Corporation                |
| `AAPLc`        | `0xb200000000000000000000c2e324d24d7eecd1fb` | Apple Inc.                           |
| `AMZNc`        | `0xb200000000000000000000d9192b6b456483c2e8` | Amazon.com Inc.                      |

`eth_getCode` on each of these returns one byte. That is expected: a B20 token is
precompile-backed, so bytecode length is not an identity signal and a code-hash comparison
proves nothing here. Identity is `(chainId, address)` confirmed against the official list
**and** the factory's `isB20Initialized`.

### The address prefix is not an issuer

Every listed asset begins `0xb2000000000000000000…`, and `IB20Factory.isB20` is documented
as recovering that answer "from the address prefix". A prefix is therefore a **format**
signal that anyone can imitate. `isB20Initialized` is stronger — it flips exactly once, when
`createB20` returns — but it still only proves the factory made the token, not that Coinbase
issued it as a tokenized stock. Issuer provenance comes from the official list. All three
must agree before an asset is `VERIFIED`.

### The Cobalt/ERC-8056 scheduling surface is not live on Base mainnet

This is the single most consequential finding in this document, and it was measured, not
assumed.

A B20 token is dispatched by a precompile. A selector the current hardfork does not dial
reverts with exactly four bytes: **the selector that was called**. That gives an exact,
verifiable capability probe.

| Surface                     | Selectors                                                                                                                                                             | Observed       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Beryl (current)             | `multiplier()`, `toScaledBalance()`, `toRawBalance()`, `scaledBalanceOf()`, `WAD_PRECISION()`, `isAnnouncementIdUsed()`, `contractURI()`, `supplyCap()`, `isPaused()` | **LIVE**       |
| Cobalt / ERC-8056 (planned) | `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()`, `toUIAmount()`, `balanceOfUI()`, `totalSupplyUI()`, `MAX_UI_MULTIPLIER()`, `supportsInterface()`              | **NOT_DIALED** |

Example: calling `uiMultiplier()` (selector `0xa60bf13d`) on `AAPLc` reverts with revert data
`0xa60bf13d`.

The consequences are concrete and they bind the whole product:

- **There is no readable scheduled multiplier on Base mainnet today.** `newUIMultiplier()`
  and `effectiveAt()` do not answer, so "a pending corporate action is coming at time T"
  cannot be read from chain state. The lifecycle reducer must return
  `UNSUPPORTED_CAPABILITY` for the scheduled path on mainnet rather than reporting "no
  pending update", which would be a false negative on the most safety-critical question the
  product answers.
- **`supportsInterface` is not available**, so ERC-165 cannot be the capability oracle. The
  selector-revert probe is.
- **Only the instant `updateMultiplier` path exists today**, meaning a mainnet corporate
  action arrives with no advance on-chain warning. The guard window is therefore _reactive_
  on mainnet and _predictive_ only where the scheduled surface is live.
- **The capability is an observation at a block, never a date.** Cobalt's changelog carries a
  start date of 2026-08-17; that date does not enable anything. `check` re-measures.

### Chainlink

13 Coinbase equity feeds exist for Base mainnet; 10 official tokens exist. Three feeds
(`COIN`, `CRCL`, `INTC`) have no listed token. Every feed reports 8 decimals, an 86400 s
heartbeat and a 0.5 % deviation threshold.

The L2 sequencer uptime feed is `0xbcf85224fc0756b9fa45aa7892530b47e10b6433`, answering `0`
(sequencer up) at the recorded block.

Every equity feed is recorded with `priceBasis: TOTAL_RETURN_TOKEN_PRICE`. That field is the
most load-bearing string in the manifest: Chainlink publishes the **multiplier-adjusted token
price**, not the underlying share price. Multiplying a share-equivalent quantity by it applies
the multiplier twice. See
[ADR 0006](../architecture/decisions/0006-equity-quantity-and-valuation-semantics.md).

### Token ↔ feed pairing is not established by either source

Nothing on chain links a B20 token to a Chainlink proxy: `IB20Asset` never references a feed,
and the aggregator never references a token address. The only available correspondence is
that the token's display symbol stem matches the feed directory's `docs.baseAsset` — which is
a **ticker inference**, and a ticker is not an identifier.

`provenance/base-b20/token-feed-pairing.json` therefore records all ten pairings with
`reviewStatus: INFERRED_UNREVIEWED`, usable for `DISPLAY_POSITION` only. Every value-sensitive
action class refuses an unreviewed pairing. Promotion to `REVIEWED_VERIFIED` requires an
issuer- or Chainlink-published statement naming both addresses, recorded with its URL,
retrieval time and body hash, committed by a human. No script may set that status.

### Feed freshness is not a single number

At the recorded block (`blockTimestamp` 1788776091) the `Coinbase AAPL` feed's `updatedAt`
was 1788551901 — roughly 62 hours old, against an 86400 s heartbeat. That is what a weekend
looks like for an equity feed, and it is exactly the case the product must not resolve by
guessing. A hold that is expected under a declared session policy and a feed that has truly
stopped publishing produce the same `updatedAt`; only an explicit, versioned session policy
plus fresh source state can distinguish them, and neither may be silently called "fresh".

## Deliberate gaps

| Unknown                                                  | Why it is still unknown                                             | How it gets resolved                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base Sepolia B20 asset creation                          | Not probed in this snapshot                                         | `capture` against chain 84532; if the factory or variant is not activated, module 17 records `BLOCKED` with evidence and the fixture stays local |
| Token ↔ feed pairing                                     | No primary source publishes both addresses together                 | Human review with a named published statement                                                                                                    |
| ISIN / CUSIP                                             | Not exposed by the live `extraMetadata` keys probed                 | Treated as untrusted attribute metadata if it ever appears                                                                                       |
| Policy and activation registry state                     | Probed for address presence only, not for per-feature activation    | Module 06 reads `IActivationRegistry.isActivated` per feature key                                                                                |
| Whether any listed asset has ever had a corporate action | All ten read `multiplier() == 1e18`; no historical scan has run yet | Module 06's backfill over the factory and token event history                                                                                    |
