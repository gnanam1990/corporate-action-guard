<!--
  GENERATED FILE — regenerate with: node scripts/b20-e2e-proof.mjs
  Every number below was computed by the run that wrote it.
-->

# B20 end-to-end proof

**Run at:** 2026-09-07T13:42:25.709Z
**Base mainnet block:** 50999399 `0xc45f69caafd5d2192fbd32fb5aee1d421340e09f742a7d2ab0cb0b4b788470b2`
**Artifact digest:** `sha256:9cc28049727abdf42bcc373175ea953bd60463f6e306258aace12463acd3bee1`

```text
B20 Equity Integrity Layer — end-to-end proof
run at 2026-09-07T13:42:25.709Z

──────────────────────────────────────────────────────────────────────────────
1. A verified Base asset, read live
──────────────────────────────────────────────────────────────────────────────
  asset            AAPLc  0xb200000000000000000000c2e324d24d7eecd1fb
  issuer source    https://www.base.org/stocks
  chain            8453 (Base mainnet, read-only)
  block            50999399  0xc45f69caafd5d2192fbd32fb5aee1d421340e09f742a7d2ab0cb0b4b788470b2
  on-chain name    Apple Inc.
  on-chain symbol  AAPLc
  decimals         8
  multiplier       1.000000000000000000  (1000000000000000000)

  Identity is (chainId, address). The symbol is display only — it is mutable on chain,
  and an integration keyed on it loses the position when the issuer renames the token.

──────────────────────────────────────────────────────────────────────────────
2. What the chain will not tell us
──────────────────────────────────────────────────────────────────────────────
  newUIMultiplier()  NOT_DIALED   selector 0xdc767007
  effectiveAt()      NOT_DIALED

  A B20 token is precompile-backed, and a selector this hardfork has not dialed reverts
  with exactly its own four bytes. So the ERC-8056 scheduling surface is absent, which
  means there is NO READABLE PENDING CORPORATE ACTION on Base mainnet today.

  The product reports UNSUPPORTED_CAPABILITY for that question. It does not report
  "nothing is scheduled" — that would be a false negative on the most safety-critical
  thing it is asked.

  token to feed      INFERRED_UNREVIEWED
  Nothing on chain links a B20 token to a Chainlink proxy. The only correspondence is a
  ticker match, and a ticker is not an identifier — so a live valuation is refused for
  every class except DISPLAY_POSITION until a human reviews the pairing.

──────────────────────────────────────────────────────────────────────────────
3. A 10:1 split, replayed — three integrations, one asset, one moment
──────────────────────────────────────────────────────────────────────────────

  Holding                    1.00000000 AAPLc (raw units, unchanged by the split)
  Multiplier after the split 10.000000000000000000
  Chainlink total-return     $200.00000000 per token — unchanged, because the
                             multiplier is already inside it

  ┌──────────────────────────────────┬───────────────┬───────────────┬──────────┐
  │ integration                      │ shares        │ value         │ verdict  │
  ├──────────────────────────────────┼───────────────┼───────────────┼──────────┤
  │ reads balanceOf as shares        │ 1.00000000    │ —             │ WRONG    │
  │ multiplies shares by feed price  │ 10.00000000   │ $2000.0000000 │ WRONG    │
  │ Corporate Action Guard           │ 10.00000000   │ $200.00000000 │ VERIFIED │
  └──────────────────────────────────┴───────────────┴───────────────┴──────────┘

  The double-multiplied answer is exactly 10x the correct one.
  Neither wrong answer reverts. Both reconcile against themselves. A holder sees a
  plausible number and a lending market prices collateral against it.

  Show the math:
    Raw token amount               balanceOf(account)
                                   = 1.00000000
    Active multiplier              multiplier()
                                   = 10.000000000000000000
    Share equivalent               floor(100000000 * 10000000000000000000 / 1000000000000000000)
                                   = 10.00000000
    Remainder discarded by floor   (100000000 * 10000000000000000000) mod 1000000000000000000
                                   = 0.000000000000000000

──────────────────────────────────────────────────────────────────────────────
4. The conformance suite, run against a correct integration and eight broken ones
──────────────────────────────────────────────────────────────────────────────

  reference integration:  CONFORMANT: 15 passed, 0 failed, 0 errored, of 15 scenarios (adapter reference, contract v1)
    RAW_AS_SHARES        CAUGHT   on INSTANT_OVERRIDE_CLEARS_PENDING
    DOUBLE_MULTIPLIER    CAUGHT   on FORWARD_SPLIT_10_TO_1
    ACTIVATE_ON_ARRIVAL  CAUGHT   on CANCEL_AND_RESCHEDULE
    IGNORE_CANCEL        CAUGHT   on SCHEDULE_CANCELLED_BEFORE_EFFECTIVE
    KEY_BY_TICKER        CAUGHT   on SYMBOL_RENAME_STABLE_IDENTITY
    ACCEPT_STALE_FEED    CAUGHT   on OFF_HOURS_HOLD_VERSUS_STALE
    DUPLICATE_ON_RETRY   CAUGHT   on LEGACY_AND_CANONICAL_ONE_UPDATE
    SWALLOW_REORG        CAUGHT   on SHALLOW_REORG_REPLACES_ACTION

  8/8 known integration defects caught by the suite.
  A suite that only ever sees correct code proves nothing about itself, so each of these
  is a real bug someone has shipped, and each has to fail the scenario aimed at it.

──────────────────────────────────────────────────────────────────────────────
5. What this proof does NOT claim
──────────────────────────────────────────────────────────────────────────────

  - No Coinbase asset has had a corporate action yet. The 10:1 split above is a replay,
    not an observed event. Every listed asset reads multiplier() == 1.0 today.
  - A holder can call the B20 token directly and bypass the guard entirely. Enforcement
    reaches only funds routed through the adapter, and a passing Foundry test asserts
    that bypass exists.
  - Base mainnet is read-only here. Nothing was signed and no transaction was broadcast.
  - No customers, no pilot, no audit, no Coinbase partnership, no production deployment.

```
