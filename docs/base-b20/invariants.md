# B20 invariants

Each invariant states its dimensions, its rounding direction and the reason code emitted when
it is violated. Every one has, or will have, an executable test named after it. An invariant
without a test is a comment.

## Quantity

**Q1 — raw amount is multiplier-invariant.**
A change in `activeMultiplier` never changes `rawAmount`. Violation: `RAW_AMOUNT_DRIFT`.

**Q2 — share equivalent is floor-exact.**
`shareEquivalent = floor(rawAmount * multiplierWad / 1e18)`, integer division, matching the
official `toScaledBalance`. Units: raw token units at the token's `decimals`, multiplier
scaled by 1e18. Violation: `SHARE_CONVERSION_MISMATCH`.

**Q3 — the remainder is reported, never absorbed.**
`remainder = (rawAmount * multiplierWad) mod 1e18`. It appears in the derivation output.
Silently dropping it is `DUST_UNREPORTED`.

**Q4 — reverse conversion loses at most one unit.**
`sharesToRaw(rawToShares(x)) <= x`, and the gap is bounded by the documented floor loss.
Violation: `REVERSE_CONVERSION_UNBOUNDED`.

**Q5 — share equivalent is monotonic in the multiplier.**
For fixed `rawAmount`, `m1 <= m2` implies `shares(m1) <= shares(m2)`. Violation:
`MONOTONICITY_VIOLATED`.

**Q6 — no JS number on the quantity path.**
Asserted by test over the compiled sources, not by review. Violation: `FLOAT_ON_MONEY_PATH`.

## Valuation

**V1 — two routes, and only two.**
Route A is `rawAmount × TOTAL_RETURN_TOKEN_PRICE`; route B is
`shareEquivalent × UNDERLYING_EQUITY_PRICE`. Any other pairing of quantity and basis is
rejected before arithmetic. Violation: `DOUBLE_MULTIPLIER_APPLIED` or `PRICE_BASIS_MISMATCH`.

**V2 — a price is never a bare number.**
Every price carries basis, feed identity, decimals, round ID and freshness outcome. A price
without them cannot enter valuation. Violation: `PRICE_PROVENANCE_MISSING`.

**V3 — the routes reconcile.**
When both are available at the same block and round, they agree within the documented floor
bound. Beyond it: `VALUATION_ROUTE_CONFLICT`, never an average.

**V4 — a compensated corporate action creates no value.**
When the multiplier scales by `k` and the total-return price scales by `k`, route A's value is
unchanged. Violation: `VALUE_CREATED_BY_ACTION`.

**V5 — unsafe price evidence yields no authorization value.**
Stale, paused, sequencer-down, in-grace or wrong-decimals evidence produces no value for
collateral, liquidation, agent-order or transfer classes. Display may show a last-known value
only when it is explicitly typed non-actionable. Violation: `STALE_PRICE_AUTHORIZED`.

**V6 — formatting never changes arithmetic.**
Display formatting is a separate function over the exact integer result. JSON round-trips
preserve exact integers, with no scientific notation. Violation: `FORMATTING_ALTERED_VALUE`.

## Temporal

**T1 — event arrival never activates a schedule.**
A scheduled multiplier is active only at `block.timestamp >= effectiveAt`, evaluated against
the block being asked about, never against the time the event was indexed or the wall clock.
Violation: `PREMATURE_ACTIVATION`.

**T2 — cancellation and instant override supersede.**
A cancelled schedule never activates. An instant override clears any live pending update.
Violation: `CANCELLED_SCHEDULE_ACTIVATED`.

**T3 — a historical query never sees future state.**
Evaluating at block `n` yields the same answer whether asked at block `n` or block `n + 10^6`.
Violation: `FUTURE_LEAK`.

**T4 — no wall clock in lifecycle logic.**
`Date.now()` does not appear in the reducer. Block timestamp is an argument. Violation:
`WALL_CLOCK_IN_LIFECYCLE`.

**T5 — ordering is deterministic at equal timestamps.**
Ties break by block number, then transaction index, then log index. The result is independent
of how input was paginated. Violation: `NONDETERMINISTIC_ORDER`.

**T6 — two business facts are not merged because their values match.**
Event identity (chain, block hash, tx hash, log index) and semantic folding are separate
steps. Violation: `SEMANTIC_DEDUP`.

**T7 — an unsupported capability is not a negative answer.**
Where `newUIMultiplier()`/`effectiveAt()` are not dialed, the reducer returns
`UNSUPPORTED_CAPABILITY`, never "no pending update". Violation: `CAPABILITY_FALSE_NEGATIVE`.

## Identity

**I1 — identity is `(chainId, address)`.**
Symbol, name, ISIN, CUSIP, address prefix and user input are attributes, never keys.
Violation: `TICKER_AS_IDENTITY`.

**I2 — a rename preserves identity and is journaled.**
A changed `symbol()` or `name()` produces a versioned metadata history entry and never
reassigns the asset. Violation: `IDENTITY_DRIFT`.

**I3 — the B20 address prefix proves format, not issuance.**
`isB20` is recovered from the prefix. Issuer provenance comes from the official list, and
`isB20Initialized` from the factory. All three are required. Violation: `PREFIX_AS_ISSUER`.

**I4 — a fixture can never be `VERIFIED` on a production route.**
Violation: `FIXTURE_IN_PRODUCTION`.

## Evidence

**E1 — journal before projection.**
No projection row exists without its journal event. Violation: `PROJECTION_WITHOUT_EVIDENCE`.

**E2 — rebuild is exact.**
Deleting and regenerating every projection reproduces identical content hashes. Violation:
`REBUILD_DIVERGED`.

**E3 — observations from incompatible blocks are not compared.**
Two facts read at different, non-comparable blocks or rounds cannot produce agreement.
Violation: `EVIDENCE_BLOCK_MISMATCH`.

**E4 — absence is never agreement.**
A field a source cannot supply is `INCOMPLETE` and blocks, unless it is explicitly declared
chain-authoritative — the rule established in
[ADR 0004](../architecture/decisions/0004-source-agreement-field-policy.md). Violation:
`ABSENCE_READ_AS_AGREEMENT`.

**E5 — reorg compensation is append-only.**
A reorg invalidates derived canonical projections and journals a compensation event. It never
deletes a raw observation. Violation: `HISTORY_REWRITTEN`.

**E6 — every write is idempotent by canonical identity.**
The same canonical fact delivered twice produces one logical record. Violation:
`DUPLICATE_POSTING`.

## Authorization

**A1 — one receipt authorizes one operation, once.**
Bound to chain, target, asset, sender, receiver, raw amount, action, operation digest,
multiplier commitment, price-round commitment, policy version and expiry. Violation:
`RECEIPT_REPLAY` or `RECEIPT_BINDING_MISMATCH`.

**A2 — a receipt is signed only after re-verification.**
Issuance re-reads mandatory evidence inside a bounded window and requires the result to still
be `ALLOW`. Never signed from a caller-supplied result. Violation: `SIGNED_STALE_ALLOW`.

**A3 — same key, same request returns the original; same key, different request is 409.**
Concurrent same-key calls produce one logical result and at most one receipt. Violation:
`IDEMPOTENCY_BREACH`.

**A4 — no generic catch converts uncertainty into `ALLOW`.**
Violation: `FAIL_OPEN`.

**A5 — AI output never reaches authorization, arithmetic, classification, receipts or
contracts.** Enforced mechanically by `pnpm arch:check`. Violation: `AI_IN_DECISION_PATH`.
