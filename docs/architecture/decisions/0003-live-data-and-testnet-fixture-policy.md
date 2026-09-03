# ADR 0003 — Live data and testnet fixture policy

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Gnanam, Anandan, Vasanth

## Context

Real corporate actions cannot be scheduled on demand, so the failure paths this product
exists to prove cannot be triggered against production xStocks contracts. At the same time,
a demo built on mocks would prove nothing.

## Decision

**Live where it matters:**

- Asset catalog and provenance come from the live xStocks production API.
- Displayed X Layer state comes from live mainnet reads at recorded blocks (chain `196`).
- Mainnet is **read-only**. No signing code path exists for chain 196, and deployment
  scripts refuse chain 196.

**Fixture only where reality cannot be scheduled:**

- A deterministic Foundry fixture on X Layer testnet (chain `1952`) reproduces the
  schedule / override / activation surface.
- It is labelled `TESTNET FIXTURE` on chain, in metadata, and in the UI.
- It does not use the xStocks name, ticker, branding, or addresses in a misleading way.
- It proves the _guard_ rejects stale, mutated, replayed, expired, and unsafe-window
  operations. It does **not** prove compatibility with the production xStocks interface;
  where selectors differ, a narrow `ICorporateActionAsset` interface is defined and the
  production compatibility gap is documented.

**Never:**

- Fake balances, fake API health, invented transaction hashes, hard-coded success, or
  mocked critical-path results in main product routes.
- Bundled sample data substituted when a production call fails.
- A fixture symbol or fake transaction hash present in a production browser bundle — this
  is asserted by a build-output scan in CI.

**Degradation is truthful:** when a live dependency is unavailable the product shows an
explicit degraded or unavailable state, labels last-known-good data `STALE`, and fails
closed. Stale data may be _displayed_; it may not _authorize_.

## Consequences

- Test fixtures live in clearly named test paths, isolated from production bundles.
- Live contract tests against the real API and RPC run behind an explicit opt-in
  environment flag so ordinary CI stays deterministic.
- The demo narrative centres on failure evidence, which the fixture makes reproducible.
- The README and submission material must state the testnet limitation plainly.
