# ADR 0004 — Source agreement is scoped to fields both sources expose

- **Status:** Accepted
- **Date:** 2026-09-03
- **Supersedes part of:** the informal reading of "required sources agree" in ADR 0002
- **Driven by:** verified inspection of the live xStocks OpenAPI v2 contract and live
  production responses on 2026-09-03

## Context

ADR 0002 states that API/on-chain disagreement blocks protected actions, and
`packages/domain` implements `INCOMPLETE` — a field one source cannot supply — as blocking,
exactly like `MISMATCH`. That rule exists so an absent value can never read as agreement.

Verifying the real contract at `https://api.xstocks.fi/api/v2` showed that the multiplier
**nonce is not exposed by the API at all**. `GET /public/assets/{symbol}/multiplier`
returns only:

```json
{
  "currentMultiplier": 1.0032690125398187,
  "newMultiplier": 0,
  "activationDateTime": 0,
  "reason": null
}
```

Under the original reading, the nonce field would be `INCOMPLETE` on every asset forever,
`compareSources` would return `INCOMPLETE` permanently, and `evaluatePreflight` would emit
`SOURCE_MISMATCH` for every action. The guard would block everything, always. A guard that
blocks unconditionally is not safe, it is broken — it teaches integrators to disable it.

## Decision

Source agreement is evaluated over an explicit **required agreement field set**: the fields
both sources are contractually expected to expose.

- **Required (default):** `multiplier`, `scheduledActivation`, `wrapperAddress`. Each is
  published by the xStocks API and readable on chain. A field in this set that either
  source cannot supply is `INCOMPLETE` and **blocks**, unchanged from before.
- **Chain-authoritative:** `multiplierNonce`. The API does not publish it, so its absence
  is the expected contract rather than a degradation. It is reported in the comparison for
  operator visibility but does not contribute to the agreement verdict.

The nonce is not left unprotected. It is checked directly against the caller's operation by
`MULTIPLIER_NONCE_MISMATCH`, and re-verified independently on chain by
`ActionGuardAdapter`. That is a **stronger** check than source agreement: agreement asks
whether two observers concur, while the nonce check asks whether the caller's assumed epoch
equals the current chain epoch.

The required set is data, not a hard-coded condition, so extending the API later — or
integrating a second reference feed — is a policy change with a test, not a code change.

## Consequences

- `TolerancePolicy` gains `requiredAgreementFields`. Callers must state the policy; there
  is no implicit default inside the comparison function.
- A field being chain-authoritative is visible in the comparison output, so the console can
  show "chain only" rather than silently omitting the row.
- **The safety property is preserved:** removing a field from the required set does not
  make a _disagreement_ pass. A field present on both sides and differing is still
  `MISMATCH`, and `MISMATCH` still dominates. Only the absent-value case changes, and only
  for fields the API has no contract to provide.
- If xStocks later publishes a nonce, moving it into the required set is a one-line policy
  change that immediately makes disagreement blocking.

## Alternatives rejected

- **Leave nonce required.** Blocks every action forever. Rejected: an unconditional block
  is not a safety property.
- **Treat a missing nonce as a match.** Rejected outright — this is precisely the "missing
  evidence becomes an implicit match" failure ADR 0002 forbids, and it would generalize to
  every field.
- **Infer the nonce from the API multiplier value.** Rejected: inventing a value the source
  never stated and then calling it agreement is fabricated evidence.
