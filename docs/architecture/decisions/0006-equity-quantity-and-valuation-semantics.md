# ADR 0006 — Three quantities, two valuation routes, one forbidden product

- **Status:** Accepted
- **Date:** 2026-09-07
- **Driven by:** the B20 Asset multiplier semantics in `base/base-std` at commit `be6d0450`,
  and the `TOTAL_RETURN_TOKEN_PRICE` basis of the Chainlink Coinbase equity feeds on Base

## Context

A B20 tokenized stock exposes three numbers that all look like "how much stock is this", and
two of the three are routinely confused:

```text
rawAmount             balanceOf() / the transfer unit. Never changed by a corporate action.
shareEquivalent       floor(rawAmount * multiplier / 1e18). What a holder thinks they own.
totalReturnPrice      underlyingEquityPrice * multiplier. What Chainlink publishes.
```

Two errors follow, and neither reverts:

- Treating `rawAmount` as a share count. Correct until the first corporate action, then
  wrong by exactly the multiplier, forever.
- Multiplying `shareEquivalent` by the Chainlink price. The multiplier is already inside that
  price, so it is applied twice. A 10:1 split turns a $200 position into $2,000 and the number
  looks plausible.

Both are the kind of defect that settles, reconciles against itself, and is discovered by a
customer.

## Decision

### Three distinct types, not three numbers

`RawAmount`, `ShareEquivalentAmount` and the two price types are branded types in
`@cag/domain`. They do not convert implicitly and cannot be passed to each other's positions.
Conversion goes through named, checked functions that take the multiplier and its evidence.

### Exactly two valuation routes

```text
Route A   economicValue = rawAmount        × TOTAL_RETURN_TOKEN_PRICE
Route B   economicValue = shareEquivalent  × UNDERLYING_EQUITY_PRICE
```

A price is never a bare number. It carries a branded **basis** (`TOTAL_RETURN_TOKEN_PRICE` or
`UNDERLYING_EQUITY_PRICE`), its feed identity, its decimals, its round and its freshness
outcome. The valuation API accepts `(RawAmount, TotalReturnTokenPrice)` or
`(ShareEquivalentAmount, UnderlyingEquityPrice)` and nothing else.

### The forbidden product is unrepresentable, then rejected

`shareEquivalent × TOTAL_RETURN_TOKEN_PRICE` fails to typecheck. Where a value crosses a
runtime boundary and the types are gone — JSON, an API request, a conformance fixture — it is
rejected with the stable reason code `DOUBLE_MULTIPLIER_APPLIED` **before** any arithmetic
runs. It is never computed and then flagged.

### Integers only, with explicit scale

Every quantity, multiplier and price is a `bigint` with a declared decimals field. No JS
`number`, no float, no implicit rescale, no scientific notation in JSON. Rounding is floor,
matching the official `toScaledBalance` helper (`rawBalance * multiplier / WAD_PRECISION`,
integer division). Floor loss is bounded, documented and reported as an explicit `remainder`
rather than being silently absorbed.

### Route agreement is a check, not an assumption

When both routes are available for the same position at the same block and round, they are
computed and compared. Agreement within the documented floor-loss bound is recorded as
evidence. Disagreement beyond it is `CONFLICT`, not an average.

### `underlyingEquityPrice` is currently derived, and labelled as such

Chainlink publishes only the total-return price on Base. The underlying price is therefore
`totalReturnPrice / multiplier`, which is a derivation from one source, not a second
independent source. It is labelled `DERIVED_FROM_TOTAL_RETURN` and must not be presented as
corroboration of Route A. Route B is genuinely independent only when a real underlying feed
exists.

## Consequences

- The most valuable customer-facing artifact — "show me the math" — falls out of the type
  system rather than being written twice.
- Property tests can state the invariants directly: raw amount never changes because the
  multiplier changed; share equivalent is monotonic in the multiplier; a compensated split
  creates no value; the two routes reconcile within floor loss.
- Mutation testing has a precise target: an implementation that applies the multiplier twice
  must fail a named test, not merely "some test".
- Callers cannot pass a generic `price`. This is friction on purpose.

## Rejected alternatives

**Normalize everything to share-equivalents at ingress.** Loses the raw unit, which is what
actually transfers and what every DeFi protocol accounts in, and makes the double-multiplier
error easier rather than harder.

**Runtime-only validation of the forbidden combination.** Catches it after somebody has
already written the multiplication. The type boundary catches it while it is being written.

**A tolerance band that absorbs route disagreement.** A tolerance wide enough to hide a
double multiplier is wide enough to hide anything.
