# ADR 0002 — Trust and enforcement boundary

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Gnanam, Anandan, Vasanth

## Context

The product's only real claim is that it refuses to authorize an action when the evidence
is stale, incomplete, or contradictory. Every subsequent design argument depends on being
precise about what is authoritative, what is merely informative, and what the guard cannot
protect at all.

## Decision — recorded normatively

1. **API data is not sufficient for on-chain enforcement.** The xStocks production API is
   a mandatory source for discovery and for the off-chain half of source agreement. It is
   never, by itself, grounds to allow a protected action.

2. **Contract reads are authoritative for on-chain multiplier facts.** Multiplier value,
   nonce, activation time, and `wrapper.asset()` are decided by chain state observed at a
   recorded block number and hash — not by the API and not by a cache.

3. **API/on-chain disagreement blocks protected actions.** `SOURCE_MISMATCH` is a hard
   block. It cannot be resolved by an operator asserting agreement; only a later complete
   observation in which the sources actually agree can clear it.

4. **The signer can lie about off-chain agreement.** `ActionGuardAdapter` verifies chain
   facts itself — nonce, `wrapper.asset()`, guard window, binding, expiry, consumption —
   but it cannot verify that the xStocks API agreed. A compromised signer could issue a
   receipt asserting agreement that never existed. Mitigations in this build are limited to
   short receipt lifetimes, operation binding, single consumption, authorized-signer
   configuration, and two-step rotation. **The MVP signer is therefore not a final
   production trust architecture.** Production requires HSM/KMS custody or threshold
   signing plus an auditable rotation procedure. This gap is documented, not implemented.

5. **Direct ERC-20 transfers bypass the optional adapter.** A holder can move an xStock
   without touching the guard. The guarantee covers only paths that route through
   `ActionGuardAdapter`. Any claim of universal protection is false.

6. **AI output is non-authoritative.** The explainer module may summarize evidence for
   humans. It is structurally excluded from `evaluatePreflight`, receipt issuance, the
   adapter, and the vault, and an architecture test enforces that exclusion. Disabling it
   changes nothing about safety or core function.

## Consequences

- Missing evidence can never become an implicit match. `UNKNOWN` is a block, not a pass.
- The console must show `UNKNOWN` rows rather than hiding them, or it would misrepresent
  the boundary the product is built on.
- Marketing, README, pitch, and demo copy are bound by points 4 and 5.

## Residual risks accepted for this build

| Risk | Why accepted | Bounded by |
|---|---|---|
| Signer key held in process memory | HSM/KMS is out of scope for the event build | Testnet-only writes, short receipt lifetime, single consumption, rotation |
| Single RPC provider may be dishonest | Multi-provider quorum is out of scope | Chain-ID check, bytecode check, provider recorded per read, fallback for reads |
| Reorg deeper than the configured confirmation depth | X Layer finality details not fully documented | Conservative configurable depth, labelled as an assumption, `REORG_DETECTED` evidence |
