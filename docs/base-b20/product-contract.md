# B20 Equity Integrity Layer — product contract

The frozen semantics of the Base extension. Changing anything on this page requires an ADR.

## What the product does

It protects an integrated application from silently misinterpreting the identity, quantity,
price or corporate-action state of a Coinbase Tokenized Stock on Base, across one continuous
loop:

```text
BEFORE   replay the upcoming transition against the customer's integration
DURING   preflight the exact operation against fresh B20, policy, pause, oracle,
         sequencer, identity and lifecycle evidence
AFTER    reconcile actual chain and feed state, update the equity ledger, and
         produce a signed evidence package
```

## The three quantities

```text
rawAmount              balanceOf() / the transfer unit
shareEquivalent        floor(rawAmount * activeMultiplier / 1e18)
totalReturnTokenPrice  underlyingEquityPrice * activeMultiplier   (what Chainlink publishes)

valid   route A   rawAmount       * totalReturnTokenPrice
valid   route B   shareEquivalent * underlyingEquityPrice
FORBIDDEN         shareEquivalent * totalReturnTokenPrice     -- multiplier applied twice
```

All arithmetic is integer with explicit decimals. JS `number`, floating-point currency and
implicit decimal conversion are forbidden in decision, ledger, receipt and contract paths.
See [ADR 0006](../architecture/decisions/0006-equity-quantity-and-valuation-semantics.md).

## Deterministic outcomes

```text
VERIFIED   PENDING   CONFLICT   INSUFFICIENT_EVIDENCE   REORGED   MANUAL_REVIEW
```

`UNKNOWN`, stale, paused, contradictory, non-canonical, reorged or incomplete mandatory
evidence never becomes an authorization. Every outcome carries the exact evidence IDs behind
it and, where it blocks, the specific missing requirement.

## The guarantee boundary, stated plainly

- Enforcement reaches only what actually routes through this product — an application, smart
  account, vault or adapter that calls it. A holder can transfer the B20 token directly. This
  is **not** a universal Base firewall, and a passing test asserts the bypass exists.
- **Base mainnet (8453) is read-only.** No signing, no broadcast, no write path exists here.
- Base Sepolia (84532) writes require chain, signer, balance, verified capability and an
  explicit command, all five.
- A test fixture is always labelled `TESTNET FIXTURE — NOT COINBASE STOCK` and can never
  satisfy production issuer verification.
- Asset identity is `(chainId, contractAddress)`. A symbol, a name, an ISIN, an address prefix
  or user input is never identity. Symbols are mutable and are versioned as history.
- Coinbase/Base contract addresses and Chainlink feed addresses come from verified official
  sources plus live reads at a recorded block, and are stored with provenance.
- AI may explain evidence. AI may not classify a corporate action, choose an authorization
  result, compute money, or influence a receipt or a contract call.
- This product provides evidence and configurable books-and-records projections. It is not
  legal, tax, accounting or investment advice.

## What is true about the Base surface today

Measured, not assumed — see [`sources.md`](sources.md).

- The Beryl multiplier surface is **live**: `multiplier()`, `toScaledBalance()`,
  `toRawBalance()`, `scaledBalanceOf()`, `WAD_PRECISION()`, announcements, pause, policy,
  supply cap and `contractURI` all answer on mainnet.
- The Cobalt/ERC-8056 scheduling surface is **not dialed**: `newUIMultiplier()` and
  `effectiveAt()` do not answer, so **no readable pending corporate action exists on Base
  mainnet today**. The product reports `UNSUPPORTED_CAPABILITY` for the scheduled path rather
  than reporting "nothing pending", which would be a false negative.
- All ten officially listed assets read `multiplier() == 1e18` and `decimals() == 8`.
- Token-to-feed pairing is an unreviewed ticker inference and is refused for every
  value-sensitive action class.

## Real-product rule

Production routes read real Base mainnet state and real Chainlink state. No fake balances, no
invented hashes, no hard-coded health, no silent sample fallback. When a live dependency is
unavailable the product renders a truthful degraded state and fails closed wherever
authorization depends on it.

Every write is durably idempotent. Every state transition is journaled before any projection
updates. Every projection rebuilds exactly from the journal. Every external observation
records chain ID, block number and hash or feed round, observed time, source and freshness.
