# ADR 0007 — Base mainnet is read-only; writes are Sepolia or local, and gated

- **Status:** Accepted
- **Date:** 2026-09-07
- **Extends:** ADR 0003 (live data and testnet fixture policy)
- **Driven by:** the same reasoning that made X Layer mainnet read-only, applied to a chain
  where the tokens are claims on real equity

## Context

The product's value comes from reading real state: real Coinbase-issued B20 tokens, real
Chainlink rounds, real sequencer status. Its risk comes from writing. On Base mainnet a
write would touch tokenized securities held by real people, and no part of this product needs
that capability to do its job.

ADR 0003 already established this shape for X Layer. Base adds a wrinkle: the enforcement
demo is more convincing with a controllable asset, which creates pressure to deploy something
that looks like a stock.

## Decision

### Chain 8453 (Base mainnet) is read-only, structurally

- The Base mainnet configuration exposes no signer, no wallet client and no
  send-transaction method. This is a shape of the config type, not a runtime check that a
  future refactor can drop.
- `packages/b20-reader` and `packages/chainlink-reader` export no signing or transaction API.
  A reader that could write would eventually be asked to.
- Every read session asserts `eth_chainId == 8453` before its first call. A misconfigured RPC
  pointed at another chain aborts rather than producing evidence labelled with the wrong chain.
- Any deployment script refuses chain 8453 explicitly, by number, before doing anything else.

### Chain 84532 (Base Sepolia) writes require five independent conditions

All of: an explicit server-only feature flag; a configured signer provider; the observed chain
ID equal to 84532; a sufficient balance; and a capability that has actually been verified live
at a recorded block. An address string existing in configuration enables nothing. Missing any
one condition is a refusal with a named reason, never a warning followed by a broadcast.

### A fixture is never a stock

If Base Sepolia supports native B20 asset creation, the fixture is created through the
verified factory. If it does not, module 17 records `BLOCKED` with the evidence and the tests
run against a local Foundry fixture. Under no circumstance is a precompile address, a factory
capability or an activation invented to make a demo work.

Every fixture carries `TESTNET FIXTURE — NOT COINBASE STOCK` in its on-chain metadata, its
manifest, its API responses, its logs, its evidence packages and its UI surface. Fixtures live
in a separate manifest and a separate API namespace, and are excluded from the production
asset registry by construction rather than by a filter that can be forgotten.

### The receipt signer is not the deployment signer

They are separate keys with separate configuration. A key that can deploy a test contract must
not be able to sign an authorization, and vice versa.

## Verified position at the time of this decision

Base mainnet chain ID confirmed as 8453; the B20 factory precompile at
`0xb20f000000000000000000000000000000000000` responds to `isB20Initialized`; ten officially
listed assets read cleanly at block 50993686. No write path to Base mainnet exists in this
repository and none is planned.

Base Sepolia capability is **unverified** as of this ADR. Module 17 must probe it and record
the result; until then the Sepolia write path stays disabled and the fixture stays local.

## Consequences

- The most convincing part of the demo — a controllable corporate action — runs on a fixture
  or locally, and is labelled as such. That is a smaller claim and a true one.
- Enforcement is demonstrated for funds routed through the adapter or vault. A holder calling
  the token directly bypasses it. This is stated in the code, the docs and the UI, and is
  covered by a passing boundary test that asserts the bypass exists.
- Reviewers can verify the read-only claim mechanically: no signer type is reachable from the
  Base mainnet configuration.

## Rejected alternatives

**A single signer with a chain-ID guard.** One deleted line away from a mainnet broadcast.
The mainnet config having no signer at all cannot be defeated by deleting a check.

**Deploying a "realistic" mock stock to Base mainnet for the demo.** Would put an unbacked
asset that looks like a security on a public chain.
